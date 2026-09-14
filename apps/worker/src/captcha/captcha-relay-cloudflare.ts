import { HyeboardError } from "@hyeboard/core";
import {
  CAPTCHA_RELAY_TIMEOUT_MS,
  captchaRelayCancelled,
  captchaRelayNotFound,
  captchaRelayTimeout,
  type CaptchaRelayCoordinator,
  type CaptchaRelayWaitResult,
  type PreparedCaptchaRelay,
} from "./captcha-relay";
import type { CaptchaRelayDurableObject } from "./captcha-relay-durable-object";

export type CaptchaRelayRpcStub = Pick<CaptchaRelayDurableObject, "answer" | "cancel" | "prepare" | "wait">;
export type CaptchaRelayNamespace = { getByName(name: string): CaptchaRelayRpcStub };

export class DurableObjectCaptchaRelayCoordinator implements CaptchaRelayCoordinator {
  constructor(namespace: Env["CAPTCHA_RELAY"], createId?: () => string, timeoutMs?: number);
  constructor(namespace: CaptchaRelayNamespace, createId?: () => string, timeoutMs?: number);
  constructor(
    private readonly namespace: CaptchaRelayNamespace,
    private readonly createId: () => string = () => crypto.randomUUID(),
    private readonly timeoutMs = CAPTCHA_RELAY_TIMEOUT_MS,
  ) {}

  async prepare(image: string): Promise<PreparedCaptchaRelay> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const challengeId = this.createId();
      const stub = this.namespace.getByName(challengeId);
      if (!(await stub.prepare(Date.now() + this.timeoutMs))) continue;
      return {
        challengeId,
        image,
        wait: (signal) => this.wait(stub, signal),
        cancel: async () => { await stub.cancel(); },
      };
    }
    throw new HyeboardError("STUDENTHUB_CAPTCHA_RELAY_FAILED", "Could not create a verification code request.", 500);
  }

  async answer(challengeId: string, answer: string): Promise<void> {
    const accepted = await this.namespace.getByName(challengeId).answer(answer);
    if (!accepted) throw captchaRelayNotFound();
  }

  private async wait(
    stub: CaptchaRelayRpcStub,
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted) {
      await stub.cancel();
      throw captchaRelayCancelled();
    }

    let onAbort: (() => void) | undefined;
    const aborted = signal
      ? new Promise<never>((_, reject) => {
          onAbort = () => {
            void stub.cancel().catch(() => undefined);
            reject(captchaRelayCancelled());
          };
          signal.addEventListener("abort", onAbort, { once: true });
        })
      : undefined;

    try {
      const result = await (aborted ? Promise.race([stub.wait(), aborted]) : stub.wait());
      return this.unwrap(result);
    } finally {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  private unwrap(result: CaptchaRelayWaitResult): string {
    if (result.kind === "answer") return result.answer;
    if (result.kind === "timeout") throw captchaRelayTimeout();
    if (result.kind === "cancelled") throw captchaRelayCancelled();
    throw captchaRelayNotFound();
  }
}
