import { describe, expect, it } from "vitest";
import {
  decryptEnvelope,
  encryptEnvelope,
  type AutomationEvent,
  type AutomationKeyring,
  type UetImportJob,
} from "../../../../../packages/automation-protocol/src/index";
import { createDistributedAutomationBackend, type AutomationRedisClient } from "./backend";

const SECRET = "automation-api-secret-sentinel";
const KEY_BYTES = new Uint8Array(32).fill(7);
const KEYRING: AutomationKeyring = { current: { id: "current", material: KEY_BYTES } };
const KEY_B64 = Buffer.from(KEY_BYTES).toString("base64");

type Entry = { id: string; fields: Record<string, string> };

class FakeRedis implements AutomationRedisClient {
  readonly values = new Map<string, string>();
  readonly streams = new Map<string, Entry[]>();
  readonly keysSeen: string[] = [];
  private sequence = 0;
  onAdd?: (stream: string, fields: Record<string, string>) => Promise<void>;

  async set(key: string, value: string, options?: { PX?: number; NX?: boolean; XX?: boolean }): Promise<unknown> {
    this.keysSeen.push(key);
    if (options?.NX && this.values.has(key)) return null;
    if (options?.XX && !this.values.has(key)) return null;
    this.values.set(key, value);
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    this.keysSeen.push(key);
    return this.values.get(key) ?? null;
  }

  async del(key: string): Promise<number> {
    this.values.delete(key);
    return 1;
  }

  async eval(_script: string, options: { keys: string[]; arguments: string[] }): Promise<number> {
    const [key] = options.keys;
    const [expected, next] = options.arguments;
    if (this.values.get(key) !== expected) return 0;
    this.values.set(key, next);
    return 1;
  }

  async xAdd(stream: string, _id: string, fields: Record<string, string>): Promise<string> {
    const id = `${++this.sequence}-0`;
    const entries = this.streams.get(stream) ?? [];
    entries.push({ id, fields: { ...fields } });
    this.streams.set(stream, entries);
    await this.onAdd?.(stream, fields);
    return id;
  }

  async xRead(streams: Array<{ key: string; id: string }>): Promise<unknown> {
    const request = streams[0];
    const entries = this.streams.get(request.key) ?? [];
    const after = Number(request.id.split("-")[0]);
    const messages = entries.filter((entry) => Number(entry.id.split("-")[0]) > after).slice(0, 100);
    if (messages.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return [];
    }
    return [{ name: request.key, messages: messages.map((entry) => ({ id: entry.id, message: entry.fields })) }];
  }
}

function environment(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    AUTOMATION_KEY_CURRENT_ID: KEYRING.current.id,
    AUTOMATION_KEY_CURRENT_B64: KEY_B64,
    AUTOMATION_EXECUTOR_READY: "true",
    AUTOMATION_EVENT_BLOCK_MS: "1",
    AUTOMATION_DEADLINE_MS: "5000",
    ...overrides,
  };
}

async function eventEnvelope(job: UetImportJob, event: AutomationEvent, result?: unknown): Promise<string> {
  const payload = event.type === "succeeded" && result !== undefined
    ? { ...event, resultEnvelope: await encryptEnvelope(result, { keyring: KEYRING, aad: `hyeboard:automation:result:${job.jobId}`, issuedAt: event.emittedAt, expiresAt: job.expiresAt }) }
    : event;
  return encryptEnvelope(payload, {
    keyring: KEYRING,
    aad: `hyeboard:automation:event:${job.jobId}`,
    issuedAt: event.emittedAt,
    expiresAt: event.expiresAt,
  });
}

function baseEvent(job: UetImportJob, sequence: number, type: AutomationEvent["type"]): AutomationEvent {
  const emittedAt = new Date().toISOString();
  return { version: 1, type, jobId: job.jobId, accountId: job.accountId, fence: job.fence, sequence, emittedAt, expiresAt: job.expiresAt } as AutomationEvent;
}

function result(job: UetImportJob): unknown {
  return {
    universityId: "uet",
    studentCode: "STUDENT_SENTINEL",
    expiresAt: job.expiresAt,
    session: {
      version: 1,
      universityId: "uet",
      studentCode: "STUDENT_SENTINEL",
      expiresAt: job.expiresAt,
      uetGoogleCredential: { email: "student@vnu.edu.vn", password: "PRIVATE-PASSWORD" },
      studenthub: { kind: "bearer", value: "PRIVATE-TOKEN", expiresAt: job.expiresAt },
    },
  };
}

