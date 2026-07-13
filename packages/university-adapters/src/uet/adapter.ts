import { addHours, assertSupported, HyeboardError, type EncryptedSessionPayload } from "@hyeboard/core";
import type { ClassSession, DashboardSummary, University } from "@hyeboard/schemas";
import { CanvasClient } from "./canvas-client";
import { resolveCaptchaAnswer } from "./captcha";
import { mapCanvasCourse, mapCanvasMissingSubmission, mapCanvasPlannerItem, mapStudent, mapStudentHubBill, mapStudentHubClass, mapStudentHubExam, mapStudentHubGpa, mapStudentHubGrade, mapStudentHubNews, mapStudentHubNotifications, mapStudentHubRequest, mapStudentHubScheduleAlert, mapTerm, mapTrainingPoints, mapTuition } from "./mapper";
import { automateVnuGoogleLogin } from "./google-login-automation";
import { StudentHubClient } from "./studenthub-client";
import type { AdapterRequest, ImportedSession, ImportSessionContext, LoginImportInput, UniversityAdapter } from "../types";

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
    trainingPoints: true,
    requests: true,
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
    throw new HyeboardError("CANVAS_LOGIN_REQUIRED", "This feature needs a learning-platform login. Add a learning-platform access token from the login page.", 409);
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

function nextUpcomingSession(timetable: ClassSession[], now = new Date()): ClassSession | undefined {
  if (!timetable.length) return undefined;
  const occurrence = (session: ClassSession) => {
    const start = new Date(session.startTime);
    if (Number.isNaN(start.getTime())) return Number.POSITIVE_INFINITY;
    while (start <= now) start.setDate(start.getDate() + 7);
    return start.getTime();
  };
  return [...timetable].sort((a, b) => occurrence(a) - occurrence(b))[0];
}

function futureSession(sessions: ClassSession[], now = new Date()): ClassSession | undefined {
  return sessions.find((session) => new Date(session.startTime) > now);
}

function canvasFeatureError(error: unknown): never {
  const message = error instanceof HyeboardError ? error.message : "Learning-platform data could not be loaded.";
  throw new HyeboardError("CANVAS_UPSTREAM_UNAVAILABLE", `${message} Add or refresh your learning-platform access token from the login page.`, 409);
}

function addDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function jwtExpiry(token: string): string | undefined {
  try {
    const [, payload] = token.split(".");
    if (!payload) return undefined;
    const decoded = JSON.parse(atob(payload.replaceAll("-", "+").replaceAll("_", "/"))) as { exp?: number };
    return decoded.exp ? new Date(decoded.exp * 1000).toISOString() : undefined;
  } catch {
    return undefined;
  }
}

