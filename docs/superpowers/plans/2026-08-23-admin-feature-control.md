# Admin Feature Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a separate, authenticated admin control room that atomically publishes global feature policy and university overrides, enforces effective policy in the API, propagates revisions to clients, and retains rollback history in every supported runtime.

**Architecture:** Shared Zod contracts and a pure resolver define policy semantics. The Worker injects one `FeaturePolicyStore`: Cloudflare Durable Object SQLite, PostgreSQL in distributed mode, local SQLite in Node/Bun memory mode. API enforcement is authoritative; SSE revision events only accelerate client refresh.

**Tech Stack:** TypeScript 7, Zod 4, Elysia, Web Crypto, Cloudflare Durable Objects/SQLite, Node `node:sqlite`, Bun `bun:sqlite`, PostgreSQL, Redis Pub/Sub, React 19, TanStack Router/Query, Tailwind CSS v4, local shadcn-style primitives, Vitest, Playwright.

**Commit policy:** Do not create commits unless the user explicitly requests them. Each task ends with a diff checkpoint instead.

---

## File structure

### Shared contracts

- Create `packages/schemas/src/capabilities.ts` — one capability-key tuple and schema shared by university and policy contracts.
- Create `packages/schemas/src/feature-policy.ts` — closed limit catalog, snapshots, actors, audit entries, admin API payload schemas.
- Modify `packages/schemas/src/index.ts` — import/re-export shared capability and policy contracts.

### Worker policy core

- Create `apps/worker/src/feature-policy.ts` — pure resolution, validation, dashboard filtering, route capability map.
- Create `apps/worker/src/feature-policy.test.ts` — policy precedence, hard ceilings, dashboard projection.
- Create `apps/worker/src/feature-policy-store.ts` — store contract, conflict error, initial revision, last-known-good runtime cache, revision broadcaster.
- Create `apps/worker/src/feature-policy-store.test.ts` — shared store/runtime contract tests.

### Runtime stores

- Create `apps/worker/src/node/sqlite/feature-policy-store.ts` — local Node/Bun SQLite authority.
- Create `apps/worker/src/node/sqlite/bun-sqlite.d.ts` — minimal compile-time shape for the runtime-native Bun module.
- Create `apps/worker/src/node/sqlite/feature-policy-store.test.ts` — temporary-file persistence and CAS tests.
- Create `apps/worker/src/node/postgres/feature-policy-store.ts` — distributed PostgreSQL authority.
- Modify `apps/worker/src/node/postgres/index.ts` — export store.
- Create `apps/worker/migrations/003_feature_policy.sql` — current revision and immutable history tables.
- Modify `apps/worker/src/node/postgres/postgres.test.ts` — transaction/CAS/migration checks.
- Create `apps/worker/src/feature-policy-durable-object.ts` — Cloudflare SQLite authority.
- Create `apps/worker/src/feature-policy-cloudflare.ts` — focused Durable Object coordinator.
- Modify `apps/worker/src/index.ts` — install/export Durable Object policy store.
- Modify `apps/worker/wrangler.jsonc` — binding and migration tag.
- Modify `apps/worker/test/captcha-relay-worker.ts` — export new Durable Object in Workers tests.
- Modify `apps/worker/vitest.workers.config.ts` — bind test Durable Object.
- Create `apps/worker/test/feature-policy.workers.ts` — Cloudflare store contract.
- Create `apps/worker/src/node/redis/feature-policy-events.ts` — Redis revision publisher/subscriber.
- Modify `apps/worker/src/node/redis/client.ts` — narrow Pub/Sub client interfaces.
- Modify `apps/worker/src/node/redis/index.ts` — export revision events.
- Modify `apps/worker/src/node/redis/redis.test.ts` — invalidation tests.

### Admin authentication and API

- Create `apps/worker/src/admin-config.ts` — strict admin runtime configuration parsing and enabled-method projection.
- Create `apps/worker/src/admin-config.test.ts` — secret lengths, OAuth pairs, IDs, origins, lifetimes, local DB path.
- Create `apps/worker/src/admin-auth.ts` — encrypted admin sessions, cookies, CSRF, password hash verification, OAuth state/PKCE, numeric-ID allowlists.
- Create `apps/worker/src/admin-auth.test.ts` — password, cookie, CSRF, OAuth state tests.
- Create `apps/worker/scripts/hash-admin-password.ts` — masked interactive PBKDF2 hash generator using the tested auth helper.
- Create `apps/worker/src/admin-routes.ts` — session, password, OAuth, policy, history, publish, rollback, SSE endpoints.
- Create `apps/worker/src/admin-routes.test.ts` — endpoint-level auth and publication tests.
- Modify `apps/worker/src/app.ts` — runtime config, injected policy runtime, route registration, effective policy guards.
- Modify `apps/worker/src/app.test.ts` — feature rejection, dashboard filtering, session-scope regression.
- Modify `apps/worker/src/university-capabilities.test.ts` — effective capability/limit serialization.
- Modify `packages/university-adapters/src/types.ts` — pass an effective dashboard capability projection through the adapter boundary.
- Modify `packages/university-adapters/src/mock/adapter.ts`, `uet/adapter.ts`, and `vnu/adapter.ts` — skip disabled dashboard upstream work.
- Modify focused adapter tests — prove disabled dashboard capabilities do not call upstream clients.
- Modify `apps/worker/src/start.ts` — initialize local SQLite or PostgreSQL + Redis authority honestly.
- Modify `apps/worker/src/ha-lifecycle.test.ts` — distributed policy dependency readiness.
- Modify `apps/worker/package.json` — no new runtime package unless implementation proves native SQLite unavailable.
- Modify `apps/worker/scripts/build-node.mjs` — externalize `node:sqlite`/`bun:sqlite` only if Rolldown requires it.

### Web client and admin UI

- Create `apps/web/src/lib/admin-api.ts` — credentialed admin HTTP client and policy event stream.
- Create `apps/web/src/lib/admin-api.test.ts` — request credentials, CSRF, error parsing.
- Create `apps/web/src/lib/policy-events.ts` — student revision SSE/polling invalidation helper.
- Create `apps/web/src/lib/policy-events.test.ts` — reconnect and invalidation behavior.
- Create `apps/web/src/components/ui/switch.tsx` — local accessible switch; no new UI dependency.
- Create `apps/web/src/components/ui/dialog.tsx` — thin wrapper over already-installed Radix Dialog.
- Create `apps/web/src/components/admin/admin-layout.tsx` — separate responsive admin shell.
- Create `apps/web/src/components/admin/policy-editor.tsx` — searchable flat capability rows and staged edits.
- Create `apps/web/src/components/admin/publish-dialog.tsx` — diff, reason, publish/conflict states.
- Create `apps/web/src/components/admin/policy-history.tsx` — bounded history and rollback flow.
- Create `apps/web/src/components/admin/admin-components.test.tsx` — static/accessibility/state helpers.
- Create `apps/web/src/pages/admin-login.tsx` — password and OAuth login.
- Create `apps/web/src/pages/admin-control.tsx` — control room.
- Create `apps/web/src/pages/admin-history.tsx` — history page.
- Create `apps/web/src/pages/admin-auth.tsx` — identity/logout page.
- Modify `apps/web/src/router.tsx` — separate lazy `/admin` tree.
- Modify `apps/web/src/state.tsx` — student policy subscription and focused invalidation.
- Modify `apps/web/src/state.test.tsx` — policy revision invalidation.
- Modify `apps/web/src/pages/dashboard.tsx` — render only sections backed by effective capabilities.
- Modify `apps/web/src/components/layout.tsx` — fail closed while effective capability metadata is unavailable.
- Modify `apps/web/src/lib/i18n.tsx` — all English/Vietnamese admin strings.
- Modify `apps/web/src/styles.css` — admin shell/token-consistent responsive rules only.
- Create `apps/web/tests/admin-feature-control.spec.ts` — login, stage, publish, propagation, rollback, mobile accessibility.

