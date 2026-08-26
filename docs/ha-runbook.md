# HA Runbook

This runbook covers self-hosted memory/distributed containers and the Kubernetes deployment templates. Kubernetes keeps PostgreSQL external, can run Browserless in-cluster, and uses the OT-CONTAINER-KIT Redis Operator for production Redis replication and Sentinel failover.

## Prerequisites

For Docker and Compose, install Docker Engine with a running daemon, Docker Compose v2, and BuildKit/buildx. Verify the daemon and tools before using the commands below:

```bash
docker info
docker compose version
docker buildx version
```

For Kubernetes, install `kubectl` with a Kustomize-capable version, select the intended context, and confirm access with `kubectl cluster-info`. Applying an overlay additionally requires an ingress controller with class `nginx`, a metrics API for HPA, TLS Secrets, permissions to create/update resources in the target namespace, and enough capacity for the selected replica count. The manifests use soft topology spreading, so both single-node test clusters and multi-node production clusters are supported; replicas may co-locate when capacity is limited.

PostgreSQL, Redis, and Browserless must be reachable from the API/worker in distributed mode. Compose starts local instances for its `distributed` profile. Kubernetes staging may use managed/external Redis and Browserless; the production overlay runs RedisReplication and Browserless in-cluster. Browserless is represented by the pinned image `ghcr.io/browserless/chromium:v2.55.4`; this pin is not a claim of Browserless/UET parity.

## Modes

- `memory`: single-process Node/Bun operation. It is the safe default for local development and preserves process-local behavior; it is not replica-safe.
- `distributed`: Node/Bun API replicas share PostgreSQL and Redis. Both dependencies are required for ready operation.
- `cloudflare`: the Wrangler entry point with the existing Durable Object bindings. Use Cloudflare configuration, not this Node/Bun runbook, for that mode.

Do not use `HYEB_HA_MODE=cloudflare` to make a self-hosted process emulate Durable Objects. The Cloudflare entry point selects and installs those bindings.

## Docker Compose

Copy `compose.env.example` to the ignored `compose.env`, generate the required secret values, and validate both profiles before starting a stack:

```bash
cp compose.env.example compose.env
docker compose --env-file compose.env --profile memory config --quiet
docker compose --env-file compose.env --profile distributed config --quiet
```

The `memory` profile starts only `api-memory` and forces `HYEB_AUTOMATION_EXECUTOR_READY=false`. The `distributed` profile starts `api`, `postgres`, `redis`, `browserless`, and `automation-worker`; only the API port is published to the host. The other services use the private `hyeboard` network. PostgreSQL and Redis data persist in named volumes.

Start and inspect a selected profile as follows:

```bash
docker compose --env-file compose.env --profile memory up -d --build
curl -fsS http://127.0.0.1:8787/api/ready
docker compose --env-file compose.env --profile memory down

docker compose --env-file compose.env --profile distributed up -d --build
docker compose --env-file compose.env --profile distributed ps
```

The distributed profile uses `postgres:16.10-alpine`, `redis:7.4.5-alpine`, and `ghcr.io/browserless/chromium:v2.55.4`. Keep `HYEB_AUTOMATION_EXECUTOR_READY=false`; this local stack is not evidence of Browserless/UET parity. Use `docker compose ... down -v` only when intentionally deleting the local PostgreSQL and Redis volumes.

## Self-Hosted Configuration

`HYEB_SESSION_SECRET` is required for every self-hosted API process and must be at least 32 characters. It is read from the environment only. Keep it, database credentials, Redis credentials, and Browserless tokens out of `config.json`, `.env.example`, logs, and source control.

