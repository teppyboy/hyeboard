import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { validateClusterSnapshot } from "./validate-k8s-cluster.mjs";

const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const api = read("deploy/k8s/base/api-deployment.yaml");
const worker = read("deploy/k8s/base/automation-deployment.yaml");
const config = read("deploy/k8s/base/configmap.yaml");
const kustomization = read("deploy/k8s/base/kustomization.yaml");
const networkPolicy = read("deploy/k8s/base/network-policy.yaml");
const secret = read("deploy/k8s/base/secret.example.yaml");
const hpa = read("deploy/k8s/base/api-hpa.yaml");
const workerHpa = read("deploy/k8s/base/automation-hpa.yaml");
const apiPdb = read("deploy/k8s/base/api-pdb.yaml");
const workerPdb = read("deploy/k8s/base/automation-pdb.yaml");
const ingress = read("deploy/k8s/overlays/example/ingress.yaml");
const ciOverlay = read("deploy/k8s/overlays/ci/kustomization.yaml");
const ciDependencies = read("deploy/k8s/overlays/ci/dependencies.yaml");
const dockerfile = read("Dockerfile");
const workerDockerfile = read("apps/automation-worker/Dockerfile");
const count = (text, value) => text.split(value).length - 1;
const has = (text, pattern) => assert.match(text, pattern);

has(api, /replicas: 2/);
has(api, /maxUnavailable: 0/);
has(api, /path: \/api\/ready/);
has(api, /path: \/api\/live/);
has(api, /fieldPath: metadata\.name/);
has(api, /topologySpreadConstraints:/);
has(api, /preferredDuringSchedulingIgnoredDuringExecution:/);
has(api, /whenUnsatisfiable: ScheduleAnyway/);
assert(!api.includes("requiredDuringSchedulingIgnoredDuringExecution"));
has(api, /runAsNonRoot: true/);
has(api, /readOnlyRootFilesystem: true/);
has(api, /name: hyeboard-api/);
assert(!api.includes(":latest"));
assert(!worker.includes(":latest"));
assert(api.includes("replace-with-release-tag"));
assert(worker.includes("replace-with-release-tag"));
assert(config.includes('HYEB_SHUTDOWN_TIMEOUT_MS: "30000"'));
has(hpa, /minReplicas: 2/);
has(hpa, /maxReplicas: 12/);
has(hpa, /averageUtilization: 70/);
assert(workerHpa.includes("name: hyeboard-automation-worker"));
assert(workerHpa.includes("minReplicas: 2"));
assert(workerHpa.includes("maxReplicas: 8"));
assert(workerHpa.includes("averageUtilization: 70"));
has(apiPdb, /maxUnavailable: 1/);
has(workerPdb, /maxUnavailable: 1/);
assert(!apiPdb.includes("minAvailable"));
assert(!workerPdb.includes("minAvailable"));
has(dockerfile, /ENTRYPOINT \["node", "dist\/index\.js"\]/);
has(workerDockerfile, /ENTRYPOINT \["node", "dist\/cli\.cjs"\]/);
has(worker, /replicas: 2/);
has(worker, /topologySpreadConstraints:/);
has(worker, /preferredDuringSchedulingIgnoredDuringExecution:/);
has(worker, /whenUnsatisfiable: ScheduleAnyway/);
assert(!worker.includes("requiredDuringSchedulingIgnoredDuringExecution"));
has(worker, /path: \/readyz/);
has(worker, /path: \/healthz/);
has(worker, /AUTOMATION_CONSUMER_NAME/);
has(worker, /AUTOMATION_CONTROL_CONSUMER_NAME/);
has(worker, /BROWSERLESS_TOKEN/);
has(config, /HYEB_HA_MODE: distributed/);
has(config, /AUTOMATION_EXECUTION_MODE: distributed/);
has(config, /AUTOMATION_BROWSER_PROVIDER: browserless/);
assert(kustomization.includes("api-deployment.yaml"));
assert(kustomization.includes("automation-deployment.yaml"));
assert(!kustomization.includes("newTag: latest"));
assert(config.includes('HYEB_AUTOMATION_EXECUTOR_READY: "false"'));
assert(secret.includes("replace-with"));
assert(!/eyJ[A-Za-z0-9_-]{20,}/.test(secret));
has(ingress, /nginx.ingress.kubernetes.io\/proxy-buffering: "off"/);
has(ingress, /nginx.ingress.kubernetes.io\/proxy-request-buffering: "off"/);
assert(ciOverlay.includes("dependencies.yaml"));
assert(ciOverlay.includes("newName: hyeboard-api"));
assert(ciOverlay.includes("newName: hyeboard-automation-worker"));
assert(ciDependencies.includes("name: postgres"));
assert(ciDependencies.includes("name: redis"));
assert(ciDependencies.includes("name: browserless"));
has(networkPolicy, /name: hyeboard-automation-worker/);
assert(networkPolicy.includes("policyTypes:\n    - Egress"));
assert(count(api, "secretKeyRef:") >= 5);
assert(count(worker, "secretKeyRef:") >= 5);

const readyCondition = [{ type: "Ready", status: "True" }];
const activeCondition = [{ type: "ScalingActive", status: "True" }];
const clusterSnapshot = {
  deployments: {
    items: ["hyeboard-api", "hyeboard-automation-worker"].map((name) => ({
      metadata: { name },
      spec: { replicas: 2 },
      status: { readyReplicas: 2 },
    })),
  },
  pods: {
    items: ["hyeboard-api", "hyeboard-automation-worker"].flatMap((name) =>
      ["a", "b"].map((suffix) => ({
        metadata: {
          name: `${name}-${suffix}`,
          uid: `${name}-${suffix}`,
          labels: { "app.kubernetes.io/name": name },
        },
        spec: { nodeName: `${name}-node-${suffix}` },
        status: { conditions: readyCondition },
      })),
    ),
  },
  endpointSlices: {
    items: [
      {
        endpoints: [
          { addresses: ["10.0.0.1"], conditions: { ready: true } },
          { addresses: ["10.0.0.2"], conditions: { ready: true } },
        ],
      },
    ],
  },
  hpas: {
    items: ["hyeboard-api", "hyeboard-automation-worker"].map((name) => ({
      metadata: { name },
      status: { currentReplicas: 2, conditions: activeCondition },
    })),
  },
};
validateClusterSnapshot(clusterSnapshot);
const oneReplica = structuredClone(clusterSnapshot);
oneReplica.deployments.items[0].status.readyReplicas = 1;
assert.throws(
  () => validateClusterSnapshot(oneReplica),
  /fewer than two ready replicas/,
);
const oneNode = structuredClone(clusterSnapshot);
oneNode.pods.items
  .filter(
    (pod) => pod.metadata.labels["app.kubernetes.io/name"] === "hyeboard-api",
  )
  .forEach((pod) => {
    pod.spec.nodeName = "hyeboard-api-node-a";
  });
assert.throws(
  () => validateClusterSnapshot(oneNode),
  /not spread across two nodes/,
);
const oneEndpoint = structuredClone(clusterSnapshot);
oneEndpoint.endpointSlices.items[0].endpoints.pop();
assert.throws(
  () => validateClusterSnapshot(oneEndpoint),
  /fewer than two ready endpoint addresses/,
);
const inactiveHpa = structuredClone(clusterSnapshot);
inactiveHpa.hpas.items[0].status.conditions[0].status = "False";
assert.throws(
  () => validateClusterSnapshot(inactiveHpa),
  /metrics are not active/,
);

console.log("Kubernetes manifest contract passed.");
