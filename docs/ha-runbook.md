# HA Runbook

This runbook covers the self-hosted HA foundation and the Kubernetes deployment template. The Kubernetes resources assume managed PostgreSQL, Redis, and Browserless services; they do not create database infrastructure.

## Modes

- `memory`: single-process Node/Bun operation. It is the safe default for local development and preserves process-local behavior; it is not replica-safe.
- `distributed`: Node/Bun API replicas share PostgreSQL and Redis. Both dependencies are required for ready operation.
- `cloudflare`: the Wrangler entry point with the existing Durable Object bindings. Use Cloudflare configuration, not this Node/Bun runbook, for that mode.

Do not use `HYEB_HA_MODE=cloudflare` to make a self-hosted process emulate Durable Objects. The Cloudflare entry point selects and installs those bindings.

## Self-Hosted Configuration

`HYEB_SESSION_SECRET` is required for every self-hosted API process and must be at least 32 characters. It is read from the environment only. Keep it, database credentials, Redis credentials, and Browserless tokens out of `config.json`, `.env.example`, logs, and source control.

For memory mode:

```txt
HYEB_SESSION_SECRET=
HYEB_HA_MODE=memory
```

For each distributed API replica, use the same values for the shared settings and a distinct node ID:

```txt
HYEB_SESSION_SECRET=
HYEB_HA_MODE=distributed
HYEB_HA_NODE_ID=api-a
HYEB_HA_SESSION_EPOCH=0
HYEB_HA_ENFORCE_SESSION_EPOCH=false
HYEB_POSTGRES_URL=
HYEB_REDIS_URL=
HYEB_SHUTDOWN_TIMEOUT_MS=10000
```

`DATABASE_URL` is accepted as an alias for `HYEB_POSTGRES_URL`; `REDIS_URL` is accepted as an alias for `HYEB_REDIS_URL`. Use one PostgreSQL URL and one Redis URL. The URLs above are intentionally blank: supply them through the deployment environment, not a checked-in file. `HYEB_HA_NODE_ID` is optional in the parser but recommended for every replica so readiness and operator diagnostics identify the process.

`apps/worker/config.json` may carry non-secret defaults. Environment variables override matching values. `HYEB_HA_MODE=distributed` without both shared URLs starts the process degraded; it does not downgrade to memory mode.

Start the self-hosted API with `pnpm dev:node`, `pnpm dev:bun`, or the packaged `node dist/index.js`/`bun run dist/index.js` entry point. The distributed entry point runs ordered PostgreSQL migrations before marking PostgreSQL-backed dependencies ready.

## Shared Storage Roles

PostgreSQL is authoritative for:

- VNU refresh/grant activation, refresh leases, tombstones, and revocation transitions.
- Generic token and session revocation, stored as domain-separated opaque hashes with expiry.
- Ordered migration state and checksums.

Redis provides in the currently wired distributed API:

- Shared cache used by the API.
- CAPTCHA relay state, answer/cancel transitions, timeout, and cross-process wakeup.
- VNU probe budgets, Brc1 permits, cross-detail permits, leases, and rate-window primitives.

The repository also contains Redis single-flight/lock and refresh-coordination primitives. They are tested building blocks, but not all are wired into the API; PostgreSQL remains the current API authority for VNU refresh state.

Redis provides automation job/event streams for the standalone automation-worker foundation.

Redis outages and PostgreSQL outages fail closed for operations that require the affected authority. They do not turn a distributed process into a memory-mode process.

## Health And Shutdown

Check all three public endpoints on every replica:

```bash
curl -fsS http://127.0.0.1:8787/api/health
curl -fsS http://127.0.0.1:8787/api/live
curl -i http://127.0.0.1:8787/api/ready
```

Expected behavior:

- `/api/health` preserves the legacy service health response.
- `/api/live` is `200` while the process is alive, even when a dependency is unavailable; it becomes `503` after stop.
- `/api/ready` is `200` only when lifecycle state is `ready`; startup, degraded dependencies, draining, and stopped state return `503`.
- Readiness diagnostics expose only safe mode/state/dependency fields. They do not expose URLs, credentials, tokens, or probe error details.

Send `SIGTERM` for a normal stop. The API marks itself draining, stops accepting new work through the server shutdown path, closes cached browser sessions, closes Redis clients and the PostgreSQL pool, and exits once the bounded shutdown budget completes. `SIGINT` follows the same idempotent path. A timeout is recorded in the lifecycle report; it is not a license to treat an interrupted browser or stream operation as acknowledged.

## Session Epoch Cutover

The epoch is a one-time invalidation boundary for existing self-hosted sessions. Do not rotate `HYEB_SESSION_SECRET` as part of this procedure.

