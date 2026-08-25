import { describe, expect, it } from "vitest";
import { HyeboardError } from "@hyeboard/core";
import type { DashboardSummary, FeaturePolicyContent, University } from "@hyeboard/schemas";
import {
  effectiveUniversity,
  emptyPolicy,
  filterDashboardSummary,
  resolveCapability,
  resolveLimit,
  validatePolicy,
} from "./feature-policy";

const capabilities: University["capabilities"] = {
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
  classLookup: false,
  crossLookup: true,
};

const university: University = {
  id: "vnu",
  name: "VNU",
  shortName: "VNU",
  capabilities,
  limits: { crossLookup: { bulkMaxTargets: 500, crossDetail: { maxTargets: 50, maxRows: 200, concurrency: 6 } } },
};

describe("feature policy", () => {
  it("keeps unsupported adapter capabilities locked off", () => {
    expect(resolveCapability(false, emptyPolicy(), "vnu", "assignments"))
      .toEqual({ enabled: false, locked: true, source: "adapter" });
  });

  it("lets global and university disables win without enabling unsupported features", () => {
    const policy = emptyPolicy();
    policy.global.capabilities.grades = { enabled: false };
    policy.universities.vnu = { capabilities: { exams: { enabled: false } }, limits: {} };

    expect(resolveCapability(true, policy, "vnu", "grades")).toMatchObject({ enabled: false, source: "global" });
    expect(resolveCapability(true, policy, "vnu", "exams")).toMatchObject({ enabled: false, source: "university" });
    policy.global.capabilities.classLookup = { enabled: true };
    expect(resolveCapability(false, policy, "vnu", "classLookup")).toMatchObject({ enabled: false, locked: true });
  });

  it("inherits limits, honors null as no admin cap, and clamps to the hard ceiling", () => {
    const policy = emptyPolicy();
    policy.global.limits["crossLookup.crossDetail.concurrency"] = 12;
    expect(resolveLimit(policy, "vnu", "crossLookup.crossDetail.concurrency", 6))
      .toEqual({ value: 6, configured: 12, source: "global", clamped: true });

    policy.global.limits["crossLookup.bulkMaxTargets"] = null;
    expect(resolveLimit(policy, "vnu", "crossLookup.bulkMaxTargets", 500))
      .toEqual({ value: 500, configured: null, source: "global", clamped: false });

    policy.universities.vnu = { capabilities: {}, limits: { "crossLookup.bulkMaxTargets": 20 } };
    expect(resolveLimit(policy, "vnu", "crossLookup.bulkMaxTargets", 500))
      .toEqual({ value: 20, configured: 20, source: "university", clamped: false });
  });

  it("rejects unknown universities, keys, and unsafe values with safe path metadata", () => {
    const unknownUniversity = emptyPolicy();
    unknownUniversity.universities.unknown = { capabilities: {}, limits: {} };
    expectInvalid(() => validatePolicy(unknownUniversity, [university], {}), "universities.unknown");

    const unknownKey = emptyPolicy() as FeaturePolicyContent & { global: { capabilities: Record<string, unknown>; limits: Record<string, unknown> } };
    unknownKey.global.capabilities.secret = { enabled: true };
    expectInvalid(() => validatePolicy(unknownKey, [university], {}), "global.capabilities.secret");

    const unsafe = emptyPolicy();
    unsafe.global.limits["crossLookup.bulkMaxTargets"] = Number.POSITIVE_INFINITY;
    expectInvalid(() => validatePolicy(unsafe, [university], {}), "global.limits.crossLookup.bulkMaxTargets");

    expectInvalid(
      () => validatePolicy(emptyPolicy(), [university], { secret: 1 } as never),
      "hardLimits.secret",
    );
  });

  it("rejects university re-enable overrides", () => {
    const policy = emptyPolicy();
    policy.universities.vnu = { capabilities: { grades: { enabled: true } }, limits: {} } as never;
    expectInvalid(() => validatePolicy(policy, [university], {}), "universities.vnu.capabilities.grades.enabled");
  });

  it("projects effective hard limits and fails cross-lookup closed without finite authority", () => {
    const policy = emptyPolicy();
    policy.global.limits["crossLookup.bulkMaxTargets"] = 900;
    policy.global.limits["crossLookup.crossDetail.concurrency"] = 12;

    expectInvalid(
      () => effectiveUniversity(university, policy, { "crossLookup.bulkMaxTargets": -1 }),
      "hardLimits.crossLookup.bulkMaxTargets",
    );
    expectInvalid(
      () => effectiveUniversity(university, policy, { secret: 1 } as never),
      "hardLimits.secret",
    );

    const effective = effectiveUniversity(university, policy, {
      "crossLookup.bulkMaxTargets": 300,
      "crossLookup.crossDetail.concurrency": 4,
    });
    expect(effective.limits).toEqual({
      crossLookup: {
        bulkMaxTargets: 300,
        crossDetail: { maxTargets: 50, maxRows: 200, concurrency: 4 },
      },
    });

    const noAuthority = effectiveUniversity({ ...university, limits: undefined }, policy, {});
    expect(noAuthority.capabilities.crossLookup).toBe(false);
    expect(noAuthority.limits).toBeUndefined();

    const nativeDisabled = effectiveUniversity({
      ...university,
      limits: { crossLookup: { bulkMaxTargets: 0 } },
    }, policy, { "crossLookup.bulkMaxTargets": 300 });
    expect(nativeDisabled.capabilities.crossLookup).toBe(false);
    expect(nativeDisabled.limits).toBeUndefined();
  });

  it("clears disabled dashboard feature fields while preserving enabled identity", () => {
    const dashboard: DashboardSummary = {
      student: { id: "s", fullName: "Student", universityId: "vnu" },
      currentTerm: { id: "t", code: "t", name: "Term" },
      courseCount: { inTerm: 1, completed: 2 },
      nextClass: { id: "c", courseCode: "C", courseName: "Course", startTime: "08:00", endTime: "10:00" },
      todaySchedule: [{ id: "c", courseCode: "C", courseName: "Course", startTime: "08:00", endTime: "10:00" }],
      courses: [{ id: "c", code: "C", name: "Course" }],
      assignments: [{ id: "a", title: "A", dueAt: "2026-01-01", status: "not_started" }],
      grades: [{ id: "g", courseCode: "C", courseName: "Course" }],
      gpa: { gpa: 4 },
      exams: [{ id: "e", courseCode: "C", courseName: "Course", examDate: "2026-01-01" }],
      tuition: { totalAmount: 1, paidAmount: 0, remainingAmount: 1, bills: [] },
      notifications: [{ id: "n", title: "N", createdAt: "2026-01-01" }],
    };
    const disabled = { ...capabilities, timetable: false, courses: false, assignments: false, grades: false, exams: false, tuition: false, notifications: false };

    const filtered = filterDashboardSummary(dashboard, disabled);
    expect(filtered.student).toBe(dashboard.student);
    expect(filtered.currentTerm).toBe(dashboard.currentTerm);
    expect(filtered).toMatchObject({ todaySchedule: [], courses: [], assignments: [], grades: [], exams: [], notifications: [] });
    expect(filtered.courseCount).toBeUndefined();
    expect(filtered.nextClass).toBeUndefined();
    expect(filtered.gpa).toBeUndefined();
    expect(filtered.tuition).toBeUndefined();
  });

  it("projects dashboard profile and current term independently", () => {
    const dashboard: DashboardSummary = {
      student: { id: "s", fullName: "Student", universityId: "vnu" },
      currentTerm: { id: "t", code: "t", name: "Term" },
      todaySchedule: [],
      courses: [],
      assignments: [],
      grades: [],
      exams: [],
      notifications: [],
    };

    const profileDisabled = filterDashboardSummary(dashboard, { ...capabilities, profile: false });
    const termsDisabled = filterDashboardSummary(dashboard, { ...capabilities, terms: false });

    expect(profileDisabled.student).toBeUndefined();
    expect(profileDisabled.currentTerm).toBe(dashboard.currentTerm);
    expect(termsDisabled.student).toBe(dashboard.student);
    expect(termsDisabled.currentTerm).toBeUndefined();
  });
});

function expectInvalid(action: () => unknown, path: string): void {
  try {
    action();
    throw new Error("Expected validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(HyeboardError);
    expect(error).toMatchObject({ code: "ADMIN_POLICY_INVALID", status: 400, details: { path } });
  }
}