Generate values with a cryptographically secure source and inject them through the deployment environment or secret manager:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" # HYEB_SESSION_SECRET
openssl rand -hex 24                                                   # PostgreSQL password
openssl rand -base64 32                                                # AUTOMATION_KEY_CURRENT_B64
```

Use a unique `AUTOMATION_KEY_CURRENT_ID` for the generated automation key. Supply `AUTOMATION_KEY_PREVIOUS_ID` and `AUTOMATION_KEY_PREVIOUS_B64` together only during key rotation. Obtain `BROWSERLESS_TOKEN` from the Browserless operator; do not encode it into `BROWSERLESS_ENDPOINT`.

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

## Admin Feature Control

### Bootstrap and authentication

Generate the password hash with the repository command. Its TTY prompt is masked and stdout contains only the versioned PBKDF2 hash:

```bash
pnpm --filter @hyeboard/worker admin:hash-password
```

Set `HYEB_ADMIN_SESSION_SECRET` to a separate random value of at least 32 characters. Rotating it immediately invalidates every admin session; it does not invalidate student sessions. Set `HYEB_ADMIN_PASSWORD_HASH` to the generated output when password login is wanted. OAuth login requires each provider's client ID, client secret, and comma-separated allowlist of canonical numeric user IDs. Do not use usernames, email addresses, or leading-zero IDs. Set the exact public HTTPS origin, without a trailing slash:

```text
HYEB_ADMIN_SESSION_TTL_SECONDS=3600
HYEB_ADMIN_GITHUB_CLIENT_ID=
HYEB_ADMIN_GITHUB_IDS=123456789
HYEB_ADMIN_DISCORD_CLIENT_ID=
HYEB_ADMIN_DISCORD_IDS=123456789012345678
HYEB_ADMIN_PUBLIC_ORIGIN=https://hyeboard.example.com
```

`HYEB_ADMIN_PUBLIC_ORIGIN` is the canonical proxy/TLS authority for admin cookies and OAuth callbacks. Set it to the exact external HTTPS origin when TLS terminates before Hyeboard. Hyeboard does not trust `X-Forwarded-Proto`; without a public origin, cookie security follows only the direct request URL, suitable for direct local HTTP/HTTPS mode.

Register these OAuth callbacks:

```text
https://hyeboard.example.com/api/admin/oauth/github/callback
https://hyeboard.example.com/api/admin/oauth/discord/callback
```

Secrets stay in the environment, Kubernetes Secret, Helm `secrets.existingSecret`, or Wrangler secrets. Cloudflare also requires the existing `FEATURE_POLICY` Durable Object binding and its `v4` migration. Never put admin secrets in `wrangler.jsonc` vars.

### Policy lifecycle and recovery

A new store starts at revision 0 with no overrides. Effective capabilities therefore match the adapter's current evidence-backed capabilities. Before publishing, review the draft diff, supply an operator reason, and publish against the displayed base revision. A stale base revision returns a conflict and preserves the draft for review. Rollback selects an earlier audit entry and publishes its policy as a new revision; history is never rewritten.

If the policy store is unavailable, admin reads/writes fail explicitly and distributed readiness reports the policy dependency unavailable. A replica that already loaded a student policy retains that last-known-good snapshot; a replica without one fails with `FEATURE_POLICY_UNAVAILABLE`. If a publication commits but Redis propagation fails, the API logs a warning and other replicas reconcile on their next authoritative read; restore Redis before another publication. PostgreSQL and Redis remain required distributed authorities. There is no process-local or SQLite fallback.

Memory mode stores policy history at `HYEB_ADMIN_DB_PATH`, default `./data/admin.sqlite`. The Compose memory profile mounts `/app/data` on the `hyeboard-admin` volume. Back up the SQLite file with the process stopped or with a SQLite-consistent backup tool; restore it at the same configured path before starting the replacement container. Without persistent writable storage, container replacement loses local admin history. Distributed mode stores history in PostgreSQL and must not set `HYEB_ADMIN_DB_PATH` or mount an admin SQLite volume.

For Kubernetes or Helm, add these keys to the existing runtime Secret:

```text
HYEB_ADMIN_SESSION_SECRET
HYEB_ADMIN_PASSWORD_HASH (optional)
HYEB_ADMIN_GITHUB_CLIENT_SECRET (optional)
HYEB_ADMIN_DISCORD_CLIENT_SECRET (optional)
```

Set non-secret TTL, client IDs, numeric ID allowlists, and public origin in the Kustomize ConfigMap overlay or Helm `config.runtime`. Helm `config.runtime` and `config.extraData` allow arbitrary primitive non-secret settings, but reject known secret names and `HYEB_ADMIN_DB_PATH`; `config.extraData` also cannot repeat a `config.runtime` key. External Secret references are the sole source for secret values. The API `extraEnv` list rejects duplicate names and every name managed through the runtime ConfigMap or explicit chart environment fields. These checks run inside Helm templates; `scripts/validate-helm.mjs` remains defense in depth. Configure chart secrets through `secrets.existingSecret` only. Keep provider triples complete: client ID, secret, and at least one numeric ID. Validate before rollout:

```bash
node scripts/package-config.test.mjs
pnpm test:k8s
pnpm test:helm
```

After rollout, verify `/api/ready`, admin login, current revision, one no-op draft review, and student policy propagation. Do not publish a capability change during a degraded dependency state.

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

The API and worker expose the encrypted queue, event, CAPTCHA-control, Browserless/Puppeteer, and ownership boundaries described above. `HYEB_AUTOMATION_EXECUTOR_READY` remains an explicit deployment gate. The presence of the bridge or a healthy Browserless process is not evidence that automated university login is production-ready, and this repository makes no Browserless/UET parity claim.

In distributed API mode, inline browser automation is rejected with `AUTOMATION_BACKEND_UNCONFIGURED`, and the queue backend remains unavailable unless `HYEB_AUTOMATION_EXECUTOR_READY=true` is explicitly configured. Keep the flag `false` in Compose, the base Kustomize ConfigMap, and every overlay until a target-environment executor review is complete. Manual credential paths that do not need a browser remain governed by their existing adapter behavior.

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

These tests cover the shared-dependency and failure-handling foundation. They do not validate Browserless/UET parity or authorize enabling the automation executor gate.

## Kubernetes deployment

The manifests in [`deploy/k8s`](../deploy/k8s) are a deployment template, not a dependency installer. The `base` includes two Deployments, a ClusterIP API Service, readiness/liveness/startup probes, rolling-update policies, resource requests/limits, HPAs, PDBs, non-root ServiceAccounts, generated runtime ConfigMap, and egress NetworkPolicies. The API uses `/api/live` and `/api/ready`; the worker uses `/healthz` and `/readyz`.

The overlays are intentionally different:

| Overlay | Namespace | Hostname | Initial replicas | Image registry |
| --- | --- | --- | --- | --- |
| `example` | `hyeboard` | `hyeboard.example.com` | 1 API, 1 worker | `ghcr.io/teppyboy` |
| `staging` | `hyeboard-staging` | `staging.hyeboard.example.com` | 2 API, 2 workers | `ghcr.io/teppyboy` |
| `production` | `hyeboard-production` | `hyeboard.example.com` | 3 API, 3 workers, 3 Browserless | `registry.internal.example` placeholder |

CI validates `deploy/k8s/overlays/ci` as manifests and renders the example, staging, and production overlays with temporary immutable image tags. It does not create a cluster, apply an overlay, or replace target-cluster and real UET credential validation.

The base starts `HYEB_AUTOMATION_EXECUTOR_READY=false` and uses distributed mode with Browserless as the configured provider. The setting is not changed by any overlay. Keep it false: a running worker, Browserless endpoint, or healthy rollout does not establish Browserless/UET parity.

### Images and secrets

Build and publish both images with an immutable commit tag. The container workflow uses `sha-${GITHUB_SHA}` and publishes to `ghcr.io/${GITHUB_REPOSITORY_OWNER}/hyeboard-api` and `ghcr.io/${GITHUB_REPOSITORY_OWNER}/hyeboard-automation-worker` for non-PR events:

```bash
export IMAGE_OWNER=teppyboy
export IMAGE_TAG=sha-<40-character-commit-sha>
docker login ghcr.io
docker build -t "ghcr.io/${IMAGE_OWNER}/hyeboard-api:${IMAGE_TAG}" .
docker build -f apps/automation-worker/Dockerfile \
  -t "ghcr.io/${IMAGE_OWNER}/hyeboard-automation-worker:${IMAGE_TAG}" .
