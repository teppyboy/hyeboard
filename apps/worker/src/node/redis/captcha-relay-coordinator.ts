import { randomBytes } from "node:crypto";
import { HyeboardError } from "@hyeboard/core";
import {
  CAPTCHA_RELAY_TIMEOUT_MS,
  captchaRelayCancelled,
  captchaRelayNotFound,
  captchaRelayTimeout,
  type CaptchaRelayCoordinator,
  type PreparedCaptchaRelay,
} from "../../captcha/captcha-relay";
import type { RedisBlockingClient, RedisCommandClient } from "./client";
import { captchaRelayKey, captchaRelaySignalKey } from "./keys";
import { captchaTerminalScript } from "./scripts";

type RelayState = {
  status: "pending" | "answered" | "cancelled";
  answer?: string;
  expiresAt: number;
};
export type RedisCaptchaRelayCoordinatorOptions = {
  client: RedisCommandClient;
  blocking: RedisBlockingClient;
  createId?: () => string;
  timeoutMs?: number;
};

export class RedisCaptchaRelayCoordinator implements CaptchaRelayCoordinator {
  private readonly blocking: RedisBlockingClient;
  private readonly createId: () => string;
  private readonly timeoutMs: number;
  constructor(private readonly options: RedisCaptchaRelayCoordinatorOptions) {
    if (
      !Number.isSafeInteger(options.timeoutMs ?? CAPTCHA_RELAY_TIMEOUT_MS) ||
      (options.timeoutMs ?? CAPTCHA_RELAY_TIMEOUT_MS) <= 0
    ) {
      throw new Error("Redis CAPTCHA relay timeout must be positive");
    }
    this.blocking = options.blocking;
    this.createId = options.createId ?? (() => randomBytes(16).toString("hex"));
    this.timeoutMs = options.timeoutMs ?? CAPTCHA_RELAY_TIMEOUT_MS;
  }

  async prepare(image: string): Promise<PreparedCaptchaRelay> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const challengeId = this.createId();
      const expiresAt = Date.now() + this.timeoutMs;
      const accepted = await this.options.client.set(
        captchaRelayKey(challengeId),
        JSON.stringify({ status: "pending", expiresAt }),
        { expiration: { type: "PX", value: this.timeoutMs }, condition: "NX" },
      );
      if (accepted !== "OK") continue;
      return {
        challengeId,
        image,
        wait: (signal) => this.wait(challengeId, signal),
        cancel: () => this.cancel(challengeId),
      };
    }
    throw new HyeboardError(
      "STUDENTHUB_CAPTCHA_RELAY_FAILED",
      "Could not create a verification code request.",
      500,
    );
  }

  async answer(challengeId: string, answer: string): Promise<void> {
    const accepted = await this.terminal(challengeId, "answered", answer);
    if (!accepted) throw captchaRelayNotFound();
  }

  private async cancel(challengeId: string): Promise<void> {
    await this.terminal(challengeId, "cancelled", "");
  }

  private async terminal(
    challengeId: string,
    status: "answered" | "cancelled",
    answer: string,
  ): Promise<boolean> {
    const result = await this.options.client.eval(captchaTerminalScript, {
      keys: [captchaRelayKey(challengeId), captchaRelaySignalKey(challengeId)],
      arguments: [status, String(Date.now()), answer],
    });
    return Number(result) === 1;
  }

  private async wait(
    challengeId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const key = captchaRelayKey(challengeId);
    const signalKey = captchaRelaySignalKey(challengeId);
    if (signal?.aborted) {
      await this.cancel(challengeId).catch(() => undefined);
      await this.cleanup(key, signalKey).catch(() => undefined);
      throw captchaRelayCancelled();
    }
    const deadline = Date.now() + this.timeoutMs;
    let onAbort: (() => void) | undefined;
    let wasAborted = false;
    const abortPromise = signal
      ? new Promise<never>((_, reject) => {
          onAbort = () => {
            wasAborted = true;
            void this.cancel(challengeId).catch(() => undefined);
            reject(captchaRelayCancelled());
          };
          signal.addEventListener("abort", onAbort, { once: true });
        })
      : undefined;
    try {
      for (;;) {
        const state = await this.read(key);
        if (!state) throw captchaRelayNotFound();
        if (state.status === "answered") {
          await this.cleanup(key, signalKey);
          return state.answer ?? "";
        }
        if (state.status === "cancelled") {
          await this.cleanup(key, signalKey);
          throw captchaRelayCancelled();
        }
        const remaining = state.expiresAt - Date.now();
        if (remaining <= 0) {
          await this.cleanup(key, signalKey);
          throw captchaRelayTimeout();
        }
        // Poll at one-second intervals so an aborted waiter does not pin the shared blocking connection.
        const blocked = this.blocking.blPop(signalKey, 1);
        const notification = await (abortPromise
          ? Promise.race([blocked, abortPromise])
          : blocked);
        const after = await this.read(key);
        if (!after) {
          if (notification && notification.element === "cancelled")
            throw captchaRelayCancelled();
          if (Date.now() >= deadline || state.expiresAt <= Date.now())
            throw captchaRelayTimeout();
          throw captchaRelayNotFound();
        }
        if (after.status === "answered") {
          await this.cleanup(key, signalKey);
          return after.answer ?? "";
        }
        if (after.status === "cancelled") {
          await this.cleanup(key, signalKey);
          throw captchaRelayCancelled();
        }
        if (Date.now() >= deadline || after.expiresAt <= Date.now()) {
          await this.cleanup(key, signalKey);
          throw captchaRelayTimeout();
        }
      }
    } finally {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      if (wasAborted) await this.cleanup(key, signalKey).catch(() => undefined);
    }
  }

  private async read(key: string): Promise<RelayState | undefined> {
    const raw = await this.options.client.get(key);
    if (!raw) return undefined;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid Redis CAPTCHA relay state");
    const state = value as Record<string, unknown>;
    if (
      Object.keys(state).some(
        (keyName) =>
          keyName !== "status" &&
          keyName !== "answer" &&
          keyName !== "expiresAt",
      ) ||
      (state.status !== "pending" &&
        state.status !== "answered" &&
        state.status !== "cancelled") ||
      (state.answer !== undefined && typeof state.answer !== "string") ||
      !Number.isSafeInteger(state.expiresAt) ||
      (state.expiresAt as number) <= 0 ||
      (state.status === "answered" && state.answer === undefined) ||
      (state.status !== "answered" && state.answer !== undefined)
    ) {
      throw new Error("Invalid Redis CAPTCHA relay state");
    }
    return state as RelayState;
  }

  private async cleanup(key: string, signalKey: string): Promise<void> {
    await this.options.client.del(key);
    await this.options.client.del(signalKey);
  }

  async close(): Promise<void> {
    /* Clients are owned by the caller. */
  }
}
