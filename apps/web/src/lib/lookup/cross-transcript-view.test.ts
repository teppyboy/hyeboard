import { describe, expect, it } from "vitest";
import type { VnuCrossTranscript } from "../api/api";
import { deriveCrossTranscriptInput, deriveCrossTranscriptView, mapCrossTranscriptError } from "./cross-transcript-view";
import { calculateTermAcademicSummaries, newestAcademicTermsFirst } from "../grades/term-academic-summary";

const profile = { internalStudentId: "1000", studentCode: "20000000" };
const transcript: VnuCrossTranscript = {
  header: { studentCode: "20000001", studentName: "Synthetic Student" },
  terms: [{ maHK: "251", rows: [{ courseCode: "SYN9901", courseName: "Reserved Synthetic Course", credits: 3, grade4: 3.5 }] }],
  totals: { gpa4: 3.91 },
};
const derivedTerms = newestAcademicTermsFirst(calculateTermAcademicSummaries(
  transcript.terms.flatMap((term) => term.rows.map((course) => ({
    termKey: term.maHK,
    credits: course.credits,
    point4: course.grade4,
    course,
  }))),
  "vnu",
));

describe("cross-transcript input", () => {
  it("parses a valid internal-ID target and normalizes whitespace", () => {
    expect(deriveCrossTranscriptInput("stdId", " 1001 ", profile)).toEqual({
      input: "1001",
      isValid: true,
      isSelfTarget: false,
      target: { mode: "stdId", stdId: "1001" },
    });
  });

  it("parses a valid student-code target", () => {
    expect(deriveCrossTranscriptInput("stdCode", "20000001", profile)).toEqual({
      input: "20000001",
      isValid: true,
      isSelfTarget: false,
      target: { mode: "stdCode", stdCode: "20000001" },
    });
  });

  it.each([
    ["stdId" as const, "abc"],
    ["stdCode" as const, "1234567"],
  ])("rejects malformed %s input", (mode, input) => {
    expect(deriveCrossTranscriptInput(mode, input, profile)).toMatchObject({ isValid: false, isSelfTarget: false });
  });

  it.each([
    ["stdId" as const, "00000001000"],
    ["stdCode" as const, "20000000"],
  ])("recognizes own %s input", (mode, input) => {
    expect(deriveCrossTranscriptInput(mode, input, profile)).toMatchObject({ isValid: true, isSelfTarget: true });
  });
});

describe("cross-transcript view", () => {
  const validInput = deriveCrossTranscriptInput("stdId", "1001", profile);
  const view = (overrides: Partial<Parameters<typeof deriveCrossTranscriptView>[0]> = {}) => deriveCrossTranscriptView({
    input: validInput,
    submitted: true,
    isLoading: false,
    hasError: false,
    transcript,
    derivedTerms,
    ...overrides,
  });

  it("models prompt, invalid, and ready-to-submit states", () => {
    expect(view({ input: deriveCrossTranscriptInput("stdId", "", profile), submitted: false })).toEqual({ kind: "prompt" });
    expect(view({ input: deriveCrossTranscriptInput("stdId", "abc", profile), submitted: false })).toEqual({ kind: "invalid" });
    expect(view({ submitted: false })).toEqual({ kind: "ready" });
  });

  it("models loading, not-found, no-rows, and success states", () => {
    expect(view({ isLoading: true })).toEqual({ kind: "loading" });
    expect(view({ transcript: { ...transcript, header: {} } })).toEqual({ kind: "notFound" });
    expect(view({ transcript: { ...transcript, terms: [] } })).toEqual({ kind: "noRows" });
    const success = view();
    expect(success.kind).toBe("success");
    if (success.kind !== "success") throw new Error("Expected a successful cross-transcript view");
    expect(success).toEqual({ kind: "success", rowCount: 1, transcript, derivedTerms });
    expect(success.derivedTerms).toBe(derivedTerms);
    expect(success.transcript.totals.gpa4).toBe(3.91);
    expect(success.derivedTerms[0]).toMatchObject({ termGpa4: 3.5, cpa4: 3.5 });
  });

  it("models translated error categories without exposing API messages", () => {
    expect(view({ hasError: true, errorCode: "VNU_RATE_LIMITED" })).toEqual({ kind: "error", errorKind: "rateLimited" });
    expect(view({ hasError: true, errorCode: "VNU_PROBE_BUDGET_UNAVAILABLE" })).toEqual({ kind: "error", errorKind: "temporarilyUnavailable" });
    expect(view({ hasError: true, errorCode: "UNEXPECTED_TECHNICAL_ERROR" })).toEqual({ kind: "error", errorKind: "generic" });
    expect(mapCrossTranscriptError("VNU_CROSS_LOOKUP_NOT_FOUND")).toBe("notFound");
  });
});