docker push "ghcr.io/${IMAGE_OWNER}/hyeboard-api:${IMAGE_TAG}"
docker push "ghcr.io/${IMAGE_OWNER}/hyeboard-automation-worker:${IMAGE_TAG}"
```

After publishing, replace `replace-with-release-tag` in a deployment-specific release copy with the immutable `sha-${GITHUB_SHA}` tag, or use a verified registry digest. Do not use `latest`. The explicit placeholder tag deliberately fails strict rendered-manifest validation until replaced. Production also requires replacing `registry.internal.example` with the real internal registry name.

`base/secret.example.yaml` is a template only and is not listed as a Kustomize resource. Use an external secret manager or External Secrets integration to create `hyeboard-runtime` in each target namespace with these keys:

```text
HYEB_SESSION_SECRET
HYEB_ADMIN_SESSION_SECRET
HYEB_ADMIN_PASSWORD_HASH (optional)
HYEB_ADMIN_GITHUB_CLIENT_SECRET (optional)
HYEB_ADMIN_DISCORD_CLIENT_SECRET (optional)
HYEB_POSTGRES_URL
HYEB_REDIS_URL
AUTOMATION_KEY_CURRENT_ID
AUTOMATION_KEY_CURRENT_B64
AUTOMATION_KEY_PREVIOUS_ID (optional)
AUTOMATION_KEY_PREVIOUS_B64 (optional)
BROWSERLESS_ENDPOINT
BROWSERLESS_TOKEN
```

For the in-cluster production topology, set `HYEB_REDIS_URL` to the operator-managed primary Service, for example `redis://:<url-encoded-password>@hyeboard-redis-master:6379/0`, and set `BROWSERLESS_ENDPOINT=ws://hyeboard-browserless:3000/chromium`. The separate `hyeboard-redis-auth` Secret contains the same Redis password under the `password` key; do not commit either Secret.