describe("RedisDistributedAutomationBackend", () => {
  it("enqueues encrypted credentials, validates events, and decrypts a valid result", async () => {
    const redis = new FakeRedis();
    let job!: UetImportJob;
    redis.onAdd = async (stream, fields) => {
      if (stream !== "hyeboard:automation:jobs") return;
      job = await decryptEnvelope<UetImportJob>(fields.jobEnvelope, { keyring: KEYRING, aad: "hyeboard:automation:job:v1" });
      const started = baseEvent(job, 0, "started");
      const progress = { ...baseEvent(job, 1, "progress"), phase: "login" as const, percent: 50 };
      const succeeded = baseEvent(job, 2, "succeeded");
      for (const event of [started, progress, succeeded]) {
        await redis.xAdd("hyeboard:automation:events", "*", { jobId: job.jobId, eventEnvelope: await eventEnvelope(job, event, event === succeeded ? result(job) : undefined) });
      }
    };
    const backend = createDistributedAutomationBackend(redis, SECRET, environment());
    const seen: string[] = [];
    const imported = await backend.importUetGoogle({ email: "student@vnu.edu.vn", password: "PRIVATE-PASSWORD", idempotencyKey: "request-1" }, {
      onEvent: (event) => { seen.push(event.type); },
    });

    expect(seen).toEqual(["started", "progress", "succeeded"]);
    expect(imported.studentCode).toBe("STUDENT_SENTINEL");
    expect(JSON.stringify(redis.streams)).not.toContain("PRIVATE-PASSWORD");
    expect(JSON.stringify(redis.streams)).not.toContain("PRIVATE-TOKEN");
    expect(redis.keysSeen.every((key) => !key.includes("student@vnu.edu.vn"))).toBe(true);
  });

  it("replays from a cursor and deduplicates the idempotent job", async () => {
    const redis = new FakeRedis();
    let job!: UetImportJob;
    redis.onAdd = async (stream, fields) => {
      if (stream !== "hyeboard:automation:jobs") return;
      job = await decryptEnvelope<UetImportJob>(fields.jobEnvelope, { keyring: KEYRING, aad: "hyeboard:automation:job:v1" });
      for (const event of [baseEvent(job, 0, "started"), { ...baseEvent(job, 1, "progress"), phase: "login" as const, percent: 50 }, baseEvent(job, 2, "succeeded")]) {
        await redis.xAdd("hyeboard:automation:events", "*", { jobId: job.jobId, eventEnvelope: await eventEnvelope(job, event, event.type === "succeeded" ? result(job) : undefined) });
      }
    };
    const backend = createDistributedAutomationBackend(redis, SECRET, environment());
    await backend.importUetGoogle({ email: "student@vnu.edu.vn", password: "password", idempotencyKey: "same-request" }, {});
    const replayed: number[] = [];
    await backend.importUetGoogle({ email: "student@vnu.edu.vn", password: "different-but-idempotent", idempotencyKey: "same-request" }, { cursor: 1, onEvent: (event) => { replayed.push(event.sequence); } });
    expect(replayed).toEqual([2]);
    expect(redis.streams.get("hyeboard:automation:jobs")).toHaveLength(1);
  });

  it("requires signed challenge ownership and publishes encrypted answer/cancel controls", async () => {
    const redis = new FakeRedis();
    let job!: UetImportJob;
    let challengeToken = "";
    let jobToken = "";
    let resolveChallengeToken!: () => void;
    const challengeTokenReady = new Promise<void>((resolve) => { resolveChallengeToken = resolve; });
    redis.onAdd = async (stream, fields) => {
      if (stream === "hyeboard:automation:jobs") {
        job = await decryptEnvelope<UetImportJob>(fields.jobEnvelope, { keyring: KEYRING, aad: "hyeboard:automation:job:v1" });
        const challenge = { ...baseEvent(job, 1, "challenge-required"), challengeId: ("A".repeat(22)) as AutomationEvent["challengeId"], image: "data:image/png;base64:PRIVATE-IMAGE" } as AutomationEvent;
        await redis.xAdd("hyeboard:automation:events", "*", { jobId: job.jobId, eventEnvelope: await eventEnvelope(job, { ...baseEvent(job, 0, "started") }) });
        await redis.xAdd("hyeboard:automation:events", "*", { jobId: job.jobId, eventEnvelope: await eventEnvelope(job, challenge) });
      }
    };
    const backend = createDistributedAutomationBackend(redis, SECRET, environment());
    const pending = backend.importUetGoogle({ email: "student@vnu.edu.vn", password: "password", idempotencyKey: "captcha-request" }, {
      onJob: (token) => { jobToken = token; },
      onEvent: (event) => {
        if (event.type === "challenge-required") {
          challengeToken = backend.createChallengeToken(event, jobToken);
          resolveChallengeToken();
        }
      },
    });
    const pendingRejection = expect(pending).rejects.toMatchObject({ code: "GOOGLE_AUTOMATION_TIMEOUT" });
    await challengeTokenReady;
    await expect(backend.answerCaptcha(`${challengeToken}forged`, "answer")).rejects.toMatchObject({ code: "STUDENTHUB_CAPTCHA_CHALLENGE_NOT_FOUND" });
    await backend.answerCaptcha(challengeToken, "ANSWER");
    await backend.cancelAutomation(jobToken);
    await pendingRejection;
    const controlText = JSON.stringify(redis.streams.get("hyeboard:automation:control"));
    expect(controlText).not.toContain("ANSWER");
    expect(controlText).not.toContain("PRIVATE-IMAGE");
  });
});
