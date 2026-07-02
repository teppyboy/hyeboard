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
};

export type ImportedSession = {
  universityId: string;
  studentCode?: string;
  expiresAt: string;
  session: EncryptedSessionPayload;
};

export interface UniversityAdapter {
  university: University;
  importSession(input: LoginImportInput): Promise<ImportedSession>;
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