### Install the OpsTree Redis Operator

Install the OT-CONTAINER-KIT Redis Operator as a separate Helm release in
`ot-operators`. Keep its cluster-scoped RBAC and let it watch all namespaces so
Redis resources for future services can use the same operator. Its
`RedisReplication` CRD remains cluster-scoped and must be installed and
retained independently. Pin the operator chart version after reviewing the
available versions; do not install an unpinned release in production:

```bash
export OPERATOR_NAMESPACE=ot-operators
helm repo add ot-helm https://ot-container-kit.github.io/helm-charts
helm repo update
helm search repo ot-helm/redis-operator --versions
export REDIS_OPERATOR_VERSION=<reviewed-operator-chart-version>

helm upgrade --install redis-operator ot-helm/redis-operator \
  --namespace "$OPERATOR_NAMESPACE" \
  --create-namespace \
  --version "$REDIS_OPERATOR_VERSION" \
  --set rbac.scope=cluster \
  --set featureGates.GenerateConfigInInitContainer=true

kubectl -n "$OPERATOR_NAMESPACE" \
  rollout status deployment/redis-operator --timeout=180s
kubectl get crd redisreplications.redis.redis.opstreelabs.in
```

The operator's upstream YAML installer is intended for development; use its Helm chart for a production cluster. With `rbac.scope=cluster` and no `redisOperator.watchNamespace` override, the operator watches all namespaces. Verify the operator version, image provenance, cluster-scoped RBAC, CRD version (`redis.redis.opstreelabs.in/v1beta2`), and upgrade policy before installing. The production Hyeboard resource creates three Redis members and three Sentinel pods through this CRD. Do not include the operator or CRD in the application Helm release; uninstalling the application must not remove cluster-scoped CRDs. Each namespace containing an operator-managed Redis workload must allow the operator namespace through its NetworkPolicy.

