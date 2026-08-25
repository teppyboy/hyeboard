import { describe, expect, it, vi } from "vitest";
import { createRedisClient, createRedisClients, type RedisBlockingClient, type RedisCommandClient, type RedisMultiLike, type RedisPublishClient, type RedisSubscribeClient } from "./client";
import { cacheKey, captchaRelayKey, captchaRelaySignalKey, crossDetailLeaseKey, crossDetailPermitKey, crossDetailWindowKey, refreshStateKey } from "./keys";
import { RedisJsonCache } from "./cache";
import { RedisCaptchaRelayCoordinator } from "./captcha-relay-coordinator";
import { RedisSingleFlight } from "./single-flight";
import { RedisVnuProbeBudgetCoordinator } from "./vnu-probe-budget-coordinator";
import { RedisVnuRefreshControlCoordinator } from "./vnu-refresh-coordinator";
import type { LinkedPair } from "../../vnu-refresh-control";
import { MAX_FEATURE_POLICY_SSE_SUBSCRIBERS } from "../../feature-policy-store";
import { FEATURE_POLICY_REVISION_CHANNEL, RedisFeaturePolicyEvents } from "./feature-policy-events";

class FakeRedis implements RedisBlockingClient {
  readonly values = new Map<string, string>();
  readonly lists = new Map<string, string[]>();
  readonly commands: Array<{ script: string; keys?: string[]; arguments?: string[] }> = [];
  private lock = false;
  async get(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
  async set(key: string, value: string, options?: { expiration?: { type: "PX" | "EX"; value: number }; condition?: "NX" | "XX" }): Promise<string | null> {
    if (options?.condition === "NX" && this.values.has(key)) return null;
    this.values.set(key, value); return "OK";
  }
  async del(key: string): Promise<number> {
    const deleted = this.values.delete(key) || this.lists.delete(key);
    return deleted ? 1 : 0;
  }
  async watch(): Promise<void> {}
  async unwatch(): Promise<void> {}
  multi(): RedisMultiLike {
    const commands: Array<() => Promise<unknown>> = [];
    return {
      set: (key, value) => { commands.push(() => this.set(key, value)); return this.multiWith(commands); },
      del: (key) => { commands.push(() => this.del(key)); return this.multiWith(commands); },
      exec: async () => { for (const command of commands) await command(); return []; },
    };
  }
  private multiWith(commands: Array<() => Promise<unknown>>): RedisMultiLike {
    return { set: (key, value) => { commands.push(() => this.set(key, value)); return this.multiWith(commands); }, del: (key) => { commands.push(() => this.del(key)); return this.multiWith(commands); }, exec: async () => { for (const command of commands) await command(); return []; } };
  }
  async eval(script: string, options: { keys?: string[]; arguments?: string[] }): Promise<unknown> {
    this.commands.push({ script, ...options });
    const key = options.keys?.[0] ?? "";
    const args = options.arguments ?? [];
    if (script.includes("state.status")) {
      const raw = this.values.get(key); if (!raw) return 0;
      const state = JSON.parse(raw) as Record<string, unknown>; if (state.status !== "pending") return 0;
      state.status = args[0]; if (args[0] === "answered") state.answer = args[2];
      if (args[0] === "answered") this.values.set(key, JSON.stringify(state));
      else this.values.delete(key);
      const signal = options.keys?.[1]!; this.lists.set(signal, [args[0]]); return 1;
    }
    if (script.includes("PTTL") && script.includes("INCRBY")) return [1, 0];
    if (script.includes("cjson.decode")) return [1, Date.now() + 125_000, "ENVELOPE"];
    if (script.includes("ZREMRANGEBYSCORE") && script.includes("ZCARD")) return [1, Date.now() + 125_000];
    if (script.includes("SET', KEYS[1]")) { if (this.lock) return 0; this.lock = true; return 1; }
    if (script.includes("GET', KEYS[1]")) { this.lock = false; return 1; }
    if (script.includes("LPUSH")) { this.lists.set(key, ["ready"]); return 1; }
    if (script.includes("redis.call('SET', KEYS[i]")) return 1;
    return 0;
  }
  async blPop(key: string): Promise<{ key: string; element: string } | null> {
    const value = this.lists.get(key)?.shift(); return value === undefined ? null : { key, element: value };
  }
}

class FakeRedisPubSub implements RedisPublishClient, RedisSubscribeClient {
  listener?: (message: string) => void;
  subscribed?: string;
  unsubscribed?: string;
  publishFails = false;

  async publish(channel: string, message: string): Promise<number> {
    if (this.publishFails) throw new Error("Redis unavailable");
    if (channel === this.subscribed) this.listener?.(message);
    return this.listener === undefined ? 0 : 1;
  }

  async subscribe(channel: string, listener: (message: string) => void): Promise<void> {
    this.subscribed = channel;
    this.listener = listener;
  }

  async unsubscribe(channel: string): Promise<void> {
    this.unsubscribed = channel;
    this.listener = undefined;
  }

