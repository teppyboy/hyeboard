import { ApiError, type AuthResult, type StoredAccount } from "./api-types";

export type VnuRequestPolicy = "safe-replay" | "refresh-no-replay" | "never";
export const VNU_REQUEST_NOT_REPLAYED = "VNU_REQUEST_NOT_REPLAYED" as const;

const REFRESH_GRANT_PREFIX = "hyeboard.vnu.refreshGrant.";
const TERMINAL_REFRESH_CODES = new Set([
  "VNU_REFRESH_GRANT_INVALID",
  "VNU_REFRESH_GRANT_REVOKED",
  "INVALID_VNU_CREDENTIAL",
  "VNU_REFRESH_IDENTITY_MISMATCH",
]);
const SAFE_RAW_PATH = /^\/api\/vnu\/raw\/(profile|grades|progress|exam-base|exams|syllabus|point-detail)$/;
const SAFE_FEATURE_PATH = /^\/api\/vnu\/(dashboard|terms|timetable|courses|assignments|grades|exams|documents|tuition|news|training-points|requests)$/;
const SAFE_CLASS_LOOKUP_PATH = /^\/api\/vnu\/class-lookup\/(catalog|point-detail)$/;

export function storeVnuRefreshGrant(accountId: string, grant: string): void {
  sessionStorage.setItem(`${REFRESH_GRANT_PREFIX}${accountId}`, grant);
}

export function readVnuRefreshGrant(accountId: string): string | undefined {
  return sessionStorage.getItem(`${REFRESH_GRANT_PREFIX}${accountId}`) ?? undefined;
}

export function clearVnuRefreshGrant(accountId: string): void {
  sessionStorage.removeItem(`${REFRESH_GRANT_PREFIX}${accountId}`);
}

export function classifyVnuRecovery(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.code === "VNU_SESSION_EXPIRED") return true;
  if (error.code !== "VNU_LOGIN_REQUIRED") return false;
  const details: unknown = error.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return false;
  if (Object.getPrototypeOf(details) !== Object.prototype) return false;
  const keys = Object.keys(details);
  return keys.length === 1
    && keys[0] === "reason"
    && (details as Record<string, unknown>).reason === "MISSING_VNU_CREDENTIAL";
}

export function requestPolicyFor(input: { method: string; pathname: string }): VnuRequestPolicy {
  const method = input.method.toUpperCase();
  const pathname = new URL(input.pathname, "https://hyeboard.invalid").pathname;
  if (method === "POST" && pathname === "/api/vnu/cross-lookup/bulk") return "refresh-no-replay";
  if (method === "POST" && pathname.startsWith("/api/vnu/cross-lookup/detail")) return "refresh-no-replay";
  if (method !== "GET") return "never";
  if (pathname.startsWith("/api/vnu/auth/")) return "never";
  if (pathname.startsWith("/api/vnu/cross-lookup/")) return "refresh-no-replay";
  if (SAFE_RAW_PATH.test(pathname) || SAFE_FEATURE_PATH.test(pathname) || SAFE_CLASS_LOOKUP_PATH.test(pathname)) return "safe-replay";
  return "never";
}

export class VnuRequestNotReplayedError extends ApiError {
  constructor() {
    super("The VNU session was restored. Retry this operation manually.", VNU_REQUEST_NOT_REPLAYED);
  }
}

export type VnuRefreshDeps = {
  getAccount(id: string): StoredAccount | undefined;
  getActiveAccountId(): string | null;
  fetchRefresh(account: StoredAccount, grant: string, signal: AbortSignal): Promise<AuthResult>;
  commit(account: StoredAccount, result: AuthResult): boolean;
  terminal(account: StoredAccount): void;
  invalidate(accountId: string): void;
  status(accountId: string, state: "reconnecting" | "retryable" | "idle"): void;
  onFlightSettled?(): void;
};

export type VnuRefreshOutcome =
  | { kind: "committed"; auth: AuthResult }
  | { kind: "stale" };

type Flight = {
  controller: AbortController;
  generation: symbol;
  waiters: Set<symbol>;
  promise: Promise<VnuRefreshOutcome>;
};

const flights = new Map<string, Flight>();

function flightKey(account: StoredAccount): string {
  return `${account.id}\u0000${account.token}`;
}

function unchangedActive(account: StoredAccount, deps: VnuRefreshDeps): boolean {
  const current = deps.getAccount(account.id);
  return current?.token === account.token && deps.getActiveAccountId() === account.id;
}

function createFlight(account: StoredAccount, grant: string, deps: VnuRefreshDeps): Flight {
  const key = flightKey(account);
  const controller = new AbortController();
  const generation = Symbol(key);
  const waiters = new Set<symbol>();
  deps.status(account.id, "reconnecting");

  const promise = deps.fetchRefresh(account, grant, controller.signal)
    .then((auth): VnuRefreshOutcome => {
      const current = flights.get(key);
      const mayCommit = current?.generation === generation
        && current.waiters.size > 0
        && unchangedActive(account, deps);
      if (!mayCommit) return { kind: "stale" };
      if (!auth.refreshGrant) {
        throw new ApiError("VNU reconnect returned no rotated grant.", "VNU_REFRESH_GRANT_INVALID", 401);
      }
      if (!deps.commit(account, auth)) return { kind: "stale" };
      deps.invalidate(account.id);
      deps.status(account.id, "idle");
      return { kind: "committed", auth };
    })
    .catch((error: unknown) => {
      const current = flights.get(key);
      const mayHandle = current?.generation === generation
        && current.waiters.size > 0
        && unchangedActive(account, deps);
      if (!mayHandle) return { kind: "stale" } as const;
      if (error instanceof ApiError && TERMINAL_REFRESH_CODES.has(error.code ?? "")) deps.terminal(account);
      else deps.status(account.id, "retryable");
      throw error;
    })
    .finally(() => {
      if (flights.get(key)?.generation === generation) flights.delete(key);
      deps.onFlightSettled?.();
    });

  const flight = { controller, generation, waiters, promise };
  flights.set(key, flight);
  return flight;
}

function abortReason(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new DOMException("VNU refresh cancelled", "AbortError");
}

export function runVnuRefresh(
  account: StoredAccount,
  signal: AbortSignal | undefined,
  deps: VnuRefreshDeps,
): Promise<VnuRefreshOutcome> {
  const grant = readVnuRefreshGrant(account.id);
  if (!grant) {
    if (unchangedActive(account, deps)) deps.terminal(account);
    return Promise.reject(new ApiError("VNU reconnect requires manual sign-in.", "VNU_REFRESH_GRANT_INVALID", 401));
  }

  const key = flightKey(account);
  const flight = flights.get(key) ?? createFlight(account, grant, deps);
  const waiter = Symbol("vnu-refresh-waiter");
  flight.waiters.add(waiter);

  const releaseWaiter = (): void => {
    if (!flight.waiters.delete(waiter) || flight.waiters.size > 0) return;
    if (flights.get(key)?.generation === flight.generation) flights.delete(key);
    if (unchangedActive(account, deps)) deps.status(account.id, "idle");
    flight.controller.abort(new DOMException("All VNU refresh waiters cancelled", "AbortError"));
  };

  if (signal?.aborted) {
    releaseWaiter();
    return Promise.reject(abortReason(signal));
  }

  return new Promise<VnuRefreshOutcome>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      flight.waiters.delete(waiter);
      callback();
    };
    const onAbort = (): void => {
      releaseWaiter();
      settle(() => reject(abortReason(signal)));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    flight.promise.then(
      (outcome) => settle(() => resolve(outcome)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}
