export type EffectiveVnuRuntimeConfig = {
  codeLookupConcurrency: number;
  crossLookupBulkMaxTargets: number;
  crossLookupDirectChunkMaxTargets: number;
  codeLookupBulkTargetConcurrency: number;
  crossLookupRequestTimeoutMs: number;
  crossDetailMaxTargets: number;
  crossDetailMaxRows: number;
  crossDetailConcurrency: number;
  crossDetailBudget: number;
  crossDetailWindowSeconds: number;
  crossDetailPermitTtlSeconds: number;
  crossDetailExportMode: "selected" | undefined;
  crossDetailEnabled: boolean;
};

export type VnuRuntimeConfigInput = {
  codeLookupConcurrency?: string;
  crossLookupBulkMaxTargets?: string;
  crossLookupDirectChunkMaxTargets?: string;
  codeLookupBulkTargetConcurrency?: string;
  crossLookupRequestTimeoutMs?: string;
  crossDetailMaxTargets?: string;
  crossDetailMaxRows?: string;
  crossDetailConcurrency?: string;
  crossDetailBudget?: string;
  crossDetailWindowSeconds?: string;
  crossDetailPermitTtlSeconds?: string;
  crossDetailExportMode?: string;
};

export type VnuConfigWarning = (
  setting:
    | "VNU_CODE_LOOKUP_CONCURRENCY"
    | "VNU_CROSS_LOOKUP_BULK_MAX_TARGETS"
    | "VNU_CROSS_LOOKUP_DIRECT_CHUNK_MAX_TARGETS"
    | "VNU_CODE_LOOKUP_BULK_TARGET_CONCURRENCY"
    | "VNU_CROSS_LOOKUP_REQUEST_TIMEOUT_MS"
    | "VNU_CROSS_DETAIL_MAX_TARGETS"
    | "VNU_CROSS_DETAIL_MAX_ROWS"
    | "VNU_CROSS_DETAIL_CONCURRENCY"
    | "VNU_CROSS_DETAIL_BUDGET"
    | "VNU_CROSS_DETAIL_WINDOW_SECONDS"
    | "VNU_CROSS_DETAIL_PERMIT_TTL_SECONDS"
    | "VNU_CROSS_DETAIL_EXPORT_MODE",
  effectiveFallback: number,
) => void;

const CANONICAL_INTEGER = /^(?:0|[1-9]\d*)$/;

const CROSS_DETAIL_DEFAULTS = {
  maxTargets: 50,
  maxRows: 200,
  concurrency: 6,
  budget: 300,
  windowSeconds: 600,
  permitTtlSeconds: 1200, // 20 min; operator can only lower from this unless parse max (line 92) is raised too
} as const;

