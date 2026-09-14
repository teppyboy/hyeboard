import { HyeboardError } from "@hyeboard/core";

export { deriveVnuRefreshPrincipal } from "@hyeboard/core";

export const VNU_REFRESH_ATTEMPT_LIMIT = 5;
export const VNU_REFRESH_WINDOW_MS = 15 * 60 * 1000;
export const VNU_MANUAL_ACTIVATION_LIMIT = 5 as const;
export const VNU_MANUAL_ACTIVATION_WINDOW_SECONDS = 900 as const;
export const VNU_MANUAL_ACTIVATION_WINDOW_MS =
  VNU_MANUAL_ACTIVATION_WINDOW_SECONDS * 1000;
export const VNU_REFRESH_LEASE_MS = 2 * 60 * 1000;
export const VNU_REFRESH_STATE_KEY = "vnu-refresh-control";

export type LinkedPair = {
  accessTokenId: string;
  accessExpiresAt: number;
  grantId: string;
  grantExpiresAt: number;
};
export type AccessDescriptorRef = LinkedPair;
export type RefreshLease = { pair: LinkedPair; expiresAt: number };
export type RefreshWindow = { count: number; resetAt: number };
export type PreProvenanceLinkedGrantTombstone = {
  accessTokenId: string;
  accessExpiresAt: number;
  grantExpiresAt: number;
};
export type RefreshSuccessorLinkedGrantTombstone =
  PreProvenanceLinkedGrantTombstone & { refreshSuccessor: LinkedPair };
export type LinkedGrantTombstone =
  | PreProvenanceLinkedGrantTombstone
  | RefreshSuccessorLinkedGrantTombstone;
export type RevokedGrantTombstone = number | LinkedGrantTombstone;
export type VnuRefreshControlState = {
  active?: LinkedPair;
  lease?: RefreshLease;
  revokedAccess: Record<string, number>;
  revokedGrants: Record<string, RevokedGrantTombstone>;
  window: RefreshWindow;
  activationWindow?: RefreshWindow;
};

export type BeginRefreshResult =
  | { kind: "accepted"; leaseExpiresAt: number }
  | { kind: "in-progress"; retryAfterSeconds: number }
  | {
      kind: "rate-limited";
      retryAfterSeconds: number;
      limit: 5;
      windowSeconds: 900;
    }
  | { kind: "revoked" };
export type ActivatePairResult =
  | { kind: "activated" }
  | {
      kind: "rate-limited";
      retryAfterSeconds: number;
      limit: 5;
      windowSeconds: 900;
    };
export type MutationResult = {
  kind:
    | "activated"
    | "completed"
    | "aborted"
    | "revoked"
    | "mismatch"
    | "expired";
};
export type AccessCheckResult = { kind: "active" } | { kind: "revoked" };
export type TransitionOutput<T> = {
  state: VnuRefreshControlState;
  result: T;
  changed: boolean;
};

export function assertLinkedPair(value: unknown): asserts value is LinkedPair {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid VNU refresh pair");
  const pair = value as Record<string, unknown>;
  const keys = Object.keys(pair).sort();
  const expected = [
    "accessExpiresAt",
    "accessTokenId",
    "grantExpiresAt",
    "grantId",
  ];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  )
    throw new Error("Invalid VNU refresh pair");
  if (
    typeof pair.accessTokenId !== "string" ||
    !/^[A-Za-z0-9_-]{22}$/.test(pair.accessTokenId)
  )
    throw new Error("Invalid VNU refresh pair");
  if (
    typeof pair.grantId !== "string" ||
    !/^[A-Za-z0-9_-]{22}$/.test(pair.grantId)
  )
    throw new Error("Invalid VNU refresh pair");
  if (
    !Number.isSafeInteger(pair.accessExpiresAt) ||
    (pair.accessExpiresAt as number) <= 0
  )
    throw new Error("Invalid VNU refresh pair");
  if (
    !Number.isSafeInteger(pair.grantExpiresAt) ||
    (pair.grantExpiresAt as number) <= 0
  )
    throw new Error("Invalid VNU refresh pair");
}

export const assertAccessDescriptorRef: (
  value: unknown,
) => asserts value is AccessDescriptorRef = assertLinkedPair;

