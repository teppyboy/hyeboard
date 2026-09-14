# Agent Development Guide

Hyeboard is a multi-university dashboard. Prefer the smallest correct change. Reuse existing modules; do not introduce abstractions, dependencies, or configuration without a concrete need.

## Non-negotiable boundaries

1. **Browser data requests go through Hyeboard's API.** Never call StudentHub, Canvas, or VNU directly from application code. University response shapes, upstream authentication, retries, and parsing belong in adapters.
2. **Keep upstream secrets server-side after authentication.** API responses use opaque encrypted Hyeboard tokens, not decrypted upstream cookies, passwords, tokens, or SAML payloads. Never log credentials, grants, CAPTCHA images, or student PII. See the existing browser-storage discrepancy below; it is not permission to expand secret storage.
3. **Capabilities require adapter evidence.** Unsupported features fail explicitly. Effective policy may disable adapter capabilities, never invent support. A university override cannot undo a global disable; operational limits remain clamped to native ceilings.
4. **Student and admin authentication are separate.** Student routes use Bearer sessions. Admin routes use purpose-separated encrypted cookies and `HYEB_ADMIN_SESSION_SECRET`; reject student Authorization headers. Preserve CSRF, origin, cookie, OAuth state/PKCE, allowlist, and login-rate-limit checks.
5. **Session errors are scoped.** Only `MISSING_SESSION`, `SESSION_EXPIRED`, and `INVALID_SESSION` are generic session-death codes. Feature errors such as `CANVAS_LOGIN_REQUIRED` remain inline. VNU recovery has its own terminal-error and replay rules; do not collapse them into generic logout.
6. **Runtime authority must remain honest.** Distributed mode requires PostgreSQL and Redis, with no silent local-authority fallback. Keep Node-only imports out of the Cloudflare bundle and Cloudflare-only bindings out of Node/Bun startup.
7. **Visible collections need loading, error, and empty states.** Never use raw JSON as feature UI. Preserve keyboard access, labels, focus visibility, and safe external links.

### Existing browser-storage discrepancy

`apps/web/src/pages/account/login.tsx`, `src/state.tsx`, and `src/lib/session/reauth.ts` retain user-entered UET credentials and an optional Canvas token in tab `sessionStorage`. `src/lib/session/vnu-refresh.ts` stores opaque encrypted VNU reconnect grants per account there. Student accounts contain opaque Hyeboard Bearer tokens in `localStorage`.

These are existing implementation facts, not a claim that browser storage is safe from XSS. Do not expand raw-secret persistence, decrypt grants in the browser, or include either in diagnostics/exports. Changes to storage, cleanup, logout, or reconnect require explicit security review and regression coverage; do not silently remove recovery behavior during unrelated refactors.

## Source ownership

Paths below are relative to the named package unless fully qualified.

### `apps/web`

React 19, Vite, code-based TanStack Router, TanStack Query, Tailwind CSS v4.

- Composition: `src/main.tsx`, `src/router.tsx`, `src/state.tsx`.
- Pages: `src/pages/{account,academic,admin,dashboard,lookup}/`. Login is eagerly imported; feature/admin pages use lazy route imports. Admin routes stay outside the student provider.
- Browser API/transport: `src/lib/api/`; `api.ts` owns account tokens and request orchestration, university clients call Hyeboard endpoints only.
- Session recovery: `src/lib/session/`; account actions, inline UET reauth, VNU refresh and replay policy.
- Student policy/query ownership: `src/lib/policy/`; admin API/events: `src/lib/admin/`.
- Academic calculations: `src/lib/grades/`; cross-lookup models: `src/lib/lookup/`; sanitized exports: `src/lib/export/`.
- Shared UI: `src/components/shared.tsx`, `src/components/{ui,grades,admin}/`.
- Translations: `src/lib/i18n.tsx`; presentation/formatting: `src/lib/presentation.ts`, `src/lib/utils.ts`.
- Browser-test runtime configuration: `src/lib/testing/playwright-runtime-config.mjs`, `playwright.config.ts`; fixtures/specs: `tests/`.

### `apps/worker`

Elysia API/BFF, shared by Cloudflare and self-hosted Node/Bun.

