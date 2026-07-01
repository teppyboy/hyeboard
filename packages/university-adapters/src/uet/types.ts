export type StudentHubEnvelope<T> = { code?: number | string; msgCode?: string; data: T };

export type StudentHubStudent = {
  id?: string | number;
  personCode?: string;
  studentCode?: string;
  name?: string;
  schoolEmail?: string;
  email?: string;
  classCode?: string;
  programName?: string;
  majorName?: string;
};

export type StudentHubTerm = { id?: string | number; index?: number; termCode?: string; name?: string };

export type StudentHubClassSession = {
  studentCode?: string;
  courseGroupCode?: string;
  termCode?: string;
  courseSectionCode?: string;
  courseCode?: string;
  courseName?: string;
  roomCode?: string;
  roomName?: string;
  sessionStart?: string | number;
  sessionEnd?: string | number;
  weekday?: string | number;
  staffCode1?: string;
  type?: string;
};

export type StudentHubGrade = {
  pointCode?: string;
  courseCode?: string;
  name?: string;
  termCode?: string;
  courseCredit?: number;
  point4?: number | string | null;
  point10?: number | string | null;
  inProgram?: boolean;
};

export type StudentHubGpa = {
  studentCode?: string;
  cpa?: number | string | null;
  gpa?: number | string | null;
  totalCredits?: number;
  totalAccumulatedCredits?: number;
  totalCourses?: number;
  passedProgramCourses?: number;
};

export type StudentHubExam = {
  courseSectionCode?: string;
  termCode?: string;
  courseCode?: string;
  courseName?: string;
  examType?: string;
  examMethod?: string;
  examDate?: string;
  timeStart?: string;
  roomName?: string;
};

export type StudentHubBill = {
  billCode?: string;
  billDetailCode?: string;
  billTitle?: string;
  totalAmount?: number;
  paidAmount?: number;
  remainingAmount?: number;
  billStatus?: string;
  paymentStatus?: string;
  dateEnd?: string;
  termCode?: string;
  invoiceUrl?: string;
  electronicInvoiceUrl?: string;
};

export type StudentHubNotificationPage = {
  content?: Array<{ id?: string | number; title?: string; content?: string; createdAt?: string; createdDate?: string; link?: string }>;
  totalElements?: number;
};

export type StudentHubNews = { id?: string | number; title?: string; date?: string; image?: string; category?: string; link?: string };

export type CanvasDashboardCard = {
  id?: string | number;
  longName?: string;
  shortName?: string;
  originalName?: string;
  courseCode?: string;
  href?: string;
  term?: string;
  subtitle?: string;
  enrollmentState?: string;
  image?: string;
  color?: string;
};

export type CanvasPlannerItem = {
  course_id?: number;
  plannable_id?: number;
  plannable_type?: string;
  plannable_date?: string;
  html_url?: string;
  context_name?: string;
  plannable?: { id?: string | number; title?: string; name?: string; unread_count?: number; points_possible?: number; due_at?: string };
  submissions?: Array<{ submitted_at?: string; workflow_state?: string; late?: boolean; missing?: boolean }>;
};

export type CanvasAssignment = {
  id?: string | number;
  course_id?: number;
  name?: string;
  due_at?: string;
  html_url?: string;
  workflow_state?: string;
  has_submitted_submissions?: boolean;
};
