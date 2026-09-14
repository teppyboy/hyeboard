import type { DashboardSummary, UniversityCapabilities } from "@hyeboard/schemas";
import { describe, expect, it } from "vitest";
import { dashboardSections, effectiveDashboardIdentity } from "./student-policy";

const capabilities = (overrides: Partial<UniversityCapabilities> = {}): UniversityCapabilities => ({
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
  classLookup: true,
  crossLookup: true,
  ...overrides,
});

const dashboard = {
  student: {
    id: "student",
    fullName: "Student",
    universityId: "uet",
    studentCode: "SECRET-CODE",
    email: "student@example.edu",
    major: "Computer Science",
    className: "K69",
    programName: "Honors",
    currentSemester: "2025-1",
  },
  currentTerm: { id: "term", code: "term", name: "Current term" },
} as DashboardSummary;

describe("student policy visibility", () => {
  it("preserves the complete student profile only when profile is exactly true", () => {
    const sections = dashboardSections(dashboard, capabilities({ assignments: false, grades: false }));

    expect(sections.identity).toEqual({ student: dashboard.student, currentTerm: dashboard.currentTerm });
    expect(sections.stats).toEqual({ courses: true, assignments: false, grades: false, tuition: true });
    expect(sections.panels).toEqual({ timetable: true, assignments: false, courses: true, notifications: true });
  });

  it.each([undefined, capabilities({ profile: false })])("strips the complete student profile when effective profile metadata is %s", (effectiveCapabilities) => {
    expect(dashboardSections(dashboard, effectiveCapabilities).identity.student).toBeUndefined();
  });

  it.each([
    [undefined, undefined],
    [capabilities({ terms: false }), undefined],
    [capabilities({ terms: true }), dashboard.currentTerm],
  ])("projects currentTerm only when terms capability is exactly true", (effectiveCapabilities, currentTerm) => {
    expect(effectiveDashboardIdentity(dashboard, effectiveCapabilities).currentTerm).toEqual(currentTerm);
  });

  it("hides all capability-bound dashboard sections without effective metadata", () => {
    expect(dashboardSections(dashboard, undefined)).toEqual({
      identity: { student: undefined, currentTerm: undefined },
      stats: { courses: false, assignments: false, grades: false, tuition: false },
      panels: { timetable: false, assignments: false, courses: false, notifications: false },
    });
  });
});
