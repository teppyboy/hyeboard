import { describe, expect, it, vi } from "vitest";
import {
  DurableObjectVnuRefreshControlCoordinator,
  VNU_MANUAL_ACTIVATION_LIMIT,
  VNU_MANUAL_ACTIVATION_WINDOW_MS,
  VNU_REFRESH_ATTEMPT_LIMIT,
  VNU_REFRESH_LEASE_MS,
  VNU_REFRESH_STATE_KEY,
  VNU_REFRESH_WINDOW_MS,
  applyAbortRefresh,
  applyActivatePair,
  applyBeginRefresh,
  applyCheckAccess,
  applyCompleteRefresh,
  applyRevokeExactLinkedPair,
  applyRevokeLinkedPairByAccess,
  applyRevokePrincipalByLinkedGrant,
  cleanVnuRefreshState,
  deriveVnuRefreshPrincipal,
  nextVnuRefreshAlarm,
  parseVnuRefreshControlState,
  vnuRefreshUnavailable,
  type LinkedPair,
  type VnuRefreshControlState,
  type VnuRefreshControlStub,
} from "./vnu-refresh-control";

const NOW = Date.parse("2036-02-03T04:05:06.000Z");
const EXPIRY = NOW + 8 * 60 * 60 * 1000;
const OLD: LinkedPair = {
  accessTokenId: "A".repeat(22),
  accessExpiresAt: EXPIRY - 60_000,
  grantId: "B".repeat(22),
  grantExpiresAt: EXPIRY,
};
const NEXT: LinkedPair = {
  accessTokenId: "C".repeat(22),
  accessExpiresAt: EXPIRY + 60_000,
  grantId: "D".repeat(22),
  grantExpiresAt: EXPIRY,
};
const NEWER: LinkedPair = {
  accessTokenId: "E".repeat(22),
  accessExpiresAt: EXPIRY + 120_000,
  grantId: "F".repeat(22),
  grantExpiresAt: EXPIRY,
};
const grantTombstone = (pair: LinkedPair) => ({
  accessTokenId: pair.accessTokenId,
  accessExpiresAt: pair.accessExpiresAt,
  grantExpiresAt: pair.grantExpiresAt,
});
const refreshTombstone = (old: LinkedPair, next: LinkedPair) => ({
  ...grantTombstone(old),
  refreshSuccessor: next,
});
const stale = (state: VnuRefreshControlState): VnuRefreshControlState => ({
  ...state,
  revokedAccess: { ...state.revokedAccess, ["S".repeat(22)]: NOW },
});

