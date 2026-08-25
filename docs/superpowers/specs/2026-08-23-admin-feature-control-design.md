# Admin Feature Control Design

**Date:** 2026-08-23
**Status:** Approved design

## Goal

Add a separate Hyeboard admin control room where authorized operators can disable verified university capabilities, configure existing operational limits, publish global policy with university-specific overrides, propagate changes to all clients near real time, inspect history, and roll back safely.

## Scope

The first version supports:

- password, GitHub OAuth, and Discord OAuth admin login;
- a separate `/admin` application shell and admin session;
- every capability in `universityCapabilitiesSchema`;
- only operational limits already enforced by Hyeboard feature code;
- global policy plus university-specific overrides;
- atomic batch publication;
- append-only audit history and rollback;
- Cloudflare, Node/Bun memory mode, and distributed mode;
- server-side enforcement and client-side visibility updates;
- near-real-time client invalidation.

The first version does not support arbitrary flag keys, percentage rollouts, cohorts, schedules, approval workflows, or creation of new limit types from the admin UI.

## Product and security invariants

The control plane must preserve existing Hyeboard invariants:

1. Adapter evidence is authoritative. An admin cannot enable a capability that the selected adapter does not implement and verify.
2. Global disable is an emergency kill switch and always wins.
3. University overrides may further disable a capability but cannot re-enable a globally disabled capability.
4. Admin limits may only lower or remove an admin-configured cap. They cannot exceed or bypass hard security, abuse, concurrency, permit, or deployment ceilings.
5. A cleared global limit means no admin-configured cap. Hard ceilings still apply.
6. A cleared university limit inherits the global setting.
7. Disabled features are rejected by the API even when an old client still renders them.
8. Student and admin credentials, cookies, and sessions remain separate.
9. Distributed mode uses PostgreSQL as policy authority and never falls back to process-local authority.
10. Store failures never silently restore default-enabled policy.

## User experience

### Routes and shell

Admin UI lives under a separate lazy route tree:

- `/admin/login` — password, GitHub, and Discord login;
- `/admin` — feature control room;
- `/admin/history` — published revisions and rollback;
- `/admin/auth` — current identity and logout.

Admin routes do not render `RootLayout`, call student session APIs, or read student Bearer tokens. They reuse Hyeboard's Geist typography, theme tokens, local shadcn-style primitives, accessibility behavior, and responsive conventions.

### Control room

The primary screen is a compact control room:

- summary strip for capability count, enabled count, override count, and staged changes;
- tabs for Global and each registered university;
- searchable flat capability rows;
- availability switch per capability;
- operational-limit inputs only where an existing enforced limit exists;
- locked state and reason for unsupported capabilities or non-configurable limits;
- sticky staged-change bar with Discard and Review and publish actions.

The Global tab edits global defaults. A university tab shows effective state and its optional override. Clearing a university limit restores inheritance. Unsupported adapter capabilities remain visibly locked off.

Every list has loading, error, and empty states. Controls preserve labels, keyboard operation, visible focus, and practical 44px touch targets.

### Review and publish

Edits remain browser-local until publication. Review presents the exact before/after diff grouped by global and university scope. Publication requires a reason. The API validates and writes the complete new policy atomically.

If another admin publishes first, the stale draft is rejected. The UI preserves it and shows the intervening published diff; it never silently merges or overwrites.

### History and rollback

History shows revision, actor, authentication method, reason, timestamp, and diff. Rollback selects a prior snapshot, previews the reverse diff, requires a reason, and publishes that snapshot as a new revision. Existing history remains append-only.

## Policy model

The shared schemas define a closed catalog from `universityCapabilitiesSchema` and registered operational-limit descriptors.

```ts
type CapabilityKey = keyof University["capabilities"];

type CapabilityPolicy = {
  enabled: boolean;
};

type LimitValue = number | null; // null: no admin-configured cap

type ScopePolicy = {
  capabilities: Partial<Record<CapabilityKey, CapabilityPolicy>>;
  limits: Partial<Record<OperationalLimitKey, LimitValue>>;
};

type UniversityOverride = {
  capabilities: Partial<Record<CapabilityKey, { enabled: false }>>;
  limits: Partial<Record<OperationalLimitKey, number>>;
};

type FeaturePolicySnapshot = {
  revision: number;
  global: ScopePolicy;
  universities: Record<string, UniversityOverride>;
};

type FeaturePolicyAuditEntry = {
  revision: number;
  baseRevision: number;
  actor: AdminActor;
  reason: string;
  publishedAt: string;
  snapshot: FeaturePolicySnapshot;
};
```

University capability overrides only encode explicit disable. Absence means inherit. University limit overrides only encode an explicit numeric value. Absence means inherit. This keeps precedence unambiguous and prevents an override from bypassing a global kill.

