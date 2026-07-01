import { addHours, assertSupported, HyeboardError, type EncryptedSessionPayload } from "@hyeboard/core";
import type { ClassSession, DashboardSummary, University } from "@hyeboard/schemas";
import { CanvasClient } from "./canvas-client";
import { mapCanvasCourse, mapCanvasMissingSubmission, mapCanvasPlannerItem, mapStudent, mapStudentHubBill, mapStudentHubClass, mapStudentHubExam, mapStudentHubGpa, mapStudentHubGrade, mapStudentHubNews, mapStudentHubNotifications, mapTerm, mapTuition } from "./mapper";
import { StudentHubClient } from "./studenthub-client";
import type { AdapterRequest, ImportedSession, LoginImportInput, UniversityAdapter } from "../types";

const university: University = {
  id: "uet",
  name: "University of Engineering and Technology, VNU",
  shortName: "VNU-UET",
  theme: { primary: "#003A70", accent: "#0B6FAE", soft: "#EFF6FF" },
  capabilities: {
    profile: true,
    terms: true,
    timetable: true,
    courses: true,
    assignments: true,
    grades: true,
    exams: true,
    attendance: false,
    notifications: true,
    documents: false,
    tuition: true,
    news: true,
    // No verified StudentHub response shape exists for training-points/requests
    // (only the endpoint paths were identified from HAR research, never the
    // payload shape). Rather than keep presenting hardcoded placeholder rows as
    // real student data, these are declared unsupported until implemented for
    // real, matching the attendance/documents pattern.
    trainingPoints: false,
    requests: false,
  },
};

function studenthub(request: AdapterRequest) { return new StudentHubClient(request.session); }
function canvas(request: AdapterRequest) { return new CanvasClient(request.session); }

// Canvas is an optional credential - most StudentHub-backed features work
// without it. Only the handful of features that genuinely depend on Canvas
// (courses, assignments) should fail, and they should fail with a distinct
// code so the frontend can show "add a Canvas login" instead of treating it
// like the whole Hyeboard session is broken.
function requireCanvas(request: AdapterRequest): void {
  if (!request.session?.canvas) {
    throw new HyeboardError("CANVAS_LOGIN_REQUIRED", "This feature needs a Canvas login. Add a Canvas access token from the login page.", 409);
  }
}

async function fallback<T>(operation: Promise<T>, value: T): Promise<T> {
  try { return await operation; } catch { return value; }
}

function settle<T>(result: PromiseSettledResult<T>, fallbackValue: T): T {
  return result.status === "fulfilled" ? result.value : fallbackValue;
}

// Same ISO-weekday convention used by mapStudentHubClass's resolveSessionDate
// (1 = Monday ... 7 = Sunday). See mapper.ts for the caveat on this assumption.
function isoWeekdayToday(): number {
  const day = new Date().getDay();
  return day === 0 ? 7 : day;
}

function nextUpcomingSession(timetable: ClassSession[], todayWeekday: number): ClassSession | undefined {
  if (!timetable.length) return undefined;
  const sorted = [...timetable].sort((a, b) => {
    const aOffset = ((a.weekday ?? todayWeekday) - todayWeekday + 7) % 7;
    const bOffset = ((b.weekday ?? todayWeekday) - todayWeekday + 7) % 7;
    if (aOffset !== bOffset) return aOffset - bOffset;
    return (a.periodStart ?? 0) - (b.periodStart ?? 0);
  });
  return sorted[0];
}

