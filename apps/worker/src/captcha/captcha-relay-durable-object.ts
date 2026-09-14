import { DurableObject } from "cloudflare:workers";
import type { CaptchaRelayWaitResult } from "./captcha-relay";

type RelayRow = {
  answer: string | null;
  expires_at: number;
  status: string;
};

export class CaptchaRelayDurableObject extends DurableObject<Env> {
  private readonly waiters = new Set<(result: CaptchaRelayWaitResult) => void>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS relay (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        status TEXT NOT NULL,
        answer TEXT,
        expires_at INTEGER NOT NULL
      )
    `);
  }

  async prepare(expiresAt: number): Promise<boolean> {
    if (this.row()) return false;
    this.ctx.storage.sql.exec(
      "INSERT INTO relay (singleton, status, answer, expires_at) VALUES (1, 'pending', NULL, ?)",
      expiresAt,
    );
    await this.ctx.storage.setAlarm(expiresAt);
    return true;
  }

  async wait(): Promise<CaptchaRelayWaitResult> {
    const row = this.row();
    if (!row) return { kind: "not_found" };
    if (row.expires_at <= Date.now()) return this.finish({ kind: "timeout" });
    if (row.status === "answered" && row.answer !== null) return this.finish({ kind: "answer", answer: row.answer });
    if (row.status === "cancelled") return this.finish({ kind: "cancelled" });
    if (row.status !== "pending") return this.finish({ kind: "not_found" });

    const result = await new Promise<CaptchaRelayWaitResult>((resolve) => this.waiters.add(resolve));
    await this.cleanup();
    return result;
  }

  async answer(answer: string): Promise<boolean> {
    const row = this.row();
    if (!row || row.status !== "pending" || row.expires_at <= Date.now()) return false;
    this.ctx.storage.sql.exec("UPDATE relay SET status = 'answered', answer = ? WHERE singleton = 1", answer);
    this.resolveWaiters({ kind: "answer", answer });
    return true;
  }

  async cancel(): Promise<boolean> {
    const row = this.row();
    if (!row || row.status !== "pending") return false;
    this.ctx.storage.sql.exec("UPDATE relay SET status = 'cancelled', answer = NULL WHERE singleton = 1");
    this.resolveWaiters({ kind: "cancelled" });
    await this.cleanup();
    return true;
  }

  async alarm(): Promise<void> {
    if (this.row()) this.resolveWaiters({ kind: "timeout" });
    await this.cleanup();
  }

  private row(): RelayRow | undefined {
    return this.ctx.storage.sql.exec<RelayRow>(
      "SELECT status, answer, expires_at FROM relay WHERE singleton = 1",
    ).toArray()[0];
  }

  private async finish(result: CaptchaRelayWaitResult): Promise<CaptchaRelayWaitResult> {
    await this.cleanup();
    return result;
  }

  private resolveWaiters(result: CaptchaRelayWaitResult): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const resolve of waiters) resolve(result);
  }

  private async cleanup(): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM relay");
    await this.ctx.storage.deleteAlarm();
  }
}
