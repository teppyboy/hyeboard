import {
  applyAbortRefresh,
  applyActivatePair,
  applyBeginRefresh,
  applyCheckAccess,
  applyCompleteRefresh,
  applyRevokeExactLinkedPair,
  applyRevokeLinkedPairByAccess,
  applyRevokePrincipalByLinkedGrant,
  assertAccessDescriptorRef,
  assertLinkedPair,
  isQuiescentVnuRefreshState,
  parseVnuRefreshControlState,
  vnuRefreshUnavailable,
  type AccessDescriptorRef,
  type ActivatePairResult,
  type BeginRefreshResult,
  type LinkedPair,
  type VnuRefreshControlCoordinator,
  type VnuRefreshControlState,
} from "../../vnu/vnu-refresh-control";
import type { PostgresConnection, PostgresPoolLike } from "./pool";

type PrincipalRow = {
  principal_key: string;
  active_access_token_id: string | null;
  active_access_expires_at_ms: string | number | null;
  active_grant_id: string | null;
  active_grant_expires_at_ms: string | number | null;
  lease_expires_at_ms: string | number | null;
  refresh_attempt_count: string | number;
  refresh_window_reset_at_ms: string | number;
  activation_count: string | number | null;
  activation_window_reset_at_ms: string | number | null;
};

type TombstoneRow = {
  tombstone_kind: "access" | "grant";
  tombstone_id: string;
  expires_at_ms: string | number;
  linked_access_token_id: string | null;
  linked_access_expires_at_ms: string | number | null;
  linked_grant_expires_at_ms: string | number | null;
  successor_access_token_id: string | null;
  successor_access_expires_at_ms: string | number | null;
  successor_grant_id: string | null;
  successor_grant_expires_at_ms: string | number | null;
};

const PRINCIPAL_KEY_PATTERN = /^[0-9a-f]{64}$/;

function epoch(value: string | number | null, name: string): number {
  const result =
    typeof value === "number"
      ? value
      : value === null
        ? Number.NaN
        : Number(value);
  if (!Number.isSafeInteger(result) || result <= 0)
    throw new Error(`Invalid PostgreSQL ${name}`);
  return result;
}

function count(value: string | number, name: string): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 0)
    throw new Error(`Invalid PostgreSQL ${name}`);
  return result;
}

function assertPrincipalKey(principalKey: string): void {
  if (!PRINCIPAL_KEY_PATTERN.test(principalKey)) throw vnuRefreshUnavailable();
}

function pairFromPrincipal(row: PrincipalRow): LinkedPair | undefined {
  const values = [
    row.active_access_token_id,
    row.active_access_expires_at_ms,
    row.active_grant_id,
    row.active_grant_expires_at_ms,
  ];
  if (values.every((value) => value === null)) return undefined;
  if (values.some((value) => value === null))
    throw new Error("Invalid PostgreSQL VNU authority row");
  return {
    accessTokenId: row.active_access_token_id!,
    accessExpiresAt: epoch(row.active_access_expires_at_ms, "access expiry"),
    grantId: row.active_grant_id!,
    grantExpiresAt: epoch(row.active_grant_expires_at_ms, "grant expiry"),
  };
}