Create the Redis auth Secret and Hyeboard runtime Secret in the application namespace before applying either deployment method. Generate a hex password so it is safe to place in a Redis URI without additional URL encoding:

```bash
export HYEB_K8S_NAMESPACE=hyeboard-production
kubectl create namespace "$HYEB_K8S_NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
export REDIS_PASSWORD="$(openssl rand -hex 32)"
kubectl -n "$HYEB_K8S_NAMESPACE" create secret generic hyeboard-redis-auth \
  --from-literal=password="$REDIS_PASSWORD" \
  --dry-run=client -o yaml | kubectl apply -f -

export HYEB_SESSION_SECRET=<32-byte-or-longer-random-secret>
export HYEB_ADMIN_SESSION_SECRET=<separate-32-byte-or-longer-random-secret>
export HYEB_POSTGRES_URL=<managed-postgresql-url>
export AUTOMATION_KEY_CURRENT_ID=<unique-key-id>
export AUTOMATION_KEY_CURRENT_B64=<base64-encoded-32-byte-key>
export BROWSERLESS_TOKEN=<browserless-token>
export HYEB_REDIS_URL="redis://:${REDIS_PASSWORD}@hyeboard-redis-master:6379/0"
export BROWSERLESS_ENDPOINT=ws://hyeboard-browserless:3000/chromium

kubectl -n "$HYEB_K8S_NAMESPACE" create secret generic hyeboard-runtime \
  --from-literal=HYEB_SESSION_SECRET="$HYEB_SESSION_SECRET" \
  --from-literal=HYEB_ADMIN_SESSION_SECRET="$HYEB_ADMIN_SESSION_SECRET" \
  --from-literal=HYEB_POSTGRES_URL="$HYEB_POSTGRES_URL" \
  --from-literal=HYEB_REDIS_URL="$HYEB_REDIS_URL" \
  --from-literal=AUTOMATION_KEY_CURRENT_ID="$AUTOMATION_KEY_CURRENT_ID" \
  --from-literal=AUTOMATION_KEY_CURRENT_B64="$AUTOMATION_KEY_CURRENT_B64" \
  --from-literal=BROWSERLESS_ENDPOINT="$BROWSERLESS_ENDPOINT" \
  --from-literal=BROWSERLESS_TOKEN="$BROWSERLESS_TOKEN" \
  --dry-run=client -o yaml | kubectl apply -f -
```

For real operations, replace shell variables with an external secret manager or External Secrets integration. Do not save these exports in a tracked file or paste generated Secret YAML into a ticket.

Generate separate student and admin session secrets plus the automation key with a cryptographically secure generator, and use a unique key ID. Generate a PostgreSQL password separately when the managed database is provisioned. Keep values out of manifests, shell history where practical, logs, and source control. If no secret manager is available, create the Secret out of band with `kubectl` from environment variables; never apply `secret.example.yaml` unchanged.

Staging requires reachable PostgreSQL, Redis, and Browserless endpoints. Production requires PostgreSQL, the external OT-CONTAINER-KIT Redis Operator in `ot-operators` watching the selected workload namespace, its `redis.redis.opstreelabs.in/v1beta2` CRD, a `hyeboard-redis-auth` Secret with key `password`, and a StorageClass that can provision three Redis PVCs. Redis, Sentinel, application, and Browserless topology spread is a soft preference, so a smaller test cluster can co-locate replicas. Production Browserless is exposed only through the in-cluster `hyeboard-browserless` ClusterIP and uses `BROWSERLESS_ENDPOINT=ws://hyeboard-browserless:3000/chromium`. Production `HYEB_REDIS_URL` must use the operator-managed `hyeboard-redis-master` Service and include the Redis password in the URL. Add destination restrictions appropriate to the cluster CNI. The Ingress resources require an NGINX ingress controller, the named TLS Secret (`hyeboard-tls`, `hyeboard-staging-tls`, or `hyeboard-production-tls`), and DNS for the selected hostname.