export function parseVnuRefreshControlState(
  value: unknown,
): VnuRefreshControlState | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid VNU refresh state");
  const state = value as Record<string, unknown>;
  const allowed = new Set([
    "active",
    "lease",
    "revokedAccess",
    "revokedGrants",
    "window",
    "activationWindow",
  ]);
  if (Object.keys(state).some((key) => !allowed.has(key)))
    throw new Error("Invalid VNU refresh state");
  if (state.active !== undefined) assertLinkedPair(state.active);
  if (state.lease !== undefined) {
    if (
      !state.lease ||
      typeof state.lease !== "object" ||
      Array.isArray(state.lease)
    )
      throw new Error("Invalid VNU refresh state");
    const lease = state.lease as Record<string, unknown>;
    if (Object.keys(lease).sort().join(",") !== "expiresAt,pair")
      throw new Error("Invalid VNU refresh state");
    assertLinkedPair(lease.pair);
    if (
      !Number.isSafeInteger(lease.expiresAt) ||
      (lease.expiresAt as number) <= 0
    )
      throw new Error("Invalid VNU refresh state");
  }
  if (
    !state.revokedAccess ||
    typeof state.revokedAccess !== "object" ||
    Array.isArray(state.revokedAccess)
  )
    throw new Error("Invalid VNU refresh state");
  if (
    Object.entries(state.revokedAccess).some(
      ([identifier, expiry]) =>
        !/^[A-Za-z0-9_-]{22}$/.test(identifier) ||
        !Number.isSafeInteger(expiry) ||
        (expiry as number) <= 0,
    )
  )
    throw new Error("Invalid VNU refresh state");
  if (
    !state.revokedGrants ||
    typeof state.revokedGrants !== "object" ||
    Array.isArray(state.revokedGrants)
  )
    throw new Error("Invalid VNU refresh state");
  for (const [grantId, tombstone] of Object.entries(state.revokedGrants)) {
    if (!/^[A-Za-z0-9_-]{22}$/.test(grantId))
      throw new Error("Invalid VNU refresh state");
    if (typeof tombstone === "number") {
      if (!Number.isSafeInteger(tombstone) || tombstone <= 0)
        throw new Error("Invalid VNU refresh state");
      continue;
    }
    assertLinkedGrantTombstone(tombstone, grantId);
  }
  if (
    !state.window ||
    typeof state.window !== "object" ||
    Array.isArray(state.window)
  )
    throw new Error("Invalid VNU refresh state");
  const window = state.window as Record<string, unknown>;
  if (
    Object.keys(window).sort().join(",") !== "count,resetAt" ||
    !Number.isSafeInteger(window.count) ||
    (window.count as number) < 0 ||
    (window.count as number) > VNU_REFRESH_ATTEMPT_LIMIT ||
    !Number.isSafeInteger(window.resetAt) ||
    (window.resetAt as number) <= 0
  )
    throw new Error("Invalid VNU refresh state");
  if (state.activationWindow !== undefined)
    assertActivationWindow(state.activationWindow);
  const parsed = state as VnuRefreshControlState;
  if (
    parsed.lease &&
    (!parsed.active ||
      !samePair(parsed.active, parsed.lease.pair) ||
      parsed.lease.expiresAt > parsed.lease.pair.grantExpiresAt)
  )
    throw new Error("Invalid VNU refresh state");
  if (
    parsed.active &&
    (parsed.revokedAccess[parsed.active.accessTokenId] !== undefined ||
      parsed.revokedGrants[parsed.active.grantId] !== undefined)
  )
    throw new Error("Invalid VNU refresh state");
  return parsed;
}

function assertActivationWindow(
  value: unknown,
): asserts value is RefreshWindow {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid VNU refresh state");
  const window = value as Record<string, unknown>;
  if (
    Object.keys(window).sort().join(",") !== "count,resetAt" ||
    !Number.isSafeInteger(window.count) ||
    (window.count as number) <= 0 ||
    (window.count as number) > VNU_MANUAL_ACTIVATION_LIMIT ||
    !Number.isSafeInteger(window.resetAt) ||
    (window.resetAt as number) <= 0
  )
    throw new Error("Invalid VNU refresh state");
}

