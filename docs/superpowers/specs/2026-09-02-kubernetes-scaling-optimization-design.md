# Kubernetes Scaling Optimization Design

**Status:** Approved for implementation planning
**Date:** 2026-09-02
**Target:** Current `kubernetes-admin@cluster.local` cluster and repository deployment templates
**Scale horizon:** Up to 100 API requests/second. Browser automation remains disabled until real-provider validation; its later design ceiling is 20 concurrent jobs.

## Objective

Remove the measured Kubernetes scaling risks without adding speculative infrastructure. Keep Kubernetes and Helm templates aligned, apply the same policy to the current `hyeboard` namespace, and leave an evidence-based path for queue-aware automation scaling.

## Baseline

The audit sampled the live cluster without generating production load.

- Four worker nodes reported 0–1% CPU and 2–3% memory use.
- API pods used approximately 1m CPU and 60Mi memory each.
- Automation workers used approximately 2m CPU and 58Mi memory each.
- Browserless pods used 528–577Mi memory each while nearly idle.
- API and automation HPAs were pinned at their two-replica minimums.
- API, worker, Redis, Sentinel, and Browserless pods were distributed across worker nodes.
- Redis had three members, three Sentinels, and a healthy master Service.
- The API and worker had no OOM or persistent dependency failures in the sampled logs.
- The ingress-nginx controller had one replica and no HPA.
- The live application images used mutable `latest` tags.
- The live runtime set `HYEB_AUTOMATION_EXECUTOR_READY=true`, although no successful real-provider Browserless/UET validation was confirmed.
- Application resources are Helm-owned, but Helm is not installed on the operator host. Subsequent `kubectl` patches have created live drift from the recorded Helm release.

The cluster currently has substantial spare capacity. The immediate risks are incorrect scaling signals, uncontrolled dependency fan-out, a single ingress replica, mutable images, and deployment drift—not node exhaustion.

## Decisions

### 1. Restore the automation safety gate

Set `HYEB_AUTOMATION_EXECUTOR_READY=false` in the live runtime ConfigMap and preserve `false` in every repository default and production overlay.

The API must not enqueue distributed browser work until a real-provider Browserless/UET validation has succeeded. Worker or Browserless health alone does not authorize the gate.

The automation worker remains deployed with two replicas so its Redis Streams, shutdown, and readiness behavior stay continuously exercised. Its HPA is removed while the gate is disabled because CPU and memory do not represent queued browser work.

### 2. Use immutable application images

The live API and worker will be pinned to their currently running registry digests:

- API: `ghcr.io/teppyboy/hyeboard-api@sha256:ca202a197a505d00a064e8bdc5709cfd2876d5e5060fc338adc2bc48c875605b`
- Worker: `ghcr.io/teppyboy/hyeboard-automation-worker@sha256:948dd7533bcdaf3c01b5e1d99a8aeadc1bb37d7474bf120f59326aa2b9420df5`

Generic repository values retain explicit release placeholders. Target-cluster values use digests. `latest` is rejected by manifest validation.

### 3. Right-size API and worker requests

Use measured baselines plus more than 3× memory headroom:

| Workload | CPU request | Memory request | CPU limit | Memory limit |
| --- | ---: | ---: | ---: | ---: |
| API | 100m | 192Mi | 2 | 2Gi |
| Automation worker | 100m | 192Mi | 2 | 2Gi |
| Browserless | 1 | 1Gi | 2 | 4Gi |

Limits remain unchanged during this pass. Browserless requests also remain unchanged because Chromium has bursty resource use and the idle sample is already above 500Mi.

Request changes are calibration defaults, not permanent capacity claims. Revisit them after a representative load test or seven days of production percentiles.

### 4. Scale the API on CPU only

Memory is removed from the API HPA. Node process memory contains a stable runtime baseline and does not reliably fall after traffic decreases. CPU is the available native metric most closely related to API request work.

API HPA policy:

- `minReplicas: 2`
- `maxReplicas: 8`
- CPU target: 60% of the 100m request
- Scale up by the larger of 100% or two pods every 30 seconds
- No scale-up stabilization delay
- Scale down by at most 25% every 60 seconds
- 300-second scale-down stabilization

Eight API replicas and a five-connection pool cap limit normal PostgreSQL fan-out to 40 connections.

### 5. Bound PostgreSQL connection fan-out

Add validated self-hosted runtime settings:

- `HYEB_POSTGRES_POOL_MAX=5`
- `HYEB_POSTGRES_CONNECT_TIMEOUT_MS=5000`

`apps/worker/src/start.ts` passes these values to the existing `PostgresPool`; no new pool abstraction is introduced. Invalid, zero, negative, or non-integer values fail configuration loading.

The defaults are five connections and a five-second connect timeout. Every replica uses the same cap. The resulting connection budget is documented as:

```text
maximum normal API pool connections = API HPA maxReplicas × HYEB_POSTGRES_POOL_MAX
                                    = 8 × 5
                                    = 40
```

Migrations continue to use the same per-process pool. PostgreSQL remains external authority and dependency failures continue to fail closed.

### 6. Bound Browserless capacity explicitly

Browserless remains present but cannot receive new API jobs while the executor gate is false. Configure explicit safe defaults so later validation cannot inherit permissive image defaults:

- `CONCURRENT=1`
- `QUEUED=2`
- `TIMEOUT=120000`
- `MAX_RECONNECT_TIME=120000`

The current two Browserless replicas therefore expose two active sessions and at most four queued connections. Its HPA uses CPU only, with `minReplicas: 2`, `maxReplicas: 8`, and a 60% target. Memory is removed as a scale signal.

