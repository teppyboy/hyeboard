import { apiErrorDetailsSchema, type ApiErrorDetails, type ApiResponse, type Assignment, type ClassSession, type Course, type DashboardSummary, type DocumentItem, type ExamSession, type Grade, type GpaSummary, type NewsItem, type ServiceRequest, type Student, type Term, type TrainingPoint, type TuitionStatus, type University } from "@hyeboard/schemas";
import { createLinkedAbortController } from "./abort-deadline";
import { createUetClient } from "./uet-client";
import { createVnuClient, type VnuBulkLookupItem, type VnuBulkLookupMode, type VnuCrossDetailComponent, type VnuCrossDetailItem, type VnuCrossDetailPermit, type VnuCrossStudentCode, type VnuCrossStudentId, type VnuCrossTranscript, type VnuCrossTranscriptInput } from "./vnu-client";
import { canReauthenticateInline, requestInlineReauth } from "./reauth";
import { readUetSessionStream } from "./uet-session-stream";
import { ApiError, markVnuRefreshAttempted, wasVnuRefreshAttempted, type AuthResult, type ImportedAccountResult, type ImportSessionInput, type StoredAccount } from "./api-types";
import { classifyVnuRecovery, clearVnuRefreshGrant, readVnuRefreshGrant, requestPolicyFor, runVnuRefresh, storeVnuRefreshGrant, VNU_REQUEST_NOT_REPLAYED, VnuRequestNotReplayedError, type VnuRequestPolicy } from "./vnu-refresh";

export { ApiError } from "./api-types";
export type { AuthResult, ImportedAccountResult, ImportSessionInput, StoredAccount } from "./api-types";
export type { VnuBulkLookupItem, VnuBulkLookupMode, VnuBulkLookupResult, VnuCrossDetailComponent, VnuCrossDetailItem, VnuCrossDetailPermit, VnuCrossStudentCode, VnuCrossStudentId, VnuCrossTranscript, VnuCrossTranscriptInput } from "./vnu-client";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";
const SESSION_KEY = "hyeboard.sessionToken";
const ACCOUNTS_KEY = "hyeboard.accounts";
const ACTIVE_ACCOUNT_KEY = "hyeboard.activeAccountId";
const UET_LOGIN_DEADLINE_MS = 3 * 60_000;
const LEGACY_VNU_RELOGIN_KEYS = ["hyeboard.relogin.vnu.username", "hyeboard.relogin.vnu.password"] as const;

function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// Only these codes mean the Hyeboard session itself is dead - everything else
// (e.g. a feature that needs a learning-platform credential the user never provided) is
// a feature-specific problem that should NOT log the user out of a session
// that is otherwise perfectly valid.
const SESSION_INVALID_CODES: ReadonlySet<string> = new Set(["MISSING_SESSION", "SESSION_EXPIRED", "INVALID_SESSION"]);

export function isSessionDeathCode(code: string | undefined): boolean {
  return code !== undefined && SESSION_INVALID_CODES.has(code);
}

// Fired only when the LAST remaining account's session dies/is signed out -
// the app shell listens for this to bounce the user to /login. If other
// accounts remain, ACCOUNT_SWITCHED_EVENT fires instead (auto-switch, no
// redirect needed).
export const SESSION_CLEARED_EVENT = "hyeboard:session-cleared";

// Fired whenever the active account changes for any reason (explicit switch,
// a new account added via login, or an account removed while another one
// remains). The app shell listens for this to re-sync universityId/palette
// and refetch data for whichever account is now active.
export const ACCOUNT_SWITCHED_EVENT = "hyeboard:account-switched";
export const SESSION_TOKEN_ROTATED_EVENT = "hyeboard:session-token-rotated";
export const VNU_REFRESH_COMMITTED_EVENT = "hyeboard:vnu-refresh-committed";
export const VNU_REFRESH_STATUS_EVENT = "hyeboard:vnu-refresh-status";

function readAccounts(): StoredAccount[] {
  try {
    const raw = localStorage.getItem(ACCOUNTS_KEY);
    return raw ? (JSON.parse(raw) as StoredAccount[]) : [];
  } catch {
    return [];
  }
}