describe("normative VNU refresh contracts", () => {
  it("uses exact state key and optional active/lease shape", () => {
    expect(VNU_REFRESH_STATE_KEY).toBe("vnu-refresh-control");
    const state = applyActivatePair(undefined, OLD, NOW).state;
    expect(state).toEqual({
      active: OLD,
      lease: undefined,
      revokedAccess: {},
      revokedGrants: {},
      window: { count: 0, resetAt: NOW + VNU_REFRESH_WINDOW_MS },
      activationWindow: {
        count: 1,
        resetAt: NOW + VNU_MANUAL_ACTIVATION_WINDOW_MS,
      },
    });
    const leased = applyBeginRefresh(state, OLD, NOW).state;
    expect(leased.lease).toEqual({
      pair: OLD,
      expiresAt: NOW + VNU_REFRESH_LEASE_MS,
    });
  });

  it("parses only exact allowed state, lease, pair, maps, and window shapes", () => {
    const state = applyBeginRefresh(
      applyActivatePair(undefined, OLD, NOW).state,
      OLD,
      NOW,
    ).state;
    expect(parseVnuRefreshControlState(state)).toEqual(state);
    for (const invalid of [
      { ...state, extra: true },
      { ...state, lease: { ...state.lease, accessTokenId: OLD.accessTokenId } },
      { ...state, active: { ...OLD, extra: true } },
      { ...state, revokedAccess: undefined },
      {
        ...state,
        revokedGrants: {
          ["E".repeat(22)]: { ...grantTombstone(NEXT), extra: true },
        },
      },
      { ...state, window: { count: -1, resetAt: NOW } },
    ])
      expect(() => parseVnuRefreshControlState(invalid)).toThrow(
        /Invalid VNU refresh (state|pair)/,
      );
  });

  it("strictly parses bounded refresh successor provenance", () => {
    const completed = applyCompleteRefresh(
      applyBeginRefresh(applyActivatePair(undefined, OLD, NOW).state, OLD, NOW)
        .state,
      { old: OLD, next: NEXT },
      NOW + 1,
    ).state;
    expect(parseVnuRefreshControlState(completed)).toEqual(completed);
    for (const invalidSuccessor of [
      { ...NEXT, extra: true },
      { ...NEXT, accessTokenId: OLD.accessTokenId },
      { ...NEXT, grantId: OLD.grantId },
      { ...NEXT, grantExpiresAt: NEXT.grantExpiresAt + 1 },
    ]) {
      const invalid = {
        ...completed,
        revokedGrants: {
          [OLD.grantId]: {
            ...grantTombstone(OLD),
            refreshSuccessor: invalidSuccessor,
          },
        },
      };
      expect(() => parseVnuRefreshControlState(invalid)).toThrow(
        /Invalid VNU refresh (state|pair)/,
      );
    }
  });

  it("rejects impossible relational authority states", () => {
    const active = applyActivatePair(undefined, OLD, NOW).state;
    const impossible = [
      {
        ...active,
        lease: { pair: OLD, expiresAt: NOW + 1 },
        active: undefined,
      },
      { ...active, lease: { pair: NEXT, expiresAt: NOW + 1 } },
      { ...active, lease: { pair: OLD, expiresAt: OLD.grantExpiresAt + 1 } },
      {
        ...active,
        revokedAccess: { [OLD.accessTokenId]: OLD.accessExpiresAt },
      },
      { ...active, revokedGrants: { [OLD.grantId]: OLD.grantExpiresAt } },
      { ...active, window: { count: 6, resetAt: EXPIRY } },
    ];
    for (const state of impossible)
      expect(() => parseVnuRefreshControlState(state)).toThrow(
        "Invalid VNU refresh state",
      );
  });

  it("parses legacy numeric grant tombstones but never promotes them to pair linkage", () => {
    const legacy: VnuRefreshControlState = {
      active: NEXT,
      revokedAccess: {},
      revokedGrants: { [OLD.grantId]: OLD.grantExpiresAt },
      window: { count: 1, resetAt: EXPIRY + 1 },
    };
    expect(parseVnuRefreshControlState(legacy)).toEqual(legacy);
    expect(applyRevokePrincipalByLinkedGrant(legacy, OLD, NOW + 1)).toEqual({
      state: legacy,
      result: { kind: "mismatch" },
      changed: false,
    });
    expect(applyCheckAccess(legacy, NEXT, NOW + 1).result).toEqual({
      kind: "active",
    });
  });

  it("rejects ambiguous grant tombstones despite an exact access tombstone", () => {
    for (const active of [undefined, NEXT]) {
      const ambiguousGrantTombstones = [
        OLD.grantExpiresAt,
        {
          ...grantTombstone(OLD),
          accessTokenId: active?.accessTokenId ?? "Y".repeat(22),
        },
        { ...grantTombstone(OLD), accessExpiresAt: OLD.accessExpiresAt - 1 },
      ];
      for (const tombstone of ambiguousGrantTombstones) {
        const state: VnuRefreshControlState = {
          ...(active ? { active } : {}),
          revokedAccess: { [OLD.accessTokenId]: OLD.accessExpiresAt },
          revokedGrants: { [OLD.grantId]: tombstone },
          window: { count: 0, resetAt: EXPIRY + 1 },
        };
        expect(applyRevokeLinkedPairByAccess(state, OLD, NOW + 1)).toEqual({
          state,
          result: { kind: "mismatch" },
          changed: false,
        });
        expect(nextVnuRefreshAlarm(state)).toBe(OLD.accessExpiresAt);
      }
    }
  });

  it("keeps an exact linked tombstone idempotent without touching unrelated active state", () => {
    const state: VnuRefreshControlState = {
      active: NEXT,
      revokedAccess: { [OLD.accessTokenId]: OLD.accessExpiresAt },
      revokedGrants: { [OLD.grantId]: grantTombstone(OLD) },
      window: { count: 0, resetAt: EXPIRY + 1 },
    };
    expect(applyRevokeLinkedPairByAccess(state, OLD, NOW + 1)).toEqual({
      state,
      result: { kind: "revoked" },
      changed: false,
    });
  });

  it("does not schedule quiescent zero-attempt state", () => {
    const state: VnuRefreshControlState = {
      revokedAccess: {},
      revokedGrants: {},
      window: { count: 0, resetAt: NOW + VNU_REFRESH_WINDOW_MS },
    };
    expect(nextVnuRefreshAlarm(state)).toBeUndefined();
  });
});