1. Provision PostgreSQL and Redis, run the distributed API with `HYEB_HA_ENFORCE_SESSION_EPOCH=false`, and confirm every replica reports ready.
2. Select one new non-negative epoch, set the same `HYEB_HA_SESSION_EPOCH` on every replica, and restart/roll the replicas consistently.
3. Enable `HYEB_HA_ENFORCE_SESSION_EPOCH=true` on every replica using that same epoch.
4. Confirm a legacy session is rejected with `SESSION_EXPIRED`, then sign in again to mint a session carrying the current epoch.
5. Keep the epoch and enforcement setting stable. A later intentional invalidation repeats the policy with another explicitly chosen epoch, but is a separate operational cutover.

While enforcement is disabled, old sessions remain accepted for compatibility. Once enabled, tokens without session ID/epoch metadata and tokens with a mismatched epoch require login again. This is expected behavior, not an upstream university-session failure.

## Automation Status

The standalone `apps/automation-worker` and `packages/automation-protocol` foundations currently provide:

- Encrypted job, credential, result, and event envelopes with expiry and key IDs.
- Redis Streams consumer groups, pending-message reclaim, job leases, fencing, heartbeats, retries, cancellation, and bounded shutdown drain.
- A Browserless/Puppeteer provider with reconnect metadata and no token in exposed connection metadata.

The distributed API now enqueues encrypted UET jobs, consumes validated event/result streams, and exposes signed CAPTCHA answer/cancel controls. The executable host CLI bridge in `apps/automation-worker` supplies the UET executor and Browserless/Puppeteer provider, and the UET adapter uses the worker-owned Puppeteer session with ownership checks around browser work. StudentHub's current `Đăng nhập với VNU mail` button uses Google Identity Services with FedCM; FedCM hides the popup target that the worker must drive through VNU Keycloak. Browserless sessions therefore launch Chromium with `--disable-features=FedCm`, restoring the popup-compatible path. `AUTOMATION_EXECUTOR_READY` remains an explicit deployment gate; the bridge does not by itself establish full feature parity.

In distributed API mode, inline Google browser automation is rejected with `AUTOMATION_BACKEND_UNCONFIGURED`, and the queue backend remains unavailable unless `AUTOMATION_EXECUTOR_READY=true` is explicitly configured. The Browserless image is pinned to `ghcr.io/browserless/chromium:v2.55.4`, was pulled manually, and started successfully; a live Puppeteer CDP smoke test passed against `ws://127.0.0.1:3000/chromium`, including a token query. A real distributed Browserless/UET Google login was attempted with credentials supplied through the local ignored `.env`, local PostgreSQL/Redis, the API, and the automation worker. `/api/ready` reached ready and `pnpm test:ha` passed PostgreSQL 5/5 and Redis 4/4. Login progress reached `0, 10, 35, 35, 60` before HTTP 502 code `GOOGLE_SIGNIN_FAILURE`; the worker logged Puppeteer `Attempted to use detached Frame ...` while waiting for Keycloak `#username`. The real login did not pass. The node-redis stream read-shape fix was committed as `f7c78fd`. Manual credential paths that do not need a browser remain governed by their existing adapter behavior.

Patchright is prohibited in distributed mode. The API rejects `HYEB_BROWSER_PATCHRIGHT=true` in distributed HA mode, and the automation worker rejects `AUTOMATION_EXECUTION_MODE=distributed` with `AUTOMATION_BROWSER_PROVIDER=patchright`. Patchright is available only for local/single-worker execution. Distributed automation must use Browserless/Puppeteer.

If the standalone worker is exercised before API integration, its required environment variable names are:

```txt
REDIS_URL=
BROWSERLESS_ENDPOINT=
BROWSERLESS_TOKEN=
AUTOMATION_KEY_CURRENT_ID=
AUTOMATION_KEY_CURRENT_B64=
```

`BROWSERLESS_TOKEN` and `AUTOMATION_KEY_CURRENT_B64` are intentionally blank. The Browserless endpoint must not contain a token query parameter. `AUTOMATION_KEY_PREVIOUS_ID` and `AUTOMATION_KEY_PREVIOUS_B64` are optional rotation inputs and must be supplied together. The worker has additional optional stream, lease, heartbeat, reclaim, retry, result-TTL, and shutdown settings with code defaults.

## Opt-In Integration Tests

The Testcontainers suites are intentionally opt-in and are not part of the default root test command. They require a working Docker daemon and the `postgres:16-alpine` and `redis:7-alpine` images:

```bash
docker pull postgres:16-alpine redis:7-alpine
pnpm test:ha:postgres
pnpm test:ha:redis
pnpm test:ha
```

The PostgreSQL suite checks shared session revocation, refresh serialization, outage behavior, readiness, and SIGTERM drain across two worker processes. The Redis suite checks cross-process refresh coordination, CAPTCHA relay, Redis outage behavior, readiness/liveness separation, and SIGTERM drain. If Docker or an image is unavailable, the suites report a skip rather than a fake passing integration result.

