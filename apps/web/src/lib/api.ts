import type { ApiResponse, Assignment, ClassSession, Course, DashboardSummary, DocumentItem, ExamSession, Grade, NewsItem, ServiceRequest, Term, TrainingPoint, TuitionStatus, University } from "@hyeboard/schemas";

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
  return payload.data as T;
}

export const api = {
  universities: () => request<University[]>("/api/universities"),
  dashboard: (universityId: string, termCode?: string) => request<DashboardSummary>(`/api/${universityId}/dashboard${termCode ? `?termCode=${encodeURIComponent(termCode)}` : ""}`),
  terms: (universityId: string) => request<Term[]>(`/api/${universityId}/terms`),
  timetable: (universityId: string, termCode?: string) => request<ClassSession[]>(`/api/${universityId}/timetable${termCode ? `?termCode=${encodeURIComponent(termCode)}` : ""}`),
  courses: (universityId: string) => request<Course[]>(`/api/${universityId}/courses`),
  assignments: (universityId: string) => request<Assignment[]>(`/api/${universityId}/assignments`),
  grades: (universityId: string) => request<Grade[]>(`/api/${universityId}/grades`),
  exams: (universityId: string, termCode?: string) => request<ExamSession[]>(`/api/${universityId}/exams${termCode ? `?termCode=${encodeURIComponent(termCode)}` : ""}`),
  documents: (universityId: string) => request<DocumentItem[]>(`/api/${universityId}/documents`),
  tuition: (universityId: string) => request<TuitionStatus>(`/api/${universityId}/tuition`),
  news: (universityId: string) => request<NewsItem[]>(`/api/${universityId}/news`),
  trainingPoints: (universityId: string) => request<TrainingPoint[]>(`/api/${universityId}/training-points`),
  requests: (universityId: string) => request<ServiceRequest[]>(`/api/${universityId}/requests`),
  importSession: async (universityId: string, body: { studentCode?: string; studenthubGoogleCredential?: string; studenthubToken?: string; studenthubCookie?: string; canvasToken?: string; canvasCookie?: string; canvasCsrfToken?: string; vnuUsername?: string; vnuPassword?: string }) => {
    const data = await request<{ token: string }>(`/api/${universityId}/auth/import-session`, { method: "POST", body: JSON.stringify(body) });
    setSessionToken(data.token);
    return data;
  },
};
