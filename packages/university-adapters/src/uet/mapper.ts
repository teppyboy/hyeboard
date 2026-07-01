import { combineDateTime } from "@hyeboard/core";
import type { Assignment, Bill, ClassSession, Course, ExamSession, Grade, GpaSummary, NewsItem, Notification, Student, Term, TuitionStatus } from "@hyeboard/schemas";
import type { CanvasAssignment, CanvasDashboardCard, CanvasPlannerItem, StudentHubBill, StudentHubClassSession, StudentHubExam, StudentHubGpa, StudentHubGrade, StudentHubNews, StudentHubNotificationPage, StudentHubStudent, StudentHubTerm } from "./types";

const toNumber = (value: unknown): number | undefined => {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
};

export function mapStudent(input: StudentHubStudent): Student {
  return {
    id: String(input.id ?? input.studentCode ?? input.personCode ?? "uet-student"),
    fullName: input.name ?? "UET Student",
    universityId: "uet",
    studentCode: input.studentCode,
    email: input.schoolEmail ?? input.email,
    major: input.majorName,
    className: input.classCode,
    programName: input.programName,
  };
}

export function mapTerm(input: StudentHubTerm, index: number): Term {
  return {
    id: String(input.id ?? input.termCode ?? index),
    code: input.termCode ?? String(input.id ?? index),
    name: input.name ?? input.termCode ?? `Term ${index + 1}`,
    index: input.index ?? index,
    current: index === 0,
  };
}

// StudentHub returns `weekday` as an ISO-style ordinal (1 = Monday ... 7 = Sunday).
// Confirmed via a real /api/student/tkb capture with weekday values 1, 2, and 3
// spanning distinct courses/rooms across a normal Mon/Tue/Wed schedule - the
// simple sequential ISO-Monday-first convention is correct, not just inferred
// from a single-value sample. Previously the mapper ignored `weekday` entirely
// and stamped every session with today's date, which made the Timetable/Dashboard
// show the wrong day for most classes. `resolveSessionDate` keeps each session
// within the current Mon-Sun week instead of always defaulting to "today".
function resolveSessionDate(weekday?: number): string {
  const today = new Date();
  const todayIso = ((today.getDay() + 6) % 7) + 1; // JS getDay(): 0=Sun..6=Sat -> ISO 1=Mon..7=Sun
  const target = weekday && weekday >= 1 && weekday <= 7 ? weekday : todayIso;
  const date = new Date(today);
  date.setDate(date.getDate() + (target - todayIso));
  return date.toISOString().slice(0, 10);
}

// StudentHub's sessionStart/sessionEnd are "tiet hoc" (class period) ordinals, not
// clock hours - real samples include sessionStart:4 and sessionStart:10 for the
// same student, which cannot be literal hours (a 4am class). No verified
// period-to-clock-time table exists for UET (checked HAR traffic and public web
// search, found nothing citable), so we deliberately do NOT fabricate a precise
// clock time for display. `periodStart`/`periodEnd` are exposed on ClassSession so
// the UI can render an honest "Period 10-12" label; startTime/endTime still need
// *some* ISO value to satisfy the schema and to sort sessions within a day, so we
// derive an internal-only proxy hour from the period number that is never shown
// to the user (UI prefers periodStart/periodEnd when present).
function clampHour(hour: number): number {
  return Math.min(23, Math.max(0, hour));
}

export function mapStudentHubClass(input: StudentHubClassSession): ClassSession {
  const periodStart = toNumber(input.sessionStart);
  const periodEnd = toNumber(input.sessionEnd);
  const weekday = toNumber(input.weekday);
  const date = resolveSessionDate(weekday);
  const sortStartHour = clampHour(6 + (periodStart ?? 1));
  const sortEndHour = clampHour(Math.max(sortStartHour + 1, 6 + (periodEnd ?? (periodStart ?? 1) + 1)));
  return {
    id: input.courseSectionCode ?? `${input.courseCode}-${input.weekday}-${input.sessionStart}`,
    courseCode: input.courseCode ?? "UET",
    courseName: input.courseName ?? "Class session",
    room: input.roomName ?? input.roomCode,
    startTime: combineDateTime(date, `${String(sortStartHour).padStart(2, "0")}:00:00`),
    endTime: combineDateTime(date, `${String(sortEndHour).padStart(2, "0")}:00:00`),
    weekday,
    periodStart,
    periodEnd,
    instructor: input.staffCode1,
    type: input.type,
  };
}

export function mapStudentHubGrade(input: StudentHubGrade): Grade {
  return {
    id: input.pointCode ?? `${input.courseCode}-${input.termCode}`,
    courseCode: input.courseCode ?? "UET",
    courseName: input.name ?? "Course",
    credits: input.courseCredit,
    termCode: input.termCode,
    point4: toNumber(input.point4) ?? null,
    point10: toNumber(input.point10) ?? null,
  };
}