### Configuration and durable documentation

- Create `apps/worker/scripts/hash-admin-password.ts` — masked interactive password-hash generator.
- Modify `apps/worker/package.json` — expose `admin:hash-password` script.
- Modify `apps/worker/.env.example` — admin session/password/OAuth/local DB configuration.
- Modify `apps/worker/config.json` — non-secret local DB/session lifetime defaults only.
- Modify `compose.env.example` — distributed admin secrets/placeholders.
- Modify `deploy/k8s/base/api-deployment.yaml` — env references and memory-mode local data path where applicable.
- Modify `deploy/k8s/base/secret.example.yaml` — secret key names with fake placeholders.
- Modify `deploy/helm/hyeboard/values.yaml` — non-secret admin defaults.
- Modify `deploy/helm/hyeboard/values.schema.json` — validate new values.
- Modify `deploy/helm/hyeboard/templates/api-deployment.yaml` — wire values/secret refs.
- Modify `deploy/helm/hyeboard/templates/secret-example.yaml` if present; otherwise document externally without creating a chart-managed real Secret.
- Modify `README.md` — setup and callback URLs.
- Modify `docs/architecture.md` — control-plane authority and enforcement.
- Modify `docs/ha-runbook.md` — rollout, readiness, rollback, outage behavior.
- Modify `scripts/package-config.test.mjs` — packaged config/migration checks.
- Modify `scripts/validate-k8s.mjs` and `scripts/validate-helm.mjs` only where existing assertions require the new settings.

---

## Task 1: Add shared policy contracts

**Files:**

- Create: `packages/schemas/src/capabilities.ts`
- Create: `packages/schemas/src/feature-policy.ts`
- Modify: `packages/schemas/src/index.ts`
- Test through: `pnpm --filter @hyeboard/schemas typecheck`

- [ ] **Step 1: Define one closed capability catalog without an index-module cycle**

Create `packages/schemas/src/capabilities.ts`:

```ts
import { z } from "zod";

export const capabilityKeys = [
  "profile", "terms", "timetable", "courses", "assignments", "grades",
  "exams", "attendance", "notifications", "documents", "tuition", "news",
  "trainingPoints", "requests", "classLookup", "crossLookup",
] as const;

export const capabilityKeySchema = z.enum(capabilityKeys);
export type CapabilityKey = z.infer<typeof capabilityKeySchema>;
```

Modify `packages/schemas/src/index.ts` so `universityCapabilitiesSchema` is built from `capabilityKeys` once:

```ts
import { capabilityKeys } from "./capabilities";

export const universityCapabilitiesSchema = z.object(
  Object.fromEntries(capabilityKeys.map((key) => [key, z.boolean()])) as {
    [K in (typeof capabilityKeys)[number]]: z.ZodBoolean;
  },
);
```

Export `./capabilities` from `index.ts`. `feature-policy.ts` imports `./capabilities`, never `./index`, so no runtime cycle exists.

- [ ] **Step 2: Define the closed operational-limit catalog**

```ts
import { z } from "zod";
import { capabilityKeySchema } from "./capabilities";

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
```

- [ ] **Step 3: Define strict policy and admin payload schemas**

```ts
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

export type AdminPolicyView = {
  snapshot: FeaturePolicySnapshot;
  nativeUniversities: University[];
  effectiveUniversities: University[];
  hardLimits: Partial<Record<OperationalLimitKey, number>>;
};
```

Use `import type { University } from "./index"` for this erased type reference only. Do not import `universitySchema` at runtime from `feature-policy.ts`; that would recreate the index-module cycle.

Extend existing `apiErrorDetailsSchema` in `index.ts` with optional typed control-plane fields so the strict response parser does not erase useful errors:

```ts
capability: capabilityKeySchema.optional(),
currentRevision: z.number().int().nonnegative().optional(),
targetRevision: z.number().int().positive().optional(),
path: z.string().max(256).optional(),
```

- [ ] **Step 4: Export inferred types and module exports**

```ts
export type OperationalLimitKey = z.infer<typeof operationalLimitKeySchema>;
export type AdminActor = z.infer<typeof adminActorSchema>;
export type FeaturePolicyContent = z.infer<typeof featurePolicyContentSchema>;
export type FeaturePolicySnapshot = z.infer<typeof featurePolicySnapshotSchema>;
export type FeaturePolicyAuditEntry = z.infer<typeof featurePolicyAuditEntrySchema>;
```

Append to `packages/schemas/src/index.ts`:

```ts
export * from "./capabilities";
export * from "./feature-policy";
```

- [ ] **Step 5: Verify contracts**

Run: `pnpm --filter @hyeboard/schemas typecheck`

Expected: exit 0. Add a worker-side schema regression in Task 2 proving omitted keys are accepted and unknown keys are rejected; `z.partialRecord` is required because Zod 4 `z.record(z.enum(...), ...)` requires every enum key.

- [ ] **Step 6: Diff checkpoint**

Run: `git diff --check -- packages/schemas`

Expected: no output.

---

## Task 2: Implement pure policy resolution

**Files:**

- Create: `apps/worker/src/feature-policy.ts`
- Create: `apps/worker/src/feature-policy.test.ts`

- [ ] **Step 1: Write failing precedence tests**

```ts
import { describe, expect, it } from "vitest";
import { emptyPolicy, resolveCapability, resolveLimit } from "./feature-policy";

it("keeps unsupported adapter capabilities locked off", () => {
  expect(resolveCapability(false, emptyPolicy(), "vnu", "assignments"))
    .toEqual({ enabled: false, locked: true, source: "adapter" });
});

it("lets the global kill switch win over every override", () => {
  const policy = emptyPolicy();
  policy.global.capabilities.grades = { enabled: false };
  expect(resolveCapability(true, policy, "vnu", "grades").enabled).toBe(false);
});

it("inherits global limits and clamps them to hard ceilings", () => {
  const policy = emptyPolicy();
  policy.global.limits["crossLookup.crossDetail.concurrency"] = 12;
  expect(resolveLimit(policy, "vnu", "crossLookup.crossDetail.concurrency", 6))
    .toEqual({ value: 6, configured: 12, source: "global", clamped: true });
});

it("treats a null global limit as no admin cap", () => {
  const policy = emptyPolicy();
  policy.global.limits["crossLookup.bulkMaxTargets"] = null;
  expect(resolveLimit(policy, "vnu", "crossLookup.bulkMaxTargets", 500).value).toBe(500);
});
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `pnpm --filter @hyeboard/worker exec vitest run src/feature-policy.test.ts`

Expected: FAIL because `feature-policy.ts` does not exist.

- [ ] **Step 3: Implement minimal pure helpers**

```ts
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
  if (policy.global.capabilities[capability]?.enabled === false)
    return { enabled: false, locked: false, source: "global" };
  if (policy.universities[universityId]?.capabilities[capability]?.enabled === false)
    return { enabled: false, locked: false, source: "university" };
  return { enabled: true, locked: false, source: "adapter" };
}

