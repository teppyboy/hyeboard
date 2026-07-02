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
  },
};

function client(request: AdapterRequest): DaotaoClient {
  return new DaotaoClient(request.session);
}

async function loadGrades(request: AdapterRequest) {
  return parseGradesHtml(await client(request).getGradesHtml());
}

async function loadProgress(request: AdapterRequest) {
  return parseStudyProgressHtml(await client(request).getStudyProgressHtml());
}

export function createVnuAdapter(): UniversityAdapter {
  return {
    university,
    async importSession(input: LoginImportInput): Promise<ImportedSession> {
      if (!input.vnuUsername || !input.vnuPassword) {
        throw new HyeboardError("MISSING_UPSTREAM_CREDENTIAL", "Provide your university portal username and password.", 400);
      }
      const cookie = await new DaotaoClient().login(input.vnuUsername, input.vnuPassword);
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
        profile = parseProfileHtml(await new DaotaoClient(session).getProfileHtml());
      } catch {
        throw new HyeboardError("INVALID_VNU_CREDENTIAL", "The university portal rejected this username or password.", 401);
      }
      if (!profile.studentCode) {
        throw new HyeboardError("INVALID_VNU_CREDENTIAL", "The university portal rejected this username or password.", 401);
      }
      return { universityId: "vnu", studentCode: profile.studentCode, expiresAt, session };
    },
    async getStudentProfile(request) {
      const profile = parseProfileHtml(await client(request).getProfileHtml());
      return mapProfile(profile, university.id);
    },
    async getTerms(request) {
      return mapTerms(await loadGrades(request));
    },
    async getDashboard(request) {
      const [student, terms, grades, progress, tuition] = await Promise.all([
        this.getStudentProfile(request),
        this.getTerms(request),
        loadGrades(request),
        loadProgress(request),
        Promise.resolve(undefined),
      ]);
      return {
        student,
        currentTerm: terms[0],
        todaySchedule: [],
        courses: [],
        assignments: [],
        grades: grades.rows.map(mapGradeRow),
        gpa: mapGpaSummary(grades, progress),
        exams: [],
        tuition,
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
      const profile = parseProfileHtml(await daotao.getProfileHtml());
      if (!profile.internalStudentId || !profile.internalUnivId) {
        throw new HyeboardError("VNU_PROFILE_INCOMPLETE", "The university portal did not return enough profile data to look up exams.", 500);
      }
      const baseHtml = await daotao.getExamBaseHtml();
      const termOptions = parseExamTermOptions(baseHtml);
      const requestedTerm = request.termCode;
      const option = requestedTerm
        ? termOptions.find((o) => o.label.startsWith(`${requestedTerm}.`))
        : (termOptions.find((o) => o.selected) ?? termOptions[0]);
      if (!option) return [];
      const html = await daotao.getExamsHtml({ selUniv: profile.internalUnivId, selStd: profile.internalStudentId, vTermID: option.value });
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
      const html = await client(request).getSyllabusHtml();
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