export function mapStudentHubGpa(input: StudentHubGpa): GpaSummary {
  return {
    gpa: toNumber(input.gpa) ?? null,
    cpa: toNumber(input.cpa) ?? null,
    totalCredits: input.totalCredits,
    totalAccumulatedCredits: input.totalAccumulatedCredits,
    totalCourses: input.totalCourses,
    passedProgramCourses: input.passedProgramCourses,
  };
}

export function mapStudentHubExam(input: StudentHubExam): ExamSession {
  return {
    id: input.courseSectionCode ?? `${input.courseCode}-${input.examDate}`,
    courseCode: input.courseCode ?? "UET",
    courseName: input.courseName ?? "Exam",
    examType: input.examType,
    examMethod: input.examMethod,
    examDate: input.examDate ?? new Date().toISOString(),
    startTime: input.timeStart,
    room: input.roomName,
    termCode: input.termCode,
  };
}

export function mapStudentHubBill(input: StudentHubBill): Bill {
  return {
    id: input.billDetailCode ?? input.billCode ?? crypto.randomUUID(),
    title: input.billTitle ?? "Tuition bill",
    termCode: input.termCode,
    totalAmount: input.totalAmount ?? 0,
    paidAmount: input.paidAmount ?? 0,
    remainingAmount: input.remainingAmount ?? 0,
    status: input.paymentStatus ?? input.billStatus ?? "unknown",
    dueAt: input.dateEnd,
    invoiceUrl: input.invoiceUrl ?? input.electronicInvoiceUrl,
  };
}

export function mapTuition(inputs: StudentHubBill[]): TuitionStatus {
  const bills = inputs.map(mapStudentHubBill);
  return bills.reduce<TuitionStatus>((total, bill) => ({
    totalAmount: total.totalAmount + bill.totalAmount,
    paidAmount: total.paidAmount + bill.paidAmount,
    remainingAmount: total.remainingAmount + bill.remainingAmount,
    bills: [...total.bills, bill],
  }), { totalAmount: 0, paidAmount: 0, remainingAmount: 0, bills: [] });
}

export function mapStudentHubNotifications(page: StudentHubNotificationPage): Notification[] {
  return (page.content ?? []).map((item) => ({
    id: String(item.id ?? item.title ?? crypto.randomUUID()),
    title: item.title ?? "Notification",
    body: item.content,
    createdAt: item.createdAt ?? item.createdDate ?? new Date().toISOString(),
    url: item.link,
    source: "studenthub" as const,
  }));
}

export function mapStudentHubNews(input: StudentHubNews): NewsItem {
  return {
    id: String(input.id ?? input.title ?? crypto.randomUUID()),
    title: input.title ?? "UET news",
    date: input.date,
    image: input.image,
    category: input.category,
    url: input.link,
  };
}

export function mapCanvasCourse(input: CanvasDashboardCard): Course {
  return {
    id: `canvas-${input.id ?? input.courseCode ?? input.shortName}`,
    source: "canvas",
    code: input.courseCode ?? input.shortName ?? "CANVAS",
    name: input.longName ?? input.originalName ?? input.shortName ?? "Canvas course",
    status: input.enrollmentState === "active" ? "active" : undefined,
    url: input.href,
  };
}

export function mapCanvasPlannerItem(input: CanvasPlannerItem): Assignment {
  const submitted = input.submissions?.some((submission) => submission.submitted_at || submission.workflow_state === "submitted") ?? false;
  const missing = input.submissions?.some((submission) => submission.missing) ?? false;
  const late = input.submissions?.some((submission) => submission.late) ?? false;
  return {
    id: `canvas-planner-${input.plannable_id ?? crypto.randomUUID()}`,
    title: input.plannable?.title ?? input.plannable?.name ?? "Canvas item",
    courseName: input.context_name,
    dueAt: input.plannable_date ?? input.plannable?.due_at ?? new Date().toISOString(),
    status: missing ? "missing" : late ? "late" : submitted ? "submitted" : "not_started",
    priority: missing || late ? "high" : "medium",
    type: input.plannable_type === "quiz" ? "quiz" : input.plannable_type === "announcement" ? "announcement" : "assignment",
    url: input.html_url,
  };
}

export function mapCanvasMissingSubmission(input: CanvasAssignment): Assignment {
  return {
    id: `canvas-missing-${input.id ?? crypto.randomUUID()}`,
    title: input.name ?? "Missing submission",
    dueAt: input.due_at ?? new Date().toISOString(),
    status: "missing",
    priority: "high",
    type: "assignment",
    url: input.html_url,
  };
}