export function resolveLimit(
  policy: FeaturePolicyContent,
  universityId: string,
  key: OperationalLimitKey,
  hardCeiling: number,
): EffectiveLimit {
  const university = policy.universities[universityId]?.limits[key];
  const global = policy.global.limits[key];
  const configured = university ?? global ?? null;
  const source = university !== undefined ? "university" : global !== undefined ? "global" : "native";
  const value = configured === null ? hardCeiling : Math.min(configured, hardCeiling);
  return { value, configured, source, clamped: configured !== null && configured > hardCeiling };
}
```

- [ ] **Step 4: Add policy validation and dashboard projection tests**

Test that:

- unknown universities are rejected at publish validation;
- global `enabled: true` cannot make an unsupported adapter capability effective;
- university overrides cannot encode `enabled: true` because the shared schema rejects them;
- `filterDashboardSummary()` clears disabled schedule/courses/assignments/grades/exams/tuition/notifications fields without changing student/current-term identity;
- finite-limit-required features remain disabled when their authoritative native limit is absent.

- [ ] **Step 5: Implement registry-backed validation and projection**

Expose:

```ts
export function validatePolicy(
  policy: FeaturePolicyContent,
  universities: readonly University[],
  hardLimits: Readonly<Partial<Record<OperationalLimitKey, number>>>,
): FeaturePolicyContent;

export function effectiveUniversity(
  university: University,
  policy: FeaturePolicyContent,
  hardLimits: Readonly<Partial<Record<OperationalLimitKey, number>>>,
): University;

export function filterDashboardSummary(
  dashboard: DashboardSummary,
  capabilities: UniversityCapabilities,
): DashboardSummary;
```

Validation returns the parsed normalized value. It throws `HyeboardError("ADMIN_POLICY_INVALID", ..., 400, { path })` without secrets or full submitted content.

- [ ] **Step 6: Verify policy core**

Run: `pnpm --filter @hyeboard/worker exec vitest run src/feature-policy.test.ts`

Expected: PASS.

Run: `git diff --check -- apps/worker/src/feature-policy*`

Expected: no output.

---

## Task 3: Add the store contract and last-known-good runtime

**Files:**

- Create: `apps/worker/src/feature-policy-store.ts`
- Create: `apps/worker/src/feature-policy-store.test.ts`

- [ ] **Step 1: Write a reusable contract test against an in-memory fake**

```ts
export function featurePolicyStoreContract(
  name: string,
  create: () => Promise<FeaturePolicyStore>,
): void {
  describe(name, () => {
    it("bootstraps revision zero and atomically publishes revision one", async () => {
      const store = await create();
      expect((await store.current()).revision).toBe(0);
      const entry = await store.publish({
        baseRevision: 0,
        policy: emptyPolicy(),
        reason: "Initial operator publication",
        actor: { method: "password", subject: "password-admin" },
      });
      expect(entry.revision).toBe(1);
      expect((await store.history({ limit: 10 })).items).toEqual([entry]);
    });

    it("rejects a stale base revision without overwriting", async () => {
      const store = await create();
      await store.publish(publication(0));
      await expect(store.publish(publication(0))).rejects.toMatchObject({
        code: "ADMIN_POLICY_CONFLICT",
        status: 409,
      });
    });
  });
}
```

- [ ] **Step 2: Define the narrow store and event contracts**

```ts
export interface FeaturePolicyStore {
  current(): Promise<FeaturePolicySnapshot>;
  publish(input: PublishFeaturePolicyInput): Promise<FeaturePolicyAuditEntry>;
  history(input: { beforeRevision?: number; limit: number }): Promise<{
    items: FeaturePolicyAuditEntry[];
    nextBeforeRevision?: number;
  }>;
  revision(revision: number): Promise<FeaturePolicyAuditEntry | undefined>;
  close?(): Promise<void>;
}

export interface FeaturePolicyEvents {
  publish(revision: number): Promise<void>;
  subscribe(listener: (revision: number) => void): () => void;
  stream(lastRevision: number | undefined, signal: AbortSignal): Promise<Response>;
  close?(): Promise<void>;
}
```

- [ ] **Step 3: Implement in-memory store/events for tests and explicit test injection only**

`MemoryFeaturePolicyStore` must clone parsed snapshots at boundaries, use a single promise queue for CAS serialization, prepend history newest-first, and never be selected by production distributed startup.

- [ ] **Step 4: Implement `FeaturePolicyRuntime`**

```ts
export class FeaturePolicyRuntime {
  private cached?: FeaturePolicySnapshot;
  constructor(
    private readonly store: FeaturePolicyStore,
    private readonly events: FeaturePolicyEvents,
  ) {}

  async current(): Promise<FeaturePolicySnapshot> {
    try {
      return this.cached = featurePolicySnapshotSchema.parse(await this.store.current());
    } catch (error) {
      if (this.cached) return this.cached;
      throw new HyeboardError("FEATURE_POLICY_UNAVAILABLE", "Feature policy is unavailable.", 503);
    }
  }

  invalidate(revision: number): void {
    if (!this.cached || revision > this.cached.revision) this.cached = undefined;
  }
}
```

Add `publish`, `rollback`, `history`, `revision`, and `stream` pass-through methods. `current()` deliberately reads durable authority on every API request; `cached` is last-known-good fallback only, not a positive cache. This keeps enforcement correct even when Redis/SSE notification fails. Publish validates first, writes once, records the returned snapshot as last-known-good, then emits the revision. Notification failure is logged safely but does not reverse the successful publication.

- [ ] **Step 5: Test last-known-good and cold fail-closed behavior**

Tests must prove:

- loaded runtime serves cached policy during a read outage;
- cold runtime throws `FEATURE_POLICY_UNAVAILABLE`;
- successful publish remains successful when event publication throws;
- rollback loads an earlier snapshot and publishes it as a new revision.

- [ ] **Step 6: Verify**

Run: `pnpm --filter @hyeboard/worker exec vitest run src/feature-policy-store.test.ts`

Expected: PASS.

---

## Task 4: Implement local SQLite authority for Node and Bun

**Files:**

- Create: `apps/worker/src/node/sqlite/feature-policy-store.ts`
- Create: `apps/worker/src/node/sqlite/bun-sqlite.d.ts`
- Create: `apps/worker/src/node/sqlite/feature-policy-store.test.ts`
- Modify: `apps/worker/scripts/build-node.mjs` only if needed

- [ ] **Step 1: Write persistence/CAS tests with a temporary DB**

Test opening, publishing, closing, reopening, history pagination, malformed row rejection, stale CAS, and append-only rollback. Use `mkdtemp()` and remove the directory in `finally`.

- [ ] **Step 2: Add a tiny database driver shape**

```ts
type SqliteStatement = {
  run(...values: unknown[]): unknown;
  get(...values: unknown[]): unknown;
  all(...values: unknown[]): unknown[];
};