function writeAccounts(accounts: StoredAccount[]): void {
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
}

// One-time migration for users who had a single session stored under the old
// scheme before multi-account support existed - preserves their login
// instead of silently signing them out on the next deploy.
function migrateLegacySessionIfNeeded(): void {
  if (readAccounts().length > 0) return;
  const legacyToken = sessionStorage.getItem(SESSION_KEY) ?? localStorage.getItem(SESSION_KEY);
  if (!legacyToken) return;
  const legacyUniversityId = localStorage.getItem("hyeboard.universityId") ?? "uet";
  const account: StoredAccount = { id: uuid(), universityId: legacyUniversityId, token: legacyToken, addedAt: new Date().toISOString() };
  writeAccounts([account]);
  localStorage.setItem(ACTIVE_ACCOUNT_KEY, account.id);
  sessionStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(SESSION_KEY);
}

export function listAccounts(): StoredAccount[] {
  migrateLegacySessionIfNeeded();
  return readAccounts();
}

export function getActiveAccountId(): string | null {
  migrateLegacySessionIfNeeded();
  return localStorage.getItem(ACTIVE_ACCOUNT_KEY);
}

export function getActiveAccount(): StoredAccount | undefined {
  const id = getActiveAccountId();
  return id ? readAccounts().find((account) => account.id === id) : undefined;
}

export function getAccountById(id: string): StoredAccount | undefined {
  return readAccounts().find((account) => account.id === id);
}

// Adds a new account or, if one already exists for this university+student
// code, updates its token in place - either way it becomes the active
// account. This is what every login flow (Google automation, manual token,
// VNU, mock demo) calls on success, so logging into a different account
// never discards previously-saved ones.
export function upsertAccount(universityId: string, token: string, studentCode?: string): StoredAccount {
  const accounts = readAccounts();
  const matchIndex = accounts.findIndex((account) => account.universityId === universityId && (account.studentCode ?? "") === (studentCode ?? ""));
  const account: StoredAccount = matchIndex >= 0
    ? { ...accounts[matchIndex], token, studentCode: studentCode ?? accounts[matchIndex].studentCode }
    : { id: uuid(), universityId, token, studentCode, addedAt: new Date().toISOString() };
  if (matchIndex >= 0) accounts[matchIndex] = account;
  else accounts.push(account);
  writeAccounts(accounts);
  localStorage.setItem(ACTIVE_ACCOUNT_KEY, account.id);
  window.dispatchEvent(new CustomEvent(ACCOUNT_SWITCHED_EVENT));
  return account;
}

function restoreStorageValue(storage: Storage, key: string, value: string | null): void {
  if (value === null) storage.removeItem(key);
  else storage.setItem(key, value);
}

function buildImportedAccount(accounts: StoredAccount[], universityId: string, auth: AuthResult): { account: StoredAccount; index: number } {
  const studentCode = auth.session.studentCode;
  const index = accounts.findIndex((account) => account.universityId === universityId && (account.studentCode ?? "") === (studentCode ?? ""));
  if (index < 0) {
    return {
      account: { id: uuid(), universityId, token: auth.token, studentCode, addedAt: new Date().toISOString() },
      index,
    };
  }
  return {
    account: { ...accounts[index], token: auth.token, studentCode: studentCode ?? accounts[index].studentCode },
    index,
  };
}