function assertLinkedGrantTombstone(
  value: unknown,
  revokedGrantId: string,
): asserts value is LinkedGrantTombstone {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid VNU refresh state");
  const tombstone = value as Record<string, unknown>;
  const keys = Object.keys(tombstone).sort().join(",");
  if (
    keys !== "accessExpiresAt,accessTokenId,grantExpiresAt" &&
    keys !== "accessExpiresAt,accessTokenId,grantExpiresAt,refreshSuccessor"
  )
    throw new Error("Invalid VNU refresh state");
  if (
    typeof tombstone.accessTokenId !== "string" ||
    !/^[A-Za-z0-9_-]{22}$/.test(tombstone.accessTokenId)
  )
    throw new Error("Invalid VNU refresh state");
  if (
    !Number.isSafeInteger(tombstone.accessExpiresAt) ||
    (tombstone.accessExpiresAt as number) <= 0
  )
    throw new Error("Invalid VNU refresh state");
  if (
    !Number.isSafeInteger(tombstone.grantExpiresAt) ||
    (tombstone.grantExpiresAt as number) <= 0
  )
    throw new Error("Invalid VNU refresh state");
  if (tombstone.refreshSuccessor === undefined) return;
  assertLinkedPair(tombstone.refreshSuccessor);
  const successor = tombstone.refreshSuccessor;
  if (
    successor.accessTokenId === tombstone.accessTokenId ||
    successor.grantId === revokedGrantId ||
    successor.grantExpiresAt !== tombstone.grantExpiresAt
  )
    throw new Error("Invalid VNU refresh state");
}

function linkedGrantTombstone(pair: LinkedPair): LinkedGrantTombstone {
  return {
    accessTokenId: pair.accessTokenId,
    accessExpiresAt: pair.accessExpiresAt,
    grantExpiresAt: pair.grantExpiresAt,
  };
}

function refreshSuccessorGrantTombstone(
  old: LinkedPair,
  next: LinkedPair,
): RefreshSuccessorLinkedGrantTombstone {
  return { ...linkedGrantTombstone(old), refreshSuccessor: next };
}

function grantTombstoneExpiresAt(
  tombstone: RevokedGrantTombstone | undefined,
): number | undefined {
  if (typeof tombstone === "number") return tombstone;
  return tombstone?.grantExpiresAt;
}

function exactlyLinksGrantTombstone(
  tombstone: RevokedGrantTombstone | undefined,
  pair: LinkedPair,
): boolean {
  return (
    typeof tombstone === "object" &&
    tombstone.accessTokenId === pair.accessTokenId &&
    tombstone.accessExpiresAt === pair.accessExpiresAt &&
    tombstone.grantExpiresAt === pair.grantExpiresAt
  );
}

function refreshSuccessor(
  tombstone: RevokedGrantTombstone | undefined,
): LinkedPair | undefined {
  return typeof tombstone === "object" && "refreshSuccessor" in tombstone
    ? tombstone.refreshSuccessor
    : undefined;
}

export function samePair(
  left: LinkedPair | undefined,
  right: LinkedPair,
): boolean {
  return Boolean(
    left &&
      left.accessTokenId === right.accessTokenId &&
      left.accessExpiresAt === right.accessExpiresAt &&
      left.grantId === right.grantId &&
      left.grantExpiresAt === right.grantExpiresAt,
  );
}

export function sameVnuRefreshState(
  left: VnuRefreshControlState | undefined,
  right: VnuRefreshControlState,
): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

function emptyState(now: number): VnuRefreshControlState {
  return {
    revokedAccess: {},
    revokedGrants: {},
    window: { count: 0, resetAt: now + VNU_REFRESH_WINDOW_MS },
  };
}

export function cleanVnuRefreshState(
  input: VnuRefreshControlState | undefined,
  now: number,
): VnuRefreshControlState {
  const source = input ?? emptyState(now);
  const revokedGrants = Object.fromEntries(
    Object.entries(source.revokedGrants).filter(
      ([, tombstone]) => grantTombstoneExpiresAt(tombstone)! > now,
    ),
  );
  const revokedAccess = Object.fromEntries(
    Object.entries(source.revokedAccess).filter(
      ([, expiresAt]) => expiresAt > now,
    ),
  );
  const active =
    source.active && source.active.grantExpiresAt > now
      ? source.active
      : undefined;
  const lease =
    source.lease &&
    source.lease.expiresAt > now &&
    source.lease.pair.grantExpiresAt > now
      ? source.lease
      : undefined;
  const window =
    now >= source.window.resetAt
      ? { count: 0, resetAt: now + VNU_REFRESH_WINDOW_MS }
      : source.window;
  const activationWindow =
    source.activationWindow &&
    source.activationWindow.count > 0 &&
    now < source.activationWindow.resetAt
      ? source.activationWindow
      : undefined;
  return {
    active,
    lease,
    revokedAccess,
    revokedGrants,
    window,
    ...(activationWindow ? { activationWindow } : {}),
  };
}

