import { z } from "zod";

export const universityThemeSchema = z.object({
  primary: z.string(),
  accent: z.string(),
  soft: z.string(),
});

export const universityCapabilitiesSchema = z.object({
  profile: z.boolean(),
  terms: z.boolean(),
  timetable: z.boolean(),
  courses: z.boolean(),
  assignments: z.boolean(),
  grades: z.boolean(),
  exams: z.boolean(),
  attendance: z.boolean(),
  notifications: z.boolean(),
  documents: z.boolean(),
  tuition: z.boolean(),
  news: z.boolean(),
  trainingPoints: z.boolean(),
  requests: z.boolean(),
});

export const universitySchema = z.object({
  id: z.string(),
  name: z.string(),
  shortName: z.string(),
  theme: universityThemeSchema.optional(),
  capabilities: universityCapabilitiesSchema,
});

export const termSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  index: z.number().optional(),
  current: z.boolean().optional(),
});

export const studentSchema = z.object({
  id: z.string(),
  fullName: z.string(),
  universityId: z.string(),
  studentCode: z.string().optional(),
  email: z.string().optional(),
  major: z.string().optional(),
  className: z.string().optional(),
  programName: z.string().optional(),
  currentSemester: z.string().optional(),
});

export const courseSchema = z.object({
  id: z.string(),
  source: z.enum(["studenthub", "canvas", "mock"]).optional(),
  code: z.string(),
  name: z.string(),
  credits: z.number().optional(),
  instructor: z.string().optional(),
  progress: z.number().optional(),
  status: z.enum(["active", "completed", "upcoming"]).optional(),
  nextDeadline: z.string().optional(),
  url: z.string().optional(),
});

export const classSessionSchema = z.object({
  id: z.string(),
  courseCode: z.string(),
  courseName: z.string(),
  room: z.string().optional(),
  startTime: z.string(),
  endTime: z.string(),
  timeLabel: z.string().optional(),
  weekday: z.number().optional(),
  periodStart: z.number().optional(),
  periodEnd: z.number().optional(),
  canvasCourseId: z.number().optional(),
  url: z.string().optional(),
  instructor: z.string().optional(),
  type: z.string().optional(),
});

export const assignmentSchema = z.object({
  id: z.string(),
  title: z.string(),
  courseCode: z.string().optional(),
  courseName: z.string().optional(),
  dueAt: z.string(),
  status: z.enum(["not_started", "in_progress", "submitted", "late", "missing"]),
  priority: z.enum(["low", "medium", "high"]).optional(),
  type: z.enum(["assignment", "quiz", "announcement", "planner_item"]).optional(),
  url: z.string().optional(),
});

export const gradeSchema = z.object({
  id: z.string(),
  courseCode: z.string(),
  courseName: z.string(),
  credits: z.number().optional(),
  termCode: z.string().optional(),
  point4: z.number().nullable().optional(),
  point10: z.number().nullable().optional(),
  letter: z.string().optional(),
});

export const gpaSummarySchema = z.object({
  gpa: z.number().nullable().optional(),
  cpa: z.number().nullable().optional(),
  totalCredits: z.number().optional(),
  totalAccumulatedCredits: z.number().optional(),
  totalCourses: z.number().optional(),
  passedProgramCourses: z.number().optional(),
});

export const examSessionSchema = z.object({
  id: z.string(),
  courseCode: z.string(),
  courseName: z.string(),
  examType: z.string().optional(),
  examMethod: z.string().optional(),
  examDate: z.string(),
  startTime: z.string().optional(),
  examSession: z.number().optional(),
  examNumber: z.string().optional(),
  room: z.string().optional(),
  termCode: z.string().optional(),
});

export const attendanceRecordSchema = z.object({
  id: z.string(),
  courseCode: z.string(),
  courseName: z.string(),
  attended: z.number(),
  total: z.number(),
  percentage: z.number(),
});

