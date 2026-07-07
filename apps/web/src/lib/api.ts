import type { ApiResponse, Assignment, ClassSession, Course, DashboardSummary, DocumentItem, ExamSession, Grade, NewsItem, ServiceRequest, Term, TrainingPoint, TuitionStatus, University } from "@hyeboard/schemas";
import { mapExamRow, mapGpaSummary, mapGradeRow, mapProfile, mapSyllabusRow, mapTerms, mapTrainingPoints } from "@hyeboard/university-adapters/src/vnu/mapper";
import { parseExamTermOptions, parseExamsHtml, parseGradesHtml, parseProfileHtml, parseStudyProgressHtml, parseSyllabusHtml } from "@hyeboard/university-adapters/src/vnu/parser";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";
const SESSION_KEY = "hyeboard.sessionToken";
const ACCOUNTS_KEY = "hyeboard.accounts";
const ACTIVE_ACCOUNT_KEY = "hyeboard.activeAccountId";

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
const SESSION_INVALID_CODES = new Set(["MISSING_SESSION", "SESSION_EXPIRED", "INVALID_SESSION"]);

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

export type StoredAccount = {
  id: string;
  universityId: string;
  token: string;
  studentCode?: string;
  addedAt: string;
};

export class ApiError extends Error {
  constructor(message: string, public readonly code?: string, public readonly status?: number) {
    super(message);
    this.name = "ApiError";
  }
}

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

export function switchAccount(id: string): void {
  if (!readAccounts().some((account) => account.id === id)) return;
  localStorage.setItem(ACTIVE_ACCOUNT_KEY, id);
  window.dispatchEvent(new CustomEvent(ACCOUNT_SWITCHED_EVENT));
}

// Removes an account entirely (e.g. sign-out, or a dead session detected via
// a 401). If the removed account was the active one, auto-switches to
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
  if (index === -1) return;
  accounts[index] = { ...accounts[index], token };
  writeAccounts(accounts);
}

// Signs out of the active account only. If other accounts remain, switches
// to one of them instead of forcing a login redirect (see removeAccount).
export function clearSessionToken(): void {
  const activeId = getActiveAccountId();
  if (activeId) removeAccount(activeId);
  else window.dispatchEvent(new CustomEvent(SESSION_CLEARED_EVENT));
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getSessionToken();
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
    const code = payload.error?.code;
    if (code ? SESSION_INVALID_CODES.has(code) : response.status === 401) clearSessionToken();
    throw new ApiError(payload.error?.message ?? `Request failed: ${response.status}`, code, response.status);
  }
  // Silent session refresh: for UET sessions created via automated Google login, the
  // worker's resolveSession() (apps/worker/src/index.ts) may re-run the login automation
  // mid-request when the upstream credential has expired, then hand back a fresh encrypted
  // token via meta.refreshedToken. Adopt it transparently so the user never sees a re-login
  // prompt for routine expiry — only trusted, server-signed tokens ever populate this field.
  const refreshedToken = payload.meta?.refreshedToken;
  if (typeof refreshedToken === "string" && refreshedToken) setSessionToken(refreshedToken);
  return payload.data as T;
}

function queryString(params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value);
  }
  const rendered = query.toString();
  return rendered ? `?${rendered}` : "";
}

async function vnuRaw(page: string, params: Record<string, string | undefined> = {}) {
  return request<{ html: string }>(`/api/vnu/raw/${page}${queryString(params)}`);
}

async function vnuDashboard(): Promise<DashboardSummary> {
  const [profilePage, gradesPage, progressPage] = await Promise.all([
    vnuRaw("profile"),
    vnuRaw("grades"),
    vnuRaw("progress"),
  ]);
  const profile = parseProfileHtml(profilePage.html);
  const grades = parseGradesHtml(gradesPage.html);
  const progress = parseStudyProgressHtml(progressPage.html);
  const terms = mapTerms(grades);
  return {
    student: mapProfile(profile, "vnu"),
    currentTerm: terms[0],
    todaySchedule: [],
    courses: [],
    assignments: [],
    grades: grades.rows.map(mapGradeRow),
    gpa: mapGpaSummary(grades, progress),
    exams: [],
    notifications: [],
  };
}

async function vnuTerms(): Promise<Term[]> {
  return mapTerms(parseGradesHtml((await vnuRaw("grades")).html));
}

async function vnuGrades(): Promise<Grade[]> {
  return parseGradesHtml((await vnuRaw("grades")).html).rows.map(mapGradeRow);
}

async function vnuExams(termCode?: string): Promise<ExamSession[]> {
  const [profilePage, basePage] = await Promise.all([vnuRaw("profile"), vnuRaw("exam-base")]);
  const profile = parseProfileHtml(profilePage.html);
  if (!profile.internalStudentId || !profile.internalUnivId) throw new ApiError("daotao.vnu.edu.vn did not return enough profile data to look up exams.", "VNU_PROFILE_INCOMPLETE", 500);
  const options = parseExamTermOptions(basePage.html);
  const option = termCode
    ? options.find((item) => item.label.startsWith(`${termCode}.`))
    : (options.find((item) => item.selected) ?? options[0]);
  if (!option) return [];
  const page = await vnuRaw("exams", { selUniv: profile.internalUnivId, selStd: profile.internalStudentId, vTermID: option.value });
  return parseExamsHtml(page.html).map(mapExamRow);
}

