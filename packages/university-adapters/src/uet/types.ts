export type StudentHubEnvelope<T> = { code?: number | string; msgCode?: string; data: T };

export type StudentHubGoogleLogin = {
  accountCode?: string;
  username?: string;
  name?: string;
  email?: string;
  accessToken: string;
  refreshToken?: string;
  role?: string;
  dependAccountCode?: string;
};

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

export type StudentHubScheduleAlertSession = {
  sessionStart?: string | number;
  courseSectionCode?: string;
  weekDay?: string | number;
  name?: string;
  sessionEnd?: string | number;
  typeLesson?: string;
  name1?: string;
  roomName?: string;
  canvasCourseId?: number;
};

export type StudentHubCourseCount = { inTerm?: number; completed?: number };

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
  examSession?: string | number;
  roomName?: string;
  examNumber?: string;
};

export type StudentHubBill = {
  billCode?: string;
  billDetailCode?: string;
  billTitle?: string;
  totalAmount?: number;
  paidAmount?: number;
  remainingAmount?: number;
  billStatus?: string | number;
  paymentStatus?: string;
  payDate?: string;
  dateEnd?: string;
  termCode?: string;
  billDescription?: string;
  parentBillCode?: string;
  invoiceUrl?: string;
  electronicInvoiceUrl?: string;
};

export type StudentHubNotificationPage = {
  content?: Array<{ id?: string | number; title?: string; content?: string; createdAt?: string; createdDate?: string; link?: string }>;
  totalElements?: number;
};

export type StudentHubNews = { id?: string | number; title?: string; date?: string; image?: string; category?: string; link?: string };

export type StudentHubTrainingPointLockAssessment = {
  studentCode?: string;
  studentName?: string;
  className?: string;
  faculty?: string;
  status?: string;
  termCode?: string;
  totalBase?: number;
  totalSV?: number;
  totalBCS?: number;
  totalCVHT?: number;
  totalKV?: number;
  totalCTSV?: number;
};

export type StudentHubTrainingPointAssessment = {
  assessmentStatus?: string;
  canAssess?: boolean;
  termCode?: string;
  criteriaAssessmentList?: Array<{
    name?: string;
    baseScore?: number;
    maxScore?: number;
    orderIndex?: number;
  }>;
};

export type StudentHubServiceRequest = {
  id?: string | number;
  requestId?: string | number;
  requestType?: string;
  requestTypeName?: string;
  type?: string;
  title?: string;
  detail?: string;
  description?: string;
  reason?: string;
  status?: string;
  statusName?: string;
  createdAt?: string;
  createdDate?: string;
};

export type StudentHubRequestType = { label?: string; value?: string | number };

// Same response shape as the Google-OAuth callback login — StudentHub's
// direct username/password login (POST /api/auth/login, used by
// parent/guardian accounts, see har-notes.md's "parent/guardian account"
// section) returns identical fields.
export type StudentHubDirectLogin = StudentHubGoogleLogin;

// Generic Spring Data Page<T> envelope — used by the reference/lookup
// endpoints (province/district/ward/nation/blood-type search) and shares
// the same shape as the notifications page.
export type StudentHubPage<T> = {
  content?: T[];
  pageable?: { pageNumber?: number; pageSize?: number; offset?: number; paged?: boolean; unpaged?: boolean };
  last?: boolean;
  first?: boolean;
  totalElements?: number;
  totalPages?: number;
  size?: number;
  number?: number;
  numberOfElements?: number;
  empty?: boolean;
};

export type StudentHubAdmissionInfo = {
  id?: string | number;
  studentCode?: string;
  graduationCert?: unknown;
  transcript?: unknown;
  cccdFront?: unknown;
  cccdBack?: unknown;
  birthCert?: unknown;
  militaryDoc?: unknown;
  priorityDoc?: unknown;
  studentBankInfo?: unknown;
  workflowState?: unknown;
  admissionNotice?: unknown;
  personalInfo?: unknown;
  residenceInfo?: unknown;
  tempGraduationCert?: unknown;
  isLocked?: boolean;
};

export type StudentHubCommitteeCheck = { check?: boolean };

export type StudentHubCourseRef = { courseCode?: string; courseName?: string; [key: string]: unknown };