  receive(message: string): void {
    this.listener?.(message);
  }
}

const PAIR: LinkedPair = { accessTokenId: "A".repeat(22), accessExpiresAt: Date.now() + 600_000, grantId: "B".repeat(22), grantExpiresAt: Date.now() + 900_000 };

describe("Redis HA primitives", () => {
  it("exposes node-redis clients through the narrow injectable interfaces", () => {
    const client: RedisCommandClient = createRedisClient();
    const clients = createRedisClients();
    expect(client).toBeDefined();
    expect(clients.subscriber).not.toBe(clients.client);
  });

  it("uses versioned opaque hash-tagged keys and rejects non-opaque identities", () => {
    const key = refreshStateKey("a".repeat(64));
    expect(key).toMatch(/^hyeboard:v1:\{[0-9a-f]{64}\}:refresh$/);
    expect(key).not.toContain("a".repeat(64));
    expect(() => refreshStateKey("raw-user-id")).toThrow();
    expect(() => captchaRelayKey("short")).toThrow();
  });

  it("co-locates every multi-key operation under one Redis Cluster hash tag", () => {
    const identity = "a".repeat(64);
    const tag = (key: string) => key.match(/\{([^}]+)\}/)?.[1];
    expect(new Set([
      tag(crossDetailPermitKey(identity, "1".repeat(64))),
      tag(crossDetailLeaseKey(identity)),
      tag(crossDetailWindowKey(identity)),
    ]).size).toBe(1);
    expect(tag(captchaRelayKey("C".repeat(16)))).toBe(tag(captchaRelaySignalKey("C".repeat(16))));
  });

  it("keeps refresh transitions in the existing pure contract and writes through CAS", async () => {
    const redis = new FakeRedis();
    const coordinator = new RedisVnuRefreshControlCoordinator({ client: redis });
    await expect(coordinator.activatePair("a".repeat(64), PAIR)).resolves.toEqual({ kind: "activated" });
    const stored = await redis.get(refreshStateKey("a".repeat(64)));
    expect(stored).toContain(PAIR.accessTokenId);
    expect(redis.commands.some(({ script }) => script === undefined)).toBe(false);
  });

  it("maps probe budget and permit results without leaking the session identity", async () => {
    const redis = new FakeRedis();
    const coordinator = new RedisVnuProbeBudgetCoordinator({ client: redis });
    await coordinator.consume("a".repeat(64), 3);
    await expect(coordinator.acquireBrc1Permit("a".repeat(64))).resolves.toMatchObject({ leaseId: expect.stringMatching(/^[0-9a-f]{32}$/) });
    const commandText = JSON.stringify(redis.commands);
    expect(commandText).not.toContain("a".repeat(64));
    expect(commandText).not.toMatch(/password|cookie|raw.?token/i);
  });

  it("keeps cross-detail permits opaque and returns only the validated envelope", async () => {
    const redis = new FakeRedis();
    const coordinator = new RedisVnuProbeBudgetCoordinator({ client: redis });
    const limits = { maxTargets: 1, maxRows: 1, concurrency: 1, budget: 2, windowSeconds: 60 };
    const permit = {
      permitHash: "1".repeat(64),
      record: {
        requesterHmac: "2".repeat(64), targetHmac: "3".repeat(64), revisionHmac: "4".repeat(64), rowHmac: "5".repeat(64),
        policyVersion: 1, nonce: "6".repeat(32), envelope: "ENVELOPE", expiresAt: Date.now() + 60_000,
      },
    };
    await coordinator.issueCrossDetailPermits("a".repeat(64), [permit], limits);
    await expect(coordinator.consumeCrossDetailPermit("a".repeat(64), { ...permit.record, permitHash: permit.permitHash }, limits)).resolves.toMatchObject({ envelope: "ENVELOPE" });
    expect(JSON.stringify(redis.commands)).not.toContain("a".repeat(64));
  });

  it("preserves CAPTCHA answer-before-wait and cancellation semantics", async () => {
    const redis = new FakeRedis();
    const coordinator = new RedisCaptchaRelayCoordinator({ client: redis, blocking: redis, createId: () => "C".repeat(16), timeoutMs: 50 });
    const relay = await coordinator.prepare("data:image/png;base64,IMAGE");
    expect(JSON.stringify(redis.values)).not.toContain("data:image/png;base64,IMAGE");
    await coordinator.answer(relay.challengeId, "ANSWER");
    await expect(relay.wait()).resolves.toBe("ANSWER");
    await expect(coordinator.answer(relay.challengeId, "LATE")).rejects.toMatchObject({ code: "STUDENTHUB_CAPTCHA_CHALLENGE_NOT_FOUND" });
    const cancelled = await coordinator.prepare("data:image/png;base64,IMAGE");
    await cancelled.cancel();
    await expect(cancelled.wait()).rejects.toMatchObject({ code: "STUDENTHUB_CAPTCHA_CHALLENGE_NOT_FOUND" });
  });

  it("cleans a relay state and signal when a waiter is aborted", async () => {
    const redis = new FakeRedis();
    const coordinator = new RedisCaptchaRelayCoordinator({ client: redis, blocking: redis, createId: () => "D".repeat(16), timeoutMs: 1000 });
    const relay = await coordinator.prepare("IMAGE");
    const controller = new AbortController();
    const waiting = relay.wait(controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: "STUDENTHUB_CAPTCHA_CANCELLED" });
    expect(await redis.get(captchaRelayKey(relay.challengeId))).toBeNull();
    expect(redis.lists.has(captchaRelaySignalKey(relay.challengeId))).toBe(false);
  });