async function vnuDocuments(): Promise<DocumentItem[]> {
  return parseSyllabusHtml((await vnuRaw("syllabus")).html).map(mapSyllabusRow);
}

async function vnuTrainingPoints(): Promise<TrainingPoint[]> {
  return mapTrainingPoints(parseStudyProgressHtml((await vnuRaw("progress")).html));
}

export const api = {
  universities: () => request<University[]>("/api/universities"),
  dashboard: (universityId: string, termCode?: string) => universityId === "vnu" ? vnuDashboard() : request<DashboardSummary>(`/api/${universityId}/dashboard${termCode ? `?termCode=${encodeURIComponent(termCode)}` : ""}`),
  terms: (universityId: string) => universityId === "vnu" ? vnuTerms() : request<Term[]>(`/api/${universityId}/terms`),
  timetable: (universityId: string, termCode?: string) => request<ClassSession[]>(`/api/${universityId}/timetable${termCode ? `?termCode=${encodeURIComponent(termCode)}` : ""}`),
  courses: (universityId: string) => request<Course[]>(`/api/${universityId}/courses`),
  assignments: (universityId: string) => request<Assignment[]>(`/api/${universityId}/assignments`),
  grades: (universityId: string) => universityId === "vnu" ? vnuGrades() : request<Grade[]>(`/api/${universityId}/grades`),
  exams: (universityId: string, termCode?: string) => universityId === "vnu" ? vnuExams(termCode) : request<ExamSession[]>(`/api/${universityId}/exams${termCode ? `?termCode=${encodeURIComponent(termCode)}` : ""}`),
  documents: (universityId: string) => universityId === "vnu" ? vnuDocuments() : request<DocumentItem[]>(`/api/${universityId}/documents`),
  tuition: (universityId: string) => request<TuitionStatus>(`/api/${universityId}/tuition`),
  news: (universityId: string) => request<NewsItem[]>(`/api/${universityId}/news`),
  trainingPoints: (universityId: string) => universityId === "vnu" ? vnuTrainingPoints() : request<TrainingPoint[]>(`/api/${universityId}/training-points`),
  requests: (universityId: string) => request<ServiceRequest[]>(`/api/${universityId}/requests`),
  importSession: async (universityId: string, body: { studentCode?: string; studenthubGoogleCredential?: string; studenthubToken?: string; studenthubCookie?: string; canvasToken?: string; canvasCookie?: string; canvasCsrfToken?: string; vnuUsername?: string; vnuPassword?: string; uetGoogleEmail?: string; uetGooglePassword?: string }) => {
    const data = await request<{ token: string; session?: { studentCode?: string } }>(`/api/${universityId}/auth/import-session`, { method: "POST", body: JSON.stringify(body) });
    upsertAccount(universityId, data.token, data.session?.studentCode);
    return data;
  },
  // The uet Google-login automation is the one slow (potentially 90s+),
  // multi-step login path — the worker streams interim progress as
  // Server-Sent Events instead of one opaque blocking response (see
  // apps/worker/src/app.ts's import-session route). Every other login mode
  // (vnu, manual token/cookie paste, mock demo) uses the plain importSession
  // above since those resolve almost instantly.
  importUetGoogleSession: async (body: { uetGoogleEmail: string; uetGooglePassword: string; uetGoogleCookies?: unknown }, onProgress?: (message: string) => void) => {
    const token = getSessionToken();
    const response = await fetch(`${API_BASE_URL}/api/uet/auth/import-session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
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
      throw new ApiError(payload?.error?.message ?? `Request failed: ${response.status}`, payload?.error?.code, response.status);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separatorIndex: number;
      while ((separatorIndex = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        const eventMatch = /^event: (.+)$/m.exec(rawEvent);
        const dataMatch = /^data: (.+)$/m.exec(rawEvent);
        if (!eventMatch || !dataMatch) continue;
        const data = JSON.parse(dataMatch[1]) as { message?: string; token?: string; session?: { studentCode?: string }; code?: string; status?: number };
        if (eventMatch[1] === "progress" && data.message) {
          onProgress?.(data.message);
        } else if (eventMatch[1] === "done" && data.token) {
          upsertAccount("uet", data.token, data.session?.studentCode);
          return { token: data.token };
        } else if (eventMatch[1] === "error") {
          throw new ApiError(data.message ?? "Google sign-in failed.", data.code, data.status);
        }
      }
    }
    throw new ApiError("The sign-in stream ended unexpectedly. Try again.", undefined, 502);
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
};