type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
};
```

- [ ] **Step 3: Select the native runtime module lazily**

```ts
export async function openFeaturePolicyDatabase(path: string): Promise<SqliteDatabase> {
  if (typeof Bun !== "undefined") {
    const { Database } = await import("bun:sqlite");
    return new Database(path, { create: true });
  }
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(path);
}
```

Keep this file outside Cloudflare imports. Detect Bun with `"Bun" in globalThis`. Add `apps/worker/src/node/sqlite/bun-sqlite.d.ts` containing only the `Database` constructor and `exec`/`prepare`/`close` members used here; do not add global Bun types to the Worker project.

- [ ] **Step 4: Implement schema and atomic CAS**

Use two tables:

```sql
CREATE TABLE IF NOT EXISTS feature_policy_current (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS feature_policy_history (
  revision INTEGER PRIMARY KEY,
  base_revision INTEGER NOT NULL,
  actor_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  published_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL
);
```

Initialize current revision zero once. Publish with `BEGIN IMMEDIATE`, read current revision, compare, insert history, update current, commit; rollback on every exception.

- [ ] **Step 5: Run Node tests and Bun smoke check when installed**

Run: `pnpm --filter @hyeboard/worker exec vitest run src/node/sqlite/feature-policy-store.test.ts`

Expected: PASS.

Run: `bun --version && bun -e "import { Database } from 'bun:sqlite'; const db=new Database(':memory:'); db.exec('select 1'); db.close()"`

Expected: PASS when Bun exists; otherwise record Bun unavailable and retain the typed runtime branch for the broader Bun gate.

- [ ] **Step 6: Validate packaged Node resolution**

Run: `pnpm --filter @hyeboard/worker build:node && node --check apps/worker/dist/index.js`

Expected: exit 0. If Rolldown tries to resolve `bun:sqlite` in the Node build, add `"bun:sqlite"` to `external`; do not externalize ordinary project modules.

---

## Task 5: Implement PostgreSQL authority

**Files:**

- Create: `apps/worker/migrations/003_feature_policy.sql`
- Create: `apps/worker/src/node/postgres/feature-policy-store.ts`
- Modify: `apps/worker/src/node/postgres/index.ts`
- Modify: `apps/worker/src/node/postgres/postgres.test.ts`

- [ ] **Step 1: Write failing SQL-boundary tests**

Add fake-pool tests proving publication:

- starts a transaction;
- locks singleton current row with `FOR UPDATE`;
- compares `baseRevision` before writes;
- inserts immutable history before updating current;
- never writes raw OAuth tokens, passwords, or cookies.

- [ ] **Step 2: Add migration**

```sql
CREATE TABLE hyeboard_feature_policy_current (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  revision bigint NOT NULL CHECK (revision >= 0),
  snapshot jsonb NOT NULL
);

CREATE TABLE hyeboard_feature_policy_history (
  revision bigint PRIMARY KEY CHECK (revision > 0),
  base_revision bigint NOT NULL CHECK (base_revision >= 0),
  actor jsonb NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  published_at timestamptz NOT NULL,
  snapshot jsonb NOT NULL
);

INSERT INTO hyeboard_feature_policy_current (singleton, revision, snapshot)
VALUES (true, 0, '{"revision":0,"global":{"capabilities":{},"limits":{}},"universities":{}}')
ON CONFLICT (singleton) DO NOTHING;
```

- [ ] **Step 3: Implement `PostgresFeaturePolicyStore`**

Use `PostgresPoolLike.transaction()`. Parse every JSON row through shared schemas. Pagination query must use `revision < $1 ORDER BY revision DESC LIMIT $2`, with a hard server-side page maximum of 100.

- [ ] **Step 4: Export and verify**

Add to `apps/worker/src/node/postgres/index.ts`:

```ts
export { PostgresFeaturePolicyStore } from "./feature-policy-store";
```

Run: `pnpm --filter @hyeboard/worker exec vitest run src/node/postgres/postgres.test.ts`

Expected: PASS.

Run: `pnpm --filter @hyeboard/worker test:ha:postgres`

Expected: PASS when Docker/Testcontainers is available; otherwise report the environment blocker without claiming the HA gate.

---

## Task 6: Implement Cloudflare Durable Object authority

**Files:**

- Create: `apps/worker/src/feature-policy-durable-object.ts`
- Create: `apps/worker/src/feature-policy-cloudflare.ts`
- Modify: `apps/worker/src/index.ts`
- Modify: `apps/worker/wrangler.jsonc`
- Regenerate: `apps/worker/worker-configuration.d.ts`
- Modify: `apps/worker/test/captcha-relay-worker.ts`
- Modify: `apps/worker/vitest.workers.config.ts`
- Create: `apps/worker/test/feature-policy.workers.ts`

- [ ] **Step 1: Write Workers contract tests**

Bind one `FEATURE_POLICY` Durable Object with `useSQLite: true`. Test current revision, publication, stale CAS, history, revision lookup, rollback, two listeners receiving the new revision, and atomic login-window consumption with opaque bucket hashes.

- [ ] **Step 2: Implement the Durable Object**

Use `ctx.storage.sql` for the same logical policy tables as local SQLite plus a bounded `admin_login_windows` table keyed only by HMAC bucket. Expose focused RPC methods:

```ts
export class FeaturePolicyDurableObject extends DurableObject<Env> {
  current(): FeaturePolicySnapshot;
  publish(input: PublishFeaturePolicyInput): FeaturePolicyAuditEntry;
  history(input: HistoryInput): HistoryPage;
  revision(revision: number): FeaturePolicyAuditEntry | undefined;
  consumeAdminLoginAttempt(bucketHash: string, limit: number, windowMs: number): { allowed: boolean; retryAfterSeconds?: number };
  subscribe(): Response;
}
```

Use `ctx.blockConcurrencyWhile()` for schema/bootstrap. Store only parsed JSON. Login windows reject malformed non-hex bucket hashes and delete expired rows during consumption; raw IPs/passwords never reach storage. Keep SSE writer handles in memory; durable policy state remains SQLite-backed.

- [ ] **Step 3: Add the coordinator**

`DurableObjectFeaturePolicyStore` obtains `namespace.get(namespace.idFromName("global"))` and forwards the store contract. `DurableObjectFeaturePolicyEvents.publish()` and `.stream()` call focused Durable Object RPC/fetch methods; `.subscribe()` is a no-op local listener registration because Cloudflare API requests read authority on every request rather than relying on isolate cache invalidation. Keep Cloudflare types in the Cloudflare-specific file.

- [ ] **Step 4: Wire binding and migration**

Add:

```jsonc
{ "name": "FEATURE_POLICY", "class_name": "FeaturePolicyDurableObject" }
```

Add migration tag `v4` with `new_sqlite_classes: ["FeaturePolicyDurableObject"]`. Export the class from `index.ts` and Workers test entry.

Regenerate binding types:

```bash
pnpm --filter @hyeboard/worker exec wrangler types
```

Expected: `worker-configuration.d.ts` includes `FEATURE_POLICY` and `FeaturePolicyDurableObject`; review the generated diff.

- [ ] **Step 5: Verify**

Run: `pnpm --filter @hyeboard/worker test:workers`

Expected: PASS.

Run: `pnpm --filter @hyeboard/worker exec wrangler deploy --dry-run`

Expected: packaging succeeds; no publish.

---

## Task 7: Add Redis revision propagation and runtime startup wiring

**Files:**

- Create: `apps/worker/src/node/redis/feature-policy-events.ts`
- Modify: `apps/worker/src/node/redis/client.ts`
- Modify: `apps/worker/src/node/redis/index.ts`
- Modify: `apps/worker/src/node/redis/redis.test.ts`
- Modify: `apps/worker/src/start.ts`
- Modify: `apps/worker/src/app.ts`
- Modify: `apps/worker/src/ha-lifecycle.test.ts`

- [ ] **Step 1: Extend the narrow Redis interfaces**

```ts
export interface RedisPublishClient {
  publish(channel: string, message: string): Promise<number>;
}

export interface RedisSubscribeClient {
  subscribe(channel: string, listener: (message: string) => void): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
}
```

Create a dedicated duplicate/subscriber client in distributed startup; never issue normal commands on a subscribed connection.

- [ ] **Step 2: Implement revision events**

Use fixed channel `hyeboard:v1:feature-policy:revision`. Accept only canonical nonnegative integer messages. Expose `publish`, `subscribe`, `stream`, and `close`. `stream()` registers an in-process listener, emits heartbeat comments, removes it on abort, and receives cross-replica revisions through the dedicated Redis subscriber.

- [ ] **Step 3: Test malformed messages and fan-out**

Prove duplicate, stale, negative, floating-point, and nonnumeric messages do not invalidate. Newer canonical revisions notify every local listener once.

- [ ] **Step 4: Add runtime injection**

In `app.ts` expose only:

```ts
let featurePolicyRuntime: FeaturePolicyRuntime | undefined;
export function setFeaturePolicyRuntime(runtime: FeaturePolicyRuntime | undefined): void {
  featurePolicyRuntime = runtime;
}
```

Tests inject `MemoryFeaturePolicyStore`. Production startup must install a durable implementation before serving.

- [ ] **Step 5: Wire runtime modes honestly**

In `start.ts`:

- memory mode: open `HYEB_ADMIN_DB_PATH` local SQLite and in-process events;
- distributed mode: add `policyStore` and `policyEvents` readiness dependencies; install PostgreSQL store only after migrations; install Redis events only after publisher/subscriber connect; mark unavailable on failure; never install local SQLite;
- close store/events during shutdown.

In `index.ts`: install Durable Object store/events.

- [ ] **Step 6: Verify readiness**

Add tests proving distributed readiness remains degraded when either policy authority or propagation is unavailable, and memory mode does not advertise distributed dependencies.

Run: `pnpm --filter @hyeboard/worker exec vitest run src/node/redis/redis.test.ts src/ha-lifecycle.test.ts`

Expected: PASS.

---

## Task 8: Implement admin configuration, session, password, CSRF, and OAuth primitives

**Files:**

- Create: `apps/worker/src/admin-config.ts`
- Create: `apps/worker/src/admin-config.test.ts`
- Create: `apps/worker/src/admin-auth.ts`
- Create: `apps/worker/src/admin-auth.test.ts`
- Create: `apps/worker/scripts/hash-admin-password.ts`
- Modify: `apps/worker/src/app.ts`

- [ ] **Step 1: Write failing configuration tests**

Test `parseAdminConfig()` for session-secret minimum length, canonical TTL, exact public origin, OAuth client-ID/secret pairs, numeric-ID allowlist normalization, local DB path, and zero configured login methods. Secret values must never appear in thrown messages.

Implement one immutable `AdminAuthConfig` projection consumed by routes. Disabled/malformed methods are absent from `methods`; malformed security-critical values fail startup rather than downgrade.

- [ ] **Step 2: Write failing session/password tests**

Cover:

- versioned PBKDF2 hash parsing;
- correct and incorrect password;
- malformed/weak hash rejection;
- constant-length comparison path;
- encrypted cookie round trip;
- expiry;
- wrong secret;
- student Bearer token rejection;
- Origin and CSRF rejection for mutation;
- numeric-ID allowlist parsing.

Use hash format:

```text
pbkdf2-sha256$310000$<base64url-16-byte-salt>$<base64url-32-byte-digest>
```

- [ ] **Step 3: Implement PBKDF2 with Web Crypto**

```ts
export async function verifyAdminPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = parseAdminPasswordHash(encoded);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const actual = new Uint8Array(await crypto.subtle.deriveBits({
    name: "PBKDF2",
    hash: "SHA-256",
    salt: parsed.salt,
    iterations: parsed.iterations,
  }, key, 256));
  return timingSafeEqual(actual, parsed.digest);
}
```

`timingSafeEqual` loops over equal fixed-size arrays and accumulates XOR; malformed lengths fail before comparison. Export `createAdminPasswordHash(password, salt?)` from the same module so generation and verification share one format and test vectors.

- [ ] **Step 4: Add the masked password-hash command**

Create `apps/worker/scripts/hash-admin-password.ts`. Read one password twice from an interactive TTY while suppressing typed characters, reject empty/mismatched input, call `createAdminPasswordHash`, print only the encoded hash, and clear local string references in `finally`. Refuse non-TTY input by default; allow an explicit `--stdin` mode for automation without logging input.

- [ ] **Step 5: Implement encrypted admin session envelopes**

Use AES-GCM with HKDF-derived key, purpose-specific salt/info/AAD, random 96-bit IV, exact schema parsing, and `HYEB_ADMIN_SESSION_SECRET` minimum 32 characters. Session payload:

```ts
type AdminSession = {
  version: 1;
  purpose: "hyeboard-admin";
  actor: AdminActor;
  csrfToken: string;
  issuedAt: string;
  expiresAt: string;
};
```

Cookie name: `hyeboard_admin`. Attributes: `HttpOnly; SameSite=Lax; Path=/api/admin`; add `Secure` outside local development. Logout overwrites with `Max-Age=0`.

- [ ] **Step 6: Implement mutation checks**

Require:

- valid admin cookie;
- `Origin` exactly matching request origin or configured allowed admin origin;
- `X-Hyeboard-CSRF` matching session token;
- content type `application/json` for JSON mutations.

- [ ] **Step 7: Implement OAuth state + PKCE helpers**

State cookie is separate, encrypted, short-lived, provider-specific, one-use by expiry/clearing, and contains verifier plus return path limited to `/admin`. Build provider URLs using standard `URL`/`URLSearchParams`. Callback exchanges code server-side, fetches `/user` or `/users/@me`, extracts numeric string ID, checks configured allowlist, discards access token, then issues the same admin session cookie.

- [ ] **Step 8: Verify auth primitives**

Run: `pnpm --filter @hyeboard/worker exec vitest run src/admin-config.test.ts src/admin-auth.test.ts`

Expected: PASS.

---

## Task 9: Add admin routes and atomic publication API

**Files:**

- Create: `apps/worker/src/admin-routes.ts`
- Create: `apps/worker/src/admin-routes.test.ts`
- Modify: `apps/worker/src/app.ts`

- [ ] **Step 1: Write route tests first**

Test:

- `/api/admin/session` reports unauthenticated without leaking config;
- password login uses rate limiter and sets only admin cookie;
- bad password gives one generic 401;
- OAuth start/callback validates provider, state, PKCE, and numeric allowlist;
- GET policy/history/revision require admin session;
- publish/rollback require Origin + CSRF;
- publish returns 409 with current revision metadata on stale base;
- history is newest-first and bounded;
- all admin responses are `Cache-Control: no-store`;
- revision stream contains only revision IDs.

- [ ] **Step 2: Define focused route registration**

```ts
export function registerAdminRoutes(app: Elysia, dependencies: {
  runtime: () => FeaturePolicyRuntime;
  config: () => AdminAuthConfig;
  rateLimit: AdminLoginRateLimit;
  fetch: typeof fetch;
}): Elysia;
```

Keep `app.ts` from growing further: call this function from `createApp()` before ordinary feature groups.

- [ ] **Step 3: Add endpoints**

```text
GET    /api/admin/session
POST   /api/admin/login/password
GET    /api/admin/oauth/:provider/start
GET    /api/admin/oauth/:provider/callback
POST   /api/admin/logout
GET    /api/admin/policy
POST   /api/admin/policy/validate
POST   /api/admin/policy/publish
GET    /api/admin/policy/history
GET    /api/admin/policy/history/:revision
POST   /api/admin/policy/rollback
GET    /api/admin/policy/events
GET    /api/policy/events
```

The student event endpoint requires a valid student session and emits only `event: revision\ndata: <integer>\n\n`.

- [ ] **Step 4: Add strict login rate limiting**

Reuse the existing `RateLimitCoordinator` in distributed mode. Use the Durable Object authority for Cloudflare password-attempt serialization. Use a process-local fixed window only in explicitly single-process memory mode, marked with:

```ts
// ponytail: process-local password limiter is valid only in documented single-process memory mode; use shared authority before replicas.
```

Key attempts by HMAC of normalized client IP plus a global bucket. Never store raw IP or password.

- [ ] **Step 5: Verify route suite**

Run: `pnpm --filter @hyeboard/worker exec vitest run src/admin-routes.test.ts`

Expected: PASS.

---

## Task 10: Enforce effective policy across the API

**Files:**

- Modify: `apps/worker/src/app.ts`
- Modify: `apps/worker/src/app.test.ts`
- Modify: `apps/worker/src/university-capabilities.test.ts`
- Modify: `apps/worker/src/vnu-cross-detail.test.ts`
- Modify: `packages/university-adapters/src/types.ts`
- Modify: `packages/university-adapters/src/mock/adapter.ts`
- Modify: `packages/university-adapters/src/uet/adapter.ts`
- Modify: `packages/university-adapters/src/vnu/adapter.ts`
- Modify: focused adapter tests beside changed adapters

- [ ] **Step 1: Write failing route-enforcement tests**

For representative ordinary and specialized routes, publish disabled policy and prove adapter/upstream spies are not called:

```ts
it.each([
  ["courses", "/api/mock/courses"],
  ["grades", "/api/mock/grades"],
  ["crossLookup", "/api/vnu/cross-lookup/student-code?stdId=1002&allowCrossLookup=true"],
])("rejects disabled %s before upstream work", async (capability, path) => {
  // publish global disabled, request with valid student token
  expect(response.status).toBe(503);
  expect(body.error.code).toBe("FEATURE_DISABLED");
  expect(upstreamSpy).not.toHaveBeenCalled();
});
```

Also prove `FEATURE_DISABLED` does not match the web session-death code set. Add adapter tests proving a disabled dashboard field never starts its underlying upstream call.

- [ ] **Step 2: Make university serialization asynchronous**

Change `serializeUniversities()` to load the current policy and run every native university through `effectiveUniversity()`. Keep the existing `University[]` data shape so static query consumers do not need a broad refactor; the SSE helper deduplicates canonical revision IDs locally.

- [ ] **Step 3: Add one shared guard**

```ts
async function requireFeature(universityId: string, capability: CapabilityKey): Promise<EffectiveUniversity> {
  const native = serializeNativeUniversity(universityId);
  const policy = await requireFeaturePolicyRuntime().current();
  const effective = effectiveUniversity(native, policy, effectiveHardLimits());
  if (!effective.capabilities[capability]) {
    throw new HyeboardError("FEATURE_DISABLED", "This feature is temporarily unavailable.", 503, { capability });
  }
  return effective;
}
```

Do not copy guards into pages or adapters. Route groups call this once before adapter work.

- [ ] **Step 4: Map every route to capability**

Ordinary routes:

```ts
const adapterRouteCapabilities = {
  "/me": "profile",
  "/terms": "terms",
  "/timetable": "timetable",
  "/courses": "courses",
  "/assignments": "assignments",
  "/grades": "grades",
  "/gpa": "grades",
  "/exams": "exams",
  "/attendance": "attendance",
  "/notifications": "notifications",
  "/news": "news",
  "/documents": "documents",
  "/tuition": "tuition",
  "/training-points": "trainingPoints",
  "/requests": "requests",
} satisfies Record<string, CapabilityKey>;
```

Guard dashboard once, then pass the effective capability projection into `adapter.getDashboard({ session, termCode, capabilities })` and filter the returned aggregate defensively. Extend `AdapterRequest` with `capabilities?: Partial<UniversityCapabilities>`. Each adapter replaces disabled dashboard work with an already-resolved empty/undefined value before constructing `Promise.all`/`Promise.allSettled`; this prevents calls from starting rather than merely hiding their results. Map `profile` to `student`, `terms` to `currentTerm`, `timetable` to `nextClass`/`todaySchedule`, `courses` to `courseCount`/`courses`, `assignments` to `assignments`, `grades` to `grades`/`gpa`, `exams` to `exams`, `tuition` to `tuition`, and `notifications` to `notifications`. Guard specialized class lookup/cross lookup/raw routes at their shared route group or helper boundary.

- [ ] **Step 5: Apply effective operational limits**

Replace editable raw config reads at request validation points with resolved values. Use `Math.min(adminEffective, hardCeiling)` once in `effectiveHardLimits()`. Preserve budgets, permits, timeouts, and resolver constants unchanged.

- [ ] **Step 6: Verify**

Run: `pnpm --filter @hyeboard/worker exec vitest run src/app.test.ts src/university-capabilities.test.ts src/vnu-cross-detail.test.ts`

Expected: PASS.

Run: `pnpm --filter @hyeboard/university-adapters test`

Expected: PASS; disabled dashboard capabilities have zero upstream calls.

---

## Task 11: Add browser API clients and policy invalidation

**Files:**

- Create: `apps/web/src/lib/admin-api.ts`
- Create: `apps/web/src/lib/admin-api.test.ts`
- Create: `apps/web/src/lib/policy-events.ts`
- Create: `apps/web/src/lib/policy-events.test.ts`
- Modify: `apps/web/src/state.tsx`
- Modify: `apps/web/src/state.test.tsx`
- Modify: `apps/web/src/lib/api.ts`

- [ ] **Step 1: Write request-boundary tests**

Prove admin requests use `credentials: "include"`, mutations include `Content-Type` and CSRF, no student Authorization header is copied, and typed API errors preserve 409 details.

- [ ] **Step 2: Implement the admin client**

```ts
async function adminRequest<T>(path: string, init: RequestInit = {}, csrf?: string): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(csrf ? { "X-Hyeboard-CSRF": csrf } : {}),
      ...init.headers,
    },
  });
  // parse Hyeboard envelope; throw AdminApiError on non-2xx/error
}
```

Export session, login, logout, policy, validate, publish, history, revision, rollback, OAuth URL, and event helpers.

- [ ] **Step 3: Implement student revision subscription**

Use native `EventSource` only when the student session exists. Because EventSource cannot set Bearer headers, use a short-lived opaque stream ticket endpoint or `fetch()` streaming with the existing Bearer token. Prefer `fetch()` streaming to avoid a second credential type. Parse only canonical `data:` integer lines. Abort on account switch/unmount. Reconnect with bounded exponential delay and a 60-second polling fallback.

- [ ] **Step 4: Invalidate focused queries**

On a newer revision:

```ts
await queryClient.invalidateQueries({ queryKey: ["universities"] });
await queryClient.invalidateQueries({
  predicate: shouldInvalidateAccountQuery,
  refetchType: "active",
});
```

Reuse `shouldInvalidateAccountQuery`; do not globally clear QueryClient.

- [ ] **Step 5: Verify**

Run: `pnpm --filter @hyeboard/web exec vitest run src/lib/admin-api.test.ts src/lib/policy-events.test.ts src/state.test.tsx`

Expected: PASS.

---

## Task 12: Add the separate admin route tree and login UI

**Files:**

- Create: `apps/web/src/components/ui/switch.tsx`
- Create: `apps/web/src/components/ui/dialog.tsx`
- Create: `apps/web/src/components/admin/admin-layout.tsx`
- Create: `apps/web/src/pages/admin-login.tsx`
- Create: `apps/web/src/pages/admin-auth.tsx`
- Modify: `apps/web/src/router.tsx`
- Modify: `apps/web/src/lib/i18n.tsx`
- Modify: `apps/web/src/styles.css`
- Create: `apps/web/src/components/admin/admin-components.test.tsx`

- [ ] **Step 1: Write static/accessibility tests**

Render login and shell with mocked session. Assert persistent labels, password input type, OAuth buttons, 44px controls, semantic nav, separate logout, loading/error states, and absence of student account data.

- [ ] **Step 2: Add local UI primitives**

`Switch` is a native button with `role="switch"`, `aria-checked`, disabled behavior, visible focus, and existing tokens. `Dialog` is a thin typed wrapper over installed `@radix-ui/react-dialog`; no dependency change or shadcn CLI.

- [ ] **Step 3: Add separate routes**

Structure:

```ts
const adminLoginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/login",
  component: lazyPage(() => import("@/pages/admin-login"), "AdminLoginPage"),
});

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  component: lazyPage(() => import("@/components/admin/admin-layout"), "AdminLayout"),
});
```

Do not use `getSessionToken()` in admin route guards. `AdminLayout` queries `/api/admin/session`, redirects unauthenticated users to `/admin/login`, and renders its own `Outlet`.

- [ ] **Step 4: Implement login/auth pages**

Login shows configured methods only. Password submit disables while pending and uses a generic failure message. OAuth buttons navigate to server start endpoints. Auth page shows method/label/subject-safe display and logout.

- [ ] **Step 5: Add translations**

Add complete `admin` trees to both dictionaries. Keep identifiers untranslated; map capability and limit keys to typed labels/descriptions.

- [ ] **Step 6: Verify**

Run: `pnpm --filter @hyeboard/web exec vitest run src/components/admin/admin-components.test.tsx`

Expected: PASS.

Run: `pnpm --filter @hyeboard/web typecheck`

Expected: exit 0.

---

## Task 13: Build control room, publish review, history, and rollback

**Files:**

- Create: `apps/web/src/components/admin/policy-editor.tsx`
- Create: `apps/web/src/components/admin/publish-dialog.tsx`
- Create: `apps/web/src/components/admin/policy-history.tsx`
- Create: `apps/web/src/pages/admin-control.tsx`
- Create: `apps/web/src/pages/admin-history.tsx`
- Modify: `apps/web/src/components/admin/admin-components.test.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: Extract pure draft helpers and test them**

