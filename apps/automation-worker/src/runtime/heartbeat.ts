import { LeaseLostError } from "./errors";
import type { JobLease } from "../transport/lease";

export class JobHeartbeat {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly lease: JobLease,
    private readonly intervalMs: number,
    private readonly onHeartbeat: () => Promise<void>,
    private readonly onLeaseLost: () => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, this.intervalMs);
  }

  async tick(): Promise<void> {
    if (!this.running) return;
    if (!(await this.lease.renew())) {
      this.onLeaseLost();
      throw new LeaseLostError();
    }
    await this.onHeartbeat();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