function commitImportedAccount(universityId: string, auth: AuthResult): StoredAccount {
  const beforeAccounts = localStorage.getItem(ACCOUNTS_KEY);
  const beforeActiveAccountId = localStorage.getItem(ACTIVE_ACCOUNT_KEY);
  const accounts = readAccounts();
  const { account, index } = buildImportedAccount(accounts, universityId, auth);
  const beforeGrant = readVnuRefreshGrant(account.id);

  try {
    if (universityId === "vnu") {
      if (auth.refreshGrant) storeVnuRefreshGrant(account.id, auth.refreshGrant);
      else clearVnuRefreshGrant(account.id);
    }
    if (index < 0) accounts.push(account);
    else accounts[index] = account;
    writeAccounts(accounts);
    localStorage.setItem(ACTIVE_ACCOUNT_KEY, account.id);
    for (const key of LEGACY_VNU_RELOGIN_KEYS) sessionStorage.removeItem(key);
  } catch (error) {
    restoreStorageValue(localStorage, ACCOUNTS_KEY, beforeAccounts);
    restoreStorageValue(localStorage, ACTIVE_ACCOUNT_KEY, beforeActiveAccountId);
    if (beforeGrant) storeVnuRefreshGrant(account.id, beforeGrant);
    else clearVnuRefreshGrant(account.id);
    throw error;
  }

  window.dispatchEvent(new CustomEvent(ACCOUNT_SWITCHED_EVENT));
  return account;
}

export function switchAccount(id: string): void {
  if (!readAccounts().some((account) => account.id === id)) return;
  localStorage.setItem(ACTIVE_ACCOUNT_KEY, id);
  window.dispatchEvent(new CustomEvent(ACCOUNT_SWITCHED_EVENT));
}

// Removes an account entirely (e.g. sign-out, or an explicitly coded dead
// session). If the removed account was the active one, auto-switches to
// another remaining account if any exist, otherwise fires
// SESSION_CLEARED_EVENT so the app bounces to /login.
export function removeAccount(id: string): void {
  const accounts = readAccounts().filter((account) => account.id !== id);
  writeAccounts(accounts);
  const activeId = localStorage.getItem(ACTIVE_ACCOUNT_KEY);
  if (activeId !== id) return;
  const next = accounts[0];
  if (next) {
    localStorage.setItem(ACTIVE_ACCOUNT_KEY, next.id);
    window.dispatchEvent(new CustomEvent(ACCOUNT_SWITCHED_EVENT));
  } else {
    localStorage.removeItem(ACTIVE_ACCOUNT_KEY);
    window.dispatchEvent(new CustomEvent(SESSION_CLEARED_EVENT));
  }
}

export function getSessionToken(): string | null {
  return getActiveAccount()?.token ?? null;
}

// Used only for silent token refresh (see meta.refreshedToken handling in
// request() below) - updates the active account's token in place without
// touching the accounts list or firing any switch event. New logins go
// through upsertAccount() instead.
export function setSessionToken(token: string): void {
  const activeId = getActiveAccountId();
  if (!activeId) return;
  const accounts = readAccounts();
  const index = accounts.findIndex((account) => account.id === activeId);
  if (index === -1 || accounts[index]?.token === token) return;
  accounts[index] = { ...accounts[index], token };
  writeAccounts(accounts);
  window.dispatchEvent(new CustomEvent(SESSION_TOKEN_ROTATED_EVENT, { detail: { accountId: activeId } }));
}

function findUnchangedStoredAccount(originatingAccount: StoredAccount | undefined): StoredAccount | undefined {
  if (!originatingAccount) return undefined;
  return readAccounts().find((account) => account.id === originatingAccount.id && account.token === originatingAccount.token);
}

export function commitVnuRefresh(origin: StoredAccount, result: AuthResult): boolean {
  const accounts = readAccounts();
  const index = accounts.findIndex((account) => account.id === origin.id && account.token === origin.token);
  if (index < 0 || getActiveAccountId() !== origin.id || !result.refreshGrant) return false;
  const previousGrant = readVnuRefreshGrant(origin.id);
  try {
    storeVnuRefreshGrant(origin.id, result.refreshGrant);
    accounts[index] = {
      ...accounts[index],
      token: result.token,
      studentCode: result.session.studentCode ?? accounts[index].studentCode,
    };
    writeAccounts(accounts);
    if (result.token !== origin.token) window.dispatchEvent(new CustomEvent(SESSION_TOKEN_ROTATED_EVENT, { detail: { accountId: origin.id } }));
    return true;
  } catch (error) {
    if (previousGrant) storeVnuRefreshGrant(origin.id, previousGrant);
    else clearVnuRefreshGrant(origin.id);
    throw error;
  }
}