function unchanged<T>(
  stored: VnuRefreshControlState | undefined,
  now: number,
  result: T,
): TransitionOutput<T> {
  return { state: stored ?? emptyState(now), result, changed: false };
}

function changed<T>(
  stored: VnuRefreshControlState | undefined,
  state: VnuRefreshControlState,
  result: T,
): TransitionOutput<T> {
  return { state, result, changed: !sameVnuRefreshState(stored, state) };
}

function revokeExact(
  state: VnuRefreshControlState,
  pair: LinkedPair,
  grantTombstone: LinkedGrantTombstone = linkedGrantTombstone(pair),
): VnuRefreshControlState {
  return {
    ...state,
    active: undefined,
    lease:
      state.lease && samePair(state.lease.pair, pair) ? undefined : state.lease,
    revokedAccess: {
      ...state.revokedAccess,
      [pair.accessTokenId]: pair.accessExpiresAt,
    },
    revokedGrants: { ...state.revokedGrants, [pair.grantId]: grantTombstone },
  };
}

export function applyActivatePair(
  stored: VnuRefreshControlState | undefined,
  pair: LinkedPair,
  now: number,
): TransitionOutput<ActivatePairResult> {
  assertLinkedPair(pair);
  if (samePair(stored?.active, pair) && stored?.lease === undefined)
    return unchanged(stored, now, { kind: "activated" });
  const state = cleanVnuRefreshState(stored, now);
  if (
    state.activationWindow &&
    state.activationWindow.count >= VNU_MANUAL_ACTIVATION_LIMIT
  ) {
    return unchanged(stored, now, {
      kind: "rate-limited",
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((state.activationWindow.resetAt - now) / 1000),
      ),
      limit: VNU_MANUAL_ACTIVATION_LIMIT,
      windowSeconds: VNU_MANUAL_ACTIVATION_WINDOW_SECONDS,
    });
  }
  const replaced =
    state.active && !samePair(state.active, pair)
      ? revokeExact(state, state.active)
      : state;
  const activationWindow = state.activationWindow
    ? { ...state.activationWindow, count: state.activationWindow.count + 1 }
    : { count: 1, resetAt: now + VNU_MANUAL_ACTIVATION_WINDOW_MS };
  return changed(
    stored,
    { ...replaced, active: pair, lease: undefined, activationWindow },
    { kind: "activated" },
  );
}

export function applyBeginRefresh(
  stored: VnuRefreshControlState | undefined,
  pair: LinkedPair,
  now: number,
): TransitionOutput<BeginRefreshResult> {
  assertLinkedPair(pair);
  const state = cleanVnuRefreshState(stored, now);
  if (
    pair.grantExpiresAt <= now ||
    state.revokedAccess[pair.accessTokenId] ||
    state.revokedGrants[pair.grantId] ||
    !samePair(state.active, pair)
  )
    return unchanged(stored, now, { kind: "revoked" });
  if (state.lease && samePair(state.lease.pair, pair))
    return unchanged(stored, now, {
      kind: "in-progress",
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((state.lease.expiresAt - now) / 1000),
      ),
    });
  if (state.window.count >= VNU_REFRESH_ATTEMPT_LIMIT)
    return unchanged(stored, now, {
      kind: "rate-limited",
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((state.window.resetAt - now) / 1000),
      ),
      limit: 5,
      windowSeconds: 900,
    });
  const leaseExpiresAt = Math.min(
    now + VNU_REFRESH_LEASE_MS,
    pair.grantExpiresAt,
  );
  return changed(
    stored,
    {
      ...state,
      lease: { pair, expiresAt: leaseExpiresAt },
      window: { ...state.window, count: state.window.count + 1 },
    },
    { kind: "accepted", leaseExpiresAt },
  );
}

