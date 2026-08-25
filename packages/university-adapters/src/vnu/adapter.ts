import { addHours, assertSupported, HyeboardError, type EncryptedSessionPayload } from "@hyeboard/core";
import type { University } from "@hyeboard/schemas";
import { DaotaoClient } from "./daotao-client";
import { mapExamRow, mapGpaSummary, mapGradeRow, mapProfile, mapSyllabusRow, mapTerms, mapTrainingPoints } from "./mapper";
import { parseExamTermOptions, parseExamsHtml, parseGradesHtml, parseProfileHtml, parseStudyProgressHtml, parseSyllabusHtml } from "./parser";
import type { AdapterRequest, ImportedSession, LoginImportInput, UniversityAdapter } from "../types";

const university: University = {
  id: "vnu",
  name: "Vietnam National University, Hanoi (daotao portal)",
  shortName: "VNU (daotao)",
  theme: { primary: "#7A1E28", accent: "#B23A47", soft: "#FBEEEE" },
  capabilities: {
    profile: true,
    terms: true,
    // Course registration/timetable viewing was moved off daotao.vnu.edu.vn
    // to a separate portal (dangkyhoc.vnu.edu.vn) that this adapter has no
    // captured data for — see har-notes.md. Never fake a timetable.
    timetable: false,
    courses: false,
    assignments: false,
    grades: true,
    exams: true,
    attendance: false,
    notifications: false,
    documents: true,
    tuition: false,
    news: false,
    trainingPoints: true,
    requests: false,
    // StdExamination.asp's hidCrdID rows + TabStdSelf.asp's hidStdID are both
    // verified vnu-only shapes (see har-notes.md) — this is the only adapter
    // that can honestly claim the class-lookup tool.
    classLookup: true,
    // Live-verified: cross-student lookup is backed by
    // ListPoint/listpoint_Brc1.asp?selStd=..., which DOES honor arbitrary
    // StdIDs (it renders the requested student's identity header) — unlike
    // StdExamination.asp, which silently IGNORES selStd and always renders
    // the session owner (see har-notes.md). This deployment is authorized
    // to expose that behavior, gated server-side behind an explicit opt-in
    // flag — honest here, false in mock/uet.
    crossLookup: true,
  },
};

function incompleteVnuProfile(): HyeboardError {
  return new HyeboardError("VNU_PROFILE_INCOMPLETE", "The university portal profile is incomplete.", 500);
}

function client(request: AdapterRequest): DaotaoClient {
  return new DaotaoClient(request.session);
}

async function loadGrades(request: AdapterRequest) {
  return parseGradesHtml(await client(request).getGradesHtml(request.signal));
}

async function loadProgress(request: AdapterRequest) {
  return parseStudyProgressHtml(await client(request).getStudyProgressHtml(request.signal));
}