In `policy-editor.tsx` export/test:

```ts
export function updateCapabilityDraft(...): FeaturePolicyContent;
export function updateLimitDraft(...): FeaturePolicyContent;
export function policyDiff(before: FeaturePolicyContent, after: FeaturePolicyContent): PolicyDiffItem[];
export function hasPolicyChanges(...): boolean;
```

Tests cover global kills, university further-disable only, clear-to-inherit, global null/unlimited, immutable updates, and stable diff ordering.

- [ ] **Step 2: Implement control room query states**

Use TanStack Query keys:

```ts
["admin", "session"]
["admin", "policy"]
["admin", "history", beforeRevision]
```

The page displays summary strip, Global/university tabs, search, flat rows, lock reasons, limit provenance, and explicit loading/error/empty states.

- [ ] **Step 3: Implement staged edits**

Keep draft state local to the control page. Reset only on explicit Discard, successful publication, or confirmed navigation. Do not write drafts to localStorage because policy may contain stale operational state.

- [ ] **Step 4: Implement review/publish dialog**

Show grouped diff, required reason textarea, base revision, and Publish. On 409 preserve the draft, refetch current policy, show intervening revision, and require operator review; never auto-merge.

- [ ] **Step 5: Implement history and rollback**

Render bounded flat rows with Load more. Revision detail shows actor/method/reason/diff. Rollback opens the same review pattern, requires reason, and publishes against current base revision.

