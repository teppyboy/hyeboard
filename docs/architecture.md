# Hyeboard Architecture

Hyeboard has one frontend/API contract and three runtime modes. Cloudflare deployments use one Worker containing the client-heavy dashboard and its API/BFF. Self-hosted Node/Bun deployments use the same API code through a separate Node-only entry point.

```txt
Cloudflare Worker
  ├─ static React assets (apps/web/dist)
  └─ /api/* BFF
       -> university adapter registry
       -> UET adapter
       -> StudentHub + Canvas upstream APIs
```

The frontend never calls university upstream systems directly. University-specific behavior lives in adapters.

Memory-mode self-hosted Node/Bun deployments run the bundled worker without Cloudflare Durable Objects. They lack durable linked-pair authority and automatic VNU relogin; existing process-local access-token revocation remains available. Distributed self-hosted mode adds PostgreSQL-backed refresh/grant authority and generic session revocation, while Cloudflare retains its Durable Object implementation.

## Runtime Modes

`memory` is the default self-hosted mode. It preserves single-process behavior with process-local cache/relay state and no shared replica authority.

`distributed` is the self-hosted HA mode. Its API replicas share PostgreSQL and Redis:

```txt
API replica A ─┐
API replica B ─┼─> PostgreSQL
API replica N ─┘       └─ VNU refresh/grant authority
       │               └─ generic session revocation
       └──────────────> Redis
                       └─ shared cache
                       └─ CAPTCHA relay
                       └─ VNU budgets, permits, leases
                       └─ shared coordination primitives
                       └─ automation streams (protocol foundation)
```

PostgreSQL migrations are ordered, checksum-checked, and protected by an advisory lock. PostgreSQL stores opaque/domain-separated session revocation hashes and VNU refresh-control state; it does not store raw session tokens, upstream credentials, or raw grants. Redis uses versioned, hashed keys and Lua/CAS-style primitives for shared ephemeral coordination. Redis does not replace PostgreSQL as the authority for revocation or durable VNU refresh state.

Redis single-flight/lock and refresh-coordination implementations exist as standalone primitives, but not every primitive is wired into the API. The currently wired distributed API uses PostgreSQL for VNU refresh authority and Redis for the shared cache, CAPTCHA relay, and VNU probe/permit coordination.

`cloudflare` is selected by the Cloudflare entry point and keeps the existing Durable Object implementations for CAPTCHA relay, VNU probe budgets, and VNU refresh control. `config.json` and Node-only PostgreSQL/Redis imports are outside the Cloudflare bundle.

Distributed startup is intentionally fail-closed. If PostgreSQL or Redis is absent or unavailable, `/api/live` can still report the process as alive, while `/api/ready` reports `503` and dependent operations return a typed dependency-unavailable error. There is no hidden fallback from distributed authority to process-local state.

## UET Sources

- StudentHub (`studenthub.uet.edu.vn`): profile, timetable, terms, grades, GPA, bills, exams, notifications, news, training points, service requests.
- Canvas (`portal.uet.vnu.edu.vn`): courses, planner items, assignments/quizzes/announcements, missing submissions, unread conversations, optional files.

## Session Model

University upstream origins make browser-managed third-party cookies fragile. Hyeboard therefore uses an encrypted Bearer token:

1. API receives or discovers upstream credentials.
2. API encrypts them with AES-GCM using `HYEB_SESSION_SECRET`.
3. Web stores the opaque token and sends `Authorization: Bearer <token>`.
4. API decrypts per request and replays credentials upstream.

No upstream cookies, tokens, SAML payloads, or personal data are logged.

When distributed mode is active, newly issued or refreshed sessions carry an opaque `sessionId` and the configured `sessionEpoch`. Enforcement is disabled by default for rollout compatibility. A one-time cutover sets the same new epoch and `HYEB_HA_ENFORCE_SESSION_EPOCH=true` on every replica; pre-cutover tokens, including legacy tokens without metadata, then fail as `SESSION_EXPIRED` and require login again. The session encryption secret is not rotated for this operation.

## Health And Lifecycle

- `/api/health` preserves the existing `{status:"ok",service:"hyeboard"}` health response.
- `/api/live` reports liveness independently of dependency readiness and returns `503` only after the lifecycle is stopped.
- `/api/ready` runs the lifecycle dependency checks and returns `503` for starting, degraded, draining, or stopped state. Its safe diagnostics include mode, state, timestamp, and dependency statuses without URLs, reasons, credentials, or tokens.

Node/Bun `SIGINT`/`SIGTERM` handling is idempotent. Shutdown drains the HTTP server first, then closes cached browser sessions, Redis, and the PostgreSQL pool under a bounded timeout. A timeout is recorded rather than allowing cleanup to block the process indefinitely; cleanup handlers remain responsible for their own cancellation.

## Admin Feature Control

Admin authentication is separate from student sessions. Password login uses a versioned PBKDF2 hash; GitHub and Discord login require exact numeric user-ID allowlists. Admin session tokens use `HYEB_ADMIN_SESSION_SECRET`, so rotating that secret invalidates admin sessions without rotating student tokens.

Feature policy storage follows runtime authority: Cloudflare uses the `FEATURE_POLICY` Durable Object, self-hosted memory mode uses local SQLite, distributed mode uses PostgreSQL plus Redis revision events. Distributed mode never mounts or falls back to local SQLite. Revision 0 is the empty override policy, so initial effective capabilities match adapter evidence. Publishing requires the current base revision and creates an immutable audit entry; rollback publishes a new revision rather than rewriting history.

