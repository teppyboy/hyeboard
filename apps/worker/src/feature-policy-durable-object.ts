import { HyeboardError } from "@hyeboard/core";
import {
  adminActorSchema,
  featurePolicyAuditEntrySchema,
  featurePolicySnapshotSchema,
  publishFeaturePolicySchema,
  type FeaturePolicyAuditEntry,
  type FeaturePolicySnapshot,
} from "@hyeboard/schemas";
import { DurableObject } from "cloudflare:workers";
import { emptyPolicy } from "./feature-policy";
import {
  featurePolicyStreamLimited,
  MAX_FEATURE_POLICY_SSE_SUBSCRIBERS,
  type HistoryInput,
  type HistoryPage,
  type PublishFeaturePolicyInput,
} from "./feature-policy-store";

const MAX_HISTORY_LIMIT = 100;
const MAX_LOGIN_WINDOW_BUCKETS = 10_000;
const BUCKET_HASH_PATTERN = /^[0-9a-f]{64}$/;
const publicationSchema = publishFeaturePolicySchema.extend({ actor: adminActorSchema });

type CurrentRow = { revision: number; snapshot_json: string };
type HistoryRow = {
  revision: number;
  base_revision: number;
  actor_json: string;
  reason: string;
  published_at: string;
  snapshot_json: string;
};
type LoginWindowRow = { attempt_count: number; reset_at: number };
type Subscriber = {
  controller: ReadableStreamDefaultController<Uint8Array>;
  heartbeat: ReturnType<typeof setInterval>;
  id?: string;
  seen: number;
};

export type AdminLoginAttemptResult = { allowed: boolean; retryAfterSeconds?: number };

