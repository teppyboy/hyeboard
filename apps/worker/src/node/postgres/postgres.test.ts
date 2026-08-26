import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyPolicy } from "../../feature-policy";
import type { PublishFeaturePolicyInput } from "../../feature-policy-store";
import { derivePostgresOpaqueHash, toPostgresEpochMilliseconds } from "./crypto";
import { PostgresFeaturePolicyStore } from "./feature-policy-store";
import { defaultPostgresMigrationsDirectory, runPostgresMigrations } from "./migrations";
import { PostgresSessionRevocationStore } from "./session-revocation";
import { PostgresVnuRefreshControlCoordinator } from "./vnu-refresh-coordinator";
import type { PostgresConnection, PostgresPoolLike } from "./pool";
import type { LinkedPair } from "../../vnu-refresh-control";

const SECRET = "postgres-test-secret-with-at-least-32-bytes";
const PAIR: LinkedPair = {
  accessTokenId: "A".repeat(22),
  accessExpiresAt: Date.parse("2036-02-03T12:00:00.000Z"),
  grantId: "B".repeat(22),
  grantExpiresAt: Date.parse("2036-02-03T13:00:00.000Z"),
};
const POLICY_ACTOR = { method: "password" as const, subject: "password-admin" };

function publication(baseRevision: number, reason = `Publish ${baseRevision + 1}`): PublishFeaturePolicyInput {
  return { baseRevision, policy: emptyPolicy(), reason, actor: POLICY_ACTOR };
}

class FakeConnection implements PostgresConnection {
  readonly queries: Array<{ text: string; values?: readonly unknown[] }> = [];

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
    this.queries.push({ text, values });
    if (text.includes("FROM hyeboard_vnu_refresh_principals")) return { rows: [] as Row[] };
    if (text.includes("FROM hyeboard_vnu_refresh_tombstones")) return { rows: [] as Row[] };
    return { rows: [] as Row[] };
  }

  release(): void {}
}

class FakePool implements PostgresPoolLike {
  readonly connection = new FakeConnection();

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
    return this.connection.query<Row>(text, values);
  }

  async connect(): Promise<PostgresConnection> {
    return this.connection;
  }

  async transaction<T>(body: (connection: PostgresConnection) => Promise<T>): Promise<T> {
    return body(this.connection);
  }
}

class FeaturePolicyFakeConnection implements PostgresConnection {
  readonly queries: Array<{ text: string; values?: readonly unknown[] }> = [];
  currentRow: Record<string, unknown> = {
    revision: "0",
    snapshot: JSON.stringify({ ...emptyPolicy(), revision: 0 }),
  };
  readonly historyRows: Record<string, unknown>[] = [];

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
    this.queries.push({ text, values });
    if (text.includes("FROM hyeboard_feature_policy_current")) return { rows: [this.currentRow] as Row[] };
    if (text.includes("INSERT INTO hyeboard_feature_policy_history")) {
      this.historyRows.push({
        revision: String(values![0]),
        base_revision: String(values![1]),
        actor: values![2],
        reason: values![3],
        published_at: values![4],
        snapshot: values![5],
      });
    }
    if (text.includes("UPDATE hyeboard_feature_policy_current")) {
      this.currentRow = { revision: String(values![0]), snapshot: values![1] };
    }
    if (text.includes("FROM hyeboard_feature_policy_history")) {
      const matching = text.includes("revision = $1")
        ? this.historyRows.filter(({ revision }) => Number(revision) === values![0])
        : this.historyRows
          .filter(({ revision }) => Number(revision) < Number(values![0]))
          .sort((left, right) => Number(right.revision) - Number(left.revision))
          .slice(0, Number(values![1]));
      return { rows: matching as Row[] };
    }
    return { rows: [] as Row[] };
  }

  release(): void {}
}

class FeaturePolicyFakePool implements PostgresPoolLike {
  readonly connection = new FeaturePolicyFakeConnection();

  query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
    return this.connection.query<Row>(text, values);
  }

  async connect(): Promise<PostgresConnection> {
    return this.connection;
  }

  async transaction<T>(body: (connection: PostgresConnection) => Promise<T>): Promise<T> {
    await this.connection.query("BEGIN");
    try {
      const result = await body(this.connection);
      await this.connection.query("COMMIT");
      return result;
    } catch (error) {
      await this.connection.query("ROLLBACK");
      throw error;
    }
  }
}