export function applyCompleteRefresh(
  stored: VnuRefreshControlState | undefined,
  input: { old: LinkedPair; next: LinkedPair },
  now: number,
): TransitionOutput<{ kind: "completed" } | { kind: "revoked" }> {
  assertLinkedPair(input.old);
  assertLinkedPair(input.next);
  if (input.next.grantExpiresAt !== input.old.grantExpiresAt)
    throw new Error("VNU refresh grant expiry changed");
  if (
    input.next.accessTokenId === input.old.accessTokenId ||
    input.next.grantId === input.old.grantId
  )
    throw new Error("Invalid VNU refresh rotation identifiers");
  if (
    stored?.revokedAccess[input.next.accessTokenId] !== undefined ||
    stored?.revokedGrants[input.next.grantId] !== undefined
  )
    throw new Error("Invalid VNU refresh rotation collision");
  const state = cleanVnuRefreshState(stored, now);
  if (
    input.old.grantExpiresAt <= now ||
    !samePair(state.active, input.old) ||
    !state.lease ||
    !samePair(state.lease.pair, input.old)
  )
    return unchanged(stored, now, { kind: "revoked" });
  const revoked = revokeExact(
    state,
    input.old,
    refreshSuccessorGrantTombstone(input.old, input.next),
  );
  return changed(
    stored,
    { ...revoked, active: input.next },
    { kind: "completed" },
  );
}

export function applyAbortRefresh(
  stored: VnuRefreshControlState | undefined,
  input: { pair: LinkedPair; terminal: boolean },
  now: number,
): TransitionOutput<{ kind: "aborted" | "revoked" }> {
  assertLinkedPair(input.pair);
  const state = cleanVnuRefreshState(stored, now);
  if (
    state.revokedAccess[input.pair.accessTokenId] ||
    state.revokedGrants[input.pair.grantId]
  )
    return unchanged(stored, now, { kind: "revoked" });
  if (
    !state.lease ||
    !samePair(state.lease.pair, input.pair) ||
    !samePair(state.active, input.pair)
  )
    return unchanged(stored, now, { kind: "aborted" });
  if (!input.terminal)
    return changed(stored, { ...state, lease: undefined }, { kind: "aborted" });
  return changed(stored, revokeExact(state, state.active!), {
    kind: "revoked",
  });
}

export function applyRevokeLinkedPairByAccess(
  stored: VnuRefreshControlState | undefined,
  pair: AccessDescriptorRef,
  now: number,
): TransitionOutput<{ kind: "revoked" | "mismatch" | "expired" }> {
  assertAccessDescriptorRef(pair);
  if (pair.accessExpiresAt <= now && pair.grantExpiresAt <= now)
    return unchanged(stored, now, { kind: "expired" });
  const state = cleanVnuRefreshState(stored, now);
  const grantTombstone = state.revokedGrants[pair.grantId];
  if (
    state.revokedAccess[pair.accessTokenId] === pair.accessExpiresAt &&
    exactlyLinksGrantTombstone(grantTombstone, pair)
  )
    return unchanged(stored, now, { kind: "revoked" });
  // The corresponding grant tombstone retains this exact link only through
  // grant expiry, after the independently expiring access tombstone is gone.
  if (
    pair.accessExpiresAt <= now &&
    exactlyLinksGrantTombstone(grantTombstone, pair)
  )
    return unchanged(stored, now, { kind: "revoked" });
  if (state.active && !samePair(state.active, pair))
    return unchanged(stored, now, { kind: "mismatch" });
  if (!samePair(state.active, pair))
    return unchanged(stored, now, { kind: "mismatch" });
  return changed(stored, revokeExact(state, pair), { kind: "revoked" });
}

export function applyRevokePrincipalByLinkedGrant(
  stored: VnuRefreshControlState | undefined,
  proof: LinkedPair,
  now: number,
): TransitionOutput<{ kind: "revoked" | "mismatch" | "expired" }> {
  assertLinkedPair(proof);
  if (proof.grantExpiresAt <= now)
    return unchanged(stored, now, { kind: "expired" });
  const state = cleanVnuRefreshState(stored, now);
  const exactActiveProof = samePair(state.active, proof);
  const tombstone = state.revokedGrants[proof.grantId];
  const exactGrantTombstone = exactlyLinksGrantTombstone(tombstone, proof);
  if (!exactActiveProof && !exactGrantTombstone)
    return unchanged(stored, now, { kind: "mismatch" });
  if (!state.active) return unchanged(stored, now, { kind: "revoked" });
  if (!exactActiveProof) {
    const successor = refreshSuccessor(tombstone);
    const exactSuccessorAuthority =
      successor !== undefined &&
      samePair(state.active, successor) &&
      (!state.lease || samePair(state.lease.pair, successor));
    if (!exactSuccessorAuthority)
      return unchanged(stored, now, { kind: "mismatch" });
  }

  const current = state.active;
  const revoked = revokeExact(
    {
      ...state,
      revokedAccess: {
        ...state.revokedAccess,
        [proof.accessTokenId]: proof.accessExpiresAt,
      },
      revokedGrants: {
        ...state.revokedGrants,
        [proof.grantId]: linkedGrantTombstone(proof),
      },
    },
    current,
  );
  return changed(stored, revoked, { kind: "revoked" });
}