function setOriginatingSessionToken(originatingAccount: StoredAccount | undefined, token: string): void {
  const currentOriginatingAccount = findUnchangedStoredAccount(originatingAccount);
  if (!currentOriginatingAccount || currentOriginatingAccount.token === token) return;
  const accounts = readAccounts();
  const index = accounts.findIndex((account) => account.id === currentOriginatingAccount.id);
  if (index === -1) return;
  accounts[index] = { ...accounts[index], token };
  writeAccounts(accounts);
  window.dispatchEvent(new CustomEvent(SESSION_TOKEN_ROTATED_EVENT, { detail: { accountId: currentOriginatingAccount.id } }));
}

// Signs out of the active account only. If other accounts remain, switches
// to one of them instead of forcing a login redirect (see removeAccount).
export function clearSessionToken(): void {
  const activeId = getActiveAccountId();
  if (activeId) removeAccount(activeId);
  else window.dispatchEvent(new CustomEvent(SESSION_CLEARED_EVENT));
}

type InternalRequestOptions = {
  policy?: VnuRequestPolicy;
  noRefresh?: boolean;
  tokenOverride?: string;
};

function apiErrorFromPayload(payload: ApiResponse<unknown>, response: Response): ApiError {
  return new ApiError(
    payload.error?.message ?? `Request failed: ${response.status}`,
    payload.error?.code,
    response.status,
    parseApiErrorDetails(payload.error?.details, payload.error?.code),
  );
}

function parseApiErrorDetails(details: unknown, code?: string): ApiErrorDetails | undefined {
  const exact = apiErrorDetailsSchema.safeParse(details);
  if (exact.success) return exact.data;
  if (code === "VNU_LOGIN_REQUIRED") return undefined;
  const sanitized = apiErrorDetailsSchema.strip().safeParse(details);
  return sanitized.success ? sanitized.data : undefined;
}

async function executeRequest<T>(path: string, init: RequestInit, token: string | undefined): Promise<{ data: T; meta?: Record<string, unknown> }> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  let payload: ApiResponse<T>;
  try {
    payload = (await response.json()) as ApiResponse<T>;
  } catch {
    throw new ApiError(`Request failed: ${response.status} ${response.statusText}`, undefined, response.status);
  }
  if (!response.ok || payload.error) {
    throw apiErrorFromPayload(payload, response);
  }
  return { data: payload.data as T, meta: payload.meta };
}

async function requestWithAccount<T>(account: StoredAccount, path: string, init: RequestInit): Promise<T> {
  return (await executeRequest<T>(path, init, account.token)).data;
}

function reducedPolicy(routePolicy: VnuRequestPolicy, override: VnuRequestPolicy | undefined): VnuRequestPolicy {
  if (!override || override === routePolicy) return routePolicy;
  if (override === "never") return "never";
  if (routePolicy === "safe-replay" && override === "refresh-no-replay") return "refresh-no-replay";
  return routePolicy;
}

function normalizeRefreshError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new ApiError("VNU reconnect was cancelled.", "VNU_REFRESH_CANCELLED", 499);
  }
  return new ApiError("VNU reconnect failed. Try again.", "VNU_REFRESH_NETWORK_ERROR", 503);
}

function removeUnchangedOrigin(account: StoredAccount): void {
  if (getActiveAccountId() !== account.id || !findUnchangedStoredAccount(account)) return;
  clearVnuRefreshGrant(account.id);
  removeAccount(account.id);
}

function removeDeadOriginatingAccount(account: StoredAccount): void {
  const unchangedAccount = findUnchangedStoredAccount(account);
  if (!unchangedAccount) return;
  if (unchangedAccount.universityId === "vnu") clearVnuRefreshGrant(unchangedAccount.id);
  removeAccount(unchangedAccount.id);
}

const refreshControllers = new Map<string, Set<AbortController>>();
const refreshSuppressedAccounts = new Set<string>();
type VnuRefreshStatusGeneration = { generation: number; state: "reconnecting" | "retryable" | "idle" };
const vnuRefreshStatuses = new Map<string, VnuRefreshStatusGeneration>();

