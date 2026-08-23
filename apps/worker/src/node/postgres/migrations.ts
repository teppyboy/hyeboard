import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PostgresPoolLike } from "./pool";

export const POSTGRES_MIGRATION_LOCK_KEY = "hyeboard:postgres:migrations:v1";
export const POSTGRES_MIGRATION_TABLE = "hyeboard_schema_migrations";

type MigrationFile = { version: number; name: string; sql: string; checksum: string };
type AppliedMigration = { version: string | number; name: string; checksum: string };

const migrationFilePattern = /^(\d+)_([a-z0-9_-]+)\.sql$/i;

export function defaultPostgresMigrationsDirectory(): string {
  // The bundled Node artifact keeps `migrations/` beside its `dist/` folder:
  // apps/worker/dist -> apps/worker/migrations in the workspace and
  // package/dist -> package/migrations in the standalone artifact. During
  // tsx development this module still lives under src/node/postgres, so use
  // the source-tree path when the bundled sibling does not exist.
  const bundledPath = fileURLToPath(new URL("../migrations/", import.meta.url));
  if (existsSync(bundledPath)) return bundledPath;
  return fileURLToPath(new URL("../../../migrations/", import.meta.url));
}

async function loadMigrationFiles(directory: string): Promise<MigrationFile[]> {
  const names = (await readdir(directory)).filter((name) => migrationFilePattern.test(name)).sort((left, right) => {
    const leftVersion = Number(migrationFilePattern.exec(left)![1]);
    const rightVersion = Number(migrationFilePattern.exec(right)![1]);
    return leftVersion - rightVersion || left.localeCompare(right);
  });
  const migrations: MigrationFile[] = [];
  for (const name of names) {
    const match = migrationFilePattern.exec(name);
    if (!match) continue;
    const version = Number(match[1]);
    if (!Number.isSafeInteger(version) || version < 1) throw new Error(`Invalid migration version: ${name}`);
    const sql = await readFile(join(directory, name), "utf8");
    if (sql.trim().length === 0) throw new Error(`Empty migration: ${name}`);
    migrations.push({ version, name: basename(name), sql, checksum: createHash("sha256").update(sql, "utf8").digest("hex") });
  }
  const versions = new Set<number>();
  for (const migration of migrations) {
    if (versions.has(migration.version)) throw new Error(`Duplicate migration version: ${migration.version}`);
    versions.add(migration.version);
  }
  return migrations;
}

export async function runPostgresMigrations(pool: PostgresPoolLike, directory = defaultPostgresMigrationsDirectory()): Promise<ReadonlyArray<AppliedMigration>> {
  const migrations = await loadMigrationFiles(directory);
  const connection = await pool.connect();
  let lockHeld = false;
  let unlockFailed = false;
  let discardConnection = false;
  try {
    await connection.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [POSTGRES_MIGRATION_LOCK_KEY]);
    lockHeld = true;
    await connection.query(
      `CREATE TABLE IF NOT EXISTS ${POSTGRES_MIGRATION_TABLE} (
         version bigint PRIMARY KEY,
         name text NOT NULL,
         checksum text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const appliedResult = await connection.query<AppliedMigration>(
      `SELECT version, name, checksum FROM ${POSTGRES_MIGRATION_TABLE} ORDER BY version`,
    );
    const applied = new Map(appliedResult.rows.map((row) => [Number(row.version), row]));

    for (const row of appliedResult.rows) {
      if (!migrations.some((migration) => migration.version === Number(row.version))) {
        throw new Error(`Applied migration is missing locally: ${row.version}`);
      }
    }

    for (const migration of migrations) {
      const previous = applied.get(migration.version);
      if (previous) {
        if (previous.name !== migration.name || previous.checksum !== migration.checksum) {
          throw new Error(`Migration checksum mismatch: ${migration.name}`);
        }
        continue;
      }

      await connection.query("BEGIN");
      let commitAttempted = false;
      try {
        await connection.query(migration.sql);
        await connection.query(
          `INSERT INTO ${POSTGRES_MIGRATION_TABLE} (version, name, checksum) VALUES ($1, $2, $3)`,
          [migration.version, migration.name, migration.checksum],
        );
        commitAttempted = true;
        await connection.query("COMMIT");
      } catch (error) {
        if (commitAttempted) discardConnection = true;
        try {
          await connection.query("ROLLBACK");
        } catch {
          discardConnection = true;
        }
        throw error;
      }
    }

    return migrations.map(({ version, name, checksum }) => ({ version, name, checksum }));
  } finally {
    if (lockHeld) {
      try {
        await connection.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [POSTGRES_MIGRATION_LOCK_KEY]);
      } catch {
        unlockFailed = true;
      }
    }
    connection.release(unlockFailed || discardConnection
      ? new Error("PostgreSQL migration connection is not reusable")
      : undefined);
  }
}
