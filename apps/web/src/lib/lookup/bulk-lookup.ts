import type { VnuBulkLookupItem, VnuBulkLookupMode, VnuCrossStudentCode, VnuCrossStudentId, VnuCrossTranscript } from "../api/api";
import { ApiError } from "../api/api";
import { VNU_REQUEST_NOT_REPLAYED } from "../session/vnu-refresh";

export type BulkTargetError = "disabled" | "empty" | "tooMany";

export type ParsedBulkTargets = {
  targets: string[];
  error?: BulkTargetError;
};

export type BulkLookupProgress = {
  processed: number;
  total: number;
  items: VnuBulkLookupItem[];
};

export type BulkLookupViewState = "empty" | "validation" | "loading" | "completed";

export type BulkLookupExecution = {
  progress: BulkLookupProgress;
  remainingTargets: string[];
  error?: unknown;
  aborted: boolean;
  restoredWithoutReplay: boolean;
};

export type ExecuteBulkLookupOptions = {
  mode: VnuBulkLookupMode;
  targets: readonly string[];
  signal: AbortSignal;
  initialProgress?: BulkLookupProgress;
  modeMaxTargets?: Partial<Record<VnuBulkLookupMode, number>>;
  directChunkMaxTargets?: number;
  requestChunk: (mode: VnuBulkLookupMode, targets: string[], signal: AbortSignal) => Promise<VnuBulkLookupItem[]>;
  onProgress?: (progress: BulkLookupProgress) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("Invalid bulk lookup response");
  return value;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid bulk lookup response");
  return value;
}

function parseStudentCodeResult(value: unknown): VnuCrossStudentCode {
  if (!isRecord(value) || typeof value.studentCode !== "string") throw new Error("Invalid bulk lookup response");
  return {
    studentCode: value.studentCode,
    studentName: optionalString(value.studentName),
    className: optionalString(value.className),
  };
}

function parseStudentIdResult(value: unknown): VnuCrossStudentId {
  if (!isRecord(value) || typeof value.stdCode !== "string" || typeof value.stdId !== "string" || typeof value.probes !== "number" || !Number.isFinite(value.probes)) {
    throw new Error("Invalid bulk lookup response");
  }
  return { stdCode: value.stdCode, stdId: value.stdId, probes: value.probes };
}

function parseTranscriptResult(value: unknown): VnuCrossTranscript {
  if (!isRecord(value) || !isRecord(value.header) || typeof value.header.studentCode !== "string" || !isRecord(value.totals) || !Array.isArray(value.terms)) {
    throw new Error("Invalid bulk lookup response");
  }
  const header = {
    studentCode: value.header.studentCode,
    studentName: optionalString(value.header.studentName),
    className: optionalString(value.header.className),
  };
  const totals = {
    totalCredits: optionalFiniteNumber(value.totals.totalCredits),
    accumulatedCredits: optionalFiniteNumber(value.totals.accumulatedCredits),
    gpa4: optionalFiniteNumber(value.totals.gpa4),
  };
  const terms = value.terms.map((term) => {
    if (!isRecord(term) || typeof term.maHK !== "string" || !Array.isArray(term.rows)) throw new Error("Invalid bulk lookup response");
    return {
      maHK: term.maHK,
      rows: term.rows.map((row) => {
        if (!isRecord(row) || typeof row.courseCode !== "string" || typeof row.courseName !== "string") throw new Error("Invalid bulk lookup response");
        return {
          courseCode: row.courseCode,
          courseName: row.courseName,
          credits: optionalFiniteNumber(row.credits),
          grade10: optionalFiniteNumber(row.grade10),
          letterGrade: optionalString(row.letterGrade),
          grade4: optionalFiniteNumber(row.grade4),
          classId: optionalString(row.classId),
          termOrdinal: optionalString(row.termOrdinal),
        };
      }),
    };
  });
  return { header, totals, terms };
}

export function parseBulkLookupItems(mode: VnuBulkLookupMode, value: unknown): VnuBulkLookupItem[] {
  if (!Array.isArray(value)) throw new Error("Invalid bulk lookup response");
  return value.map((item) => {
    if (!isRecord(item) || typeof item.target !== "string") throw new Error("Invalid bulk lookup response");
    if (item.status === "error") {
      if (typeof item.errorCode !== "string") throw new Error("Invalid bulk lookup response");
      return { target: item.target, status: "error", errorCode: item.errorCode };
    }
    if (item.status !== "ok") throw new Error("Invalid bulk lookup response");
    const result = mode === "stdid-to-code"
      ? parseStudentCodeResult(item.result)
      : mode === "code-to-stdid"
        ? parseStudentIdResult(item.result)
        : parseTranscriptResult(item.result);
    return { target: item.target, status: "ok", result };
  });
}