async function loadState(
  connection: PostgresConnection,
  principalKey: string,
): Promise<VnuRefreshControlState | undefined> {
  const principalResult = await connection.query<PrincipalRow>(
    `SELECT principal_key, active_access_token_id, active_access_expires_at_ms,
            active_grant_id, active_grant_expires_at_ms, lease_expires_at_ms,
            refresh_attempt_count, refresh_window_reset_at_ms, activation_count,
            activation_window_reset_at_ms
       FROM hyeboard_vnu_refresh_principals
      WHERE principal_key = $1
      FOR UPDATE`,
    [principalKey],
  );
  const row = principalResult.rows[0];
  if (!row) return undefined;

  const active = pairFromPrincipal(row);
  const tombstoneResult = await connection.query<TombstoneRow>(
    `SELECT tombstone_kind, tombstone_id, expires_at_ms,
            linked_access_token_id, linked_access_expires_at_ms, linked_grant_expires_at_ms,
            successor_access_token_id, successor_access_expires_at_ms,
            successor_grant_id, successor_grant_expires_at_ms
       FROM hyeboard_vnu_refresh_tombstones
      WHERE principal_key = $1
      FOR UPDATE`,
    [principalKey],
  );
  const revokedAccess: Record<string, number> = {};
  const revokedGrants: VnuRefreshControlState["revokedGrants"] = {};
  for (const tombstone of tombstoneResult.rows) {
    if (tombstone.tombstone_kind === "access") {
      revokedAccess[tombstone.tombstone_id] = epoch(
        tombstone.expires_at_ms,
        "access tombstone expiry",
      );
      continue;
    }
    if (
      tombstone.linked_access_token_id === null ||
      tombstone.linked_access_expires_at_ms === null ||
      tombstone.linked_grant_expires_at_ms === null
    ) {
      throw new Error("Invalid PostgreSQL VNU grant tombstone");
    }
    const successorValues = [
      tombstone.successor_access_token_id,
      tombstone.successor_access_expires_at_ms,
      tombstone.successor_grant_id,
      tombstone.successor_grant_expires_at_ms,
    ];
    if (
      successorValues.some((value) => value === null) &&
      successorValues.some((value) => value !== null)
    )
      throw new Error("Invalid PostgreSQL VNU successor tombstone");
    revokedGrants[tombstone.tombstone_id] = {
      accessTokenId: tombstone.linked_access_token_id,
      accessExpiresAt: epoch(
        tombstone.linked_access_expires_at_ms,
        "linked access expiry",
      ),
      grantExpiresAt: epoch(
        tombstone.linked_grant_expires_at_ms,
        "linked grant expiry",
      ),
      ...(successorValues.every((value) => value !== null)
        ? {
            refreshSuccessor: {
              accessTokenId: tombstone.successor_access_token_id!,
              accessExpiresAt: epoch(
                tombstone.successor_access_expires_at_ms,
                "successor access expiry",
              ),
              grantId: tombstone.successor_grant_id!,
              grantExpiresAt: epoch(
                tombstone.successor_grant_expires_at_ms,
                "successor grant expiry",
              ),
            },
          }
        : {}),
    };
  }

  return parseVnuRefreshControlState({
    ...(active ? { active } : {}),
    ...(row.lease_expires_at_ms === null
      ? {}
      : {
          lease: {
            pair: active!,
            expiresAt: epoch(row.lease_expires_at_ms, "lease expiry"),
          },
        }),
    revokedAccess,
    revokedGrants,
    window: {
      count: count(row.refresh_attempt_count, "refresh attempt count"),
      resetAt: epoch(row.refresh_window_reset_at_ms, "refresh window expiry"),
    },
    ...(row.activation_count === null ||
    row.activation_window_reset_at_ms === null
      ? {}
      : {
          activationWindow: {
            count: count(row.activation_count, "activation count"),
            resetAt: epoch(
              row.activation_window_reset_at_ms,
              "activation window expiry",
            ),
          },
        }),
  });
}

