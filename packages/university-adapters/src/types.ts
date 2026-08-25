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
  UniversityCapabilities,
} from "@hyeboard/schemas";
import type { EncryptedSessionPayload, GoogleSessionCookie } from "@hyeboard/core";

export type AdapterRequest = {
  signal?: AbortSignal;
  session?: EncryptedSessionPayload;
  termCode?: string;
  limit?: number;
  capabilities?: Partial<UniversityCapabilities>;
};

export type LoginImportInput = {
  signal?: AbortSignal;
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

// The small Puppeteer surface used by the UET Google flow. This is intentionally
// structural so a Node-only host can inject its already-owned browser without
// making this shared contract depend on puppeteer-core at runtime.
export type UetBrowserCookie = GoogleSessionCookie;

export type UetElementHandle = {
  click(): Promise<void>;
};

export type UetNavigationOptions = {
  waitUntil: "domcontentloaded" | "networkidle0";
  timeout?: number;
};

export type UetPageDriver = {
  close(): Promise<void>;
  setCookie(...cookies: GoogleSessionCookie[]): Promise<void>;
  goto(url: string, options: UetNavigationOptions): Promise<unknown>;
  url(): string;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<UetElementHandle>;
  click(selector: string): Promise<void>;
  type(selector: string, text: string, options?: { delay?: number }): Promise<void>;
  waitForNavigation(options: UetNavigationOptions): Promise<unknown>;
  bringToFront(): Promise<void>;
  isClosed(): boolean;
  evaluate<T>(pageFunction: () => T): Promise<T>;
  once(event: "close", listener: () => void): void;
  cookies(...urls: string[]): Promise<UetBrowserCookie[]>;
  waitForNetworkIdle(options: { idleTime: number; timeout: number }): Promise<void>;
};

export type UetBrowserTarget = {
  page(): Promise<UetPageDriver | undefined>;
};

export type UetBrowserDriver = {
  readonly connected?: boolean;
  newPage(): Promise<UetPageDriver>;
  close(): Promise<void>;
  disconnect(): Promise<void> | void;
  on(event: "targetcreated", listener: (target: UetBrowserTarget) => void): void;
  off(event: "targetcreated", listener: (target: UetBrowserTarget) => void): void;
};

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
  | { kind: "local"; headless?: boolean }
  // Node-only bridge for a browser owned by an automation host. The optional
  // assertion is checked at handoff boundaries so a stale lease cannot keep
  // driving the shared browser session.
  | { kind: "owned"; driver: UetBrowserDriver; assertOwned?: () => Promise<void> };

export type ImportSessionContext = {
  // Cancellation for the complete import operation. LoginImportInput.signal
  // takes precedence when both are supplied by a caller.
  signal?: AbortSignal;
  browserConnection?: BrowserConnection;
  // Optional progress reporter for slow, multi-step logins (currently only
  // the uet adapter's automated Google-login flow calls this). Callers that
  // don't care about interim progress (e.g. resolveSession()'s silent
  // background refresh) can simply omit it.
  onProgress?: (message: string) => void;
  // Called when the uet adapter's parent/guardian direct API login receives
  // a CAPTCHA image that OCR (see packages/university-adapters/src/uet/
  // captcha-ocr.ts) couldn't confidently solve. Relays the image (a base64
  // data URL) to the end user and resolves with their
  // typed answer. Omitting this means a CAPTCHA that OCR can't solve fails
  // outright (STUDENTHUB_CAPTCHA_REQUIRED) instead of prompting a human —
  // appropriate for e.g. resolveSession()'s silent background refresh,
  // which has no interactive user to ask.
  onCaptchaNeeded?: (imageDataUrl: string, signal?: AbortSignal) => Promise<string>;
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
