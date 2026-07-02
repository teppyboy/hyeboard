import type { DocumentItem, ExamSession, Grade, GpaSummary, Student, Term, TrainingPoint } from "@hyeboard/schemas";
import type { VnuExamRow, VnuGradesResult, VnuProfile, VnuSyllabusRow, VnuTermProgressRow } from "./types";

export function mapProfile(profile: VnuProfile, universityId: string): Student {
  return {
    id: profile.studentCode ?? profile.internalStudentId ?? "vnu-student",
    fullName: profile.fullName ?? "",
    universityId,
    studentCode: profile.studentCode,
    major: profile.majorName,
    className: profile.className,
    programName: [profile.levelName, profile.trainingModeName].filter(Boolean).join(" \u00b7 ") || undefined,
    currentSemester: undefined,
  };
}

export function mapGradeRow(row: VnuGradesResult["rows"][number], index: number): Grade {
  return {
    id: `vnu-grade-${row.termCode}-${row.courseCode}-${index}`,
    courseCode: row.courseCode,
    courseName: row.courseName,
    credits: row.credits,
    termCode: row.termCode || undefined,
    point4: row.point4 ?? null,
    point10: row.point10 ?? null,
    letter: row.letter,
  };
}

// daotao doesn't expose a single "current term GPA" figure the way UET's
// StudentHub does — the grades page (ListPoint_Brc1.asp) only has cumulative
// totals, and per-term GPA lives on a separate page (TabStdStudy.asp), which
// also lists future/not-yet-started terms with a defined-but-meaningless
// termGpa of 0. To avoid picking one of those empty future terms, "current
// term" is restricted to term codes that actually have real coursework in
// the grades table, then the most recent one of those is used both for the
// term GPA and for the "credits this term" figure (also scraped-page-derived
// from the grades table, distinct from the cumulative total).
export function mapGpaSummary(grades: VnuGradesResult, progress: VnuTermProgressRow[]): GpaSummary {
  const termsWithCourses = new Set(grades.rows.map((row) => row.termCode).filter(Boolean));
  const currentTermCode = [...termsWithCourses].sort((a, b) => Number.parseInt(b, 10) - Number.parseInt(a, 10))[0];
  const currentTermProgress = progress.find((row) => row.termCode === currentTermCode && row.termGpa !== undefined);
  const currentTermCredits = grades.rows
    .filter((row) => row.termCode === currentTermCode)
    .reduce((sum, row) => sum + (row.credits ?? 0), 0);
  return {
    gpa: currentTermProgress?.termGpa ?? null,
    cpa: grades.cumulativeGpa4 ?? null,
    totalCredits: currentTermCode ? currentTermCredits : grades.totalCredits,
    totalAccumulatedCredits: grades.totalAccumulatedCredits,
    totalCourses: grades.rows.length || undefined,
  };
}

// Terms are derived from the grades table's per-course termCode/termLabel
// pairs (daotao has no separate term-listing endpoint). Sorted newest-first
// by numeric term code; the newest is marked current since daotao doesn't
// expose an explicit "current term" flag either.
export function mapTerms(grades: VnuGradesResult): Term[] {
  const seen = new Map<string, string>();
  for (const row of grades.rows) {
    if (row.termCode && !seen.has(row.termCode)) seen.set(row.termCode, row.termLabel);
  }
  const codes = [...seen.keys()].sort((a, b) => Number.parseInt(b, 10) - Number.parseInt(a, 10));
  return codes.map((code, index) => ({
    id: code,
    code,
    name: seen.get(code) ?? code,
    index,
    current: index === 0,
  }));
}

function parseDateDDMMYYYY(value: string, hour?: string): string | undefined {
  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return undefined;
  const [, day, month, year] = match;
  const [h, m] = (hour ?? "00:00").split(":").map((part) => Number.parseInt(part, 10));
  const date = new Date(Date.UTC(Number.parseInt(year, 10), Number.parseInt(month, 10) - 1, Number.parseInt(day, 10), h || 0, m || 0));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function mapExamRow(row: VnuExamRow, index: number): ExamSession {
  const examDate = parseDateDDMMYYYY(row.examDate) ?? row.examDate;
  return {
    id: `vnu-exam-${row.termCode ?? "t"}-${row.courseCode}-${index}`,
    courseCode: row.courseCode,
    courseName: row.courseName,
    examMethod: row.method,
    examDate,
    startTime: parseDateDDMMYYYY(row.examDate, row.hour),
    examSession: row.session,
    examNumber: row.seatNumber,
    room: row.room,
    termCode: row.termCode,
  };
}

// Only the conduct-score ("Điểm rèn luyện") rows count as training points —
// term/cumulative GPA from the same table is already surfaced via
// getGpaSummary, not duplicated here.
export function mapTrainingPoints(progress: VnuTermProgressRow[]): TrainingPoint[] {
  return progress
    .filter((row) => row.conductScore !== undefined)
    .map((row) => ({
      id: `vnu-training-${row.termCode ?? row.termLabel}`,
      termCode: row.termCode,
      title: row.termLabel,
      score: row.conductScore ?? null,
      maxScore: 100,
    }));
}

export function mapSyllabusRow(row: VnuSyllabusRow, index: number): DocumentItem {
  return {
    id: `vnu-syllabus-${row.courseCode}-${index}`,
    name: `${row.courseCode} \u2014 ${row.courseName}`,
    courseCode: row.courseCode,
    mimeType: row.fileUrl ? "application/pdf" : undefined,
    updatedAt: row.uploadedAt,
    url: row.fileUrl,
  };
}
