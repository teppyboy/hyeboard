import type {
  Assignment,
  AttendanceRecord,
  ClassSession,
  Course,
  DashboardSummary,
  DocumentItem,
  ExamSession,
  Grade,
  GpaSummary,
  NewsItem,
  Notification,
  ServiceRequest,
  Student,
  Term,
  TrainingPoint,
  TuitionStatus,
  University,
} from "@hyeboard/schemas";
import type { EncryptedSessionPayload, GoogleSessionCookie } from "@hyeboard/core";

export type AdapterRequest = {
  session?: EncryptedSessionPayload;
  termCode?: string;
  limit?: number;
};

export type LoginImportInput = {
  studenthubGoogleCredential?: string;
  studenthubToken?: string;
  studenthubCookie?: string;
  canvasToken?: string;
  canvasCookie?: string;
  canvasCsrfToken?: string;
  vnuUsername?: string;
  vnuPassword?: string;
  studentCode?: string;
  // Automated VNU Google-account login for the uet adapter (StudentHub +
  // Canvas). Deliberately NOT named vnuGoogle* — the unrelated vnu (daotao)
  // adapter already owns vnuUsername/vnuPassword for its own login form.
  uetGoogleEmail?: string;
  uetGooglePassword?: string;
  // Previously-captured Google session cookies (see
  // EncryptedSessionPayload.uetGoogleCredential.googleCookies). Only ever
  // supplied by resolveSession()'s lazy-refresh path in apps/worker, never
  // by a real end-user request — lets automateVnuGoogleLogin attempt a
  // silent, cookie-based re-login before falling back to the full
  // interactive flow.
  uetGoogleCookies?: GoogleSessionCookie[];
};

export type ImportedSession = {
  universityId: string;
  studentCode?: string;
  expiresAt: string;
  session: EncryptedSessionPayload;
};

// Minimal structural type for the Cloudflare Browser Rendering binding
// (env.BROWSER). Avoids depending on @cloudflare/workers-types from this
// package — only apps/worker needs the full Cloudflare ambient types; this
// package only needs to call .fetch() on whatever binding it's handed
// (that's exactly what @cloudflare/puppeteer's puppeteer.launch() expects).
export type BrowserBinding = { fetch: typeof fetch };

// Two ways to drive the Google-login automation's headless browser:
// - "cloudflare": Cloudflare's managed Browser Rendering binding (env.BROWSER),
//   used when deployed to Cloudflare Workers. This is the live-verified,
//   production path — do not change its behavior.
// - "self-hosted": a plain CDP WebSocket endpoint (e.g. a `browserless/chrome`
//   Docker container) for running Hyeboard under standalone `workerd` outside
//   Cloudflare, where the Browser Rendering service does not exist.
export type BrowserConnection =
  | { kind: "cloudflare"; binding: BrowserBinding }
  | { kind: "self-hosted"; browserWSEndpoint: string }
  | { kind: "local"; headless?: boolean };

export type ImportSessionContext = {
  browserConnection?: BrowserConnection;
};

export interface UniversityAdapter {
  university: University;
  importSession(input: LoginImportInput, context?: ImportSessionContext): Promise<ImportedSession>;
  getStudentProfile(request: AdapterRequest): Promise<Student>;
  getTerms(request: AdapterRequest): Promise<Term[]>;
  getDashboard(request: AdapterRequest): Promise<DashboardSummary>;
  getTimetable(request: AdapterRequest): Promise<ClassSession[]>;
  getCourses(request: AdapterRequest): Promise<Course[]>;
  getCourseDetail(request: AdapterRequest & { courseId: string }): Promise<Course>;
  getAssignments(request: AdapterRequest): Promise<Assignment[]>;
  getGrades(request: AdapterRequest): Promise<Grade[]>;
  getGpaSummary(request: AdapterRequest): Promise<GpaSummary>;
  getExams(request: AdapterRequest): Promise<ExamSession[]>;
  getAttendance(request: AdapterRequest): Promise<AttendanceRecord[]>;
  getNotifications(request: AdapterRequest): Promise<Notification[]>;
  getNews(request: AdapterRequest): Promise<NewsItem[]>;
  getDocuments(request: AdapterRequest): Promise<DocumentItem[]>;
  getTuition(request: AdapterRequest): Promise<TuitionStatus>;
  getTrainingPoints(request: AdapterRequest): Promise<TrainingPoint[]>;
  getRequests(request: AdapterRequest): Promise<ServiceRequest[]>;
}