  it("provides JSON cache and distributed import single-flight on hashed keys", async () => {
    const redis = new FakeRedis();
    const cache = new RedisJsonCache({ client: redis, defaultTtlMs: 1000 });
    await cache.set("student-import", { ok: true });
    await expect(cache.get<{ ok: boolean }>("student-import")).resolves.toEqual({ ok: true });
    expect([...redis.values.keys()].some((key) => key === cacheKey("student-import"))).toBe(true);
    const singleFlight = new RedisSingleFlight({ client: redis, blocking: redis, resultTtlMs: 1000 });
    let calls = 0;
    await expect(singleFlight.run("student-import", async () => { calls += 1; return { imported: true }; })).resolves.toEqual({ imported: true });
    await expect(singleFlight.run("student-import", async () => { calls += 1; return { imported: false }; })).resolves.toEqual({ imported: true });
    expect(calls).toBe(1);
  });
});

describe("RedisFeaturePolicyEvents", () => {
  it("fans out only newer canonical nonnegative revisions once", async () => {
    const redis = new FakeRedisPubSub();
    const events = new RedisFeaturePolicyEvents(redis, redis);
    const first: number[] = [];
    const second: number[] = [];
    events.subscribe((revision) => first.push(revision));
    events.subscribe((revision) => second.push(revision));
    await events.start();

    expect(redis.subscribed).toBe(FEATURE_POLICY_REVISION_CHANNEL);
    for (const message of ["0", "0", "-1", "2.0", "02", "wat", "9007199254740992", "1", "1", "0", "2"]) redis.receive(message);
    expect(first).toEqual([0, 1, 2]);
    expect(second).toEqual([0, 1, 2]);
    await events.publish(3);
    expect(first).toEqual([0, 1, 2, 3]);
    redis.publishFails = true;
    await expect(events.publish(4)).rejects.toThrow("Redis unavailable");
    expect(first).toEqual([0, 1, 2, 3, 4]);
    await events.close();
    expect(redis.unsubscribed).toBe(FEATURE_POLICY_REVISION_CHANNEL);
  });

  it("caps streams and reuses a slot after cancellation", async () => {
    const redis = new FakeRedisPubSub();
    const events = new RedisFeaturePolicyEvents(redis, redis);
    const streams = await Promise.all(Array.from(
      { length: MAX_FEATURE_POLICY_SSE_SUBSCRIBERS },
      () => events.stream(undefined, new AbortController().signal),
    ));

    await expect(events.stream(undefined, new AbortController().signal)).rejects.toMatchObject({
      code: "FEATURE_POLICY_STREAM_LIMITED",
      status: 503,
    });
    await streams[0]!.body!.cancel();
    const reused = await events.stream(undefined, new AbortController().signal);
    expect(reused.status).toBe(200);
    await reused.body!.cancel();
    await events.close();
  });

  it("reconciles the current revision on reconnect without duplicating an already-seen revision", async () => {
    const redis = new FakeRedisPubSub();
    const events = new RedisFeaturePolicyEvents(redis, redis);
    await events.start();

    const missed = await events.stream(1, new AbortController().signal, 2);
    const missedReader = missed.body!.getReader();
    expect(new TextDecoder().decode((await missedReader.read()).value)).toBe("event: revision\ndata: 2\n\n");
    await missedReader.cancel();

    const current = await events.stream(2, new AbortController().signal, 2);
    const reader = current.body!.getReader();
    const pending = reader.read();
    redis.receive("2");
    redis.receive("3");
    expect(new TextDecoder().decode((await pending).value)).toBe("event: revision\ndata: 3\n\n");
    await reader.cancel();
    await events.close();
  });

  it("streams revisions with heartbeats and removes listeners on abort", async () => {
    vi.useFakeTimers();
    try {
      const redis = new FakeRedisPubSub();
      const events = new RedisFeaturePolicyEvents(redis, redis);
      await events.start();
      const controller = new AbortController();
      const response = await events.stream(1, controller.signal);
      const reader = response.body!.getReader();

      await vi.advanceTimersByTimeAsync(15_000);
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(": heartbeat\n\n");
      redis.receive("2");
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("event: revision\ndata: 2\n\n");
      controller.abort();
      await expect(reader.read()).resolves.toMatchObject({ done: true });
      redis.receive("3");
      await events.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
