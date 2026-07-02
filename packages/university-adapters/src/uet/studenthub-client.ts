import { HyeboardError, unwrapStudentHubEnvelope, type EncryptedSessionPayload } from "@hyeboard/core";
import type { StudentHubBill, StudentHubClassSession, StudentHubCourseCount, StudentHubExam, StudentHubGoogleLogin, StudentHubGpa, StudentHubGrade, StudentHubNews, StudentHubNotificationPage, StudentHubRequestType, StudentHubScheduleAlertSession, StudentHubServiceRequest, StudentHubStudent, StudentHubTerm, StudentHubTrainingPointAssessment, StudentHubTrainingPointLockAssessment } from "./types";

const STUDENTHUB_BASE = "https://studenthub.uet.edu.vn";

export class StudentHubClient {
  constructor(private readonly session?: EncryptedSessionPayload) {}

  private headers(): HeadersInit {
    const credential = this.session?.studenthub;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (credential?.kind === "bearer") headers.Authorization = `Bearer ${credential.value}`;
    if (credential?.kind === "cookie") headers.Cookie = credential.value;
    return headers;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${STUDENTHUB_BASE}${path}`, {
      ...init,
      headers: { ...this.headers(), "Content-Type": "application/json", ...init.headers },
    });
    if (!response.ok) throw new HyeboardError("STUDENTHUB_REQUEST_FAILED", `StudentHub request failed: ${response.status}`, response.status);
    const json = (await response.json()) as T;
    return unwrapStudentHubEnvelope(json);
  }

  async exchangeGoogleCredential(credential: string) {
    return this.request<StudentHubGoogleLogin>(`/api/auth/google/callback?code=${encodeURIComponent(credential)}`);
  }

  getProfile() { return this.request<StudentHubStudent>("/api/student/detail"); }
  getTerms() { return this.request<StudentHubTerm[]>("/api/student/term/getTerm", { method: "POST", body: "{}" }); }
  getTimetable(termCode?: string) { return this.request<StudentHubClassSession[]>("/api/student/tkb", { method: "POST", body: JSON.stringify({ termCode }) }); }
  getScheduleAlert(day: string) { return this.request<StudentHubScheduleAlertSession[][]>(`/api/student/schedule-alert?day=${encodeURIComponent(day)}`); }
  getCourseCount() { return this.request<StudentHubCourseCount>("/api/student/count-course-term"); }
  getMandatoryTasks() { return this.request<unknown[]>("/api/student/mandatory-task/incomplete"); }
  getGrades() { return this.request<StudentHubGrade[]>("/api/student/kqht"); }
  getGpa() { return this.request<StudentHubGpa>("/api/student/results"); }
  getExams(termCode?: string) { return this.request<StudentHubExam[]>("/api/student/exam-schedule", { method: "POST", body: JSON.stringify({ termCode }) }); }
  getBills() { return this.request<StudentHubBill[]>("/api/student/getAllBills", { method: "POST", body: "{}" }); }
  getNotifications(studentCode?: string) { return this.request<StudentHubNotificationPage>(`/api/noti/user/${studentCode ?? this.session?.studentCode ?? ""}`); }
  getNews() { return this.request<StudentHubNews[]>("/api/student/news"); }
  getTrainingPointAssessment(studentCode: string) { return this.request<StudentHubTrainingPointAssessment>(`/api/student/training-points/assessment?studentCode=${encodeURIComponent(studentCode)}`); }
  getTrainingPointLockAssessment(studentCode: string, termCode: string) { return this.request<StudentHubTrainingPointLockAssessment>(`/api/student/training-points/assessment/lock-assessment?studentCode=${encodeURIComponent(studentCode)}&termCode=${encodeURIComponent(termCode)}`); }
  getRequests() { return this.request<StudentHubServiceRequest[]>("/api/student/request/display"); }
  getRequestTypes() { return this.request<StudentHubRequestType[]>("/api/student/request/type"); }
}
