import pg from "pg";
import type { PoolConfig, QueryResult, QueryResultRow } from "pg";

export type PostgresQueryResult<Row> = { rows: Row[] };

export interface PostgresQueryable {
  query<Row extends QueryResultRow = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<PostgresQueryResult<Row>>;
}

export interface PostgresConnection extends PostgresQueryable {
  release(error?: Error): void;
}

export interface PostgresPoolLike extends PostgresQueryable {
  connect(): Promise<PostgresConnection>;
  transaction<T>(body: (connection: PostgresConnection) => Promise<T>): Promise<T>;
}

export type PostgresPoolConfig = PoolConfig | string;

// Bound startup dependency checks so an unreachable distributed database does
// not prevent the HTTP server from binding its liveness port indefinitely.
export const POSTGRES_CONNECTION_TIMEOUT_MS = 5_000;

export class PostgresPool implements PostgresPoolLike {
  private readonly pool: pg.Pool;

  constructor(config?: PostgresPoolConfig) {
    this.pool = typeof config === "string"
      ? new pg.Pool({ connectionString: config, connectionTimeoutMillis: POSTGRES_CONNECTION_TIMEOUT_MS })
      : new pg.Pool(config);
    // `pg.Pool` emits idle-client errors asynchronously. Without a listener a
    // database outage can become an uncaught process exception, taking every
    // API replica down instead of letting the request boundary return the
    // sanitized HA dependency error.
    this.pool.on("error", () => undefined);
  }

  async query<Row extends QueryResultRow = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>> {
    return this.pool.query<Row>(text, values as unknown[] | undefined);
  }

  async connect(): Promise<PostgresConnection> {
    return await this.pool.connect();
  }

  async transaction<T>(body: (connection: PostgresConnection) => Promise<T>): Promise<T> {
    const connection = await this.connect();
    let discardConnection = false;
    let failure: unknown;
    let transactionStarted = false;
    let commitAttempted = false;
    try {
      await connection.query("BEGIN");
      transactionStarted = true;
      try {
        const result = await body(connection);
        commitAttempted = true;
        await connection.query("COMMIT");
        return result;
      } catch (error) {
        failure = error;
        try {
          await connection.query("ROLLBACK");
        } catch {
          discardConnection = true;
        }
        if (commitAttempted) discardConnection = true;
        throw error;
      }
    } catch (error) {
      failure = error;
      if (!transactionStarted) discardConnection = true;
      throw error;
    } finally {
      // A failed BEGIN/COMMIT or rollback failure can leave the session unusable.
      // Passing an error to pg releases and destroys that pooled connection.
      connection.release(discardConnection
        ? (failure instanceof Error ? failure : new Error("PostgreSQL transaction connection is not reusable"))
        : undefined);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