export const notificationSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string().optional(),
  createdAt: z.string(),
  unread: z.boolean().optional(),
  url: z.string().optional(),
  source: z.enum(["studenthub", "canvas", "mock"]).optional(),
});

export const newsItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  date: z.string().optional(),
  image: z.string().optional(),
  category: z.string().optional(),
  url: z.string().optional(),
});

export const documentItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  courseCode: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.number().optional(),
  updatedAt: z.string().optional(),
  url: z.string().optional(),
});

export const billSchema = z.object({
  id: z.string(),
  title: z.string(),
  termCode: z.string().optional(),
  totalAmount: z.number(),
  paidAmount: z.number(),
  remainingAmount: z.number(),
  status: z.string(),
  dueAt: z.string().optional(),
  paidAt: z.string().optional(),
  invoiceUrl: z.string().optional(),
});

export const tuitionStatusSchema = z.object({
  totalAmount: z.number(),
  paidAmount: z.number(),
  remainingAmount: z.number(),
  bills: z.array(billSchema),
});

export const trainingPointSchema = z.object({
  id: z.string(),
  termCode: z.string().optional(),
  title: z.string(),
  score: z.number().nullable().optional(),
  maxScore: z.number().nullable().optional(),
  locked: z.boolean().optional(),
});

export const serviceRequestSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: z.string().optional(),
  status: z.string().optional(),
  createdAt: z.string().optional(),
});

export const dashboardSummarySchema = z.object({
  student: studentSchema.optional(),
  currentTerm: termSchema.optional(),
  courseCount: z.object({ inTerm: z.number(), completed: z.number() }).optional(),
  nextClass: classSessionSchema.nullable().optional(),
  todaySchedule: z.array(classSessionSchema),
  courses: z.array(courseSchema),
  assignments: z.array(assignmentSchema),
  grades: z.array(gradeSchema),
  gpa: gpaSummarySchema.optional(),
  exams: z.array(examSessionSchema),
  tuition: tuitionStatusSchema.optional(),
  notifications: z.array(notificationSchema),
});

export const authSessionSchema = z.object({
  universityId: z.string(),
  studentCode: z.string().optional(),
  expiresAt: z.string(),
  authenticated: z.boolean(),
});

export const apiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});

export const apiResponseSchema = <T extends z.ZodType>(data: T) =>
  z.object({ data, error: apiErrorSchema.nullable(), meta: z.record(z.string(), z.unknown()).optional() });

export type UniversityTheme = z.infer<typeof universityThemeSchema>;
export type UniversityCapabilities = z.infer<typeof universityCapabilitiesSchema>;
export type University = z.infer<typeof universitySchema>;
export type Term = z.infer<typeof termSchema>;
export type Student = z.infer<typeof studentSchema>;
export type Course = z.infer<typeof courseSchema>;
export type ClassSession = z.infer<typeof classSessionSchema>;
export type Assignment = z.infer<typeof assignmentSchema>;
export type Grade = z.infer<typeof gradeSchema>;
export type GpaSummary = z.infer<typeof gpaSummarySchema>;
export type ExamSession = z.infer<typeof examSessionSchema>;
export type AttendanceRecord = z.infer<typeof attendanceRecordSchema>;
export type Notification = z.infer<typeof notificationSchema>;
export type NewsItem = z.infer<typeof newsItemSchema>;
export type DocumentItem = z.infer<typeof documentItemSchema>;
export type Bill = z.infer<typeof billSchema>;
export type TuitionStatus = z.infer<typeof tuitionStatusSchema>;
export type TrainingPoint = z.infer<typeof trainingPointSchema>;
export type ServiceRequest = z.infer<typeof serviceRequestSchema>;
export type DashboardSummary = z.infer<typeof dashboardSummarySchema>;
export type AuthSession = z.infer<typeof authSessionSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
export type ApiResponse<T> = { data: T | null; error: ApiError | null; meta?: Record<string, unknown> };