- Composition/shared routes: `src/app.ts`; Cloudflare entry: `src/index.ts`; Node/Bun entry: `src/index.node.ts`, `src/start.ts`; static serving: `src/serve-static.ts`.
- Admin security and routes: `src/admin/`.
- Effective policy, store contracts/runtime, Cloudflare policy authority: `src/policy/`.
- CAPTCHA coordination: `src/captcha/`; VNU budgets, refresh authority, resolver, cross-detail: `src/vnu/`.
- HA contracts/lifecycle: `src/ha/`.
- Node-only implementations: `src/node/{postgres,redis,sqlite,automation}/`.
- PostgreSQL migrations: `migrations/`; runner: `src/node/postgres/migrations.ts`.
- Ordinary tests are colocated. Cloudflare execution fixtures/tests remain under `test/` with a separate Vitest pool.

### `apps/automation-worker`

Node-only executor boundary. `src/cli.ts` and `src/main.ts` compose Redis clients, Browserless/Puppeteer, health, and UET execution. `src/index.ts` preserves the package export surface.

- `src/runtime/`: worker lifecycle, cancellation, heartbeat, configuration, errors.
- `src/transport/`: Redis Streams broker/control/events, encrypted envelopes, leases.
- `src/browser/`: provider ownership and executor contracts/UET implementation.

### Shared packages and deployment

- `packages/schemas`: shared Zod schemas/types; capability and feature-policy contracts.
- `packages/core`: Worker-safe envelopes, errors, logging, AES-GCM session/grant helpers.
- `packages/university-adapters`: `src/types.ts` defines `UniversityAdapter`; `src/registry.ts` registers `mock`, `uet`, `vnu`; implementation remains university-grouped.
- `packages/automation-protocol`: encrypted automation job/event/result and keyring contracts.
- `deploy/k8s`: Kustomize base/overlays; `deploy/helm/hyeboard`: Helm chart. Dependency placement is topology-specific, not universally external. Consult values/manifests and `docs/kubernetes-deployment.md`; Redis Operator/CRDs and secrets need operator ownership.

### Organization rules

Keep cohesive behavior and its unit tests together in the existing domain directory. Keep entrypoints thin where practical; do not grow a new root-level collection of unrelated helpers. Share through the owning module, not duplicate utilities or catch-all barrels. Preserve package exports, lazy loading, and runtime boundaries when moving files. Update import paths, test mocks, source-relative assets, scripts, configuration, and durable documentation together. Small packages do not need directories for their own sake.

## Change workflow

1. Read the owning implementation and tests; trace callers of shared functions. Check `git status --short` and preserve unrelated changes.
2. Follow the existing schema, adapter, API, query, and UI path. Choose the smallest coherent change.
3. Add the smallest regression test that would fail without a behavioral fix. For path-only moves, preserve test discovery and prove imports/builds still work rather than inventing behavior tests.
4. Run focused diagnostics/tests, then the changed-surface gates below. Typechecking alone is insufficient.
5. Run `git diff --check`; review the exact diff, including newly added/moved files. Report commands, outcomes, and unverified surfaces.

No commits, branches, issues, PRs, deployments, history rewriting, or force-pushes unless requested.

## Web development rules

### Queries, policy, and recovery

- TanStack Query owns server state. Keys include feature and active university/session scope. `useFeatureQuery` in `src/state.tsx` and `FeatureFrame` in `src/components/shared.tsx` are the default feature path.
- New account-scoped queries must participate in `INVALIDATABLE_QUERY_NAMES` in `src/lib/policy/query-scope.ts`. Preserve the distinct nonce position used by `vnu-` keys.
- `/api/universities` contains effective live policy, not immutable metadata. Keep it cached normally; policy events explicitly cancel affected scoped queries and invalidate universities before feature refetches. Do not globally invalidate unrelated accounts.
- Account switch, refresh, and removal must not expose prior-account data. `student-policy.ts` masks disabled or unavailable dashboard identity/sections.
- VNU `requestPolicyFor` distinguishes `safe-replay`, `refresh-no-replay`, and `never`. Charged cross-lookups/bulk operations may refresh but must not automatically replay. Preserve acknowledged results/exports and stale-account commit guards.
- Terminal VNU refresh codes include `VNU_REFRESH_GRANT_INVALID`, `VNU_REFRESH_GRANT_REVOKED`, `INVALID_VNU_CREDENTIAL`, and `VNU_REFRESH_IDENTITY_MISMATCH`. Preserve the recovery owner's cleanup semantics.

### Internationalization and UI

