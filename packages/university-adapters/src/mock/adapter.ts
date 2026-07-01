import { addHours, assertSupported } from "@hyeboard/core";
import type {
  Assignment,
  ClassSession,
  Course,
  DashboardSummary,
  ExamSession,
  Grade,
  GpaSummary,
  NewsItem,
  Notification,
  Student,
  Term,
  TuitionStatus,
  University,
} from "@hyeboard/schemas";
import type { ImportedSession, LoginImportInput, UniversityAdapter } from "../types";

const university: University = {
  id: "mock",
  name: "Hyeboard Demo University",
  shortName: "Demo",
  theme: { primary: "#0A0A0A", accent: "#525252", soft: "#F5F5F5" },
  capabilities: {
    profile: true,
    terms: true,
    timetable: true,
    courses: true,
    assignments: true,
    grades: true,
    exams: true,
    attendance: true,
    notifications: true,
    documents: true,
    tuition: true,
    news: true,
    trainingPoints: true,
    requests: true,
  },
};

const student: Student = {
  id: "demo-student",
  fullName: "Demo Student",
  universityId: "mock",
  studentCode: "24000000",
  email: "student@example.edu",
  major: "Computer Science",
  className: "K69CLC-C",
  programName: "Engineering Program",
  currentSemester: "2025-2026 I",
};

const terms: Term[] = [
  { id: "20251", code: "20251", name: "2025-2026 I", index: 1, current: true },
  { id: "20242", code: "20242", name: "2024-2025 II", index: 2 },
];

const courses: Course[] = [
  { id: "canvas-5359", source: "canvas", code: "INT2204", name: "Web Application Development", credits: 3, instructor: "Dr. Nguyen", progress: 68, status: "active", nextDeadline: addHours(18) },
  { id: "studenthub-mat1093", source: "studenthub", code: "MAT1093", name: "Linear Algebra", credits: 3, instructor: "Assoc. Prof. Tran", progress: 52, status: "active" },
  { id: "canvas-int2210", source: "canvas", code: "INT2210", name: "Data Structures and Algorithms", credits: 4, instructor: "Dr. Le", progress: 74, status: "active", nextDeadline: addHours(48) },
];

const timetable: ClassSession[] = [
  { id: "tkb-1", courseCode: "INT2204", courseName: "Web Application Development", room: "G2-301", startTime: addHours(2), endTime: addHours(4), weekday: 2, instructor: "Dr. Nguyen", type: "lecture" },
  { id: "tkb-2", courseCode: "MAT1093", courseName: "Linear Algebra", room: "G3-105", startTime: addHours(25), endTime: addHours(27), weekday: 3, instructor: "Assoc. Prof. Tran", type: "lecture" },
];

const assignments: Assignment[] = [
  { id: "planner-1", title: "React Router Lab", courseCode: "INT2204", courseName: "Web Application Development", dueAt: addHours(18), status: "in_progress", priority: "high", type: "assignment" },
  { id: "planner-2", title: "Graph traversal quiz", courseCode: "INT2210", courseName: "Data Structures and Algorithms", dueAt: addHours(48), status: "not_started", priority: "medium", type: "quiz" },
  { id: "missing-1", title: "Practice set 03", courseCode: "MAT1093", courseName: "Linear Algebra", dueAt: addHours(-24), status: "missing", priority: "high", type: "assignment" },
];

const grades: Grade[] = [
  { id: "grade-1", courseCode: "INT2204", courseName: "Web Application Development", credits: 3, termCode: "20251", point4: 3.7, point10: 8.6, letter: "A" },
  { id: "grade-2", courseCode: "MAT1093", courseName: "Linear Algebra", credits: 3, termCode: "20251", point4: 3.2, point10: 7.8, letter: "B+" },
  { id: "grade-3", courseCode: "INT2210", courseName: "Data Structures and Algorithms", credits: 3, termCode: "20242", point4: 3.0, point10: 7.2, letter: "B" },
  { id: "grade-4", courseCode: "ELT2035", courseName: "Signals and Systems", credits: 2, termCode: "20243", point4: 4.0, point10: 9.5, letter: "A+" },
];

const gpa: GpaSummary = { gpa: 3.48, cpa: 3.41, totalCredits: 18, totalAccumulatedCredits: 92, totalCourses: 31, passedProgramCourses: 29 };

const exams: ExamSession[] = [
  { id: "exam-1", courseCode: "INT2210", courseName: "Data Structures and Algorithms", examDate: addHours(24 * 12), startTime: "08:00", room: "G2-401", examType: "midterm", termCode: "20251" },
];

const notifications: Notification[] = [
  { id: "noti-1", title: "Tuition bill updated", body: "A new payment status is available.", createdAt: addHours(-5), unread: true, source: "studenthub" },
  { id: "canvas-announce-1", title: "Canvas announcement: project groups", createdAt: addHours(-14), unread: false, source: "canvas" },
];

const tuition: TuitionStatus = {
  totalAmount: 14500000,
  paidAmount: 8000000,
  remainingAmount: 6500000,
  bills: [
    { id: "bill-1", title: "Tuition 2025-2026 I", totalAmount: 14500000, paidAmount: 8000000, remainingAmount: 6500000, status: "partial", termCode: "20251", dueAt: addHours(24 * 9) },
  ],
};

const news: NewsItem[] = [{ id: "news-1", title: "Academic calendar update", date: addHours(-48), category: "Academic" }];

export function createMockAdapter(): UniversityAdapter {
  return {
    university,
    async importSession(input: LoginImportInput): Promise<ImportedSession> {
      const expiresAt = addHours(8);
      return {
        universityId: university.id,
        studentCode: input.studentCode ?? student.studentCode,
        expiresAt,
        session: { version: 1, universityId: university.id, studentCode: input.studentCode ?? student.studentCode, expiresAt },
      };
    },
    async getStudentProfile() { return student; },
    async getTerms() { return terms; },
    async getDashboard(): Promise<DashboardSummary> {
      return { student, currentTerm: terms[0], nextClass: timetable[0] ?? null, todaySchedule: timetable.slice(0, 1), courses, assignments, grades, gpa, exams, tuition, notifications };
    },
    async getTimetable() { return timetable; },
    async getCourses() { return courses; },
    async getCourseDetail({ courseId }) { return courses.find((course) => course.id === courseId || course.code === courseId) ?? courses[0]!; },
    async getAssignments() { return assignments; },
    async getGrades() { return grades; },
    async getGpaSummary() { return gpa; },
    async getExams() { return exams; },
    async getAttendance() { return [{ id: "att-1", courseCode: "INT2204", courseName: "Web Application Development", attended: 10, total: 12, percentage: 83 }]; },
    async getNotifications() { return notifications; },
    async getNews() { return news; },
    async getDocuments() { return [{ id: "doc-1", name: "Course outline.pdf", courseCode: "INT2204", mimeType: "application/pdf", updatedAt: addHours(-72) }]; },
    async getTuition() { return tuition; },
    async getTrainingPoints() { return [{ id: "tp-1", title: "Semester training points", termCode: "20251", score: 82, maxScore: 100, locked: false }]; },
    async getRequests() { return [{ id: "req-1", title: "Transcript request", type: "document", status: "available", createdAt: addHours(-120) }]; },
  };
}