### Render and apply

Run static validation first. It does not require a live cluster:

```bash
pnpm test:k8s
```

Replace image tags/digests, provision the runtime/auth Secrets, install the pinned Redis Operator for production, and render the selected overlay to a file for review:

```bash
kubectl kustomize deploy/k8s/overlays/staging > /tmp/hyeboard-staging.yaml
kubectl diff -k deploy/k8s/overlays/staging
kubectl apply -k deploy/k8s/overlays/staging
kubectl rollout status deployment/hyeboard-api -n hyeboard-staging --timeout=180s
kubectl rollout status deployment/hyeboard-automation-worker -n hyeboard-staging --timeout=180s
```

Use the corresponding overlay and namespace for `example` or `production`. The example overlay has one replica and is not suitable for the multi-replica cluster validator. For production, verify the Redis Operator reports the CRD and reconcile permissions before applying the overlay. For staging or production, after the dependencies and metrics API are ready:

```bash
HYEB_K8S_NAMESPACE=hyeboard-staging \
  node scripts/validate-k8s-cluster.mjs --failover
```

The cluster validator needs a working `kubectl` context, two ready replicas of both application Deployments, two ready API Service endpoints, active HPA metrics, and permission to create a temporary `node:22-alpine` probe pod. It accepts a single node; it checks rollouts, readiness, endpoint spread, a mock session against each API pod, repeated readiness requests, and API pod replacement during `--failover`. Separately verify Redis Sentinel failover and Browserless session recovery; the validator does not establish Browserless/UET parity.

### Apply the production Kustomize overlay

The production overlay is the `kubectl` deployment path. It includes Browserless and the `RedisReplication` custom resource. It still expects the external Redis Operator in `ot-operators` watching the target workload namespace, both Secrets, PostgreSQL, DNS/TLS, and real immutable application images to exist. Do not edit tracked placeholders; render a temporary release copy:

```bash
export IMAGE_TAG=sha-<40-character-commit-sha>
export IMAGE_REGISTRY=registry.example.internal
export RELEASE_DIR="$(mktemp -d)"
trap 'rm -rf "$RELEASE_DIR"' EXIT
cp -R deploy/k8s "$RELEASE_DIR/k8s"

perl -pi -e "s#registry.internal.example#${IMAGE_REGISTRY}#g; s/replace-with-release-tag/${IMAGE_TAG}/g" \
  "$RELEASE_DIR/k8s/base/"*.yaml \
  "$RELEASE_DIR/k8s/overlays/"*/*.yaml

kubectl kustomize "$RELEASE_DIR/k8s/overlays/production" > "$RELEASE_DIR/production.yaml"
node scripts/validate-k8s.mjs \
  --rendered="$RELEASE_DIR/production.yaml" \
  --expected-tag="$IMAGE_TAG"
kubectl diff -f "$RELEASE_DIR/production.yaml"
kubectl apply -f "$RELEASE_DIR/production.yaml"

kubectl -n "$HYEB_K8S_NAMESPACE" get redisreplication hyeboard-redis
kubectl -n "$HYEB_K8S_NAMESPACE" get pods -l app=hyeboard-redis
kubectl -n "$HYEB_K8S_NAMESPACE" get svc hyeboard-redis-master
kubectl -n "$HYEB_K8S_NAMESPACE" rollout status deployment/hyeboard-api --timeout=10m
kubectl -n "$HYEB_K8S_NAMESPACE" rollout status deployment/hyeboard-automation-worker --timeout=10m
kubectl -n "$HYEB_K8S_NAMESPACE" rollout status deployment/hyeboard-browserless --timeout=10m
```

