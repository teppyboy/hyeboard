// Raw, parsed-from-HTML shapes scraped from daotao.vnu.edu.vn (classic ASP,
// server-rendered, no JSON API). See har-notes.md for the page-by-page
// research this parser is based on.

export type VnuProfile = {
  studentCode?: string;
  fullName?: string;
  dob?: string;
  internalStudentId?: string; // hidStdID hidden field, used as selStd in exam URLs
  internalUnivId?: string; // selected UnivID option value, used as selUniv in exam URLs
  levelName?: string;
  trainingModeName?: string;
  programTypeName?: string;
  cohortName?: string;
  className?: string;
  facultyName?: string;
  majorName?: string;
};

export type VnuGradeRow = {
  termCode: string;
  termLabel: string;
  courseCode: string;
  courseName: string;
  credits?: number;
  point10?: number;
  letter?: string;
  point4?: number;
};

export type VnuGradesResult = {
  rows: VnuGradeRow[];
  totalCredits?: number;
  totalAccumulatedCredits?: number;
  cumulativeGpa4?: number;
};

export type VnuTermProgressRow = {
  termCode?: string;
  termLabel: string;
  conductScore?: number;
  termGpa?: number;
  cumulativeGpa?: number;
};

export type VnuExamTermOption = {
  value: string;
  label: string;
  selected: boolean;
};

export type VnuExamRow = {
  termCode?: string;
  courseCode: string;
  courseName: string;
  examDate: string; // DD/MM/YYYY as rendered by the portal
  session?: number;
  hour?: string; // HH:MM
  method?: string;
  room?: string;
  seatNumber?: string;
};

export type VnuSyllabusRow = {
  courseCode: string;
  courseName: string;
  credits?: number;
  fileUrl?: string;
  fileSize?: string;
  uploadedAt?: string;
};
