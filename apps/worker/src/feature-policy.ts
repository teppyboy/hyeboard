import { HyeboardError } from "@hyeboard/core";
import {
  featurePolicyContentSchema,
  operationalLimitKeys,
  type CapabilityKey,
  type DashboardSummary,
  type FeaturePolicyContent,
  type OperationalLimitKey,
  type University,
  type UniversityCapabilities,
} from "@hyeboard/schemas";

export type EffectiveCapability = {
  enabled: boolean;
  locked: boolean;
  source: "adapter" | "global" | "university";
};

export type EffectiveLimit = {
  value: number;
  configured: number | null;
  source: "native" | "global" | "university";
  clamped: boolean;
};

type HardLimits = Readonly<Partial<Record<OperationalLimitKey, number>>>;

export function emptyPolicy(): FeaturePolicyContent {
  return { global: { capabilities: {}, limits: {} }, universities: {} };
}

export function resolveCapability(
  adapterSupported: boolean,
  policy: FeaturePolicyContent,
  universityId: string,
  capability: CapabilityKey,
): EffectiveCapability {
  if (!adapterSupported) return { enabled: false, locked: true, source: "adapter" };
  if (policy.global.capabilities[capability]?.enabled === false) return { enabled: false, locked: false, source: "global" };
  if (policy.universities[universityId]?.capabilities[capability]?.enabled === false) {
    return { enabled: false, locked: false, source: "university" };
  }
  return { enabled: true, locked: false, source: "adapter" };
}

export function resolveLimit(
  policy: FeaturePolicyContent,
  universityId: string,
  key: OperationalLimitKey,
  hardCeiling: number,
): EffectiveLimit {
  if (!isSafeCeiling(hardCeiling)) invalidPolicy(`hardLimits.${key}`);
  const university = policy.universities[universityId]?.limits[key];
  const global = policy.global.limits[key];
  if (university !== undefined && !isSafeLimit(university)) invalidPolicy(`universities.${safeSegment(universityId)}.limits.${key}`);
  if (global !== undefined && global !== null && !isSafeLimit(global)) invalidPolicy(`global.limits.${key}`);
  const configured = university ?? global ?? null;
  const source = university === undefined ? global === undefined ? "native" : "global" : "university";
  return {
    value: configured === null ? hardCeiling : Math.min(configured, hardCeiling),
    configured,
    source,
    clamped: configured !== null && configured > hardCeiling,
  };
}

export function validatePolicy(
  policy: FeaturePolicyContent,
  universities: readonly University[],
  hardLimits: HardLimits,
): FeaturePolicyContent {
  const parsed = featurePolicyContentSchema.safeParse(policy);
  if (!parsed.success) invalidPolicy(formatPath(parsed.error.issues[0]?.path));

  const knownUniversities = new Set(universities.map(({ id }) => id));
  for (const universityId of Object.keys(parsed.data.universities)) {
    if (!knownUniversities.has(universityId)) invalidPolicy(`universities.${safeSegment(universityId)}`);
  }
  validateHardLimits(hardLimits);
  return parsed.data;
}

export function effectiveUniversity(
  university: University,
  policy: FeaturePolicyContent,
  hardLimits: HardLimits,
): University {
  validateHardLimits(hardLimits);
  const capabilities = Object.fromEntries(
    Object.entries(university.capabilities).map(([key, supported]) => [
      key,
      resolveCapability(supported, policy, university.id, key as CapabilityKey).enabled,
    ]),
  ) as UniversityCapabilities;

  const nativeLimits = flattenLimits(university);
  const projectedLimits: Partial<Record<OperationalLimitKey, number>> = {};
  for (const key of operationalLimitKeys) {
    const ceilings = [nativeLimits[key], hardLimits[key]].filter(isSafeCeiling);
    if (ceilings.length === 0) continue;
    const ceiling = Math.min(...ceilings);
    if (ceiling === 0) continue;
    projectedLimits[key] = resolveLimit(policy, university.id, key, ceiling).value;
  }

  const bulkMaxTargets = projectedLimits["crossLookup.bulkMaxTargets"];
  if (!Number.isFinite(bulkMaxTargets)) capabilities.crossLookup = false;

  return {
    ...university,
    capabilities,
    limits: capabilities.crossLookup && bulkMaxTargets !== undefined
      ? projectLimits(projectedLimits)
      : undefined,
  };
}