function parseSafeInteger(value: string | undefined): number | undefined {
  if (value === undefined || !CANONICAL_INTEGER.test(value)) return undefined;

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

// Cross-detail gate values (max targets/rows, budget, window, TTL) follow the
// crossLookupBulkMaxTargets pattern: a malformed (non-canonical-integer) value
// fails CLOSED to 0, which disables the feature through crossDetailEnabled
// below. Out-of-range-but-valid values fall back to the documented default,
// matching the directChunk/timeout style. A valid explicit 0 is an operator's
// deliberate kill switch.
function parseCrossDetailBound(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  return parseSafeInteger(value) ?? 0;
}

function parseCrossDetailRanged(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  const parsed = parseSafeInteger(value);
  // Cross-detail is an authorization boundary. Any non-default value which
  // cannot be used safely disables it; silently recovering to a permissive
  // default would make an operator typo enable an unexpected capability.
  return parsed !== undefined && parsed >= min && parsed <= max ? parsed : 0;
}

export function parseVnuRuntimeConfig(
  input: VnuRuntimeConfigInput,
  warn?: VnuConfigWarning,
): EffectiveVnuRuntimeConfig {
  const parsedConcurrency =
    input.codeLookupConcurrency === undefined
      ? 16
      : parseSafeInteger(input.codeLookupConcurrency);
  const parsedBulkMaximum =
    input.crossLookupBulkMaxTargets === undefined
      ? 500
      : parseSafeInteger(input.crossLookupBulkMaxTargets);
  const codeLookupConcurrency =
    parsedConcurrency !== undefined && parsedConcurrency > 0
      ? parsedConcurrency
      : 1;
  const crossLookupBulkMaxTargets = parsedBulkMaximum ?? 0;
  const parsedDirectChunkMaximum =
    input.crossLookupDirectChunkMaxTargets === undefined
      ? 32
      : parseSafeInteger(input.crossLookupDirectChunkMaxTargets);
  const crossLookupDirectChunkMaxTargets =
    parsedDirectChunkMaximum !== undefined &&
    parsedDirectChunkMaximum >= 1 &&
    parsedDirectChunkMaximum <= 300
      ? parsedDirectChunkMaximum
      : 32;
  const parsedBulkTargetConcurrency =
    input.codeLookupBulkTargetConcurrency === undefined
      ? 3
      : parseSafeInteger(input.codeLookupBulkTargetConcurrency);
  const codeLookupBulkTargetConcurrency =
    parsedBulkTargetConcurrency !== undefined &&
    parsedBulkTargetConcurrency >= 1 &&
    parsedBulkTargetConcurrency <= 3
      ? parsedBulkTargetConcurrency
      : 3;
  const parsedRequestTimeout =
    input.crossLookupRequestTimeoutMs === undefined
      ? 60_000
      : parseSafeInteger(input.crossLookupRequestTimeoutMs);
  const crossLookupRequestTimeoutMs =
    parsedRequestTimeout !== undefined &&
    parsedRequestTimeout >= 1 &&
    parsedRequestTimeout <= 120_000
      ? parsedRequestTimeout
      : 60_000;

  const crossDetailMaxTargets = parseCrossDetailBound(
    input.crossDetailMaxTargets,
    CROSS_DETAIL_DEFAULTS.maxTargets,
  );
  const crossDetailMaxRows = parseCrossDetailBound(
    input.crossDetailMaxRows,
    CROSS_DETAIL_DEFAULTS.maxRows,
  );
  const crossDetailConcurrency = parseCrossDetailRanged(
    input.crossDetailConcurrency,
    CROSS_DETAIL_DEFAULTS.concurrency,
    1,
    16,
  );
  const crossDetailBudget = parseCrossDetailBound(
    input.crossDetailBudget,
    CROSS_DETAIL_DEFAULTS.budget,
  );
  const crossDetailWindowSeconds = parseCrossDetailRanged(
    input.crossDetailWindowSeconds,
    CROSS_DETAIL_DEFAULTS.windowSeconds,
    1,
    86_400,
  );
  const crossDetailPermitTtlSeconds = parseCrossDetailRanged(
    input.crossDetailPermitTtlSeconds,
    CROSS_DETAIL_DEFAULTS.permitTtlSeconds,
    1,
    1200,
  );
  const crossDetailExportMode =
    input.crossDetailExportMode === undefined ||
    input.crossDetailExportMode === "selected"
      ? ("selected" as const)
      : undefined;
  const crossDetailEnabled =
    crossDetailMaxTargets > 0 &&
    crossDetailMaxRows > 0 &&
    crossDetailConcurrency > 0 &&
    crossDetailBudget > 0 &&
    crossDetailWindowSeconds > 0 &&
    crossDetailPermitTtlSeconds > 0 &&
    crossDetailExportMode === "selected";

  if (
    input.codeLookupConcurrency !== undefined &&
    codeLookupConcurrency === 1 &&
    input.codeLookupConcurrency !== "1"
  ) {
    warn?.("VNU_CODE_LOOKUP_CONCURRENCY", 1);
  }
  if (
    input.crossLookupBulkMaxTargets !== undefined &&
    parsedBulkMaximum === undefined
  ) {
    warn?.("VNU_CROSS_LOOKUP_BULK_MAX_TARGETS", 0);
  }
  if (
    input.crossLookupDirectChunkMaxTargets !== undefined &&
    crossLookupDirectChunkMaxTargets === 32 &&
    input.crossLookupDirectChunkMaxTargets !== "32"
  )
    warn?.("VNU_CROSS_LOOKUP_DIRECT_CHUNK_MAX_TARGETS", 32);
  if (
    input.codeLookupBulkTargetConcurrency !== undefined &&
    codeLookupBulkTargetConcurrency === 3 &&
    input.codeLookupBulkTargetConcurrency !== "3"
  )
    warn?.("VNU_CODE_LOOKUP_BULK_TARGET_CONCURRENCY", 3);
  if (
    input.crossLookupRequestTimeoutMs !== undefined &&
    crossLookupRequestTimeoutMs === 60_000 &&
    input.crossLookupRequestTimeoutMs !== "60000"
  )
    warn?.("VNU_CROSS_LOOKUP_REQUEST_TIMEOUT_MS", 60_000);
  if (
    input.crossDetailMaxTargets !== undefined &&
    parseSafeInteger(input.crossDetailMaxTargets) === undefined
  )
    warn?.("VNU_CROSS_DETAIL_MAX_TARGETS", 0);
  if (
    input.crossDetailMaxRows !== undefined &&
    parseSafeInteger(input.crossDetailMaxRows) === undefined
  )
    warn?.("VNU_CROSS_DETAIL_MAX_ROWS", 0);
  if (
    input.crossDetailConcurrency !== undefined &&
    parseSafeInteger(input.crossDetailConcurrency) === undefined
  )
    warn?.("VNU_CROSS_DETAIL_CONCURRENCY", 0);
  if (
    input.crossDetailBudget !== undefined &&
    parseSafeInteger(input.crossDetailBudget) === undefined
  )
    warn?.("VNU_CROSS_DETAIL_BUDGET", 0);
  if (
    input.crossDetailWindowSeconds !== undefined &&
    parseSafeInteger(input.crossDetailWindowSeconds) === undefined
  )
    warn?.("VNU_CROSS_DETAIL_WINDOW_SECONDS", 0);
  if (
    input.crossDetailPermitTtlSeconds !== undefined &&
    parseSafeInteger(input.crossDetailPermitTtlSeconds) === undefined
  )
    warn?.("VNU_CROSS_DETAIL_PERMIT_TTL_SECONDS", 0);
  if (
    input.crossDetailExportMode !== undefined &&
    crossDetailExportMode === undefined
  )
    warn?.("VNU_CROSS_DETAIL_EXPORT_MODE", 0);

  return {
    codeLookupConcurrency,
    crossLookupBulkMaxTargets,
    crossLookupDirectChunkMaxTargets,
    codeLookupBulkTargetConcurrency,
    crossLookupRequestTimeoutMs,
    crossDetailMaxTargets,
    crossDetailMaxRows,
    crossDetailConcurrency,
    crossDetailBudget,
    crossDetailWindowSeconds,
    crossDetailPermitTtlSeconds,
    crossDetailExportMode,
    crossDetailEnabled,
  };
}

export function normalizeSelfHostedInteger(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return String(value);
  return "";
}
