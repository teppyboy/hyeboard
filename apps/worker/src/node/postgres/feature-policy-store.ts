import { HyeboardError } from "@hyeboard/core";
import {
  adminActorSchema,
  featurePolicyAuditEntrySchema,
  featurePolicySnapshotSchema,
  publishFeaturePolicySchema,
  type FeaturePolicyAuditEntry,
  type FeaturePolicySnapshot,
} from "@hyeboard/schemas";
import type {
  FeaturePolicyStore,
  HistoryInput,
  HistoryPage,
  PublishFeaturePolicyInput,
} from "../../feature-policy-store";
import type { PostgresPoolLike } from "./pool";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const MAX_HISTORY_LIMIT = 100;
const AFTER_ALL_SAFE_REVISIONS = "9007199254740992";
const publicationSchema = publishFeaturePolicySchema.extend({ actor: adminActorSchema });

export class PostgresFeaturePolicyStore implements FeaturePolicyStore {
  constructor(private readonly pool: PostgresPoolLike) {}

  async current(): Promise<FeaturePolicySnapshot> {
    const result = await this.pool.query(`
      SELECT revision, snapshot
      FROM hyeboard_feature_policy_current
      WHERE singleton = true
    `);
    return parseCurrent(result.rows[0]);
  }

  async publish(input: PublishFeaturePolicyInput): Promise<FeaturePolicyAuditEntry> {
    const parsed = publicationSchema.parse(input);
    return this.pool.transaction(async (connection) => {
      const currentResult = await connection.query(`
        SELECT revision, snapshot
        FROM hyeboard_feature_policy_current
        WHERE singleton = true
        FOR UPDATE
      `);
      const current = parseCurrent(currentResult.rows[0]);
      if (current.revision !== parsed.baseRevision) {
        throw new HyeboardError(
          "ADMIN_POLICY_CONFLICT",
          "Feature policy changed before publication.",
          409,
          { currentRevision: current.revision },
        );
      }

      const revision = current.revision + 1;
      if (!Number.isSafeInteger(revision)) throw new Error("PostgreSQL feature policy revision exceeds the supported range");
      const entry = featurePolicyAuditEntrySchema.parse({
        revision,
        baseRevision: parsed.baseRevision,
        actor: parsed.actor,
        reason: parsed.reason,
        publishedAt: new Date().toISOString(),
        snapshot: { ...parsed.policy, revision },
      });
      await connection.query(`
        INSERT INTO hyeboard_feature_policy_history (
          revision, base_revision, actor, reason, published_at, snapshot
        ) VALUES ($1, $2, $3, $4, $5, $6)
      `, [
        entry.revision,
        entry.baseRevision,
        JSON.stringify(entry.actor),
        entry.reason,
        entry.publishedAt,
        JSON.stringify(entry.snapshot),
      ]);
      await connection.query(`
        UPDATE hyeboard_feature_policy_current
        SET revision = $1, snapshot = $2
        WHERE singleton = true AND revision = $3
      `, [entry.revision, JSON.stringify(entry.snapshot), entry.baseRevision]);
      return entry;
    });
  }

  async history(input: HistoryInput): Promise<HistoryPage> {
    const { beforeRevision, limit } = parseHistoryInput(input);
    const result = await this.pool.query(`
      SELECT revision, base_revision, actor, reason, published_at, snapshot
      FROM hyeboard_feature_policy_history
      WHERE revision < $1
      ORDER BY revision DESC
      LIMIT $2
    `, [beforeRevision ?? AFTER_ALL_SAFE_REVISIONS, limit + 1]);
    const items = result.rows.slice(0, limit).map(parseEntry);
    return {
      items,
      ...(result.rows.length > limit && items.length > 0
        ? { nextBeforeRevision: items.at(-1)!.revision }
        : {}),
    };
  }

  async revision(revision: number): Promise<FeaturePolicyAuditEntry | undefined> {
    if (!Number.isSafeInteger(revision) || revision <= 0) return undefined;
    const result = await this.pool.query(`
      SELECT revision, base_revision, actor, reason, published_at, snapshot
      FROM hyeboard_feature_policy_history
      WHERE revision = $1
    `, [revision]);
    return result.rows[0] === undefined ? undefined : parseEntry(result.rows[0]);
  }
}

function parseHistoryInput(input: HistoryInput): { beforeRevision?: number; limit: number } {
  if (!Number.isSafeInteger(input.limit) || input.limit <= 0) throw invalidHistory();
  if (input.beforeRevision !== undefined && (!Number.isSafeInteger(input.beforeRevision) || input.beforeRevision <= 0)) {
    throw invalidHistory();
  }
  return { ...input, limit: Math.min(input.limit, MAX_HISTORY_LIMIT) };
}

function parseCurrent(value: unknown): FeaturePolicySnapshot {
  const row = record(value, "Missing PostgreSQL feature policy current row");
  const revision = parseRevision(row.revision, true);
  const snapshot = featurePolicySnapshotSchema.parse(parseJson(row.snapshot));
  if (snapshot.revision !== revision) throw new Error("Invalid PostgreSQL feature policy current row");
  return snapshot;
}

function parseEntry(value: unknown): FeaturePolicyAuditEntry {
  const row = record(value, "Missing PostgreSQL feature policy history row");
  const entry = featurePolicyAuditEntrySchema.parse({
    revision: parseRevision(row.revision, false),
    baseRevision: parseRevision(row.base_revision, true),
    actor: parseJson(row.actor),
    reason: row.reason,
    publishedAt: row.published_at instanceof Date ? row.published_at.toISOString() : row.published_at,
    snapshot: parseJson(row.snapshot),
  });
  if (entry.snapshot.revision !== entry.revision || entry.baseRevision !== entry.revision - 1) {
    throw new Error("Invalid PostgreSQL feature policy history row");
  }
  return entry;
}

function parseRevision(value: unknown, allowZero: boolean): number {
  const revision = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < (allowZero ? 0 : 1)) {
    throw new Error("Invalid PostgreSQL feature policy revision");
  }
  return revision;
}

function parseJson(value: unknown): JsonValue {
  return (typeof value === "string" ? JSON.parse(value) : value) as JsonValue;
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new Error(message);
  return value as Record<string, unknown>;
}

function invalidHistory(): HyeboardError {
  return new HyeboardError("ADMIN_POLICY_INVALID", "Feature policy history request is invalid.", 400);
}