describe("VNU refresh transitions", () => {
  it("derives the phase-aware retention maximum across every minute offset", () => {
    const retentionLifetimeMs = EXPIRY - NOW;
    const phaseStepMs = 60_000;
    const fullBoundaryCount =
      retentionLifetimeMs / VNU_MANUAL_ACTIVATION_WINDOW_MS;
    const preBoundaryManualCapacity = VNU_MANUAL_ACTIVATION_LIMIT - 1;
    const preBoundaryRefreshCapacity = VNU_REFRESH_ATTEMPT_LIMIT;
    const phaseAwareManualMaximum =
      fullBoundaryCount * VNU_MANUAL_ACTIVATION_LIMIT +
      preBoundaryManualCapacity;
    const phaseAwareRefreshMaximum =
      fullBoundaryCount * VNU_REFRESH_ATTEMPT_LIMIT +
      preBoundaryRefreshCapacity;
    const phaseAwareAggregateMaximum =
      phaseAwareManualMaximum + phaseAwareRefreshMaximum;
    expect(VNU_MANUAL_ACTIVATION_WINDOW_MS).toBe(VNU_REFRESH_WINDOW_MS);

    const retainedAtPhase = (seedBeforeRetentionBoundaryMs: number) => {
      const firstResetAfterRetentionBoundaryMs =
        VNU_MANUAL_ACTIVATION_WINDOW_MS - seedBeforeRetentionBoundaryMs;
      const hasPreBoundaryBurst = firstResetAfterRetentionBoundaryMs > 0;
      let manual = hasPreBoundaryBurst ? preBoundaryManualCapacity : 0;
      let refresh = hasPreBoundaryBurst ? preBoundaryRefreshCapacity : 0;
      for (
        let boundary = firstResetAfterRetentionBoundaryMs;
        boundary <= retentionLifetimeMs;
        boundary += VNU_MANUAL_ACTIVATION_WINDOW_MS
      ) {
        if (boundary <= 0) continue;
        manual += VNU_MANUAL_ACTIVATION_LIMIT;
        refresh += VNU_REFRESH_ATTEMPT_LIMIT;
      }
      return { manual, refresh, total: manual + refresh };
    };

    const phaseCounts = Array.from(
      { length: VNU_MANUAL_ACTIVATION_WINDOW_MS / phaseStepMs + 1 },
      (_, phaseMinutes) => retainedAtPhase(phaseMinutes * phaseStepMs),
    );
    expect(phaseAwareManualMaximum).toBe(164);
    expect(phaseAwareRefreshMaximum).toBe(165);
    expect(phaseAwareAggregateMaximum).toBe(329);
    expect(Math.max(...phaseCounts.map(({ total }) => total))).toBe(
      phaseAwareAggregateMaximum,
    );
    expect(
      phaseCounts.every(
        ({ manual, refresh, total }) =>
          manual <= phaseAwareManualMaximum &&
          refresh <= phaseAwareRefreshMaximum &&
          total <= phaseAwareAggregateMaximum,
      ),
    ).toBe(true);
  });

  it("bounds manual activations independently from refresh attempts and resets exactly", () => {
    const pairs = Array.from(
      { length: VNU_MANUAL_ACTIVATION_LIMIT + 1 },
      (_, index): LinkedPair => ({
        accessTokenId: String(index).padStart(22, "A"),
        accessExpiresAt: EXPIRY,
        grantId: String(index).padStart(22, "B"),
        grantExpiresAt: EXPIRY,
      }),
    );
    let state: VnuRefreshControlState | undefined;
    for (const pair of pairs.slice(0, VNU_MANUAL_ACTIVATION_LIMIT)) {
      const activated = applyActivatePair(state, pair, NOW);
      expect(activated).toMatchObject({
        result: { kind: "activated" },
        changed: true,
      });
      state = activated.state;
    }

    const rejected = applyActivatePair(state, pairs.at(-1)!, NOW + 1);
    expect(rejected).toEqual({
      state,
      result: {
        kind: "rate-limited",
        retryAfterSeconds: 900,
        limit: VNU_MANUAL_ACTIVATION_LIMIT,
        windowSeconds: VNU_MANUAL_ACTIVATION_WINDOW_MS / 1000,
      },
      changed: false,
    });
    expect(Object.keys(rejected.state.revokedGrants)).toHaveLength(
      VNU_MANUAL_ACTIVATION_LIMIT - 1,
    );

    let refreshState = state!;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const begun = applyBeginRefresh(
        refreshState,
        refreshState.active!,
        NOW + attempt,
      );
      expect(begun.result.kind).toBe("accepted");
      refreshState = applyAbortRefresh(
        begun.state,
        { pair: begun.state.active!, terminal: false },
        NOW + attempt,
      ).state;
    }
    expect(refreshState.window.count).toBe(5);

    const reset = applyActivatePair(
      state,
      pairs.at(-1)!,
      NOW + VNU_MANUAL_ACTIVATION_WINDOW_MS,
    );
    expect(reset).toMatchObject({
      result: { kind: "activated" },
      changed: true,
      state: {
        activationWindow: {
          count: 1,
          resetAt: NOW + 2 * VNU_MANUAL_ACTIVATION_WINDOW_MS,
        },
      },
    });
  });

  it("parses missing activation windows for compatibility and rejects corrupt windows", () => {
    const legacy = applyActivatePair(undefined, OLD, NOW).state;
    const withoutActivationWindow = { ...legacy, activationWindow: undefined };
    delete withoutActivationWindow.activationWindow;
    expect(parseVnuRefreshControlState(withoutActivationWindow)).toEqual(
      withoutActivationWindow,
    );
    expect(
      applyActivatePair(withoutActivationWindow, NEXT, NOW + 1).state
        .activationWindow,
    ).toEqual({
      count: 1,
      resetAt: NOW + 1 + VNU_MANUAL_ACTIVATION_WINDOW_MS,
    });
    for (const activationWindow of [
      { count: -1, resetAt: NOW + 1 },
      { count: VNU_MANUAL_ACTIVATION_LIMIT + 1, resetAt: NOW + 1 },
      { count: 1, resetAt: 0 },
      { count: 1, resetAt: NOW + 1, extra: true },
    ])
      expect(() =>
        parseVnuRefreshControlState({ ...legacy, activationWindow }),
      ).toThrow("Invalid VNU refresh state");
  });

  it("cleans the manual window at its exact boundary without a perpetual alarm", () => {
    const activated = applyActivatePair(undefined, OLD, NOW).state;
    const authorityFree = { ...activated, active: undefined };
    const cleaned = cleanVnuRefreshState(
      authorityFree,
      NOW + VNU_MANUAL_ACTIVATION_WINDOW_MS,
    );
    expect(cleaned.activationWindow).toBeUndefined();
    expect(nextVnuRefreshAlarm(cleaned)).toBeUndefined();
  });

  it("does not let a replaced manual pair authorize revocation of its successor", () => {
    const replaced = applyActivatePair(
      applyActivatePair(undefined, OLD, NOW).state,
      NEXT,
      NOW + 1,
    ).state;

    expect(applyRevokePrincipalByLinkedGrant(replaced, OLD, NOW + 2)).toEqual({
      state: replaced,
      result: { kind: "mismatch" },
      changed: false,
    });
    expect(applyCheckAccess(replaced, NEXT, NOW + 2).result).toEqual({
      kind: "active",
    });
  });

  it.each([false, true])(
    "revokes only the exact refresh successor with lease=%s",
    (withLease) => {
      const leasedOld = applyBeginRefresh(
        applyActivatePair(undefined, OLD, NOW).state,
        OLD,
        NOW,
      ).state;
      const completed = applyCompleteRefresh(
        leasedOld,
        { old: OLD, next: NEXT },
        NOW + 1,
      ).state;
      const successor = withLease
        ? applyBeginRefresh(completed, NEXT, NOW + 2).state
        : completed;
      const revoked = applyRevokePrincipalByLinkedGrant(
        successor,
        OLD,
        NOW + 3,
      );

      expect(revoked).toMatchObject({
        result: { kind: "revoked" },
        changed: true,
        state: { active: undefined, lease: undefined },
      });
      expect(
        applyRevokePrincipalByLinkedGrant(revoked.state, OLD, NOW + 4),
      ).toEqual({
        state: revoked.state,
        result: { kind: "revoked" },
        changed: false,
      });
    },
  );

  it.each([false, true])(
    "does not revoke a manual pair that replaced a refresh successor with lease=%s",
    (leaseSuccessor) => {
      const leasedOld = applyBeginRefresh(
        applyActivatePair(undefined, OLD, NOW).state,
        OLD,
        NOW,
      ).state;
      const completed = applyCompleteRefresh(
        leasedOld,
        { old: OLD, next: NEXT },
        NOW + 1,
      ).state;
      const successor = leaseSuccessor
        ? applyBeginRefresh(completed, NEXT, NOW + 2).state
        : completed;
      const replaced = applyActivatePair(successor, NEWER, NOW + 3).state;

      expect(applyRevokePrincipalByLinkedGrant(replaced, OLD, NOW + 4)).toEqual(
        {
          state: replaced,
          result: { kind: "mismatch" },
          changed: false,
        },
      );
      expect(applyCheckAccess(replaced, NEWER, NOW + 4).result).toEqual({
        kind: "active",
      });
    },
  );

  it("fails closed for pre-provenance linked tombstones while preserving idempotence without active authority", () => {
    const preProvenance: VnuRefreshControlState = {
      active: NEXT,
      revokedAccess: { [OLD.accessTokenId]: OLD.accessExpiresAt },
      revokedGrants: { [OLD.grantId]: grantTombstone(OLD) },
      window: { count: 0, resetAt: EXPIRY + 1 },
    };
    expect(
      applyRevokePrincipalByLinkedGrant(preProvenance, OLD, NOW + 1),
    ).toEqual({
      state: preProvenance,
      result: { kind: "mismatch" },
      changed: false,
    });
    const withoutActive = { ...preProvenance, active: undefined };
    expect(
      applyRevokePrincipalByLinkedGrant(withoutActive, OLD, NOW + 1),
    ).toEqual({
      state: withoutActive,
      result: { kind: "revoked" },
      changed: false,
    });
  });

  it("activates and atomically revokes a replaced pair", () => {
    const first = applyActivatePair(undefined, OLD, NOW);
    const second = applyActivatePair(first.state, NEXT, NOW + 1);
    expect(first).toMatchObject({
      result: { kind: "activated" },
      changed: true,
    });
    expect(second).toMatchObject({
      result: { kind: "activated" },
      changed: true,
      state: { active: NEXT },
    });
    expect(second.state.revokedAccess[OLD.accessTokenId]).toBe(
      OLD.accessExpiresAt,
    );
    expect(second.state.revokedGrants[OLD.grantId]).toEqual(
      grantTombstone(OLD),
    );
  });

  it("same activation is unchanged without lease and clears lease as one mutation", () => {
    const active = applyActivatePair(undefined, OLD, NOW).state;
    expect(applyActivatePair(active, OLD, NOW + 1)).toEqual({
      state: active,
      result: { kind: "activated" },
      changed: false,
    });
    const leased = applyBeginRefresh(active, OLD, NOW).state;
    const cleared = applyActivatePair(leased, OLD, NOW + 1);
    expect(cleared).toMatchObject({
      result: { kind: "activated" },
      changed: true,
    });
    expect(cleared.state.lease).toBeUndefined();
  });

  it("never leases at or after grant expiry", () => {
    const pair = { ...OLD, accessExpiresAt: EXPIRY + 60_000 };
    const active = applyActivatePair(undefined, pair, NOW).state;
    expect(applyBeginRefresh(active, pair, EXPIRY)).toEqual({
      state: active,
      result: { kind: "revoked" },
      changed: false,
    });
  });

  it("leases once, exposes lease expiry, and duplicates are strict no-ops", () => {
    const active = applyActivatePair(undefined, OLD, NOW).state;
    const first = applyBeginRefresh(active, OLD, NOW);
    expect(first).toMatchObject({
      result: { kind: "accepted", leaseExpiresAt: NOW + 120_000 },
      changed: true,
    });
    expect(first.state.window).toEqual({ count: 1, resetAt: NOW + 900_000 });
    expect(applyBeginRefresh(first.state, OLD, NOW + 1)).toEqual({
      state: first.state,
      result: { kind: "in-progress", retryAfterSeconds: 120 },
      changed: false,
    });
  });

  it("caps lease expiry at the fixed grant boundary", () => {
    const pair = { ...OLD, grantExpiresAt: NOW + 1_000 };
    const active = applyActivatePair(undefined, pair, NOW).state;
    expect(applyBeginRefresh(active, pair, NOW).result).toEqual({
      kind: "accepted",
      leaseExpiresAt: pair.grantExpiresAt,
    });
  });

  it("enforces five attempts and does not smuggle cleanup on rate limit", () => {
    let state = applyActivatePair(undefined, OLD, NOW).state;
    for (let attempt = 0; attempt < 5; attempt += 1)
      state = applyBeginRefresh(state, OLD, NOW + attempt * 120_001).state;
    const snapshot = stale(state);
    expect(applyBeginRefresh(snapshot, OLD, NOW + 5 * 120_001)).toEqual({
      state: snapshot,
      result: {
        kind: "rate-limited",
        retryAfterSeconds: 300,
        limit: 5,
        windowSeconds: 900,
      },
      changed: false,
    });
  });

  it("completes exact rotation and late completion returns revoked unchanged", () => {
    const leased = applyBeginRefresh(
      applyActivatePair(undefined, OLD, NOW).state,
      OLD,
      NOW,
    ).state;
    const completed = applyCompleteRefresh(
      leased,
      { old: OLD, next: NEXT },
      NOW + 1,
    );
    expect(completed).toMatchObject({
      result: { kind: "completed" },
      changed: true,
      state: { active: NEXT },
    });
    expect(
      applyCompleteRefresh(completed.state, { old: OLD, next: NEXT }, NOW + 2),
    ).toEqual({
      state: completed.state,
      result: { kind: "revoked" },
      changed: false,
    });
  });

  it("rejects reused or revoked rotation identifiers before mutation", () => {
    const leased = applyBeginRefresh(
      applyActivatePair(undefined, OLD, NOW).state,
      OLD,
      NOW,
    ).state;
    const collisionState: VnuRefreshControlState = {
      ...leased,
      revokedAccess: {
        ...leased.revokedAccess,
        [NEXT.accessTokenId]: NEXT.accessExpiresAt,
      },
      revokedGrants: {
        ...leased.revokedGrants,
        [NEXT.grantId]: NEXT.grantExpiresAt,
      },
    };
    for (const next of [
      { ...NEXT, accessTokenId: OLD.accessTokenId },
      { ...NEXT, grantId: OLD.grantId },
      NEXT,
    ]) {
      const state = next === NEXT ? collisionState : leased;
      expect(() =>
        applyCompleteRefresh(state, { old: OLD, next }, NOW + 1),
      ).toThrow(/rotation/i);
      expect(state).toEqual(next === NEXT ? collisionState : leased);
    }
  });

  it("aborts retryably, revokes terminally, and absent abort is unchanged", () => {
    const active = applyActivatePair(undefined, OLD, NOW).state;
    expect(
      applyAbortRefresh(active, { pair: OLD, terminal: false }, NOW),
    ).toEqual({ state: active, result: { kind: "aborted" }, changed: false });
    const leased = applyBeginRefresh(active, OLD, NOW).state;
    const retryable = applyAbortRefresh(
      leased,
      { pair: OLD, terminal: false },
      NOW + 1,
    );
    expect(retryable).toMatchObject({
      result: { kind: "aborted" },
      changed: true,
    });
    const terminal = applyAbortRefresh(
      applyBeginRefresh(retryable.state, OLD, NOW + 2).state,
      { pair: OLD, terminal: true },
      NOW + 3,
    );
    expect(terminal).toMatchObject({
      result: { kind: "revoked" },
      changed: true,
    });
  });

  it("keeps exact revoke idempotent between access and grant expiry", () => {
    const pair = { ...OLD, accessExpiresAt: NOW };
    const active = applyActivatePair(undefined, pair, NOW - 1).state;
    const first = applyRevokeLinkedPairByAccess(active, pair, NOW + 1);
    expect(first).toMatchObject({ result: { kind: "revoked" }, changed: true });
    expect(first.state.revokedAccess[pair.accessTokenId]).toBe(
      pair.accessExpiresAt,
    );
    expect(applyRevokeLinkedPairByAccess(first.state, pair, NOW + 2)).toEqual({
      state: first.state,
      result: { kind: "revoked" },
      changed: false,
    });
    const cleaned = cleanVnuRefreshState(first.state, NOW + 3);
    expect(cleaned.revokedAccess[pair.accessTokenId]).toBeUndefined();
    expect(applyRevokeLinkedPairByAccess(cleaned, pair, NOW + 3)).toEqual({
      state: cleaned,
      result: { kind: "revoked" },
      changed: false,
    });
    const stillLiveWrongAccess = {
      ...pair,
      accessTokenId: "Z".repeat(22),
      accessExpiresAt: NOW + 4,
    };
    expect(
      applyRevokeLinkedPairByAccess(cleaned, stillLiveWrongAccess, NOW + 3),
    ).toEqual({ state: cleaned, result: { kind: "mismatch" }, changed: false });
    expect(
      applyRevokeLinkedPairByAccess(
        cleaned,
        { ...pair, grantId: "Z".repeat(22) },
        NOW + 3,
      ),
    ).toEqual({ state: cleaned, result: { kind: "mismatch" }, changed: false });
    expect(
      applyRevokeLinkedPairByAccess(
        cleaned,
        { ...pair, grantExpiresAt: pair.grantExpiresAt + 1 },
        NOW + 3,
      ),
    ).toEqual({ state: cleaned, result: { kind: "mismatch" }, changed: false });
  });

  it("expires access tombstones independently; unrelated grants cannot extend them", () => {
    const oldAccessId = "E".repeat(22);
    const unrelatedGrantId = "F".repeat(22);
    const stored: VnuRefreshControlState = {
      revokedAccess: { [oldAccessId]: NOW },
      revokedGrants: { [unrelatedGrantId]: EXPIRY },
      window: { count: 0, resetAt: EXPIRY },
    };
    const cleaned = cleanVnuRefreshState(stored, NOW + 1);
    expect(cleaned.revokedAccess).toEqual({});
    expect(cleaned.revokedGrants).toEqual({ [unrelatedGrantId]: EXPIRY });
    expect(nextVnuRefreshAlarm(cleaned)).toBe(EXPIRY);
  });

  it("all stale-candidate no-ops preserve the exact original snapshot", () => {
    const active = applyActivatePair(undefined, OLD, NOW).state;
    const leased = applyBeginRefresh(active, OLD, NOW).state;
    const completed = applyCompleteRefresh(
      leased,
      { old: OLD, next: NEXT },
      NOW + 1,
    ).state;
    const revoked = applyRevokeLinkedPairByAccess(active, OLD, NOW + 1).state;
    const staleActive = stale(active);
    const staleLeased = stale(leased);
    const staleCompleted = stale(completed);
    const staleRevoked = stale(revoked);
    const cases = [
      applyActivatePair(staleActive, OLD, NOW + 1),
      applyBeginRefresh(staleLeased, OLD, NOW + 1),
      applyBeginRefresh(staleCompleted, OLD, NOW + 2),
      applyCompleteRefresh(staleCompleted, { old: OLD, next: NEXT }, NOW + 2),
      applyAbortRefresh(staleActive, { pair: OLD, terminal: false }, NOW + 1),
      applyRevokeLinkedPairByAccess(
        staleActive,
        { ...OLD, grantId: "Z".repeat(22) },
        NOW + 1,
      ),
      applyRevokeLinkedPairByAccess(staleRevoked, OLD, NOW + 2),
    ];
    for (const output of cases) expect(output.changed).toBe(false);
    expect(cases.map((output) => output.state)).toEqual([
      staleActive,
      staleLeased,
      staleCompleted,
      staleCompleted,
      staleActive,
      staleActive,
      staleRevoked,
    ]);
    const expired = { ...OLD, accessExpiresAt: NOW, grantExpiresAt: NOW };
    const staleExpired = stale({
      revokedAccess: {},
      revokedGrants: {},
      window: { count: 0, resetAt: EXPIRY },
    });
    expect(applyRevokeLinkedPairByAccess(staleExpired, expired, NOW)).toEqual({
      state: staleExpired,
      result: { kind: "expired" },
      changed: false,
    });
    const cleaned = cleanVnuRefreshState(staleExpired, NOW);
    expect(applyRevokeLinkedPairByAccess(cleaned, expired, NOW)).toEqual({
      state: cleaned,
      result: { kind: "expired" },
      changed: false,
    });
  });

  it("accepts only exact old rotation tombstones idempotently while next remains active", () => {
    const leased = applyBeginRefresh(
      applyActivatePair(undefined, OLD, NOW).state,
      OLD,
      NOW,
    ).state;
    const rotated = applyCompleteRefresh(
      leased,
      { old: OLD, next: NEXT },
      NOW + 1,
    ).state;
    expect(applyRevokeLinkedPairByAccess(rotated, OLD, NOW + 2)).toEqual({
      state: rotated,
      result: { kind: "revoked" },
      changed: false,
    });
    for (const wrong of [
      { ...OLD, accessExpiresAt: OLD.accessExpiresAt + 1 },
      { ...OLD, grantExpiresAt: OLD.grantExpiresAt + 1 },
      { ...OLD, accessTokenId: "Z".repeat(22) },
      { ...OLD, grantId: "Z".repeat(22) },
    ])
      expect(applyRevokeLinkedPairByAccess(rotated, wrong, NOW + 2)).toEqual({
        state: rotated,
        result: { kind: "mismatch" },
        changed: false,
      });
    const oneTombstone = { ...rotated, revokedGrants: {} };
    expect(applyRevokeLinkedPairByAccess(oneTombstone, OLD, NOW + 2)).toEqual({
      state: oneTombstone,
      result: { kind: "mismatch" },
      changed: false,
    });
    expect(applyCheckAccess(rotated, NEXT, NOW + 2).result).toEqual({
      kind: "active",
    });
  });

  it("uses an exact old linked grant proof to revoke a completed rotation", () => {
    const leased = applyBeginRefresh(
      applyActivatePair(undefined, OLD, NOW).state,
      OLD,
      NOW,
    ).state;
    const rotated = applyCompleteRefresh(
      leased,
      { old: OLD, next: NEXT },
      NOW + 1,
    ).state;
    const revoked = applyRevokePrincipalByLinkedGrant(rotated, OLD, NOW + 2);
    expect(revoked).toMatchObject({
      result: { kind: "revoked" },
      changed: true,
    });
    expect(revoked.state.active).toBeUndefined();
    expect(revoked.state.lease).toBeUndefined();
    expect(revoked.state.revokedAccess).toMatchObject({
      [OLD.accessTokenId]: OLD.accessExpiresAt,
      [NEXT.accessTokenId]: NEXT.accessExpiresAt,
    });
    expect(revoked.state.revokedGrants).toMatchObject({
      [OLD.grantId]: grantTombstone(OLD),
      [NEXT.grantId]: grantTombstone(NEXT),
    });
    expect(
      applyRevokePrincipalByLinkedGrant(revoked.state, OLD, NOW + 3),
    ).toEqual({
      state: revoked.state,
      result: { kind: "revoked" },
      changed: false,
    });
  });

  it("rejects malformed old linkage without mutating the current pair", () => {
    const leased = applyBeginRefresh(
      applyActivatePair(undefined, OLD, NOW).state,
      OLD,
      NOW,
    ).state;
    const rotated = applyCompleteRefresh(
      leased,
      { old: OLD, next: NEXT },
      NOW + 1,
    ).state;
    for (const wrong of [
      { ...OLD, accessTokenId: "Z".repeat(22) },
      { ...OLD, accessExpiresAt: OLD.accessExpiresAt + 1 },
      { ...OLD, grantId: "Y".repeat(22) },
      { ...OLD, grantExpiresAt: OLD.grantExpiresAt + 1 },
    ]) {
      expect(
        applyRevokePrincipalByLinkedGrant(rotated, wrong, NOW + 2),
      ).toEqual({
        state: rotated,
        result: { kind: "mismatch" },
        changed: false,
      });
    }
  });

  it("uses an exact live old grant after its access tombstone is cleaned while next stays active", () => {
    const old = { ...OLD, accessExpiresAt: NOW };
    const leased = applyBeginRefresh(
      applyActivatePair(undefined, old, NOW - 1).state,
      old,
      NOW - 1,
    ).state;
    const rotated = applyCompleteRefresh(
      leased,
      { old, next: NEXT },
      NOW,
    ).state;
    const cleaned = cleanVnuRefreshState(rotated, NOW + 1);
    expect(cleaned.revokedAccess).toEqual({});
    expect(cleaned.revokedGrants).toEqual({
      [old.grantId]: refreshTombstone(old, NEXT),
    });
    expect(applyRevokeLinkedPairByAccess(cleaned, old, NOW + 1)).toEqual({
      state: cleaned,
      result: { kind: "revoked" },
      changed: false,
    });
    for (const wrong of [
      { ...old, accessTokenId: "Y".repeat(22) },
      { ...old, accessExpiresAt: old.accessExpiresAt - 1 },
      { ...old, grantId: "Z".repeat(22) },
      { ...old, grantExpiresAt: old.grantExpiresAt + 1 },
    ]) {
      expect(applyRevokeLinkedPairByAccess(cleaned, wrong, NOW + 1)).toEqual({
        state: cleaned,
        result: { kind: "mismatch" },
        changed: false,
      });
      expect(
        applyRevokePrincipalByLinkedGrant(cleaned, wrong, NOW + 1),
      ).toEqual({
        state: cleaned,
        result: { kind: "mismatch" },
        changed: false,
      });
    }
    expect(
      applyRevokeLinkedPairByAccess(
        cleaned,
        { ...old, accessTokenId: "Z".repeat(22), accessExpiresAt: NOW + 2 },
        NOW + 1,
      ),
    ).toEqual({ state: cleaned, result: { kind: "mismatch" }, changed: false });
    expect(applyCheckAccess(cleaned, NEXT, NOW + 1).result).toEqual({
      kind: "active",
    });
    const principalRevoked = applyRevokePrincipalByLinkedGrant(
      cleaned,
      old,
      NOW + 1,
    );
    expect(principalRevoked).toMatchObject({
      result: { kind: "revoked" },
      changed: true,
    });
    expect(principalRevoked.state.active).toBeUndefined();
    expect(principalRevoked.state.revokedAccess[NEXT.accessTokenId]).toBe(
      NEXT.accessExpiresAt,
    );
  });

  it("requires exact old four-field linkage while next is leased", () => {
    const old = { ...OLD, accessExpiresAt: NOW };
    const rotated = applyCompleteRefresh(
      applyBeginRefresh(
        applyActivatePair(undefined, old, NOW - 1).state,
        old,
        NOW - 1,
      ).state,
      { old, next: NEXT },
      NOW,
    ).state;
    const cleaned = cleanVnuRefreshState(rotated, NOW + 1);
    const leasedNext = applyBeginRefresh(cleaned, NEXT, NOW + 1).state;
    for (const wrong of [
      { ...old, accessTokenId: "Y".repeat(22) },
      { ...old, accessExpiresAt: old.accessExpiresAt - 1 },
    ]) {
      expect(
        applyRevokePrincipalByLinkedGrant(leasedNext, wrong, NOW + 2),
      ).toEqual({
        state: leasedNext,
        result: { kind: "mismatch" },
        changed: false,
      });
    }
    const revoked = applyRevokePrincipalByLinkedGrant(leasedNext, old, NOW + 2);
    expect(revoked).toMatchObject({
      result: { kind: "revoked" },
      changed: true,
    });
    expect(revoked.state.active).toBeUndefined();
    expect(revoked.state.lease).toBeUndefined();
    expect(
      applyRevokePrincipalByLinkedGrant(revoked.state, old, NOW + 3),
    ).toEqual({
      state: revoked.state,
      result: { kind: "revoked" },
      changed: false,
    });
  });

  it("exact linked revoke and grantless revoke share exact boundaries", () => {
    const active = applyActivatePair(undefined, OLD, NOW).state;
    expect(
      applyRevokeExactLinkedPair(
        active,
        { ...OLD, grantId: "Z".repeat(22) },
        NOW + 1,
      ),
    ).toEqual({ state: active, result: { kind: "mismatch" }, changed: false });
    expect(applyRevokeExactLinkedPair(active, OLD, NOW + 1)).toMatchObject({
      result: { kind: "revoked" },
      changed: true,
    });
    const expired = { ...OLD, accessExpiresAt: NOW, grantExpiresAt: NOW };
    expect(applyRevokeExactLinkedPair(undefined, expired, NOW)).toMatchObject({
      result: { kind: "expired" },
      changed: false,
    });
  });

  it("retains active link and grant alarm after access expiry", () => {
    const pair = {
      ...OLD,
      accessExpiresAt: NOW + 1_000,
      grantExpiresAt: NOW + 2_000,
    };
    const stored: VnuRefreshControlState = {
      active: pair,
      revokedAccess: {},
      revokedGrants: {},
      window: { count: 0, resetAt: NOW + 3_000 },
    };
    expect(nextVnuRefreshAlarm(stored)).toBe(pair.grantExpiresAt);
    expect(applyCheckAccess(stored, pair, NOW + 1_000)).toEqual({
      state: stored,
      result: { kind: "revoked" },
      changed: false,
    });
    expect(applyCheckAccess(stored, pair, NOW + 1_001)).toEqual({
      state: stored,
      result: { kind: "revoked" },
      changed: false,
    });
    expect(
      cleanVnuRefreshState(stored, pair.grantExpiresAt).active,
    ).toBeUndefined();
  });
});

