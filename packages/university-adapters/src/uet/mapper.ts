import { combineDateTime } from "@hyeboard/core";
import type { Assignment, Bill, ClassSession, Course, ExamSession, Grade, GpaSummary, NewsItem, Notification, ServiceRequest, Student, Term, TrainingPoint, TuitionStatus } from "@hyeboard/schemas";
import type { CanvasAssignment, CanvasDashboardCard, CanvasPlannerItem, StudentHubBill, StudentHubClassSession, StudentHubExam, StudentHubGpa, StudentHubGrade, StudentHubNews, StudentHubNotificationPage, StudentHubScheduleAlertSession, StudentHubServiceRequest, StudentHubStudent, StudentHubTerm, StudentHubTrainingPointAssessment, StudentHubTrainingPointLockAssessment } from "./types";

const toNumber = (value: unknown): number | undefined => {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
};

function formatPersonName(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed !== trimmed.toLocaleUpperCase("vi-VN")) return trimmed;
  return trimmed
    .toLocaleLowerCase("vi-VN")
    .replace(/(^|[\s-])(\p{L})/gu, (_match, prefix: string, letter: string) => `${prefix}${letter.toLocaleUpperCase("vi-VN")}`);
}

function formatInstructorList(value?: string): string | undefined {
  return value?.split(";").map((item) => formatPersonName(item)).filter(Boolean).join(", ") || undefined;
}