- [ ] **Step 6: Verify component behavior**

Run: `pnpm --filter @hyeboard/web exec vitest run src/components/admin/admin-components.test.tsx`

Expected: PASS.

---

## Task 14: Make student UI fail closed and react to policy changes

**Files:**

- Modify: `apps/web/src/components/layout.tsx`
- Modify: `apps/web/src/pages/dashboard.tsx`
- Modify: `apps/web/src/pages/documents.tsx`
- Modify: `apps/web/src/pages/lookup.tsx`
- Modify: `apps/web/src/state.test.tsx`
- Modify: `apps/web/tests/shell-dashboard.spec.ts`

- [ ] **Step 1: Write regression tests**

Test that missing universities metadata hides capability-bound navigation rather than assuming true, disabled dashboard capability removes its stat/panel, documents subfeatures each honor effective flags, and policy revision invalidation cannot show the previous account's data.

- [ ] **Step 2: Fix capability defaults once**

Change shared visibility logic:

```ts
function isCapabilityVisible(capability: NavCapability | undefined, capabilities: UniversityCapabilities | undefined): boolean {
  if (!capability) return true;
  if (!capabilities) return false;
  if (capability === "documentsHub") return capabilities.documents || capabilities.requests || capabilities.news;
  return capabilities[capability] === true;
}
```