The operator's master Service is the endpoint used by the current Node Redis client. After the RedisReplication resource is Ready, verify that `hyeboard-redis-master` selects the current master. Test Sentinel failover in a maintenance window and confirm the Service moves to the promoted member before enabling any production automation gate.

### CI

`.github/workflows/container.yml` builds both Dockerfiles on pull requests. On non-PR events it logs in to GHCR, publishes SHA-tagged images, and when a `v*` Git tag is pushed also publishes that exact version tag; it emits SBOM/provenance. It does not deploy Kubernetes.

`.github/workflows/ha-k8s.yml` runs `pnpm test:k8s`, `docker compose config --quiet`, the build/package/test gates, the HA integration tests, and temporary Kustomize renders for all three overlays with the commit SHA substituted for `replace-with-release-tag`. It does not create a cluster, apply an overlay, or enable `HYEB_AUTOMATION_EXECUTOR_READY`.

## Helm alternative

The Helm chart is published at `oci://ghcr.io/teppyboy/charts/hyeboard`. It is an alternative to the Kustomize templates above; do not let Helm and Kustomize manage the same workloads in one namespace. The chart can deploy Browserless, render a RedisReplication custom resource, and create the application Secrets when `secrets.create` is enabled. It does not install or own the Redis Operator or its cluster-scoped CRD; install the separate cluster-scoped operator release in `ot-operators` first.

The Helm production prerequisites are Helm 3, `kubectl` access to the selected cluster context, a pinned cluster-scoped OT-CONTAINER-KIT Redis Operator in `ot-operators` watching all namespaces, its CRD, a StorageClass for Redis PVCs, an ingress controller matching the chart's configured Ingress class, DNS, and a pre-created TLS Secret. PostgreSQL remains external. `values-production.yaml` enables Browserless and the RedisReplication resource; the chart does not install the Redis Operator itself.

Put the runtime credentials and Redis password in a local values file with `secrets.create: true`. The chart creates `hyeboard-runtime` and `hyeboard-redis-auth` from that file. The runtime Secret must contain:

```text
HYEB_SESSION_SECRET
HYEB_ADMIN_SESSION_SECRET
HYEB_ADMIN_PASSWORD_HASH (optional)
HYEB_ADMIN_GITHUB_CLIENT_SECRET (optional)
HYEB_ADMIN_DISCORD_CLIENT_SECRET (optional)
HYEB_POSTGRES_URL
HYEB_REDIS_URL
AUTOMATION_KEY_CURRENT_ID
AUTOMATION_KEY_CURRENT_B64
AUTOMATION_KEY_PREVIOUS_ID (optional)
AUTOMATION_KEY_PREVIOUS_B64 (optional)
BROWSERLESS_ENDPOINT
BROWSERLESS_TOKEN
```

Set `images.api.repository`, `images.api.tag`/`digest`, and the corresponding `images.automationWorker.*` values and use an immutable commit SHA tag such as `sha-<40-character-commit-sha>` or a verified registry digest. Never use `latest` or another mutable tag. Put environment-specific values in a local uncommitted file. For the production values, `HYEB_REDIS_URL` uses `<release>-redis-master` and `BROWSERLESS_ENDPOINT` uses `<release>-browserless`.

For a production Helm release, install `redis-operator` in `ot-operators` first and configure it to watch the Hyeboard namespace. Then use one uncommitted values file containing the real image registry/tag or digests, `ingress.enabled: true`, ingress hostname/TLS, allowed origins, runtime credentials, and Redis password. With the default release name `hyeboard`, the runtime Secret should use `HYEB_REDIS_URL=redis://:<password>@hyeboard-redis-master:6379/0` and `BROWSERLESS_ENDPOINT=ws://hyeboard-browserless:3000/chromium`.