function publishVnuRefreshStatus(accountId: string, state: VnuRefreshStatusGeneration["state"]): void {
  const previous = vnuRefreshStatuses.get(accountId);
  const generation = state === "reconnecting" ? (previous?.generation ?? 0) + 1 : (previous?.generation ?? 0);
  vnuRefreshStatuses.set(accountId, { generation, state });
  window.dispatchEvent(new CustomEvent(VNU_REFRESH_STATUS_EVENT, { detail: { accountId, state } }));
}

function resetCancelledReconnectStatus(
  origin: StoredAccount,
  originGrant: string | undefined,
  cancelledStatus: VnuRefreshStatusGeneration | undefined,
): void {
  if (cancelledStatus?.state !== "reconnecting") return;
  const currentAccount = getAccountById(origin.id);
  const currentStatus = vnuRefreshStatuses.get(origin.id);
  if (currentAccount?.token !== origin.token) return;
  if (readVnuRefreshGrant(origin.id) !== originGrant) return;
  if (currentStatus?.generation !== cancelledStatus.generation || currentStatus.state !== "reconnecting") return;
  publishVnuRefreshStatus(origin.id, "idle");
}

export function cancelVnuRefreshForAccount(accountId: string): void {
  refreshSuppressedAccounts.add(accountId);
  const controllers = refreshControllers.get(accountId);
  if (!controllers) return;
  refreshControllers.delete(accountId);
  for (const controller of controllers) controller.abort(new DOMException("VNU account action cancelled refresh", "AbortError"));
}

const refreshDeps = {
  getAccount: (accountId: string) => refreshSuppressedAccounts.has(accountId) ? undefined : getAccountById(accountId),
  getActiveAccountId,
  fetchRefresh: async (account: StoredAccount, grant: string, signal: AbortSignal): Promise<AuthResult> => {
    const controller = new AbortController();
    const controllers = refreshControllers.get(account.id) ?? new Set<AbortController>();
    controllers.add(controller);
    refreshControllers.set(account.id, controllers);
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    try {
      const result = await executeRequest<AuthResult>("/api/vnu/auth/refresh", {
        method: "POST",
        body: JSON.stringify({ refreshGrant: grant }),
        signal: controller.signal,
        cache: "no-store",
      }, account.token);
      return result.data;
    } finally {
      signal.removeEventListener("abort", abort);
      controllers.delete(controller);
      if (controllers.size === 0) refreshControllers.delete(account.id);
    }
  },
  commit: commitVnuRefresh,
  terminal: removeUnchangedOrigin,
  invalidate: (accountId: string) => window.dispatchEvent(new CustomEvent(VNU_REFRESH_COMMITTED_EVENT, { detail: { accountId, preserveFeatureState: true } })),
  status: publishVnuRefreshStatus,
};

