import { describe, expect, it } from "vitest";
import {
  calculateTermAcademicSummaries,
  newestAcademicTermsFirst,
  type AcademicCourseInput,
} from "./term-academic-summary";

type Row = {
  id: string;
  term: string;
  credits?: number | null;
  point4?: number | null;
  summer?: boolean;
};

const normalize = (rows: Row[]): AcademicCourseInput<Row>[] =>
  rows.map((row) => ({
    termKey: row.term,
    credits: row.credits,
    point4: row.point4,
    course: row,
    isSummer: row.summer === true,
  }));

describe("calculateTermAcademicSummaries", () => {
  it("uses positive finite credits as weights and preserves full precision", () => {
    const [term] = calculateTermAcademicSummaries(
      normalize([
        { id: "a", term: "251", credits: 1, point4: 4 },
        { id: "b", term: "251", credits: 2, point4: 3 },
      ]),
      "vnu",
    );

    expect(term).toMatchObject({
      listedCredits: 3,
      includedCredits: 3,
      termGpa4: 10 / 3,
      cpa4: 10 / 3,
      estimateKind: "derived",
    });
  });

  it("calculates running CPA oldest to newest and display reversal does not change assigned CPA", () => {
    const chronological = calculateTermAcademicSummaries(
      normalize([
        { id: "new", term: "252", credits: 1, point4: 4 },
        { id: "old", term: "251", credits: 3, point4: 2 },
      ]),
      "vnu",
    );

    expect(
      chronological.map((term) => [term.termKey, term.termGpa4, term.cpa4]),
    ).toEqual([
      ["251", 2, 2],
      ["252", 4, 2.5],
    ]);
    expect(
      newestAcademicTermsFirst(chronological).map((term) => [term.termKey, term.cpa4]),
    ).toEqual([
      ["252", 2.5],
      ["251", 2],
    ]);
  });

  it("counts missing grades only in listed credits and includes numeric zero grades", () => {
    const [term] = calculateTermAcademicSummaries(
      normalize([
        { id: "missing", term: "251", credits: 3, point4: null },
        { id: "zero", term: "251", credits: 2, point4: 0 },
        { id: "graded", term: "251", credits: 1, point4: 4 },
      ]),
      "vnu",
    );

    expect(term).toMatchObject({
      listedCredits: 6,
      includedCredits: 3,
      termGpa4: 4 / 3,
      cpa4: 4 / 3,
    });
  });

  it("excludes missing, zero, negative, and non-finite credits", () => {
    const [term] = calculateTermAcademicSummaries(
      normalize([
        { id: "missing", term: "251", point4: 4 },
        { id: "zero", term: "251", credits: 0, point4: 4 },
        { id: "negative", term: "251", credits: -2, point4: 4 },
        { id: "nan", term: "251", credits: Number.NaN, point4: 4 },
        {
          id: "infinite-credit",
          term: "251",
          credits: Number.POSITIVE_INFINITY,
          point4: 4,
        },
        {
          id: "infinite-grade",
          term: "251",
          credits: 3,
          point4: Number.POSITIVE_INFINITY,
        },
      ]),
      "vnu",
    );

    expect(term).toMatchObject({ listedCredits: 3, includedCredits: 0 });
    expect(term.termGpa4).toBeUndefined();
    expect(term.cpa4).toBeUndefined();
  });

  it("carries prior CPA through an ungraded term and starts later when no prior grade exists", () => {
    const summaries = calculateTermAcademicSummaries(
      normalize([
        { id: "first-ungraded", term: "251", credits: 3, point4: null },
        { id: "graded", term: "252", credits: 2, point4: 3 },
        { id: "later-ungraded", term: "253", credits: 1, point4: null },
      ]),
      "vnu",
    );

    expect(
      summaries.map((term) => [term.termKey, term.termGpa4, term.cpa4]),
    ).toEqual([
      ["251", undefined, undefined],
      ["252", 3, 3],
      ["253", undefined, 3],
    ]);
  });

  it("orders numeric terms while retaining unknown groups in stable source slots", () => {
    const summaries = calculateTermAcademicSummaries(
      normalize([
        { id: "new", term: "252", credits: 1, point4: 4 },
        { id: "unknown-a", term: "unknown-a", credits: 1, point4: 1 },
        { id: "old", term: "251", credits: 1, point4: 2 },
        { id: "unknown-b", term: "unknown-b", credits: 1, point4: 3 },
      ]),
      "vnu",
    );

    expect(summaries.map((term) => term.termKey)).toEqual([
      "251",
      "unknown-a",
      "252",
      "unknown-b",
    ]);
  });

  it("merges UET and Mock summer code 3 into code 2 as one CPA checkpoint", () => {
    const rows = normalize([
      { id: "regular", term: "20242", credits: 3, point4: 3 },
      { id: "summer", term: "20243", credits: 1, point4: 4, summer: true },
    ]);

    for (const universityId of ["uet", "mock"]) {
      const summaries = calculateTermAcademicSummaries(rows, universityId);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({
        termKey: "20242",
        includesSummer: true,
        listedCredits: 4,
        includedCredits: 4,
        termGpa4: 3.25,
        cpa4: 3.25,
      });
      expect(summaries[0]?.courses.map((course) => course.id)).toEqual([
        "regular",
        "summer",
      ]);
    }
    expect(calculateTermAcademicSummaries(rows, "vnu")).toHaveLength(2);
  });

  it("produces identical summaries for normalized own-grade and cross-transcript rows", () => {
    const own = calculateTermAcademicSummaries(
      [
        { termKey: "251", credits: 3, point4: 3.5, course: { id: "own-a" } },
        { termKey: "251", credits: 2, point4: null, course: { id: "own-b" } },
      ],
      "vnu",
    );
    const cross = calculateTermAcademicSummaries(
      [
        { termKey: "251", credits: 3, point4: 3.5, course: { id: "cross-a" } },
        { termKey: "251", credits: 2, point4: null, course: { id: "cross-b" } },
      ],
      "vnu",
    );

    expect(own.map(({ courses: _courses, ...summary }) => summary)).toEqual(
      cross.map(({ courses: _courses, ...summary }) => summary),
    );
  });

  it("never creates a reported cumulative field inside a derived summary", () => {
    const [summary] = calculateTermAcademicSummaries(
      normalize([{ id: "a", term: "251", credits: 3, point4: 3.5 }]),
      "vnu",
    );

    expect(summary).not.toHaveProperty("reportedCumulativeGpa4");
    expect(summary.estimateKind).toBe("derived");
  });
});
