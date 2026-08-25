import { z } from "zod";
import { capabilityKeySchema } from "./capabilities";
import type { University } from "./index";

export const operationalLimitKeys = [
  "crossLookup.bulkMaxTargets",
  "crossLookup.bulkDirectChunkMaxTargets",
  "crossLookup.bulkModeMaxTargets.stdid-to-code",
  "crossLookup.bulkModeMaxTargets.stdid-to-transcript",
  "crossLookup.bulkModeMaxTargets.code-to-stdid",
  "crossLookup.crossDetail.maxTargets",
  "crossLookup.crossDetail.maxRows",
  "crossLookup.crossDetail.concurrency",
] as const;

export const operationalLimitKeySchema = z.enum(operationalLimitKeys);

export const adminActorSchema = z.object({
  method: z.enum(["password", "github", "discord"]),
  subject: z.string().min(1).max(128),
  label: z.string().min(1).max(128).optional(),
}).strict();

const globalCapabilitySchema = z.object({ enabled: z.boolean() }).strict();
const universityCapabilitySchema = z.object({ enabled: z.literal(false) }).strict();
const positiveLimitSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const featurePolicyContentSchema = z.object({
  global: z.object({
    capabilities: z.partialRecord(capabilityKeySchema, globalCapabilitySchema),
    limits: z.partialRecord(operationalLimitKeySchema, positiveLimitSchema.nullable()),
  }).strict(),
  universities: z.record(z.string().min(1), z.object({
    capabilities: z.partialRecord(capabilityKeySchema, universityCapabilitySchema),
    limits: z.partialRecord(operationalLimitKeySchema, positiveLimitSchema),
  }).strict()),
}).strict();

export const featurePolicySnapshotSchema = featurePolicyContentSchema.extend({
  revision: z.number().int().nonnegative(),
}).strict();

export const featurePolicyAuditEntrySchema = z.object({
  revision: z.number().int().positive(),
  baseRevision: z.number().int().nonnegative(),
  actor: adminActorSchema,
  reason: z.string().trim().min(1).max(500),
  publishedAt: z.iso.datetime(),
  snapshot: featurePolicySnapshotSchema,
}).strict();

export const publishFeaturePolicySchema = z.object({
  baseRevision: z.number().int().nonnegative(),
  policy: featurePolicyContentSchema,
  reason: z.string().trim().min(1).max(500),
}).strict();

export const rollbackFeaturePolicySchema = z.object({
  baseRevision: z.number().int().nonnegative(),
  targetRevision: z.number().int().positive(),
  reason: z.string().trim().min(1).max(500),
}).strict();

export const adminSessionStatusSchema = z.object({
  authenticated: z.boolean(),
  actor: adminActorSchema.optional(),
  csrfToken: z.string().min(1).optional(),
  methods: z.array(z.enum(["password", "github", "discord"])),
}).strict();

export type OperationalLimitKey = z.infer<typeof operationalLimitKeySchema>;
export type AdminActor = z.infer<typeof adminActorSchema>;
export type FeaturePolicyContent = z.infer<typeof featurePolicyContentSchema>;
export type FeaturePolicySnapshot = z.infer<typeof featurePolicySnapshotSchema>;
export type FeaturePolicyAuditEntry = z.infer<typeof featurePolicyAuditEntrySchema>;
export type PublishFeaturePolicyInput = z.infer<typeof publishFeaturePolicySchema>;
export type RollbackFeaturePolicyInput = z.infer<typeof rollbackFeaturePolicySchema>;
export type AdminSessionStatus = z.infer<typeof adminSessionStatusSchema>;

export type AdminPolicyView = {
  snapshot: FeaturePolicySnapshot;
  nativeUniversities: University[];
  effectiveUniversities: University[];
  hardLimits: Partial<Record<OperationalLimitKey, number>>;
};