async function request<T>(path: string, init: RequestInit = {}, internal: InternalRequestOptions = {}): Promise<T> {
  const originatingAccount = getActiveAccount();
  const failedToken = internal.tokenOverride ?? originatingAccount?.token;
  try {
    const result = await executeRequest<T>(path, init, failedToken);
    const refreshedToken = result.meta?.refreshedToken;
    if (typeof refreshedToken === "string" && refreshedToken) setOriginatingSessionToken(originatingAccount, refreshedToken);
    return result.data;
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;

    if (originatingAccount?.universityId === "vnu" && classifyVnuRecovery(error)) {
      if (init.signal?.aborted) throw init.signal.reason ?? new DOMException("This operation was aborted", "AbortError");
      const routePolicy = requestPolicyFor({ method: init.method ?? "GET", pathname: path });
      const policy = reducedPolicy(routePolicy, internal.policy);
      if (internal.noRefresh || policy === "never") throw error;
      if (refreshSuppressedAccounts.has(originatingAccount.id)) throw error;
      if (!readVnuRefreshGrant(originatingAccount.id)) {
        removeUnchangedOrigin(originatingAccount);
        throw error;
      }
      let outcome;
      try {
        const refresh = runVnuRefresh(originatingAccount, init.signal ?? undefined, refreshDeps);
        outcome = await refresh;
      } catch (refreshError) {
        throw markVnuRefreshAttempted(normalizeRefreshError(refreshError));
      }
      if (outcome.kind === "stale") throw markVnuRefreshAttempted(error);
      if (init.signal?.aborted) throw init.signal.reason ?? new DOMException("This operation was aborted", "AbortError");
      if (policy === "refresh-no-replay") throw markVnuRefreshAttempted(new VnuRequestNotReplayedError());
      try {
        return await request<T>(path, init, { noRefresh: true, tokenOverride: outcome.auth.token });
      } catch (replayError) {
        if (replayError instanceof ApiError) throw markVnuRefreshAttempted(replayError);
        throw markVnuRefreshAttempted(normalizeRefreshError(replayError));
      }
    }

    const code = error.code;
    const sessionDied = isSessionDeathCode(code);
    // The worker's lazy upstream refresh can stall on a StudentHub CAPTCHA
    // its server-side OCR couldn't solve. With stored credentials that is
    // recoverable inline too, so it joins the re-auth path instead of
    // surfacing a dead-end error - but it never clears the session on its
    // own, because the Hyeboard session itself is still valid.
    const refreshNeedsCaptcha = code === "STUDENTHUB_CAPTCHA_REQUIRED";
    if (sessionDied || refreshNeedsCaptcha) {
      const currentOriginatingAccount = findUnchangedStoredAccount(originatingAccount);
      const originatingAccountIsActive = currentOriginatingAccount !== undefined && getActiveAccountId() === currentOriginatingAccount.id;
      // A recoverable UET session death shows the inline re-auth dialog
      // (see components/reauth.tsx) instead of signing the user out.
      if (originatingAccountIsActive && canReauthenticateInline(currentOriginatingAccount.universityId)) requestInlineReauth();
      else if (sessionDied && currentOriginatingAccount) removeDeadOriginatingAccount(currentOriginatingAccount);
    }
    throw error;
  }
}

export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= 1) return false;
  if (wasVnuRefreshAttempted(error)) return false;
  if (classifyVnuRecovery(error)) return false;
  if (!(error instanceof ApiError)) return true;
  return !isSessionDeathCode(error.code) && error.code !== VNU_REQUEST_NOT_REPLAYED;
}

const INVALIDATABLE_VNU_QUERY_NAMES: ReadonlySet<string> = new Set([
  "dashboard",
  "terms",
  "timetable",
  "courses",
  "assignments",
  "grades",
  "exams",
  "documents",
  "tuition",
  "news",
  "training-points",
  "requests",
  "vnu-point-detail",
  "vnu-lookup-catalog",
  "vnu-lookup-profile",
]);

type VnuRefreshQueryCandidate = {
  queryKey: readonly unknown[];
  isActive(): boolean;
};

export function shouldInvalidateVnuRefreshQuery(
  query: VnuRefreshQueryCandidate,
  recoveredAccountId: string,
  activeAccountId: string | null,
): boolean {
  if (recoveredAccountId !== activeAccountId || !query.isActive()) return false;
  const [queryName, universityId] = query.queryKey;
  return universityId === "vnu"
    && typeof queryName === "string"
    && INVALIDATABLE_VNU_QUERY_NAMES.has(queryName);
}

const vnu = createVnuClient(request);
const uet = createUetClient(request);