export const applyRevokeExactLinkedPair = applyRevokeLinkedPairByAccess;

export function applyCheckAccess(
  stored: VnuRefreshControlState | undefined,
  access: AccessDescriptorRef,
  now: number,
): TransitionOutput<AccessCheckResult> {
  assertAccessDescriptorRef(access);
  const state = cleanVnuRefreshState(stored, now);
  const didChange = stored !== undefined && !sameVnuRefreshState(stored, state);
  const active = samePair(state.active, access) && access.accessExpiresAt > now;
  return {
    state,
    changed: didChange,
    result: {
      kind:
        active &&
        !state.revokedAccess[access.accessTokenId] &&
        !state.revokedGrants[access.grantId]
          ? "active"
          : "revoked",
    },
  };
}

export function nextVnuRefreshAlarm(
  state: VnuRefreshControlState,
): number | undefined {
  const values = [
    ...Object.values(state.revokedAccess),
    ...Object.values(state.revokedGrants).map(grantTombstoneExpiresAt),
    state.active?.grantExpiresAt,
    state.lease?.expiresAt,
    state.window.count > 0 ? state.window.resetAt : undefined,
    state.activationWindow && state.activationWindow.count > 0
      ? state.activationWindow.resetAt
      : undefined,
  ].filter((value): value is number => typeof value === "number");
  return values.length ? Math.min(...values) : undefined;
}