export type StudentHubCourseGroup = { courses?: StudentHubCourseRef[]; typeName?: string; optionalNum?: number | null };

// Keyed by a numeric course-category id (e.g. "32", "38") — see
// /api/student/dktn/course and /api/student/program's groupedCourses.
export type StudentHubCourseGroups = Record<string, StudentHubCourseGroup>;

export type StudentHubDktnCourses = { listPhysical?: unknown[]; listCourses?: StudentHubCourseGroups };

export type StudentHubBillOptional = StudentHubBill & { paymentStatus?: number | string | null };

export type StudentHubPersonDetail = {
  studentCode?: string;
  id?: string | number;
  personCode?: string;
  nowCountry?: string | null;
  nowProvince?: string | null;
  nowDistrict?: string | null;
  nowWard?: string | null;
  nowRoad?: string | null;
  nowHomeNumber?: string | null;
  phoneNumber?: string;
  homePhoneNumber?: string | null;
  ttProvince?: string | null;
  ttDistrict?: string | null;
  ttWard?: string | null;
  ttRoad?: string | null;
  ttHomeNumber?: string | null;
  graduateYear?: number;
  academicPerformance?: string;
  conduct?: string;
  avg12?: number;
  collegeGraduation?: string;
  intermediateSchoolGraduation?: string;
  province12Code?: string;
  school12Code?: string;
  isDisabledStudent?: number;
  disabilityLevel?: number;
  disabilityType?: number;
};

export type StudentHubFamilyDetail = {
  id?: string | number;
  personCode?: string;
  studentCode?: string;
  fatherName?: string;
  fatherYear?: number;
  fatherPhoneNumber?: string;
  fatherJob?: string;
  fatherEmail?: string | null;
  fatherAddress?: string | null;
  motherName?: string;
  motherYear?: number;
  motherPhoneNumber?: string;
  motherJob?: string;
  motherEmail?: string | null;
  motherAddress?: string | null;
  otherInformation?: string | null;
  siblingUniStatus?: unknown;
  inFamilyOrder?: unknown;
};

export type StudentHubHealthcareDetail = {
  id?: string | number;
  personCode?: string;
  healthcareCode?: string;
  hkOwnerName?: string | null;
  hkOwnerBirth?: string | null;
  hkOwnerRelation?: string | null;
  hkOwnerSex?: string | null;
  ttProvince?: string | null;
  ttWard?: string | null;
};

export type StudentHubProgramDetails = {
  programCode?: string;
  engName?: string;
  name?: string;
  creditAmount?: string;
  graduateMinPoint?: string;
  plo?: unknown;
};

export type StudentHubProgram = { programDetails?: StudentHubProgramDetails; groupedCourses?: StudentHubCourseGroups };

export type StudentHubRegistrationWindow = { startAt?: string; endAt?: string; manualMode?: string | boolean };

export type StudentHubSemesterAdvice = {
  programCode?: string;
  courseCode?: string;
  name?: string;
  egName?: string | null;
  courseCredit?: number;
  typeId?: number;
  typeName?: string;
  scorable?: unknown;
  termCode?: string | null;
  courseSpecialCodes?: unknown;
  termExpect?: unknown;
  obligatory?: number;
  optionalNum?: number | null;
  isEdit?: number;
};

export type StudentHubSemesterExpected = {
  id?: string | number;
  studentCode?: string;
  termCode?: string;
  termName?: string;
  termExpect?: number;
  isLock?: number;
  isActive?: unknown;
  termLock?: number;
};

export type StudentHubCanvasLinkInfo = { userCanvasId?: number; lastReqAt?: string; curLoginAt?: string };

export type StudentHubReferenceItem = { id?: string | number; [key: string]: unknown };
export type StudentHubBloodType = { id?: string | number; bloodType?: string };
export type StudentHubNation = { id?: string | number; nation?: string };
export type StudentHubProvince = { id?: string | number; provinceCode?: string; provinceName?: string };
export type StudentHubDistrict = { id?: string | number; districtCode?: string; districtName?: string; provinceCode?: string };
export type StudentHubWard = { id?: string | number; name?: string; provinceCode?: string; wardCode?: string };

export type StudentHubDashboardBanner = { title?: string; content?: string; isShow?: boolean; status?: string; stopAt?: string };

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