export const api = {
  universities: () => request<University[]>("/api/universities"),
  profile: (universityId: string) => universityId === "uet" ? uet.profile() : request<Student>(`/api/${universityId}/me`),
  dashboard: (universityId: string, termCode?: string) => request<DashboardSummary>(`/api/${universityId}/dashboard${termCode ? `?termCode=${encodeURIComponent(termCode)}` : ""}`),
  terms: (universityId: string) => universityId === "vnu" ? vnu.terms() : universityId === "uet" ? uet.terms() : request<Term[]>(`/api/${universityId}/terms`),
  timetable: (universityId: string, termCode?: string) => universityId === "uet" ? uet.timetable(termCode) : request<ClassSession[]>(`/api/${universityId}/timetable${termCode ? `?termCode=${encodeURIComponent(termCode)}` : ""}`),
  courses: (universityId: string) => request<Course[]>(`/api/${universityId}/courses`),
  assignments: (universityId: string) => request<Assignment[]>(`/api/${universityId}/assignments`),
  grades: (universityId: string) => universityId === "vnu" ? vnu.grades() : universityId === "uet" ? uet.grades() : request<Grade[]>(`/api/${universityId}/grades`),
  gpa: (universityId: string) => universityId === "uet" ? uet.gpa() : request<GpaSummary>(`/api/${universityId}/gpa`),
  exams: (universityId: string, termCode?: string) => universityId === "vnu" ? vnu.exams(termCode) : universityId === "uet" ? uet.exams(termCode) : request<ExamSession[]>(`/api/${universityId}/exams${termCode ? `?termCode=${encodeURIComponent(termCode)}` : ""}`),
  documents: (universityId: string) => universityId === "vnu" ? vnu.documents() : request<DocumentItem[]>(`/api/${universityId}/documents`),
  tuition: (universityId: string) => universityId === "uet" ? uet.tuition() : request<TuitionStatus>(`/api/${universityId}/tuition`),
  news: (universityId: string) => universityId === "uet" ? uet.news() : request<NewsItem[]>(`/api/${universityId}/news`),
  trainingPoints: (universityId: string) => universityId === "vnu" ? vnu.trainingPoints() : request<TrainingPoint[]>(`/api/${universityId}/training-points`),
  requests: (universityId: string) => request<ServiceRequest[]>(`/api/${universityId}/requests`),
  // vnu (daotao)-only class-code -> internal-id lookup tool - see the
  // classLookup capability flag, gated in the UI before these are called.
  vnuOwnProfile: (signal?: AbortSignal) => vnu.ownProfile(signal),
  vnuClassCatalog: (params: { vTermID: string }, signal?: AbortSignal) => vnu.classCatalog(params, signal),
  vnuClassPointDetail: (params: { id: string; Term: string }, signal?: AbortSignal) => vnu.classPointDetail(params, signal),
  vnuPointDetail: (params: { id: string; Term: string }, signal?: AbortSignal) => vnu.pointDetail(params, signal),
  vnuCrossStudentCode: (params: { stdId: string }, signal?: AbortSignal) => vnu.crossStudentCode(params, signal),
  vnuCrossStudentId: (params: { stdCode: string }, signal?: AbortSignal) => vnu.crossStudentId(params, signal),
  vnuCrossTranscript: (input: VnuCrossTranscriptInput, signal?: AbortSignal) => vnu.crossTranscript(input, signal),
  vnuCrossDetail: (permit: string, signal?: AbortSignal) => vnu.crossDetail(permit, signal),
  vnuCrossDetailBulk: (permits: string[], signal?: AbortSignal) => vnu.crossDetailBulk(permits, signal),
  vnuCrossDetailExport: (permits: string[], signal?: AbortSignal) => vnu.crossDetailExport(permits, signal),
  vnuCrossLookupBulk: (mode: VnuBulkLookupMode, targets: string[], signal?: AbortSignal) => vnu.crossLookupBulk(mode, targets, signal),
  importSession: async (universityId: string, body: ImportSessionInput): Promise<ImportedAccountResult> => {
    const auth = await request<AuthResult>(`/api/${universityId}/auth/import-session`, { method: "POST", body: JSON.stringify(body) });
    const account = commitImportedAccount(universityId, auth);
    return { account, auth };
  },
  // UET Google automation can take 90s+; parent direct login may pause for a
  // human CAPTCHA answer. Both use the Worker's SSE route. VNU, manual
  // token/cookie, and mock imports use the plain JSON request above.
  importUetGoogleSession: async (
    body: { uetGoogleEmail: string; uetGooglePassword: string; uetGoogleCookies?: unknown },
    onProgress?: (message: string) => void,
    // Called when the parent/guardian direct-login flow hits a CAPTCHA that
    // server-side OCR couldn't confidently solve (see the adapter's
    // Worker-safe CAPTCHA resolver). Resolve with the user's typed answer.
    // The signal aborts if the stream fails or closes before submission.
    onCaptchaNeeded?: (imageDataUrl: string, signal: AbortSignal) => Promise<string>,
    callerSignal?: AbortSignal,
  ) => {
    const linkedAbort = createLinkedAbortController(
      callerSignal,
      UET_LOGIN_DEADLINE_MS,
      new ApiError("Sign-in was cancelled.", "UET_LOGIN_CANCELLED", 499),
      new ApiError("Sign-in took longer than three minutes and was cancelled.", "GOOGLE_AUTOMATION_TIMEOUT", 408),
    );
    try {
      const token = getSessionToken();
      const response = await fetch(`${API_BASE_URL}/api/uet/auth/import-session`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: linkedAbort.signal,
      });
      if (!response.ok || !response.body) {
        // Errors thrown before the stream starts (rate limiting, missing
        // server config) still come back as plain JSON, not SSE.
        let payload: ApiResponse<unknown> | undefined;
        try {
          payload = (await response.json()) as ApiResponse<unknown>;
        } catch {
          // Body wasn't JSON either — fall through to the generic error below.
        }
        if (payload) throw apiErrorFromPayload(payload, response);
        throw new ApiError(`Request failed: ${response.status}`, undefined, response.status);
      }
      const reader = response.body.getReader();
      const data = await readUetSessionStream(reader, {
        onProgress,
        onCaptchaNeeded,
        submitCaptcha: (challengeId, answer) => request("/api/uet/auth/solve-captcha", {
          method: "POST",
          body: JSON.stringify({ challengeId, answer }),
          signal: linkedAbort.signal,
        }),
        createError: (message, code, status) => new ApiError(message, code, status),
      });
      upsertAccount("uet", data.token, data.session?.studentCode);
      return { token: data.token };
    } catch (error) {
      if (linkedAbort.signal.aborted && linkedAbort.signal.reason instanceof Error) throw linkedAbort.signal.reason;
      throw error;
    } finally {
      linkedAbort.dispose();
    }
  },
  // Best-effort server-side revocation (also invalidates any persisted uetGoogleCredential
  // embedded in the token). Must never throw - logout has to succeed locally even if this
  // network call fails, so callers should not need to wrap this in their own try/catch.
  logout: async (universityId: string) => {
    try {
      await request<{ authenticated: false }>(`/api/${universityId}/auth/logout`, { method: "POST" });
    } catch {
      // Ignore - the local session is cleared regardless of server-side outcome.
    }
  },
  revokeAndRemoveAccount,
};