export interface VnuRefreshControlStorage {
  get(): Promise<unknown>;
  transaction<T>(
    body: (
      stored: unknown,
      put: (state: VnuRefreshControlState) => Promise<void>,
      deleteState: () => Promise<void>,
      setAlarm: (at: number | undefined) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T>;
}

export function isQuiescentVnuRefreshState(
  state: VnuRefreshControlState,
): boolean {
  return (
    state.active === undefined &&
    state.lease === undefined &&
    Object.keys(state.revokedAccess).length === 0 &&
    Object.keys(state.revokedGrants).length === 0 &&
    state.window.count === 0 &&
    state.activationWindow === undefined
  );
}

export async function checkAccessAuthoritatively(
  storage: VnuRefreshControlStorage,
  access: AccessDescriptorRef,
  now: number,
): Promise<AccessCheckResult> {
  assertAccessDescriptorRef(access);
  const stored = parseVnuRefreshControlState(await storage.get());
  const checked = applyCheckAccess(stored, access, now);
  if (!checked.changed) return checked.result;
  return storage.transaction(async (raw, put, deleteState, setAlarm) => {
    const retry = applyCheckAccess(
      parseVnuRefreshControlState(raw),
      access,
      now,
    );
    if (retry.changed) {
      if (isQuiescentVnuRefreshState(retry.state)) await deleteState();
      else await put(retry.state);
      await setAlarm(nextVnuRefreshAlarm(retry.state));
    }
    return retry.result;
  });
}

export interface VnuRefreshControlStub {
  activatePair(pair: LinkedPair): Promise<ActivatePairResult>;
  checkAccess(access: AccessDescriptorRef): Promise<AccessCheckResult>;
  beginRefresh(pair: LinkedPair): Promise<BeginRefreshResult>;
  completeRefresh(input: {
    old: LinkedPair;
    next: LinkedPair;
  }): Promise<{ kind: "completed" } | { kind: "revoked" }>;
  abortRefresh(input: {
    pair: LinkedPair;
    terminal: boolean;
  }): Promise<{ kind: "aborted" | "revoked" }>;
  revokeLinkedPairByAccess(
    pair: AccessDescriptorRef,
  ): Promise<{ kind: "revoked" | "mismatch" | "expired" }>;
  revokePrincipalByLinkedGrant(
    pair: LinkedPair,
  ): Promise<{ kind: "revoked" | "mismatch" | "expired" }>;
  revokeExactLinkedPair(
    pair: LinkedPair,
  ): Promise<{ kind: "revoked" | "mismatch" | "expired" }>;
}

export interface VnuRefreshControlNamespace {
  getByName(name: string): VnuRefreshControlStub;
}
export interface VnuRefreshControlCoordinator {
  activatePair(
    principalKey: string,
    pair: LinkedPair,
  ): Promise<ActivatePairResult>;
  checkAccess(
    principalKey: string,
    access: AccessDescriptorRef,
  ): Promise<AccessCheckResult>;
  beginRefresh(
    principalKey: string,
    pair: LinkedPair,
  ): Promise<BeginRefreshResult>;
  completeRefresh(
    principalKey: string,
    input: { old: LinkedPair; next: LinkedPair },
  ): Promise<"completed" | "revoked">;
  abortRefresh(
    principalKey: string,
    input: { pair: LinkedPair; terminal: boolean },
  ): Promise<void>;
  revokeLinkedPairByAccess(
    principalKey: string,
    pair: AccessDescriptorRef,
  ): Promise<"revoked" | "mismatch" | "expired">;
  revokePrincipalByLinkedGrant(
    principalKey: string,
    pair: LinkedPair,
  ): Promise<"revoked" | "mismatch" | "expired">;
  revokeExactLinkedPair(
    principalKey: string,
    pair: LinkedPair,
  ): Promise<"revoked" | "mismatch" | "expired">;
}

export function vnuRefreshUnavailable(): HyeboardError {
  return new HyeboardError(
    "VNU_REFRESH_UNAVAILABLE",
    "VNU reconnect is temporarily unavailable. Try again.",
    503,
    { retryAfterSeconds: 5 },
  );
}

export class DurableObjectVnuRefreshControlCoordinator
  implements VnuRefreshControlCoordinator
{
  constructor(private readonly namespace: VnuRefreshControlNamespace) {}

  private stub(principalKey: string): VnuRefreshControlStub {
    if (!/^[0-9a-f]{64}$/.test(principalKey)) throw vnuRefreshUnavailable();
    return this.namespace.getByName(principalKey);
  }

  private async call<T>(
    principalKey: string,
    operation: (stub: VnuRefreshControlStub) => Promise<T>,
  ): Promise<T> {
    try {
      return await operation(this.stub(principalKey));
    } catch {
      throw vnuRefreshUnavailable();
    }
  }

  activatePair(principalKey: string, pair: LinkedPair) {
    return this.call(principalKey, async (stub) => {
      assertLinkedPair(pair);
      return stub.activatePair(pair);
    });
  }
  checkAccess(principalKey: string, access: AccessDescriptorRef) {
    return this.call(principalKey, async (stub) => {
      assertAccessDescriptorRef(access);
      return stub.checkAccess(access);
    });
  }
  beginRefresh(principalKey: string, pair: LinkedPair) {
    return this.call(principalKey, async (stub) => {
      assertLinkedPair(pair);
      return stub.beginRefresh(pair);
    });
  }
  completeRefresh(
    principalKey: string,
    input: { old: LinkedPair; next: LinkedPair },
  ) {
    return this.call(principalKey, async (stub) => {
      assertLinkedPair(input.old);
      assertLinkedPair(input.next);
      return (await stub.completeRefresh(input)).kind;
    });
  }
  abortRefresh(
    principalKey: string,
    input: { pair: LinkedPair; terminal: boolean },
  ) {
    return this.call(principalKey, async (stub) => {
      assertLinkedPair(input.pair);
      await stub.abortRefresh(input);
    });
  }
  revokeLinkedPairByAccess(principalKey: string, pair: AccessDescriptorRef) {
    return this.call(principalKey, async (stub) => {
      assertAccessDescriptorRef(pair);
      return (await stub.revokeLinkedPairByAccess(pair)).kind;
    });
  }
  revokePrincipalByLinkedGrant(principalKey: string, pair: LinkedPair) {
    return this.call(principalKey, async (stub) => {
      assertLinkedPair(pair);
      return (await stub.revokePrincipalByLinkedGrant(pair)).kind;
    });
  }
  revokeExactLinkedPair(principalKey: string, pair: LinkedPair) {
    return this.call(principalKey, async (stub) => {
      assertLinkedPair(pair);
      return (await stub.revokeExactLinkedPair(pair)).kind;
    });
  }
}
