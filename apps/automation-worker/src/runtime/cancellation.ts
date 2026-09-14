import { CancellationError, type CancellationReason } from "./errors";

export class CancellationToken {
  private readonly controller = new AbortController();
  private cancellation?: CancellationError;
  private readonly timer?: ReturnType<typeof setTimeout>;

  constructor(
    deadlineAt: number,
    externalSignal?: AbortSignal,
    now: () => number = Date.now,
  ) {
    const delay = deadlineAt - now();
    if (delay <= 0) this.cancel("deadline");
    else this.timer = setTimeout(() => this.cancel("deadline"), delay);
    externalSignal?.addEventListener("abort", () => this.cancel("shutdown"), {
      once: true,
    });
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get reason(): CancellationReason | undefined {
    return this.cancellation?.reason;
  }

  cancel(reason: CancellationReason): void {
    if (this.cancellation) return;
    this.cancellation = new CancellationError(reason);
    if (this.timer) clearTimeout(this.timer);
    this.controller.abort(this.cancellation);
  }

  throwIfCancelled(): void {
    if (this.cancellation) throw this.cancellation;
  }

  async sleep(milliseconds: number): Promise<void> {
    this.throwIfCancelled();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, milliseconds);
      this.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(this.cancellation ?? new CancellationError("shutdown"));
        },
        { once: true },
      );
    });
    this.throwIfCancelled();
  }
}
