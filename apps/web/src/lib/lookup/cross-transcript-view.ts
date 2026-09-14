import type { VnuProfile, VnuTranscriptRow } from "@hyeboard/university-adapters/src/vnu/types";
import type { VnuCrossTranscript, VnuCrossTranscriptInput } from "../api/api";
import type { AcademicTermSummary } from "../grades/term-academic-summary";

export type CrossTranscriptInputState = {
  input: string;
  isValid: boolean;
  isSelfTarget: boolean;
  target?: VnuCrossTranscriptInput;
};

export type CrossTranscriptErrorKind = "notFound" | "rateLimited" | "temporarilyUnavailable" | "generic";

export type CrossTranscriptView =
  | { kind: "prompt" | "ready" | "invalid" | "selfTarget" | "loading" | "notFound" | "noRows" }
  | { kind: "error"; errorKind: CrossTranscriptErrorKind }
  | { kind: "success"; transcript: VnuCrossTranscript; rowCount: number; derivedTerms: AcademicTermSummary<VnuTranscriptRow>[] };

export function deriveCrossTranscriptInput(
  mode: VnuCrossTranscriptInput["mode"],
  rawInput: string,
  profile: Pick<VnuProfile, "internalStudentId" | "studentCode">,
): CrossTranscriptInputState {
  const input = rawInput.trim();
  const isValid = mode === "stdId" ? /^\d{1,11}$/.test(input) : /^\d{8}$/.test(input);
  if (!isValid) return { input, isValid: false, isSelfTarget: false };

  const isSelfTarget = mode === "stdId"
    ? Number(input) === Number(profile.internalStudentId)
    : input === profile.studentCode;
  if (isSelfTarget) return { input, isValid: true, isSelfTarget: true };

  const target = mode === "stdId" ? { mode, stdId: input } : { mode, stdCode: input };
  return { input, isValid: true, isSelfTarget: false, target };
}

export function mapCrossTranscriptError(code: string | undefined): CrossTranscriptErrorKind {
  if (code === "VNU_CROSS_LOOKUP_NOT_FOUND" || code === "VNU_CROSS_LOOKUP_NOT_CONVERGED") return "notFound";
  if (code === "VNU_RATE_LIMITED") return "rateLimited";
  if (code === "VNU_PROBE_BUDGET_UNAVAILABLE") return "temporarilyUnavailable";
  return "generic";
}

export function deriveCrossTranscriptView(options: {
  input: CrossTranscriptInputState;
  submitted: boolean;
  isLoading: boolean;
  errorCode?: string;
  hasError: boolean;
  transcript?: VnuCrossTranscript;
  derivedTerms: AcademicTermSummary<VnuTranscriptRow>[];
}): CrossTranscriptView {
  const { input, submitted, isLoading, errorCode, hasError, transcript, derivedTerms } = options;
  if (!input.input) return { kind: "prompt" };
  if (!input.isValid) return { kind: "invalid" };
  if (input.isSelfTarget) return { kind: "selfTarget" };
  if (!submitted) return { kind: "ready" };
  if (isLoading) return { kind: "loading" };
  if (hasError) {
    const errorKind = mapCrossTranscriptError(errorCode);
    return errorKind === "notFound" ? { kind: "notFound" } : { kind: "error", errorKind };
  }
  if (!transcript?.header.studentCode) return { kind: "notFound" };

  const rowCount = transcript.terms.reduce((count, term) => count + term.rows.length, 0);
  if (rowCount === 0) return { kind: "noRows" };
  return { kind: "success", transcript, rowCount, derivedTerms };
}
