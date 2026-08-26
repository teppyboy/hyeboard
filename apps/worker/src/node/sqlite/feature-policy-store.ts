import { HyeboardError } from "@hyeboard/core";
import {
  adminActorSchema,
  featurePolicyAuditEntrySchema,
  featurePolicySnapshotSchema,
  publishFeaturePolicySchema,
  type FeaturePolicyAuditEntry,
  type FeaturePolicySnapshot,
} from "@hyeboard/schemas";
import { emptyPolicy } from "../../feature-policy";
import type {
  FeaturePolicyStore,
  HistoryInput,
  HistoryPage,
  PublishFeaturePolicyInput,
} from "../../feature-policy-store";

const MAX_HISTORY_LIMIT = 100;
const publicationSchema = publishFeaturePolicySchema.extend({ actor: adminActorSchema });

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type SqliteStatement = {
  run(...values: unknown[]): void;
  get(...values: unknown[]): object | undefined;
  all(...values: unknown[]): object[];
};

export type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
};

export async function openFeaturePolicyDatabase(path: string): Promise<SqliteDatabase> {
  if ("Bun" in globalThis) {
    const bunSqliteModule = "bun:sqlite";
    const { Database } = await import(bunSqliteModule);
    return new Database(path, { create: true });
  }
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(path) as SqliteDatabase;
}

export async function openSqliteFeaturePolicyStore(path: string): Promise<SqliteFeaturePolicyStore> {
  return new SqliteFeaturePolicyStore(await openFeaturePolicyDatabase(path));
}

export class SqliteFeaturePolicyStore implements FeaturePolicyStore {
  constructor(private readonly database: SqliteDatabase) {
    database.exec(`
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
    `);
    database.prepare(`
      INSERT OR IGNORE INTO feature_policy_current (singleton, revision, snapshot_json)
      VALUES (1, 0, ?)
    `).run(JSON.stringify({ ...emptyPolicy(), revision: 0 }));
  }

  async current(): Promise<FeaturePolicySnapshot> {
    return this.readCurrent();
  }

  async publish(input: PublishFeaturePolicyInput): Promise<FeaturePolicyAuditEntry> {
    const parsed = publicationSchema.parse(input);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.readCurrent();
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
      this.database.prepare(`
        INSERT INTO feature_policy_history (
          revision, base_revision, actor_json, reason, published_at, snapshot_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        entry.revision,
        entry.baseRevision,
        JSON.stringify(entry.actor),
        entry.reason,
        entry.publishedAt,
        JSON.stringify(entry.snapshot),
      );
      this.database.prepare(`
        UPDATE feature_policy_current
        SET revision = ?, snapshot_json = ?
        WHERE singleton = 1 AND revision = ?
      `).run(entry.revision, JSON.stringify(entry.snapshot), entry.baseRevision);
      this.database.exec("COMMIT");
      return entry;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "SQLite feature policy transaction rollback failed");
      }
      throw error;
    }
  }

  async history(input: HistoryInput): Promise<HistoryPage> {
    const { beforeRevision, limit } = parseHistoryInput(input);
    const rows = this.database.prepare(`
      SELECT revision, base_revision, actor_json, reason, published_at, snapshot_json
      FROM feature_policy_history
      WHERE revision < ?
      ORDER BY revision DESC
      LIMIT ?
    `).all(beforeRevision ?? Number.MAX_SAFE_INTEGER, limit + 1);
    const items = rows.slice(0, limit).map(parseEntry);
    return {
      items,
      ...(rows.length > limit && items.length > 0
        ? { nextBeforeRevision: items.at(-1)!.revision }
        : {}),
    };
  }

  async revision(revision: number): Promise<FeaturePolicyAuditEntry | undefined> {
    if (!Number.isSafeInteger(revision) || revision <= 0) return undefined;
    const row = this.database.prepare(`
      SELECT revision, base_revision, actor_json, reason, published_at, snapshot_json
      FROM feature_policy_history
      WHERE revision = ?
    `).get(revision);
    return row === undefined ? undefined : parseEntry(row);
  }

  async close(): Promise<void> {
    this.database.close();
  }

  private readCurrent(): FeaturePolicySnapshot {
    const row = record(this.database.prepare(`
      SELECT revision, snapshot_json
      FROM feature_policy_current
      WHERE singleton = 1
    `).get());
    const snapshot = parseSnapshot(row.snapshot_json);
    if (snapshot.revision !== row.revision) throw new Error("Invalid SQLite feature policy current row");
    return snapshot;
  }
}

function parseHistoryInput(input: HistoryInput): { beforeRevision?: number; limit: number } {
  if (!Number.isSafeInteger(input.limit) || input.limit <= 0) throw invalidHistory();
  if (input.beforeRevision !== undefined && (!Number.isSafeInteger(input.beforeRevision) || input.beforeRevision <= 0)) {
    throw invalidHistory();
  }
  return { ...input, limit: Math.min(input.limit, MAX_HISTORY_LIMIT) };
}

function parseEntry(value: unknown): FeaturePolicyAuditEntry {
  const row = record(value);
  const entry = featurePolicyAuditEntrySchema.parse({
    revision: row.revision,
    baseRevision: row.base_revision,
    actor: parseJson(row.actor_json),
    reason: row.reason,
    publishedAt: row.published_at,
    snapshot: parseJson(row.snapshot_json),
  });
  if (entry.snapshot.revision !== entry.revision || entry.baseRevision !== entry.revision - 1) {
    throw new Error("Invalid SQLite feature policy history row");
  }
  return entry;
}

function parseSnapshot(value: unknown): FeaturePolicySnapshot {
  return featurePolicySnapshotSchema.parse(parseJson(value));
}

function parseJson(value: unknown): JsonValue {
  if (typeof value !== "string") throw new Error("Invalid SQLite feature policy JSON column");
  return JSON.parse(value) as JsonValue;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new Error("Missing SQLite feature policy row");
  return value as Record<string, unknown>;
}

function invalidHistory(): HyeboardError {
  return new HyeboardError("ADMIN_POLICY_INVALID", "Feature policy history request is invalid.", 400);
}