Reuse this evidence-backed helper for search and sidebar. Do not add per-route fallback guards.

- [ ] **Step 3: Gate dashboard sections using effective capabilities**

Preserve student/current-term header. Render only stats/panels whose feature is enabled. Existing empty/error states remain inside enabled collections.

- [ ] **Step 4: Verify web package**

Run: `pnpm --filter @hyeboard/web test`

Expected: PASS.

---

## Task 15: Add browser-visible admin and propagation coverage

**Files:**

- Create: `apps/web/tests/admin-feature-control.spec.ts`
- Modify: `apps/web/tests/fixtures/base.ts` if an admin helper is reusable

- [ ] **Step 1: Add mocked password login flow**

Intercept session/login/policy endpoints. Assert `/admin` redirects to `/admin/login`, password login reaches control room, student account storage remains untouched, and OAuth links target server endpoints.

- [ ] **Step 2: Add publish/conflict/rollback flow**

Mock revision 1, stage changes, inspect diff, require reason, publish revision 2, then return 409 for a stale draft and verify edits remain. Load history and roll back revision 1 as revision 3.

- [ ] **Step 3: Add student propagation flow**

Authenticate demo page, stream a newer policy revision, return changed university capabilities, and verify disabled navigation/panel disappears without clearing the student session.

- [ ] **Step 4: Add responsive/accessibility assertions**