export function parseBulkLookupMode(value: string): VnuBulkLookupMode {
  if (value === "stdid-to-code" || value === "code-to-stdid" || value === "stdid-to-transcript") return value;
  throw new Error("Invalid bulk lookup mode");
}

export function parseBulkTargets(raw: string, bulkMaxTargets?: number): ParsedBulkTargets {
  const targets = [...new Set(raw.split(/\r?\n/).map((target) => target.trim()).filter(Boolean))];
  if (!Number.isSafeInteger(bulkMaxTargets) || bulkMaxTargets! <= 0) return { targets, error: "disabled" };
  if (targets.length === 0) return { targets, error: "empty" };
  if (targets.length > bulkMaxTargets!) return { targets, error: "tooMany" };
  return { targets };
}

function validChunkMaximum(value: number | undefined): number | undefined {
  return Number.isSafeInteger(value) && value! > 0 ? value : undefined;
}

export function chunkBulkTargets(
  mode: VnuBulkLookupMode,
  targets: readonly string[],
  directChunkMaxTargets?: number,
): string[][] {
  const size = mode === "code-to-stdid" ? 3 : validChunkMaximum(directChunkMaxTargets) ?? 5;
  const chunks: string[][] = [];
  for (let index = 0; index < targets.length; index += size) chunks.push(targets.slice(index, index + size));
  return chunks;
}

export function appendBulkLookupChunk(progress: BulkLookupProgress, items: VnuBulkLookupItem[]): BulkLookupProgress {
  const combinedItems = [...progress.items, ...items];
  return { ...progress, processed: Math.min(progress.total, combinedItems.length), items: combinedItems };
}

export async function executeBulkLookup(options: ExecuteBulkLookupOptions): Promise<BulkLookupExecution> {
  const initialProgress = options.initialProgress ?? { processed: 0, total: options.targets.length, items: [] };
  const accumulatedItems = [...initialProgress.items];
  let progress = { ...initialProgress, items: accumulatedItems };
  let completedTargets = 0;

  for (const chunk of chunkBulkTargets(options.mode, options.targets, options.directChunkMaxTargets)) {
    if (options.signal.aborted) return { progress, remainingTargets: options.targets.slice(completedTargets), aborted: true, restoredWithoutReplay: false };

    let items: VnuBulkLookupItem[];
    try {
      items = await options.requestChunk(options.mode, chunk, options.signal);
    } catch (error) {
      const aborted = options.signal.aborted;
      const restoredWithoutReplay = !aborted && error instanceof ApiError && error.code === VNU_REQUEST_NOT_REPLAYED;
      return {
        progress,
        remainingTargets: options.targets.slice(completedTargets),
        error: aborted || restoredWithoutReplay ? undefined : error,
        aborted,
        restoredWithoutReplay,
      };
    }

    if (options.signal.aborted) return { progress, remainingTargets: options.targets.slice(completedTargets), aborted: true, restoredWithoutReplay: false };
    const targetsMatch = items.length === chunk.length && items.every((item, index) => item.target === chunk[index]);
    if (!targetsMatch) {
      return {
        progress,
        remainingTargets: options.targets.slice(completedTargets),
        error: new Error("Invalid bulk lookup response"),
        aborted: false,
        restoredWithoutReplay: false,
      };
    }

    accumulatedItems.push(...items);
    progress = { ...progress, processed: Math.min(progress.total, accumulatedItems.length) };
    completedTargets += chunk.length;
    // Progress wrappers are snapshots; their items array is a live read-only
    // accumulator for this execution and retains identity across callbacks.
    options.onProgress?.(progress);
  }

  return { progress, remainingTargets: [], aborted: false, restoredWithoutReplay: false };
}

export function deriveBulkLookupViewState(input: ParsedBulkTargets, active: boolean, processed: number): BulkLookupViewState {
  if (active) return "loading";
  if (input.error === "empty" && processed === 0) return "empty";
  if (input.error) return "validation";
  return processed > 0 ? "completed" : "empty";
}
