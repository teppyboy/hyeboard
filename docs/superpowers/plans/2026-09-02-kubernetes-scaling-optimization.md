# Kubernetes Scaling Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound Hyeboard dependency fan-out, correct autoscaling signals, restore the automation gate, make ingress redundant, and apply the validated policy to the current cluster.

**Architecture:** Reuse native Kubernetes HPA, PDB, topology spreading, resource requests, immutable image digests, and the existing PostgreSQL pool. Keep Kustomize and Helm equivalent. Add no autoscaling or monitoring operator; defer queue-aware scaling until automation receives real-provider validation.

**Tech Stack:** TypeScript, `pg`, Vitest, Kustomize, Helm templates, Kubernetes autoscaling/v2, kubectl.

---

### Task 1: Bound PostgreSQL pool fan-out

**Files:**
- Modify: `apps/worker/src/start.ts`
- Modify: `apps/worker/src/node/postgres/pool.ts` only if existing `PoolConfig` support is insufficient
- Modify: focused worker configuration tests beside `apps/worker/src/start.ts`

- [ ] Add failing tests proving defaults `max=5`, `connectionTimeoutMillis=5000` and rejecting zero, negative, fractional, and non-numeric environment values.
- [ ] Run the focused worker test and confirm failure.
- [ ] Parse `HYEB_POSTGRES_POOL_MAX` and `HYEB_POSTGRES_CONNECT_TIMEOUT_MS` at the self-hosted configuration boundary.
- [ ] Construct the existing `PostgresPool` with `connectionString`, `max`, and `connectionTimeoutMillis`; add no new abstraction.
- [ ] Run focused worker tests and type checks.

### Task 2: Optimize Kustomize workloads and validators

**Files:**
- Modify: `deploy/k8s/base/api-deployment.yaml`
- Modify: `deploy/k8s/base/automation-deployment.yaml`
- Modify: `deploy/k8s/base/api-hpa.yaml`
- Delete: `deploy/k8s/base/automation-hpa.yaml`
- Modify: `deploy/k8s/base/kustomization.yaml`
- Modify: `deploy/k8s/overlays/production/browserless-deployment.yaml`
- Modify: `deploy/k8s/overlays/production/browserless-hpa.yaml`
- Modify: `scripts/validate-k8s.mjs`
- Modify: `scripts/validate-k8s-cluster.mjs`
- Modify: focused validator tests if present

- [ ] Update validator expectations first: API/worker requests `100m/192Mi`; API HPA CPU-only 60%, 2–8, immediate scale-up by 100% or two pods per 30 seconds; no worker HPA; PostgreSQL pool ConfigMap defaults; Browserless explicit `CONCURRENT=1`, `QUEUED=2`, `TIMEOUT=120000`, `MAX_RECONNECT_TIME=120000`; Browserless CPU-only HPA.
- [ ] Run `pnpm test:k8s` and confirm failure.
- [ ] Apply the minimum Kustomize manifest changes matching those expectations. Preserve the CI-only executor gate override.
- [ ] Update cluster snapshot validation to require two ready API/worker pods and an active API HPA, without requiring a worker HPA.
- [ ] Run `pnpm test:k8s` and cluster-validator unit tests.

### Task 3: Keep Helm policy equivalent

**Files:**
- Modify: `deploy/helm/hyeboard/values.yaml`
- Modify: `deploy/helm/hyeboard/templates/hpa.yaml` only if values alone are insufficient
- Modify: `deploy/helm/hyeboard/templates/browserless-deployment.yaml`
- Modify: `deploy/helm/hyeboard/templates/browserless-hpa.yaml` only if values alone are insufficient
- Modify: `scripts/validate-helm.mjs`

- [ ] Add or update Helm validation expectations for the same requests, API HPA, disabled worker HPA, pool defaults, Browserless bounds, and CPU-only Browserless HPA.
- [ ] Run the Helm validation and confirm failure.
- [ ] Update default values/templates minimally; preserve executor gate `false`.
- [ ] Render default and production charts with immutable test tags and run Helm validation.

### Task 4: Add ingress redundancy operator artifacts and runbook

**Files:**
- Create: `deploy/k8s/operator/ingress-nginx-scaling-patch.yaml`
- Create: `deploy/k8s/operator/ingress-nginx-pdb.yaml`
- Modify: `docs/ha-runbook.md`
- Modify: `scripts/validate-k8s.mjs`

- [ ] Add validation for a two-replica ingress patch, preferred hostname topology spread, and PDB `maxUnavailable: 1`.
- [ ] Run `pnpm test:k8s` and confirm failure.
- [ ] Add the minimal patch and PDB; do not claim ownership of ingress-nginx installation.
- [ ] Document `kubectl patch --patch-file`, apply, rollout, verification, chart-upgrade drift warning, and rollback.
- [ ] Run `pnpm test:k8s`.

### Task 5: Full repository verification and review

**Files:** all changed files.

- [ ] Run LSP diagnostics on changed TypeScript/JavaScript files.
- [ ] Run `pnpm test:k8s`.
- [ ] Run `pnpm --filter @hyeboard/worker test`.
- [ ] Run `pnpm --filter @hyeboard/automation-worker test`.
- [ ] Run `pnpm build`.
- [ ] Render production Kustomize and Helm outputs using immutable test tags/digests.
- [ ] Run `git diff --check`, inspect the exact diff, and verify no unrelated files changed.

### Task 6: Apply and validate the live cluster

**Files:** no tracked changes; temporary files outside the repository only.

- [ ] Capture affected live ConfigMap, Deployments, HPAs, PDBs, and ingress controller resources to an untracked temporary rollback directory.
- [ ] Pin API and worker to their currently running immutable digests.
- [ ] Set live `HYEB_AUTOMATION_EXECUTOR_READY=false`, PostgreSQL pool settings, resources, API HPA policy, remove worker HPA, and Browserless bounds/HPA.
- [ ] Apply ingress-nginx replica patch and PDB.
- [ ] Wait for API, worker, Browserless, and ingress rollouts.
- [ ] Run `HYEB_K8S_NAMESPACE=hyeboard node scripts/validate-k8s-cluster.mjs --failover`.
- [ ] Verify public `/api/live` and `/api/ready`, HPA state, endpoint counts, pod placement, restarts, immutable image IDs, Redis master health, and warning events.
- [ ] On any failed gate, rollback affected resources from the captured directory, preserving executor gate `false`.
