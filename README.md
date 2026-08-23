# Hyeboard

A multi-university student dashboard for timetables, grades, exams, tuition, courses, assignments, documents, notifications, and academic lookup tools.

Hyeboard currently supports VNU-UET through StudentHub and Canvas, VNU through `daotao.vnu.edu.vn`, and a Mock adapter for demos and local development. The browser talks only to Hyeboard; upstream university credentials remain behind the API boundary and are wrapped in Hyeboard's encrypted session token.

> [!WARNING]
> Hyeboard integrates with university systems that may change without notice. Capabilities are enabled only for response shapes verified against real upstream behavior. Do not treat unsupported features as missing UI work.

## How it works

```text
React web app
    │
    ▼
Hyeboard API/BFF
    │
    ├── Mock adapter
    ├── UET adapter ── StudentHub + Canvas
    └── VNU adapter ── daotao.vnu.edu.vn
```

The same API supports three deployment modes:

- **Cloudflare** — one Worker serves `/api/*` and the built React assets. Durable Objects coordinate CAPTCHA relay, VNU probe budgets, and VNU refresh authority.
- **Memory** — one self-hosted Node.js or Bun process with process-local state.
- **Distributed** — replicated self-hosted API and automation workers backed by PostgreSQL, Redis, and Browserless.

See [Architecture](docs/architecture.md) for session flow, runtime boundaries, exports, cross-lookup limits, and HA behavior.

## Repository layout

```text
apps/
  web/                 React 19 + Vite client
  worker/              Elysia API; Cloudflare and Node/Bun entry points
  automation-worker/   Node-only Browserless/Puppeteer job executor
packages/
  schemas/             Shared Zod schemas and inferred types
  core/                Envelopes, errors, encryption, logging, safe helpers
  university-adapters/ Adapter registry, upstream clients, parsers, mappers
  automation-protocol/ Encrypted automation job/event contracts
deploy/k8s/             Self-hosted distributed deployment templates
docs/                   Architecture, security, and operator runbooks
scripts/                Packaging, validation, benchmarks, bundle audit
```

## Requirements

- Node.js 22+
- pnpm 11.5.2 through Corepack
- A 32-byte-or-longer `HYEB_SESSION_SECRET`
- Docker Engine with a running daemon and Docker Compose v2 for container builds, Compose, and HA integration tests
- `kubectl` with a Kustomize-capable installation for Kubernetes rendering; a configured cluster context is also required to apply resources

Enable the pinned package manager and install dependencies:

```bash
corepack enable
pnpm install
```

## Local development

Create `apps/worker/.dev.vars`:

```dotenv
HYEB_SESSION_SECRET=replace-with-at-least-32-random-bytes
HYEB_ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
```

Generate a suitable secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Start the Vite client and Wrangler API together:

```bash
pnpm dev
```

- Web: `http://localhost:5173`
- API: `http://localhost:8787/api/*`
- Vite proxies `/api/*` to Wrangler in development.

Run one side only when debugging it:

```bash
pnpm dev:web
pnpm dev:worker
```

For the self-hosted Node/Bun runtime, copy `apps/worker/.env.example` to `apps/worker/.env`, set `HYEB_SESSION_SECRET`, then run:

```bash
pnpm dev:node
# or
pnpm dev:bun
```

Non-secret self-hosted defaults live in `apps/worker/config.json`. Environment variables override them.

## Build and test

```bash
pnpm build             # web, Worker typecheck, self-hosted Node bundle
pnpm test              # workspace unit/type tests + lifecycle tests
pnpm test:browser      # Playwright against fresh Wrangler and Vite servers
pnpm test:k8s          # validate Kubernetes manifests
pnpm audit:performance # build web and report entry/PDF bundle sizes
```

Target a workspace while iterating:

```bash
pnpm --filter @hyeboard/web test
pnpm --filter @hyeboard/worker test:workers
pnpm --filter @hyeboard/university-adapters test
```

PostgreSQL and Redis integration suites are opt-in and require Docker:

```bash
pnpm test:ha
```

A change is not complete until its focused checks pass. User-visible frontend changes should also pass the relevant Playwright specs. Before release, use the full `pnpm build`, `pnpm test`, and `pnpm test:browser` gate.

## Packaging and deployment

### Cloudflare

Frontend source changes must be built before deployment:

```bash
pnpm build:web
pnpm deploy
```

`pnpm deploy` does not rebuild `apps/web/dist`; deploying without the build can publish stale assets.

Validate Worker packaging without publishing:

```bash
pnpm --filter @hyeboard/worker exec wrangler deploy --dry-run
```

### Self-hosted

Create a production bundle under `dist/`:

```bash
pnpm package
```

Run it with:

```bash
cd dist
npm install --omit=dev
HYEB_SESSION_SECRET=replace-with-a-real-secret node dist/index.js
```

Container and Kubernetes deployment details live in the [HA runbook](docs/ha-runbook.md). PostgreSQL remains external; the production Kubernetes paths can run Redis through the Redis Operator and Browserless in-cluster.

### Docker images and Compose

The repository contains two production container definitions:

- `Dockerfile` builds the self-hosted API image and starts `node dist/index.js` on port `8787`.
- `apps/automation-worker/Dockerfile` builds the Node-only automation worker image and starts `node dist/cli.cjs` on port `8080`.

The images use Node `22.22.0-bookworm-slim`, refresh Debian security packages in the runtime stage, remove the unused runtime npm toolchain, use BuildKit cache mounts, lockfile-resolved production dependencies, and a non-root runtime user. BuildKit/buildx and a running Docker daemon are required:

```bash
docker info
docker compose version
docker buildx version
```

Build and publish immutable SHA-tagged images to GHCR (replace the owner and SHA with the release values):

```bash
export IMAGE_OWNER=im-yuuki
export IMAGE_TAG=sha-<40-character-commit-sha>
docker login ghcr.io
docker build -t "ghcr.io/${IMAGE_OWNER}/hyeboard-api:${IMAGE_TAG}" .
docker build -f apps/automation-worker/Dockerfile \
  -t "ghcr.io/${IMAGE_OWNER}/hyeboard-automation-worker:${IMAGE_TAG}" .
docker push "ghcr.io/${IMAGE_OWNER}/hyeboard-api:${IMAGE_TAG}"
docker push "ghcr.io/${IMAGE_OWNER}/hyeboard-automation-worker:${IMAGE_TAG}"
```

After pushing, use the immutable `sha-${GITHUB_SHA}` tag (or replace it with the verified registry digest in a deployment-specific release copy). Do not use `latest` or leave `replace-with-release-tag` in a release overlay. The production overlay intentionally uses `registry.internal.example/...`; replace that registry with the organization's actual registry before rendering.

`docker-compose.yml` has two mutually exclusive local profiles:

- `memory` starts only `api-memory`. It uses process-local state and forces `HYEB_AUTOMATION_EXECUTOR_READY=false`.
- `distributed` starts `api`, `postgres`, `redis`, `browserless`, and `automation-worker`. PostgreSQL, Redis, and Browserless are local Compose dependencies in this profile; this does not make automated UET sign-in or feature parity available.

Prepare the ignored environment file and validate both profiles before starting either one:

```bash
cp compose.env.example compose.env
# Fill the required values in compose.env; do not commit it.
docker compose --env-file compose.env --profile memory config --quiet
docker compose --env-file compose.env --profile distributed config --quiet
docker compose --env-file compose.env --profile memory up -d --build
curl -fsS http://127.0.0.1:8787/api/ready
docker compose --env-file compose.env --profile memory down
docker compose --env-file compose.env --profile distributed up -d --build
docker compose --env-file compose.env --profile distributed ps
```

`compose.env.example` defines `HYEB_SESSION_SECRET`, `POSTGRES_PASSWORD`, the current/optional previous automation key pair, `BROWSERLESS_TOKEN`, `HYEB_ALLOWED_ORIGINS`, `HYEB_AUTOMATION_EXECUTOR_READY`, and `API_PORT`; it also documents optional consumer/node names. Fill the values required by the selected profile rather than adding secrets to `docker-compose.yml`.

Only the API is published to the host. Compose keeps PostgreSQL, Redis, Browserless, and the automation health endpoint on the private `hyeboard` network. Use `docker compose ... down` to stop a profile; add `-v` only when intentionally deleting local PostgreSQL/Redis data.