export async function revokeAndRemoveAccount(accountId: string): Promise<void> {
  const origin = getAccountById(accountId);
  if (!origin) return;
  const originRefreshGrant = origin.universityId === "vnu" ? readVnuRefreshGrant(origin.id) : undefined;
  const cancelledRefreshStatus = vnuRefreshStatuses.get(origin.id);

  cancelVnuRefreshForAccount(origin.id);
  try {
    if (origin.universityId === "vnu") {
      await requestWithAccount<{ authenticated: false }>(origin, "/api/vnu/auth/logout", {
        method: "POST",
        body: JSON.stringify(originRefreshGrant ? { refreshGrant: originRefreshGrant } : {}),
      });
    } else {
      try {
        await requestWithAccount(origin, `/api/${origin.universityId}/auth/logout`, { method: "POST" });
      } catch {
        // Non-VNU logout remains best-effort; local removal must still finish.
      }
    }

    const current = getAccountById(origin.id);
    if (!current || current.token !== origin.token) return;
    clearVnuRefreshGrant(origin.id);
    for (const key of LEGACY_VNU_RELOGIN_KEYS) sessionStorage.removeItem(key);
    vnuRefreshStatuses.delete(origin.id);
    removeAccount(origin.id);
  } catch (error) {
    if (origin.universityId === "vnu") resetCancelledReconnectStatus(origin, originRefreshGrant, cancelledRefreshStatus);
    throw error;
  } finally {
    refreshSuppressedAccounts.delete(origin.id);
  }
}
