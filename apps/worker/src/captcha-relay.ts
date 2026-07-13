import { HyeboardError } from "@hyeboard/core";

export const CAPTCHA_RELAY_TIMEOUT_MS = 2 * 60_000;

export type CaptchaRelayWaitResult =
  | { kind: "answer"; answer: string }
  | { kind: "cancelled" }
  | { kind: "not_found" }
  | { kind: "timeout" };

export type PreparedCaptchaRelay = {
  challengeId: string;
  image: string;
  wait(signal?: AbortSignal): Promise<string>;
  cancel(): Promise<void>;
};

export interface CaptchaRelayCoordinator {
  prepare(image: string): Promise<PreparedCaptchaRelay>;
  answer(challengeId: string, answer: string): Promise<void>;
}

export function captchaRelayNotFound(): HyeboardError {
  return new HyeboardError("STUDENTHUB_CAPTCHA_CHALLENGE_NOT_FOUND", "This verification code request has expired or already been answered.", 404);
}

export function captchaRelayTimeout(): HyeboardError {
  return new HyeboardError("STUDENTHUB_CAPTCHA_TIMEOUT", "No verification code was entered in time. Try signing in again.", 408);
}

export function captchaRelayCancelled(): HyeboardError {
  return new HyeboardError("STUDENTHUB_CAPTCHA_CANCELLED", "Verification code request cancelled.", 499);
}

type LocalWaiter = {
  resolve: (answer: string) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

type LocalRelay = {
  status: "answered" | "pending";
  answer?: string;
  timeoutId: ReturnType<typeof setTimeout>;
  waiters: Set<LocalWaiter>;
};

export class LocalCaptchaRelayCoordinator implements CaptchaRelayCoordinator {
  private readonly relays = new Map<string, LocalRelay>();

  constructor(
    private readonly createId: () => string = () => crypto.randomUUID(),
    private readonly timeoutMs = CAPTCHA_RELAY_TIMEOUT_MS,
  ) {}

  async prepare(image: string): Promise<PreparedCaptchaRelay> {
    let challengeId = this.createId();
    while (this.relays.has(challengeId)) challengeId = this.createId();

    const relay: LocalRelay = {
      status: "pending",
      waiters: new Set(),
      timeoutId: setTimeout(() => this.reject(challengeId, captchaRelayTimeout()), this.timeoutMs),
    };
    this.relays.set(challengeId, relay);

    return {
      challengeId,
      image,
      wait: (signal) => this.wait(challengeId, signal),
      cancel: () => this.cancel(challengeId),
    };
  }

  async answer(challengeId: string, answer: string): Promise<void> {
    const relay = this.relays.get(challengeId);
    if (!relay || relay.status !== "pending") throw captchaRelayNotFound();
    if (relay.waiters.size === 0) {
      relay.status = "answered";
      relay.answer = answer;
      return;
    }
    this.resolve(challengeId, answer);
  }

  private wait(challengeId: string, signal?: AbortSignal): Promise<string> {
    const relay = this.relays.get(challengeId);
    if (!relay) return Promise.reject(captchaRelayNotFound());
    if (relay.status === "answered") {
      const answer = relay.answer!;
      this.clear(challengeId, relay);
      return Promise.resolve(answer);
    }
    if (signal?.aborted) {
      void this.cancel(challengeId);
      return Promise.reject(captchaRelayCancelled());
    }

    return new Promise<string>((resolve, reject) => {
      const waiter: LocalWaiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => void this.cancel(challengeId);
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      relay.waiters.add(waiter);
    });
  }

  private async cancel(challengeId: string): Promise<void> {
    const relay = this.relays.get(challengeId);
    if (!relay) return;
    this.reject(challengeId, captchaRelayCancelled());
  }

  private resolve(challengeId: string, answer: string): void {
    const relay = this.relays.get(challengeId);
    if (!relay) return;
    this.clear(challengeId, relay);
    for (const waiter of relay.waiters) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(answer);
    }
  }

  private reject(challengeId: string, error: Error): void {
    const relay = this.relays.get(challengeId);
    if (!relay) return;
    this.clear(challengeId, relay);
    for (const waiter of relay.waiters) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(error);
    }
  }

  private clear(challengeId: string, relay: LocalRelay): void {
    this.relays.delete(challengeId);
    clearTimeout(relay.timeoutId);
  }
}