Operational limits are a curated registry backed by existing enforcement points. Initial entries cover the published VNU cross-lookup limits:

- bulk maximum targets;
- direct chunk maximum targets;
- per-mode maximum targets;
- cross-detail maximum targets;
- cross-detail maximum rows;
- cross-detail concurrency.

Runtime security settings such as probe budgets, windows, permits, request deadlines, and immutable resolver bounds remain hard ceilings unless an existing feature path already exposes them as a user-facing operational limit. They are not turned into arbitrary editable fields.

## Resolution rules

A pure shared resolver receives:

- verified adapter capability and native limits;
- the current published snapshot;
- the deployment's effective hard ceilings;
- university ID.

For a capability, resolution is:

1. Unsupported adapter capability returns disabled and locked.
2. Explicit global disabled returns disabled.
3. Explicit university disabled returns disabled.
4. Otherwise the verified adapter capability remains enabled.

For a limit, resolution is:

1. Start with the university override when present.
2. Otherwise use the global value when present.
3. Otherwise apply no admin-configured cap.
4. Clamp the result to the native/deployment hard ceiling.
5. Preserve existing fail-closed semantics for features whose safe operation requires a finite authoritative limit.

The resolver returns effective values plus provenance and lock reasons for the admin UI. `/api/universities` serializes effective capabilities and public limits for student clients.

## API enforcement

Each authenticated feature route maps to a capability key. A shared guard loads the effective policy after session/university validation and before calling an adapter or upstream client. Disabled routes throw a feature-scoped `FEATURE_DISABLED` response with HTTP 503 and capability metadata. This code never clears a student session.

Route mapping includes ordinary adapter routes and specialized VNU/UET routes. Aggregate `/dashboard` data is filtered according to effective capabilities so disabled sections do not leak stale or newly fetched feature data. Specialized cross-lookup paths use resolved operational limits rather than raw runtime configuration wherever an editable operational limit applies.

The browser still uses TanStack Query. University data remains the source for navigation visibility. A policy revision change invalidates `universities` and active feature queries. Old clients remain safe because API enforcement is authoritative.

## Storage architecture

A shared `FeaturePolicyStore` contract provides:

- read current snapshot;
- compare-and-swap publish against a base revision;
- list audit entries with bounded pagination;
- read a specific revision;
- subscribe or emit revision invalidation where supported.

### Cloudflare

One `FeaturePolicyDurableObject` owns policy authority, SQLite storage, audit rows, compare-and-swap publication, and SSE connections. A deterministic singleton object ID gives one authority per deployment. Worker requests call it through a focused coordinator; Cloudflare-only imports remain in the Cloudflare entry path.

### Distributed Node/Bun

PostgreSQL is durable authority. A migration adds current policy and immutable audit revision tables. Publication runs in one transaction with row locking and base-revision comparison. Redis publishes revision invalidations to API replicas. Each replica caches only a validated last-known-good snapshot and invalidates it on Redis notification.

Policy authority, PostgreSQL migrations, and Redis propagation become explicit distributed readiness dependencies. Outages fail writes closed. A cold replica unable to load policy fails affected feature requests closed.

### Single-process Node/Bun memory mode

A local SQLite file provides durable single-process authority and audit history. The path is configured by `HYEB_ADMIN_DB_PATH`, with a documented local default beneath the worker data directory. It is not replica-safe and is never used in distributed mode. In-process events invalidate the policy cache and feed SSE clients.

Node and Bun use a runtime-selected SQLite adapter behind the shared store contract, keeping Node-only modules out of the Worker bundle. No new cross-runtime ORM is introduced.

## Propagation

A public authenticated-student policy event endpoint emits only revision IDs, never policy internals or admin data. The browser opens an SSE connection while a student session is active. On a newer revision it refetches universities and active feature queries.

Admin clients receive the same revision event and refresh current policy/history. SSE reconnect uses the last observed revision. A low-frequency refetch fallback recovers from proxies or deployments that interrupt streaming.

Publication is authoritative even if notification fails. API requests read or refresh current policy independently, so propagation affects freshness, not enforcement correctness.

## Admin authentication

### Session

Admin authentication creates a separate encrypted cookie using `HYEB_ADMIN_SESSION_SECRET`:

- `HttpOnly`;
- `Secure` outside local development;
- `SameSite=Lax`;
- restricted to `/api/admin` where practical;
- short configurable expiry;
- explicit logout and expiry checks.

Admin responses use `Cache-Control: no-store`. State-changing requests require same-origin validation and a session-bound CSRF token. Student Bearer tokens are never accepted on admin endpoints.

### Password

