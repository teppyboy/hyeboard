import { HyeboardError, unwrapStudentHubEnvelope, type EncryptedSessionPayload } from "@hyeboard/core";
import type {
  StudentHubAdmissionInfo,
  StudentHubBill,
  StudentHubBillOptional,
  StudentHubBloodType,
  StudentHubCanvasLinkInfo,
  StudentHubClassSession,
  StudentHubCommitteeCheck,
  StudentHubCourseCount,
  StudentHubDashboardBanner,
  StudentHubDirectLogin,
  StudentHubDistrict,
  StudentHubDktnCourses,
  StudentHubExam,
  StudentHubFamilyDetail,
  StudentHubGoogleLogin,
  StudentHubGpa,
  StudentHubGrade,
  StudentHubHealthcareDetail,
  StudentHubNation,
  StudentHubNews,
  StudentHubNotificationPage,
  StudentHubPage,
  StudentHubPersonDetail,
  StudentHubProgram,
  StudentHubProvince,
  StudentHubRegistrationWindow,
  StudentHubRequestType,
  StudentHubScheduleAlertSession,
  StudentHubSemesterAdvice,
  StudentHubSemesterExpected,
  StudentHubServiceRequest,
  StudentHubStudent,
  StudentHubTerm,
  StudentHubTrainingPointAssessment,
  StudentHubTrainingPointLockAssessment,
  StudentHubWard,
} from "./types";

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
    let response: Response;
    try {
      response = await fetch(`${STUDENTHUB_BASE}${path}`, {
        ...init,
        headers: { ...this.headers(), "Content-Type": "application/json", ...init.headers },
      });
    } catch {
      throw new HyeboardError("STUDENTHUB_REQUEST_FAILED", "Could not reach the university portal. Try again later.", 502);
    }
    if (!response.ok) throw new HyeboardError("STUDENTHUB_REQUEST_FAILED", `University portal request failed: ${response.status}`, response.status);
    try {
      const json = (await response.json()) as T;
      return unwrapStudentHubEnvelope(json);
    } catch {
      throw new HyeboardError("STUDENTHUB_REQUEST_FAILED", "The university portal returned a non-JSON response.", 502);
    }
  }

  async exchangeGoogleCredential(credential: string) {
    return this.request<StudentHubGoogleLogin>(`/api/auth/google/callback?code=${encodeURIComponent(credential)}`);
  }

  // Direct username/password login — used by parent/guardian accounts
  // (see har-notes.md's "parent/guardian account" section). No browser
  // automation involved: a single JSON POST, resolves near-instantly.
  // Unlike exchangeGoogleCredential/request's other callers, this response
  // is NOT wrapped in the {code, msgCode, data} envelope in the captured
  // HAR, so it's read directly rather than via unwrapStudentHubEnvelope.
  async authenticateDirect(username: string, password: string): Promise<StudentHubDirectLogin> {
    let response: Response;
    try {
      response = await fetch(`${STUDENTHUB_BASE}/api/auth/login`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ userName: username, password }),
      });
    } catch {
      throw new HyeboardError("STUDENTHUB_REQUEST_FAILED", "Could not reach the university portal. Try again later.", 502);
    }
    if (!response.ok) throw new HyeboardError("INVALID_STUDENTHUB_CREDENTIAL", "Incorrect username or password.", 401);
    try {
      const json = (await response.json()) as { data?: StudentHubDirectLogin } | StudentHubDirectLogin;
      return unwrapStudentHubEnvelope(json);
    } catch {
      throw new HyeboardError("STUDENTHUB_REQUEST_FAILED", "The university portal returned a non-JSON response.", 502);
    }
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

  // ─── Endpoints discovered from the parent/guardian-account HAR capture ───
  // (see har-notes.md) — not yet wired into the dashboard/mapper layer, but
  // wrapped here so they're available to call. Response shapes are best-
  // effort based on that single capture; several fields were null/unset
  // there and may need adjustment once seen populated.

  getAdmissionInfo() { return this.request<StudentHubAdmissionInfo>("/api/student/admission/info"); }
  // Plain-text response (observed mimetype text/plain, not JSON) — likely a
  // URL or base64 blob, so this bypasses request()'s JSON parsing.
  async getAvatar(): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${STUDENTHUB_BASE}/api/student/avatar`, { headers: this.headers() });
    } catch {
      throw new HyeboardError("STUDENTHUB_REQUEST_FAILED", "Could not reach the university portal. Try again later.", 502);
    }
    if (!response.ok) throw new HyeboardError("STUDENTHUB_REQUEST_FAILED", `University portal request failed: ${response.status}`, response.status);
    return response.text();
  }
  getIsCommittee() { return this.request<StudentHubCommitteeCheck>("/api/student/criteria/role/is-committee"); }
  getCriteriaStudentInfo(studentCode: string) { return this.request<unknown>(`/api/student/criteria/student-info?studentCode=${encodeURIComponent(studentCode)}`); }
  getDktn() { return this.request<string>("/api/student/dktn"); }
  getDktnCourses() { return this.request<StudentHubDktnCourses>("/api/student/dktn/course"); }
  getBillOptionalList() { return this.request<StudentHubBillOptional[]>("/api/student/getBill/bill-optional/list", { method: "POST", body: "{}" }); }
  getBillCheckNo() { return this.request<unknown>("/api/student/getBill/checkno", { method: "POST", body: "{}" }); }
  getPersonDetail() { return this.request<StudentHubPersonDetail>("/api/student/person/detail"); }
  getFamilyDetail() { return this.request<StudentHubFamilyDetail>("/api/student/person/family-detail"); }
  getHealthcareDetail() { return this.request<StudentHubHealthcareDetail>("/api/student/person/healthcare_detail"); }
  getProgram() { return this.request<StudentHubProgram>("/api/student/program"); }
  getRegistrationWindow() { return this.request<StudentHubRegistrationWindow>("/api/student/programs/dky-window"); }
  getSemesterAdvice() { return this.request<StudentHubSemesterAdvice[]>("/api/student/semester-advice"); }
  getSemesterAdviceStatus() { return this.request<unknown>("/api/student/semester-advice/status"); }
  getSemesterExpected() { return this.request<StudentHubSemesterExpected[]>("/api/student/semester-expected"); }
  getCanvasLinkInfo() { return this.request<StudentHubCanvasLinkInfo>("/api/student/student-info-canvas"); }
  getTrainingPointsIsLock() { return this.request<unknown>("/api/student/training-points/is-lock"); }
  searchBloodTypes(size = 100) { return this.request<StudentHubPage<StudentHubBloodType>>(`/api/student/vn/blood/search?size=${size}`, { method: "POST", body: "{}" }); }
  searchDistricts(provinceCode: string, size = 100) { return this.request<StudentHubPage<StudentHubDistrict>>(`/api/student/vn/district/search?size=${size}`, { method: "POST", body: JSON.stringify({ provinceCode }) }); }
  searchNations(size = 100) { return this.request<StudentHubPage<StudentHubNation>>(`/api/student/vn/nation/search?size=${size}`, { method: "POST", body: "{}" }); }
  searchProvinces(size = 100) { return this.request<StudentHubPage<StudentHubProvince>>(`/api/student/vn/province/search?size=${size}`, { method: "POST", body: "{}" }); }
  searchWards(provinceCode: string, size = 100) { return this.request<StudentHubPage<StudentHubWard>>(`/api/student/vn/ward/search?size=${size}`, { method: "POST", body: JSON.stringify({ provinceCode }) }); }
  // Static JSON, not under /api/ — a site-wide banner config, no auth needed.
  getDashboardBanner() { return this.request<StudentHubDashboardBanner>("/dashboard-banner.json"); }
}