Generate local secret material instead of inventing values:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" # HYEB_SESSION_SECRET
openssl rand -hex 24                                                   # POSTGRES_PASSWORD
openssl rand -base64 32                                                # AUTOMATION_KEY_CURRENT_B64
```

Set a unique `AUTOMATION_KEY_CURRENT_ID` beside the generated key. Keep the optional previous key ID and key together when rotating. `BROWSERLESS_TOKEN` comes from the Browserless deployment; never put a token in `BROWSERLESS_ENDPOINT`. The Compose example defaults `HYEB_AUTOMATION_EXECUTOR_READY=false`; leave it false unless the deployment-specific executor gate has been completed.

The distributed Compose profile is an infrastructure and lifecycle check, not a claim of Browserless/UET parity. It must not be used to infer that automated university login is production-ready.

### Kubernetes

The templates are under [`deploy/k8s`](deploy/k8s):

- `base` defines the API and automation Deployments, Service, HPA, PDB, ServiceAccounts, generated runtime ConfigMap, and egress NetworkPolicies.
- `overlays/example` targets namespace `hyeboard`, hostname `hyeboard.example.com`, and one replica of each workload for a small example cluster.
- `overlays/staging` targets namespace `hyeboard-staging`, hostname `staging.hyeboard.example.com`, and two replicas of each workload.
- `overlays/production` targets namespace `hyeboard-production`, hostname `hyeboard.example.com`, and three API, worker, and Browserless replicas; it also declares a three-node RedisReplication with three Sentinel pods through the OT-CONTAINER-KIT Redis Operator. Its application image names point at `registry.internal.example` until replaced.

Kubernetes does not provision PostgreSQL, an ingress controller, TLS, a secret manager, or the cluster-scoped Redis Operator. Example and staging use external PostgreSQL, Redis, and Browserless services. Production runs Redis and Browserless in-cluster, but requires the pinned Redis Operator/CRD, a production StorageClass, and enough capacity for three Redis members, three Sentinels, three Browserless pods, and the application replicas. All overlays require an NGINX ingress class, a `metrics-server`-compatible metrics API, and the referenced TLS Secret.

`deploy/k8s/base/secret.example.yaml` is a template only and is not a Kustomize resource. Prefer an external secret manager or External Secrets integration to materialize a Secret named `hyeboard-runtime` with these keys: `HYEB_SESSION_SECRET`, `HYEB_POSTGRES_URL`, `HYEB_REDIS_URL`, `AUTOMATION_KEY_CURRENT_ID`, `AUTOMATION_KEY_CURRENT_B64`, optional previous automation key pair, `BROWSERLESS_ENDPOINT`, and `BROWSERLESS_TOKEN`. For production, point `HYEB_REDIS_URL` at the operator-managed `hyeboard-redis-master` Service and `BROWSERLESS_ENDPOINT` at `ws://hyeboard-browserless:3000/chromium`; include the Redis password in the Redis URI as required by the Node Redis client. Create a separate `hyeboard-redis-auth` Secret with key `password` for the Redis Operator. If a cluster secret manager is unavailable, create both Secrets out of band with `kubectl` from environment variables; never apply templates unchanged or commit generated Secret YAML.

The base and overlays contain the explicit `replace-with-release-tag` placeholder. Replace it with the published immutable SHA tag or digest before a real deployment. The CI render job substitutes its commit SHA tag in a temporary copy; it does not modify or deploy the repository manifests.

Render, inspect, diff, and apply a selected overlay only after images, secrets, hostname/TLS, storage, the Redis Operator, and the selected external dependencies are ready:

```bash
pnpm test:k8s
kubectl kustomize deploy/k8s/overlays/staging > /tmp/hyeboard-staging.yaml
kubectl diff -k deploy/k8s/overlays/staging
kubectl apply -k deploy/k8s/overlays/staging
kubectl rollout status deployment/hyeboard-api -n hyeboard-staging --timeout=180s
kubectl rollout status deployment/hyeboard-automation-worker -n hyeboard-staging --timeout=180s
```

For a production rollout, install a pinned OT-CONTAINER-KIT Redis Operator release and verify the `redis.redis.opstreelabs.in/v1beta2` CRD before applying `deploy/k8s/overlays/production`. Confirm the internal registry names, real application digests, StorageClass, Redis auth Secret, and runtime Secret first. The example overlay is intended for rendering/smoke use and has one replica, so it does not satisfy the multi-replica cluster validator. Validate staging or production with cluster access:

```bash
HYEB_K8S_NAMESPACE=hyeboard-staging \
  node scripts/validate-k8s-cluster.mjs --failover
```

The validator needs `kubectl`, a working cluster context, active HPA metrics, the rendered Service/Deployments, and permission to create a temporary `node:22-alpine` probe pod. It accepts single-node and multi-node clusters; topology spread remains a soft preference. It exercises rollouts, endpoint spread, readiness, a mock session, and API pod failover; it does not establish Browserless/UET parity.

CI coverage is split across two workflows:

- `.github/workflows/container.yml` builds both Dockerfiles on pull requests and pushes SHA-tagged images with SBOM/provenance to GHCR on non-PR events, then scans published images with Trivy.
- `.github/workflows/ha-k8s.yml` runs manifest validation, `docker compose config --quiet`, builds both images, runs package/tests, performs the Wrangler dry-run, and renders/validates temporary Kustomize example, staging, and production overlays. It does not apply Kubernetes resources.

Keep `HYEB_AUTOMATION_EXECUTOR_READY=false` in Compose and Kubernetes defaults. Enabling it is a separate deployment gate and requires target-environment validation; the repository makes no Browserless/UET parity claim.

### Helm