export function filterDashboardSummary(
  dashboard: DashboardSummary,
  capabilities: UniversityCapabilities,
): DashboardSummary {
  return {
    ...dashboard,
    student: capabilities.profile ? dashboard.student : undefined,
    currentTerm: capabilities.terms ? dashboard.currentTerm : undefined,
    courseCount: capabilities.courses ? dashboard.courseCount : undefined,
    nextClass: capabilities.timetable ? dashboard.nextClass : undefined,
    todaySchedule: capabilities.timetable ? dashboard.todaySchedule : [],
    courses: capabilities.courses ? dashboard.courses : [],
    assignments: capabilities.assignments ? dashboard.assignments : [],
    grades: capabilities.grades ? dashboard.grades : [],
    gpa: capabilities.grades ? dashboard.gpa : undefined,
    exams: capabilities.exams ? dashboard.exams : [],
    tuition: capabilities.tuition ? dashboard.tuition : undefined,
    notifications: capabilities.notifications ? dashboard.notifications : [],
  };
}

function flattenLimits(university: University): Partial<Record<OperationalLimitKey, number>> {
  const crossLookup = university.limits?.crossLookup;
  if (!crossLookup) return {};
  return {
    "crossLookup.bulkMaxTargets": crossLookup.bulkMaxTargets,
    "crossLookup.bulkDirectChunkMaxTargets": crossLookup.bulkDirectChunkMaxTargets,
    "crossLookup.bulkModeMaxTargets.stdid-to-code": crossLookup.bulkModeMaxTargets?.["stdid-to-code"],
    "crossLookup.bulkModeMaxTargets.stdid-to-transcript": crossLookup.bulkModeMaxTargets?.["stdid-to-transcript"],
    "crossLookup.bulkModeMaxTargets.code-to-stdid": crossLookup.bulkModeMaxTargets?.["code-to-stdid"],
    "crossLookup.crossDetail.maxTargets": crossLookup.crossDetail?.maxTargets,
    "crossLookup.crossDetail.maxRows": crossLookup.crossDetail?.maxRows,
    "crossLookup.crossDetail.concurrency": crossLookup.crossDetail?.concurrency,
  };
}

function projectLimits(limits: Partial<Record<OperationalLimitKey, number>>): University["limits"] {
  const bulkMaxTargets = limits["crossLookup.bulkMaxTargets"];
  if (bulkMaxTargets === undefined) return undefined;
  const bulkDirectChunkMaxTargets = limits["crossLookup.bulkDirectChunkMaxTargets"];
  const bulkModeMaxTargets = Object.fromEntries([
    ["stdid-to-code", limits["crossLookup.bulkModeMaxTargets.stdid-to-code"]],
    ["stdid-to-transcript", limits["crossLookup.bulkModeMaxTargets.stdid-to-transcript"]],
    ["code-to-stdid", limits["crossLookup.bulkModeMaxTargets.code-to-stdid"]],
  ].filter((entry): entry is [string, number] => entry[1] !== undefined));
  const maxTargets = limits["crossLookup.crossDetail.maxTargets"];
  const maxRows = limits["crossLookup.crossDetail.maxRows"];
  const concurrency = limits["crossLookup.crossDetail.concurrency"];
  return {
    crossLookup: {
      bulkMaxTargets,
      ...(bulkDirectChunkMaxTargets === undefined ? {} : { bulkDirectChunkMaxTargets }),
      ...(Object.keys(bulkModeMaxTargets).length === 0 ? {} : { bulkModeMaxTargets }),
      ...(maxTargets === undefined || maxRows === undefined || concurrency === undefined
        ? {}
        : { crossDetail: { maxTargets, maxRows, concurrency } }),
    },
  };
}

function validateHardLimits(hardLimits: HardLimits): void {
  for (const key of Object.keys(hardLimits)) {
    if (!(operationalLimitKeys as readonly string[]).includes(key)) invalidPolicy(`hardLimits.${safeSegment(key)}`);
    if (!isSafeCeiling(hardLimits[key as OperationalLimitKey])) invalidPolicy(`hardLimits.${key}`);
  }
}

function isSafeLimit(value: unknown): value is number {
  return isSafeCeiling(value) && value > 0;
}

function isSafeCeiling(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function formatPath(path: PropertyKey[] | undefined): string {
  if (!path?.length) return "$";
  return path.map((segment) => safeSegment(String(segment))).join(".").slice(0, 256);
}

function safeSegment(segment: string): string {
  if ((operationalLimitKeys as readonly string[]).includes(segment)) return segment;
  return /^[A-Za-z0-9_-]+$/.test(segment) ? segment.slice(0, 64) : "?";
}

function invalidPolicy(path: string): never {
  throw new HyeboardError("ADMIN_POLICY_INVALID", "Feature policy is invalid.", 400, { path });
}