export function mapStudent(input: StudentHubStudent): Student {
  return {
    id: String(input.id ?? input.studentCode ?? input.personCode ?? "uet-student"),
    fullName: formatPersonName(input.name) ?? "UET Student",
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
// clock hours. The timetable page itself publishes the VNU-UET period table:
// 1-3 = 07:00-09:40, 4-6 = 09:50-12:30, 7-9 = 13:30-16:10, 10-12 = 16:20-19:00.
// Keep periodStart/periodEnd for auditability, and expose a display-ready
// timeLabel when the period range is one of the verified ranges.
const periodTimeRanges = new Map<string, { start: string; end: string }>([
  ["1-3", { start: "07:00:00", end: "09:40:00" }],
  ["4-6", { start: "09:50:00", end: "12:30:00" }],
  ["7-9", { start: "13:30:00", end: "16:10:00" }],
  ["10-12", { start: "16:20:00", end: "19:00:00" }],
]);

function periodRange(periodStart?: number, periodEnd?: number): { start: string; end: string; label: string } | undefined {
  if (periodStart == null || periodEnd == null) return undefined;
  const range = periodTimeRanges.get(`${periodStart}-${periodEnd}`);
  return range ? { ...range, label: `${range.start.slice(0, 5)} - ${range.end.slice(0, 5)}` } : undefined;
}

function clampHour(hour: number): number {
  return Math.min(23, Math.max(0, hour));
}

export function mapStudentHubClass(input: StudentHubClassSession): ClassSession {
  const periodStart = toNumber(input.sessionStart);
  const periodEnd = toNumber(input.sessionEnd);
  const weekday = toNumber(input.weekday);
  const date = resolveSessionDate(weekday);
  const verifiedRange = periodRange(periodStart, periodEnd);
  const sortStartHour = clampHour(6 + (periodStart ?? 1));
  const sortEndHour = clampHour(Math.max(sortStartHour + 1, 6 + (periodEnd ?? (periodStart ?? 1) + 1)));
  return {
    id: input.courseSectionCode ?? `${input.courseCode}-${input.weekday}-${input.sessionStart}`,
    courseCode: input.courseCode ?? "UET",
    courseName: input.courseName ?? "Class session",
    room: input.roomName ?? input.roomCode,
    startTime: combineDateTime(date, verifiedRange?.start ?? `${String(sortStartHour).padStart(2, "0")}:00:00`),
    endTime: combineDateTime(date, verifiedRange?.end ?? `${String(sortEndHour).padStart(2, "0")}:00:00`),
    timeLabel: verifiedRange?.label,
    weekday,
    periodStart,
    periodEnd,
    instructor: formatInstructorList(input.staffCode1),
    type: input.type,
  };
}

export function mapStudentHubScheduleAlert(input: StudentHubScheduleAlertSession, date: string): ClassSession {
  const periodStart = toNumber(input.sessionStart);
  const periodEnd = toNumber(input.sessionEnd);
  const weekday = toNumber(input.weekDay);
  const verifiedRange = periodRange(periodStart, periodEnd);
  const sortStartHour = clampHour(6 + (periodStart ?? 1));
  const sortEndHour = clampHour(Math.max(sortStartHour + 1, 6 + (periodEnd ?? (periodStart ?? 1) + 1)));
  return {
    id: input.courseSectionCode ?? `${input.name}-${input.weekDay}-${input.sessionStart}`,
    courseCode: input.courseSectionCode?.split("_").at(1)?.split(" ").at(0) ?? "UET",
    courseName: input.name ?? "Class session",
    room: input.roomName,
    startTime: combineDateTime(date, verifiedRange?.start ?? `${String(sortStartHour).padStart(2, "0")}:00:00`),
    endTime: combineDateTime(date, verifiedRange?.end ?? `${String(sortEndHour).padStart(2, "0")}:00:00`),
    timeLabel: verifiedRange?.label,
    weekday,
    periodStart,
    periodEnd,
    canvasCourseId: input.canvasCourseId,
    url: input.canvasCourseId ? `https://portal.uet.vnu.edu.vn/courses/${input.canvasCourseId}` : undefined,
    instructor: formatInstructorList(input.name1),
    type: input.typeLesson,
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
  const examDate = input.examDate ?? new Date().toISOString();
  const timeStart = input.timeStart?.match(/^\d{1,2}:\d{2}$/) ? `${input.timeStart}:00` : input.timeStart;
  return {
    id: input.courseSectionCode ?? `${input.courseCode}-${input.examDate}`,
    courseCode: input.courseCode ?? "UET",
    courseName: input.courseName ?? "Exam",
    examType: input.examType,
    examMethod: input.examMethod,
    examDate,
    startTime: timeStart ? combineDateTime(examDate.slice(0, 10), timeStart) : undefined,
    examSession: toNumber(input.examSession),
    examNumber: input.examNumber,
    room: input.roomName,
    termCode: input.termCode,
  };
}

function parseStudentHubPayDate(value?: string): string | undefined {
  if (!value || !/^\d{14}$/.test(value)) return undefined;
  const date = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  const time = `${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}`;
  return combineDateTime(date, time);
}

function billStatus(input: StudentHubBill): string {
  const total = input.totalAmount ?? 0;
  const paid = input.paidAmount ?? 0;
  const remaining = input.remainingAmount ?? 0;
  const rawStatus = String(input.billStatus ?? input.paymentStatus ?? "");
  if (total < 0) return "credit";
  if (remaining <= 0 && (paid > 0 || rawStatus === "1")) return "paid";
  if (paid > 0 && remaining > 0) return "partial";
  if (total > 0) return "unpaid";
  return rawStatus || "unknown";
}

export function mapStudentHubBill(input: StudentHubBill): Bill {
  const title = input.billTitle?.trim() || input.billDescription?.trim() || input.billCode || input.parentBillCode || "Tuition bill";
  return {
    id: input.billDetailCode ?? input.billCode ?? crypto.randomUUID(),
    title,
    termCode: input.termCode,
    totalAmount: input.totalAmount ?? 0,
    paidAmount: input.paidAmount ?? 0,
    remainingAmount: input.remainingAmount ?? 0,
    status: billStatus(input),
    dueAt: input.dateEnd,
    paidAt: parseStudentHubPayDate(input.payDate),
    invoiceUrl: input.invoiceUrl ?? input.electronicInvoiceUrl,
  };
}

export function mapTuition(inputs: StudentHubBill[]): TuitionStatus {
  const bills = inputs.map(mapStudentHubBill);
  return bills.reduce<TuitionStatus>((total, bill) => ({
    totalAmount: total.totalAmount + Math.max(0, bill.totalAmount),
    paidAmount: total.paidAmount + Math.max(0, bill.paidAmount),
    remainingAmount: total.remainingAmount + Math.max(0, bill.remainingAmount),
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

export function mapTrainingPoints(assessment: StudentHubTrainingPointAssessment, locked?: StudentHubTrainingPointLockAssessment): TrainingPoint[] {
  const termCode = locked?.termCode ?? assessment.termCode;
  const totals: TrainingPoint[] = locked ? [{
    id: `uet-training-total-${termCode ?? "current"}`,
    title: "Final training score",
    termCode,
    score: locked.totalCTSV ?? locked.totalKV ?? locked.totalCVHT ?? locked.totalBCS ?? locked.totalSV ?? locked.totalBase ?? null,
    maxScore: 100,
    locked: locked.status === "LOCKED" || assessment.assessmentStatus === "LOCKED",
  }] : [];
  const criteria = (assessment.criteriaAssessmentList ?? []).map((item, index) => ({
    id: `uet-training-${termCode ?? "current"}-${item.orderIndex ?? index}`,
    title: item.name ?? `Criteria ${index + 1}`,
    termCode,
    score: item.baseScore ?? null,
    maxScore: item.maxScore ?? null,
    locked: assessment.assessmentStatus === "LOCKED" || !assessment.canAssess,
  }));
  return [...totals, ...criteria];
}

export function mapStudentHubRequest(input: StudentHubServiceRequest, index: number): ServiceRequest {
  return {
    id: String(input.id ?? input.requestId ?? index),
    title: input.title ?? input.requestTypeName ?? input.requestType ?? input.type ?? "Student request",
    type: input.requestTypeName ?? input.requestType ?? input.type,
    status: input.statusName ?? input.status,
    createdAt: input.createdAt ?? input.createdDate,
  };
}

export function mapCanvasCourse(input: CanvasDashboardCard): Course {
  const rawHref = input.href;
  const href = rawHref?.startsWith("http") ? rawHref : rawHref ? `https://portal.uet.vnu.edu.vn${rawHref.startsWith("/") ? rawHref : `/${rawHref}`}` : undefined;
  return {
    id: `canvas-${input.id ?? input.courseCode ?? input.shortName}`,
    source: "canvas",
    code: input.courseCode ?? input.shortName ?? "CANVAS",
    name: input.longName ?? input.originalName ?? input.shortName ?? "Canvas course",
    status: input.enrollmentState === "active" ? "active" : undefined,
    url: href,
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