export class FeaturePolicyDurableObject extends DurableObject<Env> {
  private readonly subscribers = new Set<Subscriber>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS feature_policy_current (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          revision INTEGER NOT NULL,
          snapshot_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS feature_policy_history (
          revision INTEGER PRIMARY KEY,
          base_revision INTEGER NOT NULL,
          actor_json TEXT NOT NULL,
          reason TEXT NOT NULL,
          published_at TEXT NOT NULL,
          snapshot_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS admin_login_windows (
          bucket_hash TEXT PRIMARY KEY,
          attempt_count INTEGER NOT NULL,
          reset_at INTEGER NOT NULL
        );
        CREATE TRIGGER IF NOT EXISTS feature_policy_history_immutable_update
          BEFORE UPDATE ON feature_policy_history BEGIN SELECT RAISE(ABORT, 'feature policy history is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS feature_policy_history_immutable_delete
          BEFORE DELETE ON feature_policy_history BEGIN SELECT RAISE(ABORT, 'feature policy history is immutable'); END;
      `);
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO feature_policy_current (singleton, revision, snapshot_json) VALUES (1, 0, ?)",
        JSON.stringify({ ...emptyPolicy(), revision: 0 }),
      );
    });
  }

  current(): FeaturePolicySnapshot {
    const row = this.ctx.storage.sql.exec<CurrentRow>(
      "SELECT revision, snapshot_json FROM feature_policy_current WHERE singleton = 1",
    ).one();
    const snapshot = featurePolicySnapshotSchema.parse(JSON.parse(row.snapshot_json));
    if (snapshot.revision !== row.revision) throw new Error("Invalid Durable Object feature policy current row");
    return snapshot;
  }

  async publish(input: PublishFeaturePolicyInput): Promise<FeaturePolicyAuditEntry> {
    const parsed = publicationSchema.parse(input);
    return this.ctx.storage.transactionSync(() => {
      const current = this.current();
      if (current.revision !== parsed.baseRevision) {
        throw new HyeboardError(
          "ADMIN_POLICY_CONFLICT",
          "Feature policy changed before publication.",
          409,
          { currentRevision: current.revision },
        );
      }

      const revision = current.revision + 1;
      const entry = featurePolicyAuditEntrySchema.parse({
        revision,
        baseRevision: parsed.baseRevision,
        actor: parsed.actor,
        reason: parsed.reason,
        publishedAt: new Date().toISOString(),
        snapshot: { ...parsed.policy, revision },
      });
      this.ctx.storage.sql.exec(
        `INSERT INTO feature_policy_history
          (revision, base_revision, actor_json, reason, published_at, snapshot_json)
          VALUES (?, ?, ?, ?, ?, ?)`,
        entry.revision,
        entry.baseRevision,
        JSON.stringify(entry.actor),
        entry.reason,
        entry.publishedAt,
        JSON.stringify(entry.snapshot),
      );
      this.ctx.storage.sql.exec(
        "UPDATE feature_policy_current SET revision = ?, snapshot_json = ? WHERE singleton = 1 AND revision = ?",
        entry.revision,
        JSON.stringify(entry.snapshot),
        entry.baseRevision,
      );
      return entry;
    });
  }

  history(input: HistoryInput): HistoryPage {
    const { beforeRevision, limit } = parseHistoryInput(input);
    const rows = this.ctx.storage.sql.exec<HistoryRow>(
      `SELECT revision, base_revision, actor_json, reason, published_at, snapshot_json
       FROM feature_policy_history WHERE revision < ? ORDER BY revision DESC LIMIT ?`,
      beforeRevision ?? Number.MAX_SAFE_INTEGER,
      limit + 1,
    ).toArray();
    const items = rows.slice(0, limit).map(parseEntry);
    return {
      items,
      ...(rows.length > limit && items.length > 0
        ? { nextBeforeRevision: items.at(-1)!.revision }
        : {}),
    };
  }

  revision(revision: number): FeaturePolicyAuditEntry | undefined {
    if (!Number.isSafeInteger(revision) || revision <= 0) return undefined;
    const row = this.ctx.storage.sql.exec<HistoryRow>(
      `SELECT revision, base_revision, actor_json, reason, published_at, snapshot_json
       FROM feature_policy_history WHERE revision = ?`,
      revision,
    ).toArray()[0];
    return row && parseEntry(row);
  }

  async consumeAdminLoginAttempt(bucketHash: string, limit: number, windowMs: number): Promise<AdminLoginAttemptResult> {
    if (!BUCKET_HASH_PATTERN.test(bucketHash)) throw new Error("Admin login bucket hash is invalid");
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("Admin login limit is invalid");
    if (!Number.isSafeInteger(windowMs) || windowMs <= 0) throw new Error("Admin login window is invalid");

    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const resetAt = now + windowMs;
      if (!Number.isSafeInteger(resetAt)) throw new Error("Admin login window is invalid");
      this.ctx.storage.sql.exec("DELETE FROM admin_login_windows WHERE reset_at <= ?", now);
      const row = this.ctx.storage.sql.exec<LoginWindowRow>(
        "SELECT attempt_count, reset_at FROM admin_login_windows WHERE bucket_hash = ?",
        bucketHash,
      ).toArray()[0];
      if (row) {
        if (row.attempt_count >= limit) return denied(row.reset_at, now);
        this.ctx.storage.sql.exec(
          "UPDATE admin_login_windows SET attempt_count = attempt_count + 1 WHERE bucket_hash = ?",
          bucketHash,
        );
        return { allowed: true };
      }

      const count = this.ctx.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM admin_login_windows",
      ).one().count;
      if (count >= MAX_LOGIN_WINDOW_BUCKETS) {
        const earliest = this.ctx.storage.sql.exec<{ reset_at: number }>(
          "SELECT reset_at FROM admin_login_windows ORDER BY reset_at LIMIT 1",
        ).one().reset_at;
        return denied(earliest, now);
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO admin_login_windows (bucket_hash, attempt_count, reset_at) VALUES (?, 1, ?)",
        bucketHash,
        resetAt,
      );
      return { allowed: true };
    });
  }

  publishRevision(revision: number): void {
    if (!Number.isSafeInteger(revision) || revision < 0) return;
    const chunk = encode(`event: revision\ndata: ${revision}\n\n`);
    for (const subscriber of [...this.subscribers]) {
      if (revision <= subscriber.seen) continue;
      subscriber.seen = revision;
      try {
        subscriber.controller.enqueue(chunk);
      } catch {
        this.removeSubscriber(subscriber);
      }
    }
  }

  subscribe(lastRevision?: number, subscriptionId?: string, currentRevision?: number): Response {
    if (this.subscribers.size >= MAX_FEATURE_POLICY_SSE_SUBSCRIBERS) {
      const error = featurePolicyStreamLimited();
      return Response.json({ code: error.code, message: error.message }, { status: error.status });
    }
    const seen = Number.isSafeInteger(lastRevision) && (lastRevision as number) >= 0 ? lastRevision as number : -1;
    let subscriber: Subscriber;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        subscriber = {
          controller,
          id: subscriptionId,
          seen,
          heartbeat: setInterval(() => {
            try {
              controller.enqueue(encode(": heartbeat\n\n"));
            } catch {
              this.removeSubscriber(subscriber);
            }
          }, 15_000),
        };
        this.subscribers.add(subscriber);
        const current = Math.max(
          Number.isSafeInteger(currentRevision) && (currentRevision as number) >= 0 ? currentRevision as number : -1,
          this.current().revision,
        );
        if (current > subscriber.seen) {
          subscriber.seen = current;
          controller.enqueue(encode(`event: revision\ndata: ${current}\n\n`));
        }
      },
      cancel: () => this.removeSubscriber(subscriber),
    });
    return new Response(stream, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/event-stream",
      },
    });
  }

  unsubscribe(subscriptionId: string): void {
    for (const subscriber of this.subscribers) {
      if (subscriber.id === subscriptionId) this.removeSubscriber(subscriber);
    }
  }

  private removeSubscriber(subscriber: Subscriber): void {
    clearInterval(subscriber.heartbeat);
    this.subscribers.delete(subscriber);
  }
}

function parseHistoryInput(input: HistoryInput): { beforeRevision?: number; limit: number } {
  if (!Number.isSafeInteger(input.limit) || input.limit <= 0) throw invalidHistory();
  if (input.beforeRevision !== undefined && (!Number.isSafeInteger(input.beforeRevision) || input.beforeRevision <= 0)) {
    throw invalidHistory();
  }
  return { ...input, limit: Math.min(input.limit, MAX_HISTORY_LIMIT) };
}

function parseEntry(row: HistoryRow): FeaturePolicyAuditEntry {
  const entry = featurePolicyAuditEntrySchema.parse({
    revision: row.revision,
    baseRevision: row.base_revision,
    actor: JSON.parse(row.actor_json),
    reason: row.reason,
    publishedAt: row.published_at,
    snapshot: JSON.parse(row.snapshot_json),
  });
  if (entry.snapshot.revision !== entry.revision || entry.baseRevision !== entry.revision - 1) {
    throw new Error("Invalid Durable Object feature policy history row");
  }
  return entry;
}

function invalidHistory(): HyeboardError {
  return new HyeboardError("ADMIN_POLICY_INVALID", "Feature policy history request is invalid.", 400);
}

function denied(resetAt: number, now: number): AdminLoginAttemptResult {
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1_000)) };
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