`HYEB_ADMIN_PASSWORD_HASH` stores a versioned PBKDF2 hash. Verification uses Web Crypto and constant-time comparison. Plaintext passwords never enter files, logs, audit entries, or responses. Password attempts use a strict fixed-window rate limit. If the required shared limiter is unavailable in distributed mode, password login fails closed.

### GitHub and Discord

Both providers use Authorization Code with PKCE and state. Client secrets remain server-side. Callback identity is authorized only by immutable numeric user ID configured in:

- `HYEB_ADMIN_GITHUB_IDS`;
- `HYEB_ADMIN_DISCORD_IDS`.

Usernames and email addresses are display/audit metadata only and never grant access. OAuth state is short-lived and bound to the initiating browser. GitHub or Discord failure does not disable independent password login.

### Actor model

Audit actors contain auth method, stable provider subject or password-admin identifier, and optional display label. They contain no provider access token, authorization code, password, email-based authorization decision, or student identity.

## Admin API

The admin API exposes focused endpoints:

- session status and logout;
- password login;
- GitHub/Discord authorization start and callback;
- current policy plus resolver metadata;
- validate/publish draft;
- paginated history;
- revision detail;
- rollback publication;
- SSE revision stream.

Publish and rollback accept `baseRevision`, the complete proposed snapshot, reason, and CSRF token. The server derives actor and timestamp. Clients cannot submit audit identity.

## Caching and failure behavior

Policy snapshots are validated before entering a cache. A process keeps the last-known-good snapshot during a transient store outage. Admin reads and writes report the outage explicitly. A cold process with no validated policy does not silently substitute defaults; affected routes fail closed.

Malformed stored policy is treated as control-plane corruption: log only safe metadata, reject admin writes/feature requests as appropriate, and preserve the stored data for operator recovery.

OAuth provider outages affect only that provider. Password login remains available when configured. Password rate-limit dependency outages fail password login closed in distributed mode.

A failed SSE/Redis notification does not roll back a successful publication. Clients recover through reconnect and polling; API enforcement consults the current revision independently.

## Internationalization

All app-authored admin strings are added to both `en` and `vi` dictionaries in `apps/web/src/lib/i18n.tsx`. Capability keys and backend enum values remain stable machine identifiers; the UI maps them to translated labels and descriptions.

## Testing

### Shared policy

- schema acceptance/rejection;
- adapter evidence lock;
- global kill precedence;
- university further-disable behavior;
- global unlimited semantics;
- university inheritance;
- hard-ceiling clamp;
- fail-closed finite-limit behavior.

### Stores and propagation

- one contract suite against memory/local SQLite, Durable Object, and PostgreSQL stores;
- compare-and-swap conflict;
- atomic snapshot plus audit insertion;
- bounded history pagination;
- rollback as a new revision;
- Redis and in-process invalidation;
- SSE reconnect and polling recovery;
- distributed dependency readiness/fail-closed behavior.

### Authentication

- password success, failure, malformed hash, and rate limiting;
- cookie expiry, encryption, flags, logout, and separation from student sessions;
- CSRF and Origin rejection;
- OAuth state, PKCE, callback failure, and numeric-ID allowlists;
- provider tokens and secrets absent from logs/responses/audit.

### API

- every capability route rejects disabled policy before adapter calls;
- `FEATURE_DISABLED` remains feature-scoped and does not clear student sessions;
- `/api/universities` exposes effective capabilities and limits;
- dashboard output filters disabled feature sections;
- specialized cross-lookup routes enforce resolved limits;
- stale publication and invalid policy return precise errors.

### Web

- lazy admin routes remain outside the initial student entry graph;
- admin login states;
- control-room loading, error, empty, locked, dirty, and conflict states;
- keyboard and label behavior;
- review/publish and rollback interactions;
- student navigation and feature views update after a revision event;
- English and Vietnamese copy.

### Gates

Run focused package tests during implementation. Completion requires web tests, worker tests including Workers tests, university-adapter tests where touched, relevant Playwright flows, Node packaging, Cloudflare dry-run packaging, distributed HA tests when Docker is available, `pnpm build`, `git diff --check`, and exact diff review.

## Deployment and operations

New secrets and bindings are documented in `.env.example`, Worker secret setup, self-hosted config, Kubernetes, Helm, architecture documentation, and HA runbook as applicable. OAuth callback URLs are explicit per deployment origin. No secret enters `wrangler.jsonc` vars or tracked config.

Existing deployments start with a generated revision whose effective behavior matches current verified adapter capabilities and runtime limits. Migration does not enable unsupported features or relax any hard ceiling.

Operators must configure at least one admin authentication method. When no method is configured, admin login reports unavailable and admin mutation endpoints reject access; student operation continues under the stored policy.