export function createVnuAdapter(): UniversityAdapter {
  return {
    university,
    async importSession(input: LoginImportInput): Promise<ImportedSession> {
      const normalizedUsername = input.vnuUsername?.trim().toLowerCase();
      if (!normalizedUsername || !input.vnuPassword) {
        throw new HyeboardError("MISSING_UPSTREAM_CREDENTIAL", "Provide your university portal username and password.", 400);
      }
      const cookie = await new DaotaoClient().login(normalizedUsername, input.vnuPassword, input.signal);
      const expiresAt = addHours(8);
      const session: EncryptedSessionPayload = {
        version: 1,
        universityId: "vnu",
        expiresAt,
        vnu: { kind: "cookie", value: cookie, expiresAt },
      };
      // Verify the credential actually works before declaring success — a
      // rejected login still returns 200 with a re-rendered login page, not
      // an HTTP error, so this is the only reliable check.
      let profile;
      try {
        profile = parseProfileHtml(await new DaotaoClient(session).getProfileHtml(input.signal));
      } catch (error) {
        if (input.signal?.aborted) throw input.signal.reason ?? new DOMException("This operation was aborted", "AbortError");
        if (error instanceof HyeboardError && ["VNU_RATE_LIMITED", "VNU_UPSTREAM_UNAVAILABLE", "VNU_REQUEST_FAILED"].includes(error.code)) throw error;
        throw new HyeboardError("INVALID_VNU_CREDENTIAL", "daotao.vnu.edu.vn rejected this username or password, or the returned session expired immediately.", 401);
      }
      if (!profile.studentCode) {
        throw incompleteVnuProfile();
      }
      return { universityId: "vnu", studentCode: profile.studentCode, expiresAt, session };
    },
    async getStudentProfile(request) {
      const profile = parseProfileHtml(await client(request).getProfileHtml(request.signal));
      return mapProfile(profile, university.id);
    },
    async getTerms(request) {
      return mapTerms(await loadGrades(request));
    },
    async getDashboard(request) {
      const capabilities = request.capabilities ?? university.capabilities;
      const [student, grades, progress] = await Promise.all([
        capabilities.profile ? this.getStudentProfile(request) : Promise.resolve(undefined),
        capabilities.terms || capabilities.grades ? loadGrades(request) : Promise.resolve(undefined),
        capabilities.grades ? loadProgress(request) : Promise.resolve(undefined),
      ]);
      const terms = grades ? mapTerms(grades) : [];
      return {
        student,
        currentTerm: capabilities.terms ? terms[0] : undefined,
        todaySchedule: [],
        courses: [],
        assignments: [],
        grades: capabilities.grades && grades ? grades.rows.map(mapGradeRow) : [],
        gpa: capabilities.grades && grades && progress ? mapGpaSummary(grades, progress) : undefined,
        exams: [],
        notifications: [],
      };
    },
    async getTimetable() {
      assertSupported(false, "Timetable");
      return [];
    },
    async getCourses() {
      assertSupported(false, "Courses");
      return [];
    },
    async getCourseDetail() {
      throw new HyeboardError("UNSUPPORTED_FEATURE", "Courses is not supported by this university", 501);
    },
    async getAssignments() {
      assertSupported(false, "Assignments");
      return [];
    },
    async getGrades(request) {
      const grades = await loadGrades(request);
      return grades.rows.map(mapGradeRow);
    },
    async getGpaSummary(request) {
      const [grades, progress] = await Promise.all([loadGrades(request), loadProgress(request)]);
      return mapGpaSummary(grades, progress);
    },
    async getExams(request) {
      const daotao = client(request);
      const profile = parseProfileHtml(await daotao.getProfileHtml(request.signal));
      if (!/^\d{1,11}$/.test(profile.internalStudentId ?? "") || !/^\d+$/.test(profile.internalUnivId ?? "")) {
        throw incompleteVnuProfile();
      }
      const baseHtml = await daotao.getExamBaseHtml(request.signal);
      const termOptions = parseExamTermOptions(baseHtml);
      const requestedTerm = request.termCode;
      const option = requestedTerm
        ? termOptions.find((o) => o.label.startsWith(`${requestedTerm}.`))
        : (termOptions.find((o) => o.selected) ?? termOptions[0]);
      if (!option) return [];
      const html = await daotao.getExamsHtml({ selUniv: profile.internalUnivId!, selStd: profile.internalStudentId!, vTermID: option.value }, request.signal);
      return parseExamsHtml(html).map(mapExamRow);
    },
    async getAttendance() {
      assertSupported(false, "Attendance");
      return [];
    },
    async getNotifications() {
      assertSupported(false, "Notifications");
      return [];
    },
    async getNews() {
      assertSupported(false, "News");
      return [];
    },
    async getDocuments(request) {
      const html = await client(request).getSyllabusHtml(request.signal);
      return parseSyllabusHtml(html).map(mapSyllabusRow);
    },
    async getTuition() {
      throw new HyeboardError("UNSUPPORTED_FEATURE", "Tuition is not supported by this university", 501);
    },
    async getTrainingPoints(request) {
      return mapTrainingPoints(await loadProgress(request));
    },
    async getRequests() {
      assertSupported(false, "Requests");
      return [];
    },
  };
}