- Add app-authored strings to both `en` and `vi` dictionaries in `src/lib/i18n.tsx`. Access the typed tree (`t.nav.dashboard`), never `t("nav.dashboard")`.
- Do not translate backend data/enums unless explicitly mapped. Locale flags use inline SVG `FlagIcon`, not emoji. `formatCurrency` intentionally uses VND/`vi-VN` regardless of locale.
- Use local `components/ui` primitives; never run the shadcn CLI. Preserve semantic controls, visible focus, labels, and practical 44px touch targets.
- Prefer flat rows in one bordered section. Avoid cards inside cards, gradient text, glassmorphism, glow hover effects, decorative sparklines, and colored side-stripe borders wider than 1px.
- Theme tokens live in `src/styles.css`. Preserve light/dark, UET/VNU palettes, and the pre-JS fallback. User hue writes primary/accent/ring/sidebar variables inline; retain CSS fallbacks.
- Keep PDFMake and other heavy optional modules outside the initial entry graph. Reuse `term-academic-summary.ts` for derived academic values; never present derived GPA as upstream authority. Exports use allowlisted, sanitized models in `lib/export/data-export.ts`.

## Admin and feature policy

- Owners: worker `src/admin/`, `src/policy/`, schemas `src/{capabilities,feature-policy}.ts`; web `lib/admin`, `pages/admin`, `components/admin`.
- Preserve HttpOnly/SameSite/path-scoped cookies, HTTPS Secure behavior, accepted-origin and `X-Hyeboard-CSRF` checks, JSON mutation validation, and `no-store` responses.
- OAuth uses state, PKCE S256, exact numeric provider-ID allowlists, and constrained admin return paths. Never infer live OAuth success from unit tests.
- Publications require a reason and current base revision; actor comes from authenticated server context. Audit revisions are immutable. Rollback publishes a new revision. Handle `ADMIN_POLICY_CONFLICT` explicitly; never overwrite newer policy silently.
- Preserve last-known-good policy on later student-read outages; no cached policy fails with `FEATURE_POLICY_UNAVAILABLE`. Admin authoritative reads/writes fail on authority outages. A committed publication stays committed if its notification fails; reconciliation must remain available.

## Runtime authority and operations

| Mode | Authority and coordination | Boundary |
| --- | --- | --- |
| Cloudflare | Durable Objects for CAPTCHA, VNU budgets/refresh, feature policy | `src/index.ts` wires bindings; no Node DB/bootstrap imports |
| Node/Bun memory | Process-local session/cache/relay coordination; local SQLite policy (`data/admin.sqlite`, override `HYEB_ADMIN_DB_PATH`) | Single-process, not replica-safe; not entirely ephemeral; no durable linked-pair VNU refresh authority |
| Node/Bun distributed | PostgreSQL session revocation, VNU refresh/grant state, policy; Redis cache/coordination/budgets/automation and policy events | No SQLite/local-authority fallback; dependency readiness and outage behavior remain explicit |

- Non-secret self-hosted defaults: `apps/worker/config.json`. `HYEB_SESSION_SECRET` is environment-only, at least 32 characters. Admin secret remains separate. Cloudflare secrets belong in Worker secrets, never Wrangler vars.
- PostgreSQL migrations are ordered, checksum-verified, advisory-locked, and transactional per migration. Add migrations; do not rewrite/delete applied ones. Preserve bundled migration placement and startup failure behavior.
- `/api/live` and `/api/ready` differ. Do not turn dependency failures into healthy readiness or bypass session epoch/revocation checks.
- Automation credentials open only inside the executor boundary; results/events follow encrypted protocol contracts. Preserve ownership/fence validation, heartbeats, cancellation signals, bounded drain, and pending entries after shutdown/lease loss.
- Retryable automation failures remain pending until reclaim/delivery limits. Consumers must reject stale fences atomically; a lease alone is not result-authority proof.
- Patchright is local/single-worker only. Distributed automation uses Browserless/Puppeteer. `AUTOMATION_EXECUTOR_READY` / self-hosted `HYEB_AUTOMATION_EXECUTOR_READY` is an explicit gate: do not enable it or claim parity without successful target-provider validation.
- Preserve `AbortSignal` through upstream requests, browser work, CAPTCHA, and event streams.

## Adapter rules

Implement `UniversityAdapter`, validate external shapes, and register evidence-backed capabilities. Keep upstream URLs, authentication, retries, cancellation, parsers, and mappers in the adapter/client boundary; API code should not acquire new university-shape knowledge.

StudentHub `sessionStart`/`sessionEnd` are period ordinals, not clock hours. Render period numbers unless a verified timetable defines clocks. `ClassSession.weekday` is ISO Monday `1` through Sunday `7`.