This is intentionally below the 20-job design ceiling. After real-provider validation, load testing must establish per-session CPU, RSS, duration, and failure rate. Reaching 20 concurrent jobs requires queue-depth autoscaling or a deliberately fixed worker fleet; CPU-only worker HPA is not accepted as proof of capacity.

### 7. Make ingress redundant

The application repository does not install ingress-nginx. It will therefore track a minimal operator patch rather than claim ownership of the controller chart.

The current cluster receives:

- Two ingress-nginx controller replicas
- `maxUnavailable: 1` PDB
- Preferred hostname topology spreading across worker nodes
- Existing service and controller settings unchanged

The patch is applied with `kubectl patch --patch-file`; the PDB is applied normally. The runbook states that an ingress-nginx chart upgrade can overwrite the Deployment patch and requires revalidation.

### 8. Keep rollout and availability controls

Preserve:

- API and worker `maxUnavailable: 0`, `maxSurge: 1`
- Existing startup, readiness, and liveness endpoints
- Two API and two worker replicas
- Existing application PDBs
- Soft topology spreading and preferred anti-affinity
- Existing graceful shutdown and `preStop` delay

Brief startup-probe connection refusals are accepted as normal startup noise. Probe thresholds are not loosened without evidence of persistent failures.

### 9. Keep repository deployment paths consistent

Apply equivalent defaults to Kustomize and Helm:

- API/worker requests
- API HPA policy
- No automation-worker HPA while the executor gate is false
- Browserless environment limits and CPU-only HPA
- PostgreSQL pool environment defaults
- Immutable image enforcement

Update static validators and the live cluster validator to match intentional policy:

- Require two ready API and worker replicas.
- Require an active API HPA.
- Do not require an automation-worker HPA while automation is gated off.
- Validate the PostgreSQL connection budget inputs.
- Validate Browserless concurrency, queue, timeout, and reconnect bounds.
- Reject `HYEB_AUTOMATION_EXECUTOR_READY=true` outside the disposable CI overlay.

The CI overlay may keep the executor gate true only because it uses mock/disposable dependencies and validates wiring, not real-provider parity.

## Deployment flow

1. Run repository manifest tests and package tests for changed runtime parsing.
2. Render Kustomize and Helm production manifests with immutable image references.
3. Review `kubectl diff` for application and ingress resources.
4. Apply the runtime ConfigMap safety correction first.
5. Roll API and worker changes one workload at a time.
6. Apply Browserless bounds.
7. Apply the ingress replica patch and PDB.
8. Wait for all rollouts.
9. Run the cluster validator with API failover.
10. Check public `/api/live` and `/api/ready`.
11. Confirm HPA metrics, ready endpoint counts, pod placement, restart counts, image digests, and warning events.

No Redis failover, node deletion, or production load test occurs during this rollout.

## Rollback

Before mutation, save the affected live resources to an untracked temporary directory. Rollback consists of:

1. Reapply the captured application resources or use `kubectl rollout undo` for Deployments.
2. Restore the previous ConfigMap only if the rollback does not re-enable the unvalidated automation gate; safety wins over configuration symmetry.
3. Scale ingress-nginx back to one replica only if the second replica causes a verified controller problem.
4. Re-run rollout, readiness, and public endpoint checks.

Never roll back to mutable image tags when a known-good digest exists.

## Validation

Repository gates:

```bash
pnpm test:k8s
pnpm --filter @hyeboard/worker test
pnpm --filter @hyeboard/automation-worker test
pnpm build
kubectl kustomize deploy/k8s/overlays/production
helm template hyeboard deploy/helm/hyeboard \
  --namespace hyeboard \
  --values deploy/helm/hyeboard/values-production.yaml \
  --values /tmp/hyeboard-production-site-values.yaml
```

Live gates:

```bash
kubectl -n hyeboard rollout status deployment/hyeboard-api --timeout=10m
kubectl -n hyeboard rollout status deployment/hyeboard-automation-worker --timeout=10m
kubectl -n hyeboard rollout status deployment/hyeboard-browserless --timeout=10m
kubectl -n ingress-nginx rollout status deployment/ingress-nginx-controller --timeout=10m
HYEB_K8S_NAMESPACE=hyeboard node scripts/validate-k8s-cluster.mjs --failover
curl -fsS https://hyeboard.june8th.eu.org/api/live
curl -fsS https://hyeboard.june8th.eu.org/api/ready
```

## Acceptance criteria

- The live automation executor gate is `false`.
- API and worker images use immutable digests.
- API and worker each have two ready replicas and zero unavailable replicas.
- API HPA is active, has a 2–8 range, and uses CPU only.
- No automation-worker HPA exists while the gate is false.
- Browserless declares concurrency, queue, session timeout, and reconnect timeout bounds.
- PostgreSQL pool fan-out is capped at 40 connections at maximum API scale.
- ingress-nginx has two ready replicas on distinct worker nodes when schedulable and a PDB permitting one disruption.
- Redis replication and the current master Service remain healthy.
- `pnpm test:k8s`, focused package tests, build, rendered-manifest validation, cluster validation with failover, and public health checks pass.
- No unrelated working-tree changes are modified.

## Deferred work

Add Prometheus/KEDA, queue-depth autoscaling, PgBouncer, cluster autoscaling, dedicated browser nodes, and production load generation only after measurements show the native bounded design is insufficient. The trigger is any sustained breach of these thresholds:

- API p95 latency above 500ms at or below 100 requests/second
- API HPA held at eight replicas for ten minutes
- PostgreSQL pool wait or connection exhaustion
- Automation queue oldest-message age above 60 seconds after the executor is validated
- Browserless queue rejection or timeout under the validated workload
- Worker-node requested CPU or memory above 70% after normal scaling