describe("VNU refresh coordinator", () => {
  const allMethods = (calls: unknown[]) =>
    ({
      activatePair: async (pair: LinkedPair) => {
        calls.push(["activatePair", pair]);
        return { kind: "activated" as const };
      },
      checkAccess: async (pair: LinkedPair) => {
        calls.push(["checkAccess", pair]);
        return { kind: "active" as const };
      },
      beginRefresh: async (pair: LinkedPair) => {
        calls.push(["beginRefresh", pair]);
        return { kind: "accepted" as const, leaseExpiresAt: NOW };
      },
      completeRefresh: async (input: { old: LinkedPair; next: LinkedPair }) => {
        calls.push(["completeRefresh", input]);
        return { kind: "completed" as const };
      },
      abortRefresh: async (input: { pair: LinkedPair; terminal: boolean }) => {
        calls.push(["abortRefresh", input]);
        return { kind: "aborted" as const };
      },
      revokeLinkedPairByAccess: async (pair: LinkedPair) => {
        calls.push(["revokeLinkedPairByAccess", pair]);
        return { kind: "revoked" as const };
      },
      revokePrincipalByLinkedGrant: async (pair: LinkedPair) => {
        calls.push(["revokePrincipalByLinkedGrant", pair]);
        return { kind: "revoked" as const };
      },
      revokeExactLinkedPair: async (pair: LinkedPair) => {
        calls.push(["revokeExactLinkedPair", pair]);
        return { kind: "revoked" as const };
      },
    }) satisfies VnuRefreshControlStub;

  it("derives a stable opaque lowercase principal", async () => {
    const secret = "synthetic-worker-secret-with-at-least-32-chars";
    const first = await deriveVnuRefreshPrincipal(
      " SYNTHETIC-VNU-USER ",
      secret,
    );
    expect(first).toBe(
      await deriveVnuRefreshPrincipal("synthetic-vnu-user", secret),
    );
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toContain("synthetic");
  });

  it("uses exact RPC signatures and serializes no credential or identity", async () => {
    const calls: unknown[] = [];
    const getByName = vi.fn(() => allMethods(calls));
    const coordinator = new DurableObjectVnuRefreshControlCoordinator({
      getByName,
    });
    const principal = "a".repeat(64);
    await expect(coordinator.activatePair(principal, OLD)).resolves.toEqual({
      kind: "activated",
    });
    await coordinator.checkAccess(principal, OLD);
    await coordinator.beginRefresh(principal, OLD);
    await coordinator.completeRefresh(principal, { old: OLD, next: NEXT });
    await coordinator.abortRefresh(principal, { pair: OLD, terminal: false });
    await coordinator.revokeLinkedPairByAccess(principal, OLD);
    await coordinator.revokePrincipalByLinkedGrant(principal, OLD);
    await coordinator.revokeExactLinkedPair(principal, OLD);
    expect(getByName).toHaveBeenCalledTimes(8);
    expect(JSON.stringify(calls)).not.toMatch(
      /username|password|studentCode|cookie|raw.?token|SYNTHETIC-VNU-USER/i,
    );
  });

  it.each(["invalid-principal", "namespace", "rpc"])(
    "sanitizes %s failures exactly",
    async (failure) => {
      const namespace =
        failure === "namespace"
          ? {
              getByName() {
                throw new Error("SENTINEL_NAMESPACE");
              },
            }
          : {
              getByName() {
                return {
                  ...allMethods([]),
                  activatePair: async () => {
                    throw new Error("SENTINEL_RPC");
                  },
                };
              },
            };
      const coordinator = new DurableObjectVnuRefreshControlCoordinator(
        namespace,
      );
      await expect(
        coordinator.activatePair(
          failure === "invalid-principal" ? "SENTINEL" : "a".repeat(64),
          OLD,
        ),
      ).rejects.toEqual(vnuRefreshUnavailable());
    },
  );
});