The chart is available at [`deploy/helm/hyeboard`](deploy/helm/hyeboard). It deploys the API and automation-worker resources and can optionally deploy Browserless in-cluster. It can also render a `RedisReplication` custom resource, but it does not install the cluster-scoped Redis Operator, CRD, Namespace, or Secret; those remain operator-managed.

Helm and Kustomize are alternatives. Use one release method for a namespace; do not install the Helm release and apply a Kustomize overlay to the same workloads.

A Helm deployment still requires Helm 3, `kubectl` access to the target cluster, an ingress controller that supports the chart's configured Ingress class, DNS, and a TLS Secret in the target namespace. PostgreSQL remains external. The optional production values enable in-cluster Browserless and the RedisReplication resource; install a pinned OT-CONTAINER-KIT Redis Operator and verify its CRD first. Create `hyeboard-runtime` and `hyeboard-redis-auth` out of band before installing. `HYEB_REDIS_URL` should use the operator's `<redis-name>-master` Service and `BROWSERLESS_ENDPOINT` should use the chart's `<release>-browserless` Service. The runtime Secret must provide `HYEB_SESSION_SECRET`, `HYEB_POSTGRES_URL`, `HYEB_REDIS_URL`, `AUTOMATION_KEY_CURRENT_ID`, `AUTOMATION_KEY_CURRENT_B64`, optional previous automation key pair, `BROWSERLESS_ENDPOINT`, and `BROWSERLESS_TOKEN`; the Redis auth Secret must provide `password`.

Use `images.api.repository`, `images.api.tag`/`digest`, and the corresponding `images.automationWorker.*` values to set immutable release references. Prefer a verified registry digest; otherwise use a commit SHA tag such as `sha-<40-character-commit-sha>`. The production values file enables the in-cluster dependencies but intentionally leaves application image placeholders and environment secrets for a site-specific uncommitted values file. Do not use `latest` or a mutable environment tag.

The following commands are reference examples. Replace `/path/to/values-staging.yaml` with a values file matching the supplied chart, and review the rendered output before applying it:

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
  -f /path/to/values-staging.yaml \
  --wait --timeout 10m

helm upgrade --install hyeboard deploy/helm/hyeboard \
  --namespace hyeboard-staging \
  --create-namespace \
  -f /path/to/values-staging.yaml \
  --wait --atomic --timeout 10m

helm upgrade hyeboard deploy/helm/hyeboard \
  --namespace hyeboard-staging \
  -f /path/to/values-staging.yaml \
  --wait --atomic --timeout 10m
helm history hyeboard --namespace hyeboard-staging
helm rollback hyeboard <REVISION> \
  --namespace hyeboard-staging \
  --wait --timeout 10m
```

Keep `HYEB_AUTOMATION_EXECUTOR_READY=false` in Helm values and rendered defaults. A healthy Helm rollout, automation worker, or reachable Browserless service does not establish Browserless/UET parity; enabling the flag requires a separate target-environment executor review.

## Adding a university

1. Implement `UniversityAdapter` in `packages/university-adapters/src/`.
2. Register it in `packages/university-adapters/src/registry.ts`.
3. Add verified upstream parsers/mappers and focused tests.
4. Set each advertised capability truthfully.

Never return fabricated placeholder data for an unverified feature. Keep the capability `false` and return `UNSUPPORTED_FEATURE` until the upstream contract is understood.

## Security

- Never commit `.env`, `.dev.vars`, raw HAR captures, cookies, tokens, SAML payloads, reconnect grants, or PII.
- The frontend must never receive raw upstream credentials.
- Treat university responses as untrusted input and validate at the adapter/API boundary.
- Raw HAR files may exist locally during protocol investigation; follow [HAR Security](docs/har-security.md) before opening or processing them.

If you discover a vulnerability, do not publish credentials, captures, or student data in a public issue.

## Documentation

- [Architecture](docs/architecture.md) — runtime modes, session model, adapters, lookup and automation boundaries
- [HA runbook](docs/ha-runbook.md) — distributed configuration, health checks, session cutover, Kubernetes operations
- [HAR Security](docs/har-security.md) — credential and capture handling rules
- [Automation worker](apps/automation-worker/README.md) — worker integration and encrypted message contracts
- [Agent guide](AGENTS.md) — repository-specific instructions for coding agents

## Status

- UET, VNU, and Mock adapters are registered.
- StudentHub and Canvas credentials are independent; Canvas-only features may be unavailable in an otherwise valid UET session.
- Cloudflare, self-hosted memory, and distributed HA foundations are implemented.
- Container and Kubernetes templates are available, but automated executor use remains gated by `HYEB_AUTOMATION_EXECUTOR_READY=false`.

## License

[GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`).
