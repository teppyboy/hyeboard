import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { emptyPolicy } from "../src/feature-policy";
import {
  DurableObjectFeaturePolicyEvents,
  DurableObjectFeaturePolicyStore,
} from "../src/feature-policy-cloudflare";
import { FeaturePolicyRuntime, MAX_FEATURE_POLICY_SSE_SUBSCRIBERS, type PublishFeaturePolicyInput } from "../src/feature-policy-store";

declare module "cloudflare:workers" {
  interface ProvidedEnv { FEATURE_POLICY: Env["FEATURE_POLICY"] }
}

const actor = { method: "password" as const, subject: "password-admin" };

function publication(baseRevision: number, reason = `Publish ${baseRevision + 1}`): PublishFeaturePolicyInput {
  return { baseRevision, policy: emptyPolicy(), reason, actor };
}

function authority() {
  return env.FEATURE_POLICY.get(env.FEATURE_POLICY.idFromName("global"));
}

function store() {
  return new DurableObjectFeaturePolicyStore(env.FEATURE_POLICY);
}

afterEach(() => reset());

describe("FeaturePolicyDurableObject", () => {
  it("bootstraps SQLite, publishes with CAS, and reads immutable history", async () => {
    const policy = store();
    expect(await policy.current()).toEqual({ ...emptyPolicy(), revision: 0 });

    const first = await policy.publish(publication(0, "  First  "));
    expect(first).toMatchObject({ revision: 1, baseRevision: 0, reason: "First", actor });
    await runInDurableObject(authority(), async (instance) => {
      await expect(instance.publish(publication(0, "Stale"))).rejects.toMatchObject({
        code: "ADMIN_POLICY_CONFLICT",
        status: 409,
        details: { currentRevision: 1 },
      });
    });
    const second = await policy.publish(publication(1, "Second"));

    expect(await policy.current()).toEqual(second.snapshot);
    expect(await policy.revision(1)).toEqual(first);
    expect(await policy.revision(99)).toBeUndefined();
    expect(await policy.history({ limit: 1 })).toEqual({ items: [second], nextBeforeRevision: 2 });
    expect((await policy.history({ beforeRevision: 2, limit: 1000 })).items).toEqual([first]);

    await runInDurableObject(authority(), async (_instance, state) => {
      expect(() => state.storage.sql.exec("DELETE FROM feature_policy_history WHERE revision = 1"))
        .toThrow(/immutable/);
    });
  });

  it("rolls an earlier snapshot forward as a new revision", async () => {
    const runtime = new FeaturePolicyRuntime(store(), new DurableObjectFeaturePolicyEvents(env.FEATURE_POLICY));
    const first = publication(0, "Disable grades");
    first.policy.global.capabilities.grades = { enabled: false };
    await runtime.publish(first);
    await runtime.publish(publication(1, "Restore grades"));

    const rolledBack = await runtime.rollback({
      baseRevision: 2,
      targetRevision: 1,
      reason: "Rollback incident",
      actor,
    });
    expect(rolledBack).toMatchObject({ revision: 3, baseRevision: 2, reason: "Rollback incident" });
    expect(rolledBack.snapshot.global.capabilities.grades?.enabled).toBe(false);
    expect((await store().history({ limit: 10 })).items.map(({ revision }) => revision)).toEqual([3, 2, 1]);
  });

  it("reconciles the current revision on reconnect without duplicating an already-seen revision", async () => {
    const events = new DurableObjectFeaturePolicyEvents(env.FEATURE_POLICY);
    await store().publish(publication(0));
    await events.publish(1);

    const missed = await events.stream(0, new AbortController().signal);
    const missedReader = missed.body!.getReader();
    expect(new TextDecoder().decode((await missedReader.read()).value)).toBe("event: revision\ndata: 1\n\n");
    await missedReader.cancel();

    const current = await events.stream(1, new AbortController().signal);
    const reader = current.body!.getReader();
    const pending = reader.read();
    await events.publish(1);
    await store().publish(publication(1));
    await events.publish(2);
    expect(new TextDecoder().decode((await pending).value)).toBe("event: revision\ndata: 2\n\n");
    await reader.cancel();
  });

  it("fans revision-only events to two streams and cleans them up", async () => {
    const events = new DurableObjectFeaturePolicyEvents(env.FEATURE_POLICY);
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const first = await events.stream(0, firstAbort.signal);
    const second = await events.stream(0, secondAbort.signal);
    const firstReader = first.body!.getReader();
    const secondReader = second.body!.getReader();

    await events.publish(1);
    const chunks = await Promise.all([firstReader.read(), secondReader.read()]);
    for (const chunk of chunks) {
      const text = new TextDecoder().decode(chunk.value);
      expect(text).toBe("event: revision\ndata: 1\n\n");
      expect(text).not.toContain("policy");
    }

    firstAbort.abort();
    secondAbort.abort();
    await Promise.all([firstReader.closed, secondReader.closed]);
    await runInDurableObject(authority(), async (instance) => {
      expect((instance as unknown as { subscribers: Set<unknown> }).subscribers.size).toBe(0);
    });
  });

  it("caps streams before allocation and reuses a slot after disconnect", async () => {
    const events = new DurableObjectFeaturePolicyEvents(env.FEATURE_POLICY);
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
    await Promise.all(streams.slice(1).map((stream) => stream.body!.cancel()));
    await runInDurableObject(authority(), async (instance) => {
      expect((instance as unknown as { subscribers: Set<unknown> }).subscribers.size).toBe(0);
    });
  });

  it("atomically bounds opaque admin login windows", async () => {
    const hash = "ab".repeat(32);
    const policy = store();
    const results = await Promise.all([
      policy.consumeAdminLoginAttempt(hash, 2, 60_000),
      policy.consumeAdminLoginAttempt(hash, 2, 60_000),
      policy.consumeAdminLoginAttempt(hash, 2, 60_000),
    ]);
    expect(results.filter(({ allowed }) => allowed)).toHaveLength(2);
    expect(results.filter(({ allowed }) => !allowed)).toEqual([
      { allowed: false, retryAfterSeconds: expect.any(Number) },
    ]);
    await runInDurableObject(authority(), async (instance) => {
      await expect(instance.consumeAdminLoginAttempt("192.0.2.1", 2, 60_000)).rejects.toThrow(/bucket hash/);
    });

    await runInDurableObject(authority(), async (_instance, state) => {
      const rows = state.storage.sql.exec<{ bucket_hash: string; attempt_count: number }>(
        "SELECT bucket_hash, attempt_count FROM admin_login_windows",
      ).toArray();
      expect(rows).toEqual([{ bucket_hash: hash, attempt_count: 2 }]);
      expect(JSON.stringify(rows)).not.toContain("192.0.2.1");
    });
  });
});