Student reads retain the last successfully loaded policy during a later store outage; a replica with no cached policy fails with `FEATURE_POLICY_UNAVAILABLE`. Admin writes fail during authority outages. A publication remains committed if its propagation notification fails and logs a warning so replicas reconcile on their next authoritative read. Distributed readiness includes the PostgreSQL policy store and Redis policy-event dependency; neither failure downgrades to process-local authority.

## Academic Summaries and Exports

`apps/web/src/lib/term-academic-summary.ts` is the single pure definition of listed credits, included credits, derived term GPA, and running CPA. Grades and cross-transcript views normalize their rows into it. Portal-reported cumulative values stay separate; derived values never claim university authority.

`apps/web/src/lib/data-export.ts` builds versioned allowlisted documents from already-sanitized browser state. JSON preserves structure and calculator precision. CSV uses fixed machine columns, UTF-8 BOM, CRLF, deterministic order, formula defense, and text-safe identifiers. Downloads use temporary object URLs and always revoke them. No export path contacts an API or writes browser/server persistence.

## VNU Cross-Lookup Boundary

The code-to-ID resolver probes only the arithmetic projection and its closed ±16 neighborhood. It verifies exact eight-digit header equality, uses bounded projection-local concurrency, and cancels siblings after a deterministic winner or fatal failure. It never performs a wide/cohort search or returns an approximation.

Every route or accepted bulk chunk reserves its conservative Brc1 allowance once through the per-session Durable Object before upstream work. Candidate probes consume only that local allowance. Direct routes reserve 1 unit, code-to-ID reserves 33, and code-to-transcript reserves 34. Browser bulk runs use optional `/api/universities` limit metadata, but fixed Worker chunk validation and Durable Object enforcement remain the security boundary.

## VNU Automatic Relogin

VNU access tokens and reconnect grants are separate AES-GCM protocols. Grant keys use an HKDF context distinct from access-token encryption. Grants contain the VNU credentials needed for one tab's reconnect flow; access tokens do not.

`VnuRefreshControlDurableObject` is addressed by an HMAC-derived normalized-username principal. It stores random access-token IDs, grant IDs, expiry, a two-minute lease, and a five-attempt/fifteen-minute window—never credentials, raw tokens, or student identity. The encrypted access descriptor carries the opaque principal, exact linked IDs, and both expiries, so logout can atomically revoke its exact active pair even when a new tab has no browser grant. Logout validates any optional grant completely before its sole authoritative revoke call. A fully expired authenticated descriptor remains an idempotent access-only removal proof after authority cleanup, while any live-half mismatch fails closed. Every authority transition reports changed/no-op; no-op operations write neither state nor alarms. Active ordinary checks read authority without rewriting state or alarms; stale cleanup enters a transaction once. Refresh cryptographically decodes the outer access token through a refresh-only path, rejects principal/link mismatches without mutation, checks authority, performs one live login, verifies the live profile, and atomically revokes the old pair while activating the new pair before returning. Ordinary descriptor-bearing session resolution also checks this authority and fails closed when unavailable.

The browser coordinates one refresh per local account and failed access token. It replays only explicit side-effect-free VNU reads once. Bulk and charged cross-lookups may refresh but require a manual retry; acknowledged browser results and exports remain intact.

## Automation Boundary

The automation protocol and `apps/automation-worker` provide encrypted job envelopes, Redis Streams interfaces, consumer-group reclaim, fencing, heartbeats, cancellation, result envelopes, and graceful worker drain. The Browserless provider keeps its token in the connector closure and exposes only safe ownership metadata. The executable host CLI bridge supplies the Redis clients, Browserless/Puppeteer connector, and UET executor. The UET adapter receives the worker-owned Puppeteer session and checks ownership before browser operations.

The distributed API produces those jobs and consumes their result/event stream. The Browserless image is pinned to `ghcr.io/browserless/chromium:v2.55.4`, was pulled manually, and started successfully; a live Puppeteer CDP smoke test passed against `ws://127.0.0.1:3000/chromium`, including a token query. A real distributed Browserless/UET Google login was attempted with credentials supplied through the local ignored `.env`, local PostgreSQL/Redis, the API, and the automation worker. `/api/ready` reached ready and `pnpm test:ha` passed PostgreSQL 5/5 and Redis 4/4. Login progress reached `0, 10, 35, 35, 60` before HTTP 502 code `GOOGLE_SIGNIN_FAILURE`; the worker logged Puppeteer `Attempted to use detached Frame ...` while waiting for Keycloak `#username`. Because the real login did not pass, the distributed API does not claim full browser-automation feature parity. The node-redis stream read-shape fix was committed as `f7c78fd`. `AUTOMATION_EXECUTOR_READY` remains an explicit opt-in gate, and inline Google browser automation is rejected with an explicit backend-unconfigured error until the bridge is enabled. Patchright remains permitted only for local/single-worker execution; distributed API and worker configuration reject it.

Live PostgreSQL and Redis HA tests cover two-process coordination and outage/drain behavior when Docker is available. Kubernetes templates now live under `deploy/k8s`: two API replicas, two automation workers, readiness/liveness probes, rolling updates, PDBs, HPA, anti-affinity, external dependency secrets, and egress policies. Production rollout still requires target-cluster round-robin, failure-injection, session-cutover, and browser-provider validation. Docker image definitions are in `Dockerfile` and `apps/automation-worker/Dockerfile`.