The latest CI `pnpm test:ha` run passed PostgreSQL 5/5 and Redis 5/5, including automation crash reclaim with a replacement fencing lease; `/api/ready` reached ready during the distributed run. These tests cover the shared-dependency and failure-handling foundation. Browserless/UET login remains deployment-specific and must be validated with the target provider before enabling automated sign-in.

## Kubernetes deployment

The manifests in [`deploy/k8s`](../deploy/k8s) run two API replicas and two automation workers by default. The API Deployment uses `/api/live` for liveness, `/api/ready` for dependency-backed readiness, rolling updates with no unavailable replicas, resource requests, an HPA, and a PDB. Both Deployments prefer different nodes and use best-effort hostname topology spreading; this distributes replicas when nodes are available without blocking HPA overflow on smaller clusters. Cluster validation additionally requires the two ready replicas of each Deployment to occupy two distinct nodes. The example Ingress disables proxy buffering for the long-lived automation SSE route. Their disruption budgets permit at most one unavailable replica, including after scale-up. Worker pods expose `/healthz` and `/readyz` after Redis and Browserless startup checks pass. The worker Deployment has a CPU/memory HPA from 2 to 8 replicas; it is a conservative fallback because native Kubernetes metrics do not measure Redis queue depth.

Before applying the example overlay:

CI uses `deploy/k8s/overlays/ci` with a disposable three-node Kind cluster. It runs PostgreSQL, Redis, and Browserless inside the cluster, loads the CI images, enables metrics-server for HPA status, and executes the same round-robin/failover validator. This proves the Kubernetes wiring in an ephemeral cluster; it does not replace target-cluster or real UET credential validation.

1. Build and publish both images, then replace the image tags in `deploy/k8s/overlays/example/kustomization.yaml`. From the repository root:

```bash
docker build -t ghcr.io/teppyboy/hyeboard-api:<tag> .
docker build -t ghcr.io/teppyboy/hyeboard-automation-worker:<tag> -f apps/automation-worker/Dockerfile .
docker push ghcr.io/teppyboy/hyeboard-api:<tag>
docker push ghcr.io/teppyboy/hyeboard-automation-worker:<tag>
```

Use immutable release tags, not `latest`, for production.
2. Provision PostgreSQL, Redis, and Browserless outside this repository. Put their URLs and credentials in a Secret named `hyeboard-runtime`; start from `deploy/k8s/base/secret.example.yaml` without applying it unchanged.
3. Set the production hostname and TLS Secret in `deploy/k8s/overlays/example/ingress.yaml`.
4. Set the session epoch and enforcement flag together during the planned session cutover.
5. Render and inspect the overlay, then apply it:

```bash
pnpm test:k8s
kubectl kustomize deploy/k8s/overlays/example
kubectl apply -k deploy/k8s/overlays/example
kubectl rollout status deployment/hyeboard-api -n hyeboard
kubectl rollout status deployment/hyeboard-automation-worker -n hyeboard
node scripts/validate-k8s-cluster.mjs --failover
```

The example NetworkPolicy restricts API and worker egress to DNS, HTTPS, and the configured PostgreSQL, Redis, and Browserless ports. It leaves ingress open so managed ingress controllers and kubelet probes work across CNI implementations; add an ingress allowlist matching the target cluster before production exposure.

`validate-k8s-cluster.mjs` requires `kubectl` access to the target namespace. It checks both rollouts, two ready replicas per Deployment on distinct nodes, two API Service endpoints, active HPA metrics, one Service-minted mock session against every API pod, twenty in-cluster readiness requests, and—in `--failover` mode—service availability while one API pod is deleted and replaced.

The Kubernetes resources do not remove the runtime gates below. The example overlay starts with `HYEB_AUTOMATION_EXECUTOR_READY=false`; enable it only after the real Browserless/UET executor gate passes. Run the resources against the target cluster and dependencies before exposing the service to production:

- Two API replicas work under round-robin traffic without sticky sessions.
- VNU refresh, cross-lookup authority, and generic revocation are shared and survive replica restart.
- CAPTCHA works across replicas.
- Browser jobs reclaim safely with fencing once the API queue integration exists.
- Redis and PostgreSQL outages fail closed where required.
- Readiness and graceful shutdown are verified, including browser/Redis/PostgreSQL cleanup.
- The explicit session epoch cutover policy is verified.
- Patchright cannot be enabled in distributed mode.
- `pnpm build`, `pnpm test`, Playwright, Node package checks, and the Wrangler dry-run pass.

Until this gate passes, keep the Kubernetes overlay in staging. Production traffic requires the full multi-replica and failure-injection evidence above.