export function createUetAdapter(): UniversityAdapter {
  return {
    university,
    async importSession(input: LoginImportInput): Promise<ImportedSession> {
      if (!input.studenthubToken && !input.studenthubCookie && !input.canvasToken && !input.canvasCookie) {
        throw new HyeboardError("MISSING_UPSTREAM_CREDENTIAL", "Provide at least one StudentHub or Canvas credential until live OAuth/SAML relay is implemented", 400);
      }
      const expiresAt = addHours(8);
      const session: EncryptedSessionPayload = {
        version: 1,
        universityId: "uet",
        studentCode: input.studentCode,
        expiresAt,
        studenthub: input.studenthubToken ? { kind: "bearer", value: input.studenthubToken, expiresAt } : input.studenthubCookie ? { kind: "cookie", value: input.studenthubCookie, expiresAt } : undefined,
        canvas: input.canvasToken ? { kind: "bearer", value: input.canvasToken, expiresAt } : input.canvasCookie ? { kind: "cookie", value: input.canvasCookie, csrfToken: input.canvasCsrfToken, expiresAt } : undefined,
      };
      // Verify the credential actually works against the real upstream before
      // declaring the session imported - previously a garbage/expired token
      // would silently "succeed" and only fail later on the dashboard.
      if (session.studenthub) {
        try {
          await new StudentHubClient(session).getProfile();
        } catch {
          throw new HyeboardError("INVALID_STUDENTHUB_CREDENTIAL", "StudentHub rejected this token or cookie. Re-copy it and try again.", 401);
        }
      } else if (session.canvas) {
        try {
          await new CanvasClient(session).getUnreadConversations();
        } catch {
          throw new HyeboardError("INVALID_CANVAS_CREDENTIAL", "Canvas rejected this token or cookie. Re-copy it and try again.", 401);
        }
      }
      return { universityId: "uet", studentCode: input.studentCode, expiresAt, session };
    },
    async getStudentProfile(request) { return mapStudent(await studenthub(request).getProfile()); },
    async getTerms(request) { return (await studenthub(request).getTerms()).map(mapTerm); },
    async getDashboard(request): Promise<DashboardSummary> {
      const [studentR, termsR, timetableR, coursesR, assignmentsR, gradesR, gpaR, examsR, tuitionR, notificationsR] = await Promise.allSettled([
        this.getStudentProfile(request),
        this.getTerms(request),
        this.getTimetable(request),
        this.getCourses(request),
        this.getAssignments(request),
        this.getGrades(request),
        this.getGpaSummary(request),
        this.getExams(request),
        this.getTuition(request),
        this.getNotifications(request),
      ]);
      const allResults = [studentR, termsR, timetableR, coursesR, assignmentsR, gradesR, gpaR, examsR, tuitionR, notificationsR];
      // If every single upstream call failed, the session itself is broken
      // (expired/invalid token) - surface a real error instead of silently
      // rendering an all-empty dashboard, so the user sees the same
      // "sign in again" guidance every other feature page already shows.
      if (allResults.every((result) => result.status === "rejected")) {
        const firstReason = studentR.status === "rejected" ? studentR.reason : undefined;
        throw firstReason instanceof HyeboardError ? firstReason : new HyeboardError("UET_UPSTREAM_UNAVAILABLE", "Could not reach StudentHub or Canvas with the saved session. Sign in again.", 401);
      }
      const student = settle(studentR, undefined);
      const terms = settle(termsR, []);
      const timetable = settle(timetableR, [] as ClassSession[]);
      const canvasCourses = settle(coursesR, []);
      const assignments = settle(assignmentsR, []);
      const grades = settle(gradesR, []);
      const gpa = settle(gpaR, undefined);
      const exams = settle(examsR, []);
      const tuition = settle(tuitionR, undefined);
      const notifications = settle(notificationsR, []);

      const todayWeekday = isoWeekdayToday();
      const todaySchedule = timetable
        .filter((session) => session.weekday === todayWeekday)
        .sort((a, b) => (a.periodStart ?? 0) - (b.periodStart ?? 0));
      const nextClass = todaySchedule[0] ?? nextUpcomingSession(timetable, todayWeekday) ?? null;

      return {
        student,
        currentTerm: terms[0],
        nextClass,
        todaySchedule: todaySchedule.length ? todaySchedule : timetable.slice(0, 4),
        courses: canvasCourses,
        assignments,
        grades,
        gpa,
        exams,
        tuition,
        notifications,
      };
    },
    async getTimetable(request) { return (await studenthub(request).getTimetable(request.termCode)).map(mapStudentHubClass); },
    async getCourses(request) { requireCanvas(request); return (await canvas(request).getDashboardCards()).map(mapCanvasCourse); },
    async getCourseDetail(request) { return (await this.getCourses(request)).find((course) => course.id === request.courseId || course.code === request.courseId) ?? Promise.reject(new HyeboardError("COURSE_NOT_FOUND", "Course not found", 404)); },
    async getAssignments(request) {
      requireCanvas(request);
      const [planner, missing] = await Promise.all([
        fallback(canvas(request).getPlannerItems(), []),
        fallback(canvas(request).getMissingSubmissions(), []),
      ]);
      return [...planner.map(mapCanvasPlannerItem), ...missing.map(mapCanvasMissingSubmission)];
    },
    async getGrades(request) { return (await studenthub(request).getGrades()).map(mapStudentHubGrade); },
    async getGpaSummary(request) { return mapStudentHubGpa(await studenthub(request).getGpa()); },
    async getExams(request) { return (await studenthub(request).getExams(request.termCode)).map(mapStudentHubExam); },
    async getAttendance() { assertSupported(false, "Attendance"); return []; },
    async getNotifications(request) {
      const [profile, page, unread] = await Promise.all([
        fallback(this.getStudentProfile(request), undefined),
        fallback(studenthub(request).getNotifications(request.session?.studentCode), { content: [] }),
        fallback(canvas(request).getUnreadConversations(), { unread_count: 0 }),
      ]);
      const studentCode = profile?.studentCode ?? request.session?.studentCode;
      return [
        ...mapStudentHubNotifications(page),
        { id: "canvas-unread", title: `${unread.unread_count} unread Canvas messages`, createdAt: new Date().toISOString(), unread: Number(unread.unread_count) > 0, source: "canvas" as const, body: studentCode ? `Canvas inbox for ${studentCode}` : undefined },
      ];
    },
    async getNews(request) { return (await studenthub(request).getNews()).map(mapStudentHubNews); },
    async getDocuments() { assertSupported(false, "Documents"); return []; },
    async getTuition(request) { return mapTuition(await studenthub(request).getBills()); },
    async getTrainingPoints() { assertSupported(false, "Training points"); return []; },
    async getRequests() { assertSupported(false, "Requests"); return []; },
  };
}
