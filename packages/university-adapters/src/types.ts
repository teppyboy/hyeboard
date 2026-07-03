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
import type { EncryptedSessionPayload } from "@hyeboard/core";

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

export type ImportSessionContext = {
  browserBinding?: BrowserBinding;
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
