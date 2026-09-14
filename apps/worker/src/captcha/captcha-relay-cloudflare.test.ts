import { describe, expect, it, vi } from "vitest";
import type { CaptchaRelayWaitResult } from "./captcha-relay";
import { DurableObjectCaptchaRelayCoordinator, type CaptchaRelayNamespace } from "./captcha-relay-cloudflare";

class FakeRelayStub {
  private prepared = false;
  private waiter: ((result: CaptchaRelayWaitResult) => void) | undefined;

  async prepare(): Promise<boolean> {
    if (this.prepared) return false;
    this.prepared = true;
    return true;
  }

  wait(): Promise<CaptchaRelayWaitResult> {
    return new Promise((resolve) => { this.waiter = resolve; });
  }

  async answer(answer: string): Promise<boolean> {
    if (!this.prepared) return false;
    this.waiter?.({ kind: "answer", answer });
    return true;
  }

  async cancel(): Promise<boolean> {
    this.waiter?.({ kind: "cancelled" });
    return this.prepared;
  }
}

describe("DurableObjectCaptchaRelayCoordinator", () => {
  it("routes separate coordinator callers to the same relay binding instance", async () => {
    const stubs = new Map<string, FakeRelayStub>();
    const getByName = vi.fn((name: string) => {
      const stub = stubs.get(name) ?? new FakeRelayStub();
      stubs.set(name, stub);
      return stub;
    });
    const namespace: CaptchaRelayNamespace = { getByName };
    const producer = new DurableObjectCaptchaRelayCoordinator(namespace, () => "HYEB_RELAY_ID_SENTINEL");
    const answerer = new DurableObjectCaptchaRelayCoordinator(namespace);

    const relay = await producer.prepare("data:image/png;base64,QQ==");
    const answerPromise = relay.wait();
    await answerer.answer(relay.challengeId, "ANSWER_SENTINEL");

    await expect(answerPromise).resolves.toBe("ANSWER_SENTINEL");
    expect(getByName).toHaveBeenCalledWith("HYEB_RELAY_ID_SENTINEL");
    expect(new Set(getByName.mock.results.map((result) => result.value)).size).toBe(1);
  });
});