The values file contains credentials and must stay outside the repository. A minimal production shape is:

```yaml
images:
  api:
    repository: registry.example.internal/hyeboard-api
    tag: sha-<40-character-commit-sha>
  automationWorker:
    repository: registry.example.internal/hyeboard-automation-worker
    tag: sha-<40-character-commit-sha>
config:
  runtime:
    HYEB_ALLOWED_ORIGINS: https://hyeboard.example.com
ingress:
  enabled: true
  className: nginx
  hosts:
    - host: hyeboard.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: hyeboard-tls
      hosts:
        - hyeboard.example.com
```

Set `secrets.create: true` and add the runtime values and Redis password to the same file. Protect it with `chmod 600` and do not commit it.

```bash
export HYEB_K8S_NAMESPACE=hyeboard-production
export RELEASE_NAME=hyeboard

helm lint deploy/helm/hyeboard --strict \
  --values deploy/helm/hyeboard/values-production.yaml \
  --values /path/to/values-production-site.yaml
helm template "$RELEASE_NAME" deploy/helm/hyeboard \
  --namespace "$HYEB_K8S_NAMESPACE" \
  --values deploy/helm/hyeboard/values-production.yaml \
  --values /path/to/values-production-site.yaml \
  > /tmp/hyeboard-production-helm.yaml
kubectl diff -f /tmp/hyeboard-production-helm.yaml

helm upgrade --install "$RELEASE_NAME" deploy/helm/hyeboard \
  --namespace "$HYEB_K8S_NAMESPACE" \
  --create-namespace \
  --values deploy/helm/hyeboard/values-production.yaml \
  --values /path/to/values-production-site.yaml

helm status "$RELEASE_NAME" --namespace "$HYEB_K8S_NAMESPACE"
kubectl -n "$HYEB_K8S_NAMESPACE" get redisreplication,svc,pods
kubectl -n "$HYEB_K8S_NAMESPACE" rollout status deployment/${RELEASE_NAME}-api --timeout=10m
kubectl -n "$HYEB_K8S_NAMESPACE" rollout status deployment/${RELEASE_NAME}-automation-worker --timeout=10m
kubectl -n "$HYEB_K8S_NAMESPACE" rollout status deployment/${RELEASE_NAME}-browserless --timeout=10m
```

Do not install the Helm release and apply the Kustomize production overlay in the same namespace. Both paths create the same application resources. Helm completing the resource submission does not prove the Redis custom resource has reconciled; inspect the RedisReplication status and the `<release>-redis-master` Service separately.

Reference workflow for a staging namespace:

```bash
helm lint deploy/helm/hyeboard -f /path/to/values-staging.yaml
helm template hyeboard deploy/helm/hyeboard \
  --namespace hyeboard-staging \
  --create-namespace \
  -f /path/to/values-staging.yaml \
  > /tmp/hyeboard-staging-helm.yaml

helm install hyeboard deploy/helm/hyeboard \
  --namespace hyeboard-staging \
  --create-namespace \
  -f /path/to/values-staging.yaml

helm upgrade --install hyeboard deploy/helm/hyeboard \
  --namespace hyeboard-staging \
  --create-namespace \
  -f /path/to/values-staging.yaml

helm upgrade hyeboard deploy/helm/hyeboard \
  --namespace hyeboard-staging \
  -f /path/to/values-staging.yaml
helm history hyeboard --namespace hyeboard-staging
helm rollback hyeboard <REVISION> \
  --namespace hyeboard-staging
```

Review the rendered Ingress, namespace, TLS Secret reference, external-service configuration, image references, and Secret references before installation. Keep `HYEB_AUTOMATION_EXECUTOR_READY=false` in the Helm values and rendered defaults. A successful render, rollout, worker health check, or Browserless connectivity check is not evidence of Browserless/UET parity; enabling the executor remains a separate deployment gate.