async function saveState(
  connection: PostgresConnection,
  principalKey: string,
  state: VnuRefreshControlState,
): Promise<void> {
  const active = state.active;
  await connection.query(
    `INSERT INTO hyeboard_vnu_refresh_principals (
       principal_key, active_access_token_id, active_access_expires_at_ms,
       active_grant_id, active_grant_expires_at_ms, lease_expires_at_ms,
       refresh_attempt_count, refresh_window_reset_at_ms, activation_count,
       activation_window_reset_at_ms, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     ON CONFLICT (principal_key) DO UPDATE SET
       active_access_token_id = EXCLUDED.active_access_token_id,
       active_access_expires_at_ms = EXCLUDED.active_access_expires_at_ms,
       active_grant_id = EXCLUDED.active_grant_id,
       active_grant_expires_at_ms = EXCLUDED.active_grant_expires_at_ms,
       lease_expires_at_ms = EXCLUDED.lease_expires_at_ms,
       refresh_attempt_count = EXCLUDED.refresh_attempt_count,
       refresh_window_reset_at_ms = EXCLUDED.refresh_window_reset_at_ms,
       activation_count = EXCLUDED.activation_count,
       activation_window_reset_at_ms = EXCLUDED.activation_window_reset_at_ms,
       updated_at = now()`,
    [
      principalKey,
      active?.accessTokenId ?? null,
      active?.accessExpiresAt ?? null,
      active?.grantId ?? null,
      active?.grantExpiresAt ?? null,
      state.lease?.expiresAt ?? null,
      state.window.count,
      state.window.resetAt,
      state.activationWindow?.count ?? null,
      state.activationWindow?.resetAt ?? null,
    ],
  );
  await connection.query(
    "DELETE FROM hyeboard_vnu_refresh_tombstones WHERE principal_key = $1",
    [principalKey],
  );

  for (const [accessTokenId, expiresAt] of Object.entries(
    state.revokedAccess,
  )) {
    await connection.query(
      `INSERT INTO hyeboard_vnu_refresh_tombstones
         (principal_key, tombstone_kind, tombstone_id, expires_at_ms)
       VALUES ($1, 'access', $2, $3)`,
      [principalKey, accessTokenId, expiresAt],
    );
  }
  for (const [grantId, tombstone] of Object.entries(state.revokedGrants)) {
    if (typeof tombstone === "number")
      throw new Error("Legacy numeric grant tombstones cannot be persisted");
    const successor =
      typeof tombstone === "object" && "refreshSuccessor" in tombstone
        ? tombstone.refreshSuccessor
        : undefined;
    await connection.query(
      `INSERT INTO hyeboard_vnu_refresh_tombstones
         (principal_key, tombstone_kind, tombstone_id, expires_at_ms,
          linked_access_token_id, linked_access_expires_at_ms, linked_grant_expires_at_ms,
          successor_access_token_id, successor_access_expires_at_ms, successor_grant_id, successor_grant_expires_at_ms)
       VALUES ($1, 'grant', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        principalKey,
        grantId,
        tombstone.grantExpiresAt,
        tombstone.accessTokenId,
        tombstone.accessExpiresAt,
        tombstone.grantExpiresAt,
        successor?.accessTokenId ?? null,
        successor?.accessExpiresAt ?? null,
        successor?.grantId ?? null,
        successor?.grantExpiresAt ?? null,
      ],
    );
  }
}

export class PostgresVnuRefreshControlCoordinator
  implements VnuRefreshControlCoordinator
{
  constructor(private readonly pool: PostgresPoolLike) {}

  private async transition<T>(
    principalKey: string,
    transition: (
      state: VnuRefreshControlState | undefined,
      now: number,
    ) => { state: VnuRefreshControlState; result: T; changed: boolean },
  ): Promise<T> {
    assertPrincipalKey(principalKey);
    try {
      return await this.pool.transaction(async (connection) => {
        await connection.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [principalKey],
        );
        const stored = await loadState(connection, principalKey);
        const output = transition(stored, Date.now());
        if (output.changed) {
          if (isQuiescentVnuRefreshState(output.state)) {
            await connection.query(
              "DELETE FROM hyeboard_vnu_refresh_principals WHERE principal_key = $1",
              [principalKey],
            );
          } else {
            await saveState(connection, principalKey, output.state);
          }
        }
        return output.result;
      });
    } catch {
      throw vnuRefreshUnavailable();
    }
  }

  activatePair(
    principalKey: string,
    pair: LinkedPair,
  ): Promise<ActivatePairResult> {
    assertLinkedPair(pair);
    return this.transition(principalKey, (state, now) =>
      applyActivatePair(state, pair, now),
    );
  }

  checkAccess(principalKey: string, access: AccessDescriptorRef) {
    assertAccessDescriptorRef(access);
    return this.transition(principalKey, (state, now) =>
      applyCheckAccess(state, access, now),
    );
  }

  beginRefresh(
    principalKey: string,
    pair: LinkedPair,
  ): Promise<BeginRefreshResult> {
    assertLinkedPair(pair);
    return this.transition(principalKey, (state, now) =>
      applyBeginRefresh(state, pair, now),
    );
  }

  async completeRefresh(
    principalKey: string,
    input: { old: LinkedPair; next: LinkedPair },
  ): Promise<"completed" | "revoked"> {
    assertLinkedPair(input.old);
    assertLinkedPair(input.next);
    return (
      await this.transition(principalKey, (state, now) =>
        applyCompleteRefresh(state, input, now),
      )
    ).kind;
  }

  async abortRefresh(
    principalKey: string,
    input: { pair: LinkedPair; terminal: boolean },
  ): Promise<void> {
    assertLinkedPair(input.pair);
    await this.transition(principalKey, (state, now) =>
      applyAbortRefresh(state, input, now),
    );
  }

  async revokeLinkedPairByAccess(
    principalKey: string,
    pair: AccessDescriptorRef,
  ): Promise<"revoked" | "mismatch" | "expired"> {
    assertAccessDescriptorRef(pair);
    return (
      await this.transition(principalKey, (state, now) =>
        applyRevokeLinkedPairByAccess(state, pair, now),
      )
    ).kind;
  }

  async revokePrincipalByLinkedGrant(
    principalKey: string,
    pair: LinkedPair,
  ): Promise<"revoked" | "mismatch" | "expired"> {
    assertLinkedPair(pair);
    return (
      await this.transition(principalKey, (state, now) =>
        applyRevokePrincipalByLinkedGrant(state, pair, now),
      )
    ).kind;
  }

  async revokeExactLinkedPair(
    principalKey: string,
    pair: LinkedPair,
  ): Promise<"revoked" | "mismatch" | "expired"> {
    assertLinkedPair(pair);
    return (
      await this.transition(principalKey, (state, now) =>
        applyRevokeExactLinkedPair(state, pair, now),
      )
    ).kind;
  }
}
