import { env } from "cloudflare:workers";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { CaptchaRelayDurableObject } from "../src/captcha-relay-durable-object";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    CAPTCHA_RELAY: Env["CAPTCHA_RELAY"];
  }
}

afterEach(() => reset());

function relay(name: string) {
  return env.CAPTCHA_RELAY.getByName(name);
}

async function storedRows(stub: ReturnType<typeof relay>): Promise<number> {
  return runInDurableObject(stub, async (_instance: CaptchaRelayDurableObject, state) => {
    return state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM relay").one().count;
  });
}

describe("CaptchaRelayDurableObject", () => {
  it("persists prepare before returning and resolves answer-before-wait across separate stubs", async () => {
    const producer = relay("persisted-answer");
    const answerer = relay("persisted-answer");

    await expect(producer.prepare(Date.now() + 60_000)).resolves.toBe(true);
    await expect(storedRows(producer)).resolves.toBe(1);
    await expect(answerer.answer("ANSWER_SENTINEL")).resolves.toBe(true);
    await expect(producer.wait()).resolves.toEqual({ kind: "answer", answer: "ANSWER_SENTINEL" });
    await expect(runDurableObjectAlarm(producer)).resolves.toBe(false);
    await expect(storedRows(producer)).resolves.toBe(0);
  });

  it("cleans an unconsumed answer when its expiry alarm runs", async () => {
    const stub = relay("unconsumed-answer");
    await stub.prepare(Date.now() + 60_000);

    await expect(stub.answer("ANSWER_SENTINEL")).resolves.toBe(true);
    await expect(storedRows(stub)).resolves.toBe(1);
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    await expect(storedRows(stub)).resolves.toBe(0);
    await expect(stub.wait()).resolves.toEqual({ kind: "not_found" });
    await expect(stub.answer("LATE_ANSWER")).resolves.toBe(false);
  });

  it("returns not-found semantics for duplicate and late calls after an answer", async () => {
    const stub = relay("duplicate-answer");
    await stub.prepare(Date.now() + 60_000);

    await expect(stub.answer("FIRST_ANSWER")).resolves.toBe(true);
    await expect(stub.answer("DUPLICATE_ANSWER")).resolves.toBe(false);
    await expect(stub.wait()).resolves.toEqual({ kind: "answer", answer: "FIRST_ANSWER" });
    await expect(stub.wait()).resolves.toEqual({ kind: "not_found" });
    await expect(stub.answer("LATE_ANSWER")).resolves.toBe(false);
    await expect(stub.cancel()).resolves.toBe(false);
  });

  it("resolves cancellation and preserves the SQLite schema for late calls", async () => {
    const stub = relay("cancelled");
    await stub.prepare(Date.now() + 60_000);
    const waiting = stub.wait();

    await expect(stub.cancel()).resolves.toBe(true);
    await expect(waiting).resolves.toEqual({ kind: "cancelled" });
    await expect(storedRows(stub)).resolves.toBe(0);
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(false);
    await expect(stub.cancel()).resolves.toBe(false);
    await expect(stub.wait()).resolves.toEqual({ kind: "not_found" });
    await expect(stub.answer("LATE_ANSWER")).resolves.toBe(false);
  });

  it("resolves an alarm timeout and keeps late calls non-throwing", async () => {
    const stub = relay("timed-out");
    await stub.prepare(Date.now() + 60_000);
    const waiting = stub.wait();

    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    await expect(waiting).resolves.toEqual({ kind: "timeout" });
    await expect(stub.wait()).resolves.toEqual({ kind: "not_found" });
    await expect(stub.answer("LATE_ANSWER")).resolves.toBe(false);
    await expect(stub.cancel()).resolves.toBe(false);
    await expect(storedRows(stub)).resolves.toBe(0);
  });
});