function todayInVietnam(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

const flattenScheduleAlert = (items: Awaited<ReturnType<StudentHubClient["getScheduleAlert"]>>): ClassSession[] => items.flatMap((group) => group.map((item) => mapStudentHubScheduleAlert(item, todayInVietnam())));

export function createUetAdapter(): UniversityAdapter {
  return {
    university,
    async importSession(input: LoginImportInput, context?: ImportSessionContext): Promise<ImportedSession> {
      if (input.uetGoogleEmail || input.uetGooglePassword) {
        if (!input.uetGoogleEmail || !input.uetGooglePassword) {
          throw new HyeboardError("MISSING_UPSTREAM_CREDENTIAL", "Provide both your username/email and password.", 400);
        }
        const rawInput = input.uetGoogleEmail.trim();

        // Parent/guardian accounts authenticate through StudentHub's own
        // CAPTCHA and login APIs. Detected by the "PH" account-code prefix
        // observed live in a parent/guardian HAR capture (see
        // har-notes.md's "parent/guardian account" section) — a
        // StudentHub account-code convention (likely short for "Phụ
        // huynh", Vietnamese for parent/guardian), not something Hyeboard
        // invented. Falls through to the interactive Google-automation
        // flow below for every other (student) account.
        if (/^ph/i.test(rawInput)) {
          const client = new StudentHubClient();
          let firstAnswerSource: "ocr" | "human" | undefined;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const challenge = await client.getCaptchaChallenge();
            const skipOcr = attempt === 1 && firstAnswerSource === "ocr" && Boolean(context?.onCaptchaNeeded);
            const answer = await resolveCaptchaAnswer(challenge.image, context?.onCaptchaNeeded, { skipOcr });
            if (attempt === 0) firstAnswerSource = answer.source;
            const result = await client.authenticateDirect(rawInput, input.uetGooglePassword, challenge.captchaId, answer.answer);
            if (result.login) {
              const expiresAt = addDays(30);
              const session: EncryptedSessionPayload = {
                version: 1,
                universityId: "uet",
                studentCode: result.login.accountCode ?? rawInput,
                expiresAt,
                uetParentCredential: { username: rawInput, password: input.uetGooglePassword },
                studenthub: { kind: "bearer", value: result.login.accessToken, expiresAt: jwtExpiry(result.login.accessToken) ?? expiresAt },
              };
              return { universityId: "uet", studentCode: session.studentCode, expiresAt, session };
            }
            if (result.code !== "EX102") {
              throw new HyeboardError("INVALID_STUDENTHUB_CREDENTIAL", "Incorrect username or password.", 401);
            }
          }
          throw new HyeboardError("STUDENTHUB_CAPTCHA_REJECTED", "The verification code was rejected twice. Try signing in again.", 422);
        }

        if (!context?.browserConnection) {
          throw new HyeboardError("SERVER_CONFIG_ERROR", "Automated sign-in is not configured on this server.", 500);
        }
        // SECURITY: only the local-part (student code) of whatever the
        // caller sends is ever trusted — any domain they supply (or omit)
        // is discarded and @vnu.edu.vn is always forced server-side. This
        // automation exists to sign in to VNU-owned accounts only; without
        // this normalization a caller could pass an arbitrary external
        // address (e.g. abc@gmail.com) and have this server's Puppeteer
        // automation attempt a real Google sign-in against it.
        const studentCode = rawInput.split("@")[0]?.trim();
        if (!studentCode) {
          throw new HyeboardError("MISSING_UPSTREAM_CREDENTIAL", "Provide your VNU student code (MSV).", 400);
        }
        const uetGoogleEmail = `${studentCode}@vnu.edu.vn`;
        // No separate "validate against real upstream" check here: automation
        // only reaches the credential-capture step after actually completing
        // a real login against StudentHub/Canvas, so a captured token/cookie
        // is proof-of-working by construction. Re-validating would spend an
        // extra upstream round-trip for no new information.
        const result = await automateVnuGoogleLogin(context.browserConnection, uetGoogleEmail, input.uetGooglePassword, input.uetGoogleCookies, context.onProgress);
        const expiresAt = addDays(30);
        const session: EncryptedSessionPayload = {
          version: 1,
          universityId: "uet",
          studentCode: result.studenthub?.accountCode,
          expiresAt,
          uetGoogleCredential: { email: uetGoogleEmail, password: input.uetGooglePassword, googleCookies: result.googleCookies },
          studenthub: result.studenthub ? { kind: "bearer", value: result.studenthub.accessToken, expiresAt: jwtExpiry(result.studenthub.accessToken) ?? expiresAt } : undefined,
          canvas: result.canvas ? { kind: "cookie", value: result.canvas.cookie, csrfToken: result.canvas.csrfToken, expiresAt } : undefined,
        };
        return { universityId: "uet", studentCode: session.studentCode, expiresAt, session };
      }

      if (!input.studenthubGoogleCredential && !input.studenthubToken && !input.studenthubCookie && !input.canvasToken && !input.canvasCookie) {
        throw new HyeboardError("MISSING_UPSTREAM_CREDENTIAL", "Provide a university portal token, portal cookie, learning-platform token, or learning-platform cookie.", 400);
      }
      const googleLogin = input.studenthubGoogleCredential
        ? await new StudentHubClient().exchangeGoogleCredential(input.studenthubGoogleCredential)
        : undefined;
      const studenthubToken = googleLogin?.accessToken ?? input.studenthubToken;
      const studenthubExpiresAt = studenthubToken ? jwtExpiry(studenthubToken) : undefined;
      const expiresAt = studenthubExpiresAt ?? addHours(8);
      const session: EncryptedSessionPayload = {
        version: 1,
        universityId: "uet",
        studentCode: googleLogin?.accountCode ?? input.studentCode,
        expiresAt,
        studenthub: studenthubToken ? { kind: "bearer", value: studenthubToken, expiresAt: studenthubExpiresAt ?? expiresAt } : input.studenthubCookie ? { kind: "cookie", value: input.studenthubCookie, expiresAt } : undefined,
        canvas: input.canvasToken ? { kind: "bearer", value: input.canvasToken, expiresAt } : input.canvasCookie ? { kind: "cookie", value: input.canvasCookie, csrfToken: input.canvasCsrfToken, expiresAt } : undefined,
      };
      // Verify the credential actually works against the real upstream before
      // declaring the session imported - previously a garbage/expired token
      // would silently "succeed" and only fail later on the dashboard.
      if (session.studenthub) {
        try {
          await new StudentHubClient(session).getProfile();
        } catch {
          throw new HyeboardError("INVALID_STUDENTHUB_CREDENTIAL", "The university portal rejected this token or cookie. Copy a fresh token and try again.", 401);
        }
      } else if (session.canvas) {
        try {
          await new CanvasClient(session).getUnreadConversations();
        } catch {
          throw new HyeboardError("INVALID_CANVAS_CREDENTIAL", "The learning platform rejected this token or cookie. Copy a fresh token and try again.", 401);
        }
      }
      return { universityId: "uet", studentCode: session.studentCode, expiresAt, session };
    },
    async getStudentProfile(request) { return mapStudent(await studenthub(request).getProfile()); },
    async getTerms(request) { return (await studenthub(request).getTerms()).map(mapTerm); },
    async getDashboard(request): Promise<DashboardSummary> {
      const today = todayInVietnam();
      const [studentR, termsR, timetableR, todayScheduleR, courseCountR, coursesR, assignmentsR, gradesR, gpaR, examsR, tuitionR, notificationsR] = await Promise.allSettled([
        this.getStudentProfile(request),
        this.getTerms(request),
        this.getTimetable(request),
        studenthub(request).getScheduleAlert(today),
        studenthub(request).getCourseCount(),
        this.getCourses(request),
        this.getAssignments(request),
        this.getGrades(request),
        this.getGpaSummary(request),
        this.getExams(request),
        this.getTuition(request),
        this.getNotifications(request),
      ]);
      const allResults = [studentR, termsR, timetableR, todayScheduleR, courseCountR, coursesR, assignmentsR, gradesR, gpaR, examsR, tuitionR, notificationsR];
      // If every single upstream call failed, the session itself is broken
      // (expired/invalid token) - surface a real error instead of silently
      // rendering an all-empty dashboard, so the user sees the same
      // "sign in again" guidance every other feature page already shows.
      if (allResults.every((result) => result.status === "rejected")) {
        const firstReason = studentR.status === "rejected" ? studentR.reason : undefined;
        throw firstReason instanceof HyeboardError ? firstReason : new HyeboardError("UET_UPSTREAM_UNAVAILABLE", "Could not reach the connected university services with the saved session. Sign in again.", 401);
      }
      const student = settle(studentR, undefined);
      const terms = settle(termsR, []);
      const timetable = settle(timetableR, [] as ClassSession[]);
      const scheduleAlert = todayScheduleR.status === "fulfilled" ? flattenScheduleAlert(todayScheduleR.value) : [];
      const courseCount = settle(courseCountR, undefined);
      const canvasCourses = settle(coursesR, []);
      const assignments = settle(assignmentsR, []);
      const grades = settle(gradesR, []);
      const gpa = settle(gpaR, undefined);
      const exams = settle(examsR, []);
      const tuition = settle(tuitionR, undefined);
      const notifications = settle(notificationsR, []);

      const todayWeekday = isoWeekdayToday();
      const timetableToday = timetable
        .filter((session) => session.weekday === todayWeekday)
        .sort((a, b) => (a.periodStart ?? 0) - (b.periodStart ?? 0));
      const courseCountSummary = courseCount ? { inTerm: courseCount.inTerm ?? 0, completed: courseCount.completed ?? 0 } : undefined;
      const hasActiveTermCourses = courseCountSummary ? courseCountSummary.inTerm > 0 : true;
      const todaySchedule = scheduleAlert.length
        ? scheduleAlert.sort((a, b) => (a.periodStart ?? 0) - (b.periodStart ?? 0))
        : hasActiveTermCourses
          ? timetableToday
          : [];
      const nextClass = scheduleAlert.length
        ? futureSession(todaySchedule) ?? null
        : hasActiveTermCourses
          ? futureSession(todaySchedule) ?? nextUpcomingSession(timetable) ?? null
          : null;

      return {
        student,
        currentTerm: terms[0],
        courseCount: courseCountSummary,
        nextClass,
        todaySchedule,
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
    async getCourses(request) {
      requireCanvas(request);
      try {
        return (await canvas(request).getDashboardCards()).map(mapCanvasCourse);
      } catch (error) {
        canvasFeatureError(error);
      }
    },
    async getCourseDetail(request) { return (await this.getCourses(request)).find((course) => course.id === request.courseId || course.code === request.courseId) ?? Promise.reject(new HyeboardError("COURSE_NOT_FOUND", "Course not found", 404)); },
    async getAssignments(request) {
      requireCanvas(request);
      try {
        const [planner, missing] = await Promise.all([
          canvas(request).getPlannerItems(),
          canvas(request).getMissingSubmissions(),
        ]);
        return [...planner.map(mapCanvasPlannerItem), ...missing.map(mapCanvasMissingSubmission)];
      } catch (error) {
        canvasFeatureError(error);
      }
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
        { id: "canvas-unread", title: `${unread.unread_count} unread learning-platform messages`, createdAt: new Date().toISOString(), unread: Number(unread.unread_count) > 0, source: "canvas" as const, body: studentCode ? `Learning-platform inbox for ${studentCode}` : undefined },
      ];
    },
    async getNews(request) { return (await studenthub(request).getNews()).map(mapStudentHubNews); },
    async getDocuments() { assertSupported(false, "Documents"); return []; },
    async getTuition(request) { return mapTuition(await studenthub(request).getBills()); },
    async getTrainingPoints(request) {
      const profile = await this.getStudentProfile(request);
      const studentCode = profile.studentCode ?? request.session?.studentCode;
      if (!studentCode) throw new HyeboardError("MISSING_STUDENT_CODE", "The university portal did not return a student code", 500);
      const assessment = await studenthub(request).getTrainingPointAssessment(studentCode);
      const termCode = assessment.termCode ?? request.termCode ?? (await this.getTerms(request))[0]?.code;
      const locked = termCode ? await fallback(studenthub(request).getTrainingPointLockAssessment(studentCode, termCode), undefined) : undefined;
      return mapTrainingPoints(assessment, locked);
    },
    async getRequests(request) { return (await studenthub(request).getRequests()).map(mapStudentHubRequest); },
  };
}
