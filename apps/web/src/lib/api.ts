import type { ApiResponse, Assignment, ClassSession, Course, DashboardSummary, DocumentItem, ExamSession, Grade, NewsItem, ServiceRequest, Term, TrainingPoint, TuitionStatus, University } from "@hyeboard/schemas";
import { mapExamRow, mapGpaSummary, mapGradeRow, mapProfile, mapSyllabusRow, mapTerms, mapTrainingPoints } from "@hyeboard/university-adapters/src/vnu/mapper";
import { parseExamTermOptions, parseExamsHtml, parseGradesHtml, parseProfileHtml, parseStudyProgressHtml, parseSyllabusHtml } from "@hyeboard/university-adapters/src/vnu/parser";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";
const SESSION_KEY = "hyeboard.sessionToken";

// Only these codes mean the Hyeboard session itself is dead - everything else
// (e.g. a feature that needs a learning-platform credential the user never provided) is
// a feature-specific problem that should NOT log the user out of a session
// that is otherwise perfectly valid.
const SESSION_INVALID_CODES = new Set(["MISSING_SESSION", "SESSION_EXPIRED", "INVALID_SESSION"]);

// Fired whenever the local session token is cleared for any reason (explicit
// sign-out, or an upstream 401 that means the session itself is dead). The
// app shell listens for this to immediately bounce the user to /login
// instead of leaving them stuck on a page that can no longer fetch data.
export const SESSION_CLEARED_EVENT = "hyeboard:session-cleared";

export class ApiError extends Error {
  constructor(message: string, public readonly code?: string, public readonly status?: number) {
    super(message);
    this.name = "ApiError";
  }
}

export function getSessionToken() {
  return sessionStorage.getItem(SESSION_KEY) ?? localStorage.getItem(SESSION_KEY);
}

export function setSessionToken(token: string) {
  sessionStorage.setItem(SESSION_KEY, token);
}

export function clearSessionToken() {
  sessionStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(SESSION_KEY);
  window.dispatchEvent(new CustomEvent(SESSION_CLEARED_EVENT));
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
    const data = await request<{ token: string }>(`/api/${universityId}/auth/import-session`, { method: "POST", body: JSON.stringify(body) });
    setSessionToken(data.token);
    return data;
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
