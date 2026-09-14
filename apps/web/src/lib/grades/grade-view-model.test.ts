import type { Grade } from "@hyeboard/schemas";
import { describe, expect, it } from "vitest";
import { ALL_GRADE_TERMS, createGradeExportTerm, decodeGradeTermKey, encodeGradeTermKey, selectVisibleGradeSummaries, sortGrades, sortGradeTableRows, type GradeTableRow } from "./grade-view-model";
import type { AcademicTermSummary } from "./term-academic-summary";

const grades: Grade[] = [
  { id: "b", courseCode: "B", courseName: "Beta", credits: 2, point10: 9, point4: 4, termCode: "252" },
  { id: "a", courseCode: "A", courseName: "Alpha", credits: 3, point10: 8, point4: 3, termCode: "252" },
];

function summary(termKey: string, courses = grades): AcademicTermSummary<Grade> {
  return { termKey, courses, listedCredits: 5, includedCredits: 5, termGpa4: 3.5, cpa4: 3.5, includesSummer: false, estimateKind: "derived" };
}

describe("grade view model", () => {
  it("sorts text and numeric columns in both directions without mutating input", () => {
    expect(sortGrades(grades, { key: "name", direction: "asc" }).map((grade) => grade.id)).toEqual(["a", "b"]);
    expect(sortGrades(grades, { key: "point10", direction: "desc" }).map((grade) => grade.id)).toEqual(["b", "a"]);
    expect(grades.map((grade) => grade.id)).toEqual(["b", "a"]);
  });

  it("keeps missing, reserved, spaced, and raw term identities collision-safe", () => {
    for (const termCode of [undefined, "", " 251 ", "~hyeboard:all", "~hyeboard:known:reserved"]) {
      expect(decodeGradeTermKey(encodeGradeTermKey(termCode))).toBe(termCode?.trim() ? termCode : undefined);
    }
    expect(encodeGradeTermKey("unknown")).toBe("unknown");
  });

  it("selects newest, valid, and all-term views deterministically", () => {
    const summaries = [summary("252"), summary("251")];
    expect(selectVisibleGradeSummaries(summaries, undefined)).toMatchObject({ effectiveTerm: "252", visibleSummaries: [summaries[0]] });
    expect(selectVisibleGradeSummaries(summaries, "251")).toMatchObject({ effectiveTerm: "251", visibleSummaries: [summaries[1]] });
    expect(selectVisibleGradeSummaries(summaries, ALL_GRADE_TERMS)).toMatchObject({ effectiveTerm: ALL_GRADE_TERMS, visibleSummaries: summaries });
  });

  it("constructs export terms in current sorted course order", () => {
    const sorted = sortGrades(grades, { key: "name", direction: "asc" });
    const exported = createGradeExportTerm(summary("252"), "mock", "Semester", sorted);
    expect(exported.termCode).toBe("252");
    expect(exported.courses.map((course) => course.courseName)).toEqual(["Alpha", "Beta"]);
    expect(exported.courses.map((course) => Object.keys(course))).toEqual([
      ["courseCode", "courseName", "credits", "point10", "letter", "point4"],
      ["courseCode", "courseName", "credits", "point10", "letter", "point4"],
    ]);
  });
});

describe("sortGradeTableRows", () => {
  const rows: readonly GradeTableRow[] = [
    { id: "1", courseName: "Toán", credits: 3, point10: 8, point4: 3, letter: "B", detail: { kind: "unavailable", render: () => null } },
    { id: "2", courseName: "Anh văn", credits: 2, point10: 9, point4: 4, letter: "A", detail: { kind: "unavailable", render: () => null } },
    { id: "3", courseName: "Toán", credits: 4, point10: null, point4: null, letter: "-", detail: { kind: "unavailable", render: () => null } },
  ];

  it("sorts by name ascending", () => {
    const result = sortGradeTableRows(rows, { key: "name", direction: "asc" });
    expect(result.map(r => r.courseName)).toEqual(["Anh văn", "Toán", "Toán"]);
  });

  it("sorts by name descending", () => {
    const result = sortGradeTableRows(rows, { key: "name", direction: "desc" });
    expect(result.map(r => r.courseName)).toEqual(["Toán", "Toán", "Anh văn"]);
  });

  it("sorts by credits ascending", () => {
    const result = sortGradeTableRows(rows, { key: "credits", direction: "asc" });
    expect(result.map(r => r.credits)).toEqual([2, 3, 4]);
  });

  it("sorts by point10 with null as -1", () => {
    const result = sortGradeTableRows(rows, { key: "point10", direction: "desc" });
    expect(result.map(r => r.point10)).toEqual([9, 8, null]);
  });

  it("sorts by point4 ascending (null → -1 sorts first)", () => {
    const result = sortGradeTableRows(rows, { key: "point4", direction: "asc" });
    expect(result.map(r => r.point4)).toEqual([null, 3, 4]);
  });

  it("sorts by point10 ascending (null → -1 sorts first)", () => {
    const result = sortGradeTableRows(rows, { key: "point10", direction: "asc" });
    expect(result.map(r => r.point10)).toEqual([null, 8, 9]);
  });

  it("returns empty array for empty input", () => {
    expect(sortGradeTableRows([], { key: "name", direction: "asc" })).toEqual([]);
  });

  it("returns single-element array unchanged", () => {
    const single = rows.slice(0, 1);
    expect(sortGradeTableRows(single, { key: "point10", direction: "desc" })).toEqual(single);
  });

  it("does not mutate source", () => {
    const copy = [...rows];
    sortGradeTableRows(rows, { key: "name", direction: "asc" });
    expect(rows).toEqual(copy);
  });
});