Run the admin control room at 390×844 and 1440×900. Assert no horizontal overflow, labels, keyboard-operable switches/dialog, visible publish controls, and practical touch target size.

- [ ] **Step 5: Run focused browser test**

Run: `pnpm --filter @hyeboard/web exec playwright test tests/admin-feature-control.spec.ts --retries=0`

Expected: PASS.

---

## Task 16: Add configuration, deployment, and operator documentation

**Files:**

- Create: `apps/worker/scripts/hash-admin-password.ts` in Task 8
- Modify: `apps/worker/package.json`
- Modify: `apps/worker/.env.example`
- Modify: `apps/worker/config.json`
- Modify: `compose.env.example`
- Modify: `deploy/k8s/base/api-deployment.yaml`
- Modify: `deploy/k8s/base/secret.example.yaml`
- Modify: `deploy/helm/hyeboard/values.yaml`
- Modify: `deploy/helm/hyeboard/values.schema.json`
- Modify: `deploy/helm/hyeboard/templates/api-deployment.yaml`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/ha-runbook.md`
- Modify: `scripts/package-config.test.mjs`
- Modify validation scripts only if required by existing structure

- [ ] **Step 1: Confirm Task 8 configuration tests fail before wiring values**

Run: `pnpm --filter @hyeboard/worker exec vitest run src/admin-config.test.ts`

Expected before wiring: FAIL on missing runtime config projection. After wiring all modes below: PASS.

- [ ] **Step 2: Add secrets and non-secret settings**

Secrets:

```text
HYEB_ADMIN_SESSION_SECRET
HYEB_ADMIN_PASSWORD_HASH
HYEB_ADMIN_GITHUB_CLIENT_SECRET
HYEB_ADMIN_DISCORD_CLIENT_SECRET
```

Non-secret configuration:

```text
HYEB_ADMIN_SESSION_TTL_SECONDS=3600
HYEB_ADMIN_DB_PATH=./data/admin.sqlite
HYEB_ADMIN_GITHUB_CLIENT_ID
HYEB_ADMIN_GITHUB_IDS
HYEB_ADMIN_DISCORD_CLIENT_ID
HYEB_ADMIN_DISCORD_IDS
HYEB_ADMIN_PUBLIC_ORIGIN
```

Never put secrets in `wrangler.jsonc` vars. Cloudflare uses Worker secrets. OAuth callback URLs are:

```text
<origin>/api/admin/oauth/github/callback
<origin>/api/admin/oauth/discord/callback
```

Add to `apps/worker/package.json`:

```json
"admin:hash-password": "tsx scripts/hash-admin-password.ts"
```

Verify the interactive command manually with a synthetic password and confirm output contains only the versioned hash.

- [ ] **Step 3: Wire deployment templates**

Kubernetes/Helm distributed mode references existing external Secret keys and does not mount local SQLite. Memory mode documents a writable persistent path if durable admin history is required across container replacement.

- [ ] **Step 4: Document bootstrap and recovery**

README/runbook must include:

- generating a PBKDF2 hash with a repository script or one documented command that never echoes the password into shell history;
- configuring numeric OAuth IDs;
- first revision behavior matching current effective capabilities;
- publication/rollback procedure;
- store and propagation outage behavior;
- distributed readiness dependencies;
- local SQLite backup path;
- OAuth callback setup;
- admin session-secret rotation consequences.

- [ ] **Step 5: Run config/deployment tests**

Run: `node scripts/package-config.test.mjs`

Expected: PASS.

Run: `pnpm test:k8s && pnpm test:helm`

Expected: PASS.

---

## Task 17: Full verification and exact diff review

**Files:** all changed files only.

- [ ] **Step 1: Proactive diagnostics**

Run `lsp_diagnostics` on:

```text
packages/schemas/src/
apps/worker/src/
apps/web/src/
```

Expected: zero errors.

- [ ] **Step 2: Focused package gates**

Run:

```bash
pnpm --filter @hyeboard/schemas typecheck
pnpm --filter @hyeboard/university-adapters test
pnpm --filter @hyeboard/worker test
pnpm --filter @hyeboard/web test
```

Expected: all pass.

- [ ] **Step 3: Runtime packaging gates**

Run:

```bash
pnpm --filter @hyeboard/worker build:node
pnpm --filter @hyeboard/worker check:node-package
pnpm --filter @hyeboard/worker exec wrangler deploy --dry-run
```

Expected: all pass; no deployment occurs.

- [ ] **Step 4: Browser and deployment gates**

Run:

```bash
pnpm test:browser
pnpm test:k8s
pnpm test:helm
```

Expected: all pass.

- [ ] **Step 5: Distributed gates**

Run: `pnpm test:ha`

Expected: PostgreSQL and Redis suites pass when Docker is available. If unavailable, report this exact residual risk.

- [ ] **Step 6: Repository build**

Run: `pnpm build`

Expected: exit 0.

- [ ] **Step 7: Lens verification**

Run: `lens_diagnostics mode=all`

Expected: no blocking errors in edited files.

- [ ] **Step 8: Review exact changes**

Run:

```bash
git diff --check
git status --short
git diff --stat
git diff -- packages/schemas apps/worker apps/web deploy README.md docs/architecture.md docs/ha-runbook.md scripts
```

Expected: no whitespace errors; unrelated pre-existing modifications remain untouched; no secrets, generated build output, browser reports, or `.superpowers/` files are staged/tracked.

- [ ] **Step 9: Report evidence**

Report exact changed paths, every command and result, failures, skipped environment-dependent gates, and residual risks. Do not claim deployment or commit.