describe("PostgreSQL HA boundaries", () => {
  it("derives domain-separated opaque hashes without retaining the subject", () => {
    const tokenHash = derivePostgresOpaqueHash(SECRET, "token", "raw-session-token");
    const sessionHash = derivePostgresOpaqueHash(SECRET, "session", "raw-session-token");
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(sessionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).not.toBe(sessionHash);
    expect(tokenHash).not.toContain("raw-session-token");
  });

  it("normalizes only valid expiry timestamps", () => {
    expect(toPostgresEpochMilliseconds("2036-02-03T12:00:00.000Z")).toBe(PAIR.accessExpiresAt);
    expect(toPostgresEpochMilliseconds(new Date(PAIR.accessExpiresAt))).toBe(PAIR.accessExpiresAt);
    expect(() => toPostgresEpochMilliseconds("not-a-date")).toThrow();
  });

  it("uses hashed values for generic token revocation", async () => {
    const pool = new FakePool();
    const store = new PostgresSessionRevocationStore(pool, SECRET);
    await store.revokeToken("raw-session-token", PAIR.accessExpiresAt);
    expect(pool.connection.queries[0].values).not.toContain("raw-session-token");
    expect(pool.connection.queries[0].values?.[1]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("locks a principal before applying the pure activation transition", async () => {
    const pool = new FakePool();
    const coordinator = new PostgresVnuRefreshControlCoordinator(pool);
    await expect(coordinator.activatePair("a".repeat(64), PAIR)).resolves.toEqual({ kind: "activated" });
    const sql = pool.connection.queries.map(({ text }) => text).join("\n");
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("WHERE principal_key = $1\n      FOR UPDATE");
    expect(JSON.stringify(pool.connection.queries)).not.toMatch(/password|cookie|raw.?token/i);
  });

  it("publishes feature policy under a row lock with history before current", async () => {
    const pool = new FeaturePolicyFakePool();
    const store = new PostgresFeaturePolicyStore(pool);
    const entry = await store.publish(publication(0, "Initial publication"));

    expect(entry).toMatchObject({ revision: 1, baseRevision: 0, actor: POLICY_ACTOR });
    const statements = pool.connection.queries.map(({ text }) => text.trim());
    const lock = statements.findIndex((text) => text.includes("FOR UPDATE"));
    const insert = statements.findIndex((text) => text.includes("INSERT INTO hyeboard_feature_policy_history"));
    const update = statements.findIndex((text) => text.includes("UPDATE hyeboard_feature_policy_current"));
    expect(statements[0]).toBe("BEGIN");
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(insert);
    expect(insert).toBeLessThan(update);
    expect(update).toBeLessThan(statements.indexOf("COMMIT"));
    expect(await store.current()).toEqual(entry.snapshot);
  });

  it("rejects stale feature policy CAS before writes and never accepts credential fields", async () => {
    const pool = new FeaturePolicyFakePool();
    const store = new PostgresFeaturePolicyStore(pool);
    await store.publish(publication(0));
    const writesBeforeConflict = pool.connection.queries.filter(({ text }) => /INSERT INTO|UPDATE hyeboard/.test(text)).length;

    await expect(store.publish(publication(0))).rejects.toMatchObject({
      code: "ADMIN_POLICY_CONFLICT",
      status: 409,
      details: { currentRevision: 1 },
    });
    expect(pool.connection.queries.filter(({ text }) => /INSERT INTO|UPDATE hyeboard/.test(text)).length).toBe(writesBeforeConflict);
    expect(pool.connection.queries.at(-1)?.text).toBe("ROLLBACK");

    const credential = "sensitive-credential-sentinel";
    await expect(store.publish({ ...publication(1), password: credential } as never)).rejects.toBeTruthy();
    expect(JSON.stringify(pool.connection.queries)).not.toContain(credential);
  });

  it("parses PostgreSQL JSON and returns bounded newest-first policy pages", async () => {
    const pool = new FeaturePolicyFakePool();
    const store = new PostgresFeaturePolicyStore(pool);
    await store.publish(publication(0));
    await store.publish(publication(1));
    await store.publish(publication(2));

    const first = await store.history({ limit: 2 });
    expect(first.items.map(({ revision }) => revision)).toEqual([3, 2]);
    expect(first.nextBeforeRevision).toBe(2);
    expect((await store.history({ beforeRevision: 2, limit: 200 })).items.map(({ revision }) => revision)).toEqual([1]);
    expect(pool.connection.queries.at(-1)?.values).toEqual([2, 101]);
    expect(await store.revision(1)).toMatchObject({ revision: 1, snapshot: { revision: 1 } });
    const queriesBeforeInvalidRevision = pool.connection.queries.length;
    await expect(store.revision(Number.MAX_SAFE_INTEGER + 1)).resolves.toBeUndefined();
    expect(pool.connection.queries).toHaveLength(queriesBeforeInvalidRevision);
  });

  it("rejects malformed durable policy JSON rows", async () => {
    const pool = new FeaturePolicyFakePool();
    pool.connection.currentRow.snapshot = "{not-json";
    await expect(new PostgresFeaturePolicyStore(pool).current()).rejects.toBeTruthy();
  });

  it("runs migrations under a session advisory lock and records applied SQL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hyeboard-postgres-migrations-"));
    try {
      await writeFile(join(directory, "001_test.sql"), "CREATE TABLE migration_test (id integer);\n", "utf8");
      const pool = new FakePool();
      const applied = await runPostgresMigrations(pool, directory);
      expect(applied).toHaveLength(1);
      expect(applied[0].name).toBe("001_test.sql");
      const sql = pool.connection.queries.map(({ text }) => text).join("\n");
      expect(sql).toContain("pg_advisory_lock");
      expect(sql).toContain("hyeboard_schema_migrations");
      expect(sql).toContain("pg_advisory_unlock");
      const statements = pool.connection.queries.map(({ text }) => text);
      expect(statements.indexOf("BEGIN")).toBeLessThan(statements.indexOf("CREATE TABLE migration_test (id integer);\n"));
      expect(statements.indexOf("CREATE TABLE migration_test (id integer);\n")).toBeLessThan(statements.findIndex((text) => text.includes("INSERT INTO hyeboard_schema_migrations")));
      expect(statements.findIndex((text) => text.includes("INSERT INTO hyeboard_schema_migrations"))).toBeLessThan(statements.indexOf("COMMIT"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("ships the immutable singleton feature-policy migration through the migration runner", async () => {
    const migration = await readFile(join(defaultPostgresMigrationsDirectory(), "003_feature_policy.sql"), "utf8");
    expect(migration).toContain("singleton boolean PRIMARY KEY");
    expect(migration.match(/CHECK \(\(jsonb_typeof\((?:snapshot|actor)\) = 'object'\) IS TRUE\)/g)).toHaveLength(3);
    expect(migration).toContain("BEFORE UPDATE OR DELETE ON hyeboard_feature_policy_history");
    expect(migration).toContain("ON CONFLICT (singleton) DO NOTHING");

    const pool = new FakePool();
    const applied = await runPostgresMigrations(pool);
    expect(applied.map(({ version }) => version)).toEqual([1, 2, 3]);
    expect(pool.connection.queries.map(({ text }) => text)).toContain(migration);
  });

  it("orders migrations by numeric version and rejects an unknown applied version", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hyeboard-postgres-migration-order-"));
    try {
      await writeFile(join(directory, "10_later.sql"), "SELECT 10;\n", "utf8");
      await writeFile(join(directory, "2_earlier.sql"), "SELECT 2;\n", "utf8");
      const pool = new FakePool();
      const applied = await runPostgresMigrations(pool, directory);
      expect(applied.map((migration) => migration.version)).toEqual([2, 10]);
      expect(pool.connection.queries.map(({ text }) => text)).toEqual(expect.arrayContaining(["SELECT 2;\n", "SELECT 10;\n"]));

      class AppliedVersionPool extends FakePool {
        override readonly connection = new class extends FakeConnection {
          override async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
            this.queries.push({ text, values });
            if (text.includes("SELECT version, name, checksum")) return { rows: [{ version: "99", name: "099_missing.sql", checksum: "x" }] as unknown as Row[] };
            return { rows: [] as Row[] };
          }
        }();
        override async connect(): Promise<PostgresConnection> { return this.connection; }
      }
      await expect(runPostgresMigrations(new AppliedVersionPool(), directory)).rejects.toThrow(/missing locally/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed for malformed principals before querying PostgreSQL", async () => {
    const pool = new FakePool();
    const coordinator = new PostgresVnuRefreshControlCoordinator(pool);
    await expect(coordinator.activatePair("not-a-principal", PAIR)).rejects.toMatchObject({ code: "VNU_REFRESH_UNAVAILABLE" });
    expect(pool.connection.queries).toHaveLength(0);
  });
});