VNU cross-lookup limits, probe budgets, exact-identity checks, permits, bounded search, and `no-store` behavior are security/abuse boundaries. Never raise, bypass, approximate, or cache them as a performance shortcut.

## Commands and verification

Run from repository root with pinned pnpm (`package.json`). Use pnpm directly; no PowerShell job/process wrappers that hide output. `lint`, `typecheck`, and worker `build` are TypeScript checks, not separate linting or Cloudflare packaging.

```bash
pnpm install --frozen-lockfile
pnpm dev                         # Vite :5173 + Wrangler :8787
pnpm dev:web
pnpm dev:worker
pnpm dev:node                    # Node API + Vite
pnpm dev:bun                     # Bun API + Vite
pnpm test                       # recursive workspace tests + benchmark lifecycle
pnpm build                      # web build + worker TypeScript + Node bundle
```

| Changed surface | Required checks |
| --- | --- |
| Web logic/components | `pnpm --filter @hyeboard/web test`; web build/typecheck for test/config coverage |
| Worker/API | `pnpm --filter @hyeboard/worker test` (both TS configs, ordinary Vitest, Worker pool) |
| Cloudflare Durable Objects | Include `pnpm --filter @hyeboard/worker test:workers` |
| Adapters/parsers/mappers | `pnpm --filter @hyeboard/university-adapters test` |
| Automation/protocol/shared packages | Corresponding `pnpm --filter @hyeboard/<package> test`; include callers when contracts change |
| Browser routes, DOM/ARIA, visible flows | Relevant `apps/web/tests/*.spec.ts`; release gate `pnpm test:browser` |
| Admin/policy | Auth separation, CSRF/origin, capability limits, publication/history/conflicts/rollback, event authentication; relevant admin browser specs |
| Packaging, imports, runtime entrypoints | `pnpm build`; `pnpm --filter @hyeboard/worker check:node-package`; `node scripts/package-config.test.mjs`; Cloudflare dry-run below; `pnpm package` for standalone artifact changes |
| PostgreSQL/Redis HA | `pnpm --filter @hyeboard/worker typecheck:ha`; `pnpm test:ha` with Docker available |
| Helm / Kustomize | `pnpm test:helm` / `pnpm test:k8s` respectively |
| Performance | Measure before/after; `pnpm audit:performance` for web bundle work |

`pnpm test` does not include browser, Helm, Kubernetes, HA, or the standalone package-config test. Do not imply otherwise. Historical browser coverage allocations are not the current test inventory.

### Server and deployment safety

- Worker `dev` must retain `--show-interactive-dev-session=false --log-level info`.
- Playwright uses fresh Wrangler/Vite servers with `reuseExistingServer: false`, zero retries, default one worker. Configure ports/workers through `PW_VITE_HOST`, `PW_VITE_PORT`, `PW_WORKER_PORT`, `PW_WORKERS`; Chromium excludes `@webkit`, WebKit selects it.
- Never kill by process name/pattern. Identify the exact port owner; stop only servers you started unless explicitly authorized.
- `pnpm deploy` uploads existing `apps/web/dist`; it does not rebuild web. Build first when source changed, deploy only when requested.
- Packaging without publishing: `pnpm --filter @hyeboard/worker exec wrangler deploy --dry-run`.

## Secrets and documentation

Never commit or expose `.env`, `.env.*` (except `.env.example`), `.dev.vars`, raw HARs, cookies/auth headers, JWTs/SAML, credentials/grants, CAPTCHA images, student PII, or PII-bearing responses. Keep Playwright reports/results, Wrangler state, build output, coverage, and scratch untracked. Only manually redacted captures belong in `samples/har-redacted/`; parse large HARs programmatically and print field names/shapes only. Follow `docs/har-security.md`.

Durable owners:

- `README.md`: product, setup, common commands, deployment entrypoints.
- `AGENTS.md`: agent operating rules; `CLAUDE.md` references this file, never duplicates it.
- `docs/architecture.md`: system design/security/runtime boundaries.
- `docs/admin-dashboard.md`: admin/policy contract and operations.
- `docs/ha-runbook.md`: HA configuration and rollout.
- `docs/kubernetes-deployment.md`: Helm/Kustomize prerequisites and operations.
- `apps/automation-worker/README.md`: executor contract and limitations.

Update durable docs with architecture/operator changes. `docs/superpowers/` contains historical plans, not current authority; do not add temporary audits/plans there. Report exact files, commands, failures, and residual risks. Never claim tests, builds, deployments, or performance improvements without fresh evidence.
