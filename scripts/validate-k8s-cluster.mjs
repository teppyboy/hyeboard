import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const namespace = process.env.HYEB_K8S_NAMESPACE ?? "hyeboard";
const failover = process.argv.includes("--failover");
const kubectl = process.env.KUBECTL_BIN ?? "kubectl";

function run(args, options = {}) {
  try {
    return execFileSync(kubectl, args, {
      encoding: "utf8",
      stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`kubectl ${args.join(" ")} failed: ${reason}`);
  }
}

function readJson(args) {
  const output = run([...args, "-o", "json"], { capture: true });
  try {
    return JSON.parse(output);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `kubectl ${args.join(" ")} returned invalid JSON: ${reason}`,
    );
  }
}

function assertPolicy(policies, type, value, periodSeconds, label) {
  const matches = policies.filter(
    (policy) =>
      policy.type === type &&
      policy.value === value &&
      policy.periodSeconds === periodSeconds,
  );
  if (matches.length !== 1) throw new Error(`${label} policy is invalid`);
}

function validateCpuHpa(hpa, name) {
  if (!hpa) throw new Error(`Missing HorizontalPodAutoscaler ${name}`);
  if (hpa.spec?.minReplicas !== 2 || hpa.spec?.maxReplicas !== 8)
    throw new Error(`${name} HPA must scale from 2 to 8 replicas`);
  const metrics = hpa.spec.metrics ?? [];
  if (
    metrics.length !== 1 ||
    metrics[0].type !== "Resource" ||
    metrics[0].resource?.name !== "cpu" ||
    metrics[0].resource?.target?.type !== "Utilization" ||
    metrics[0].resource?.target?.averageUtilization !== 60
  )
    throw new Error(`${name} HPA must use only a 60% CPU target`);
  const scaleUp = hpa.spec.behavior?.scaleUp;
  if (scaleUp?.stabilizationWindowSeconds !== 0)
    throw new Error(`${name} HPA scale-up stabilization is invalid`);
  const scaleUpPolicies = scaleUp?.policies ?? [];
  if (scaleUpPolicies.length !== 2)
    throw new Error(`${name} HPA scale-up policies are invalid`);
  assertPolicy(scaleUpPolicies, "Percent", 100, 30, `${name} HPA scale-up`);
  assertPolicy(scaleUpPolicies, "Pods", 2, 30, `${name} HPA scale-up`);
  const scaleDown = hpa.spec.behavior?.scaleDown;
  if (scaleDown?.stabilizationWindowSeconds !== 300)
    throw new Error(`${name} HPA scale-down stabilization is invalid`);
  const scaleDownPolicies = scaleDown?.policies ?? [];
  if (scaleDownPolicies.length !== 1)
    throw new Error(`${name} HPA scale-down policies are invalid`);
  assertPolicy(
    scaleDownPolicies,
    "Percent",
    25,
    60,
    `${name} HPA scale-down`,
  );
}

function validateBrowserless(deployment, hpas) {
  if (!deployment) return;
  const env = deployment.spec?.template?.spec?.containers?.[0]?.env ?? [];
  for (const [name, value] of [
    ["CONCURRENT", "1"],
    ["QUEUED", "2"],
    ["TIMEOUT", "120000"],
    ["MAX_RECONNECT_TIME", "120000"],
  ]) {
    const matches = env.filter((item) => item.name === name);
    if (matches.length !== 1 || matches[0].value !== value)
      throw new Error(
        `hyeboard-browserless must set ${name}=${value} exactly once`,
      );
  }
  validateCpuHpa(
    hpas.items.find((item) => item.metadata.name === "hyeboard-browserless"),
    "hyeboard-browserless",
  );
}

function deploymentImage(deployment) {
  return deployment?.spec?.template?.spec?.containers?.[0]?.image;
}

function apiRuntimeConfigName(apiDeployment) {
  const apiContainer = apiDeployment?.spec?.template?.spec?.containers?.find(
    (container) => container.name === "api",
  );
  const names = (apiContainer?.envFrom ?? [])
    .map((source) => source.configMapRef?.name)
    .filter(Boolean);
  if (names.length !== 1)
    throw new Error("hyeboard-api must reference exactly one runtime ConfigMap");
  return names[0];
}

function isDisposableCi(deploymentByName, allowCiAutomationExecutor) {
  return (
    allowCiAutomationExecutor &&
    deploymentImage(deploymentByName.get("hyeboard-api")) ===
      "hyeboard-api:ci" &&
    deploymentImage(deploymentByName.get("hyeboard-automation-worker")) ===
      "hyeboard-automation-worker:ci" &&
    ["postgres", "redis", "browserless"].every((name) =>
      deploymentByName.has(name),
    )
  );
}

export function validateClusterSnapshot(
  { configMaps, deployments, pods, endpointSlices, hpas },
  { allowCiAutomationExecutor = false } = {},
) {
  const deploymentByName = new Map(
    deployments.items.map((item) => [item.metadata.name, item]),
  );
  const runtimeConfigName = apiRuntimeConfigName(
    deploymentByName.get("hyeboard-api"),
  );
  const runtimeConfig = configMaps.items.find(
    (item) => item.metadata.name === runtimeConfigName,
  );
  if (!runtimeConfig)
    throw new Error(`Missing ConfigMap ${runtimeConfigName}`);
  const executorReady = runtimeConfig.data?.HYEB_AUTOMATION_EXECUTOR_READY;
  if (
    executorReady !== "false" &&
    !(
      executorReady === "true" &&
      isDisposableCi(deploymentByName, allowCiAutomationExecutor)
    )
  )
    throw new Error(
      "hyeboard-runtime must set HYEB_AUTOMATION_EXECUTOR_READY=false outside disposable CI",
    );
  for (const [name, value] of [
    ["HYEB_POSTGRES_POOL_MAX", "5"],
    ["HYEB_POSTGRES_CONNECT_TIMEOUT_MS", "5000"],
  ]) {
    if (runtimeConfig.data?.[name] !== value)
      throw new Error(`hyeboard-runtime must set ${name}=${value}`);
  }

  for (const name of ["hyeboard-api", "hyeboard-automation-worker"]) {
    const deployment = deploymentByName.get(name);
    if (!deployment) throw new Error(`Missing Deployment ${name}`);
    if ((deployment.spec.replicas ?? 0) < 2)
      throw new Error(`${name} has fewer than two desired replicas`);
    if ((deployment.status.readyReplicas ?? 0) < 2)
      throw new Error(`${name} has fewer than two ready replicas`);
    if ((deployment.status.unavailableReplicas ?? 0) > 0)
      throw new Error(`${name} has unavailable replicas`);
  }

  const readyPods = (name) =>
    pods.items.filter(
      (pod) =>
        pod.metadata.labels?.["app.kubernetes.io/name"] === name &&
        pod.status.conditions?.some(
          (condition) =>
            condition.type === "Ready" && condition.status === "True",
        ),
    );
  for (const name of ["hyeboard-api", "hyeboard-automation-worker"]) {
    const replicas = readyPods(name);
    if (replicas.length < 2)
      throw new Error(`${name} has fewer than two ready pods`);
    if (
      new Set(replicas.map((pod) => pod.metadata.uid)).size !== replicas.length
    )
      throw new Error(`${name} pod identities are not unique`);
  }

  const endpointAddresses = endpointSlices.items
    .flatMap((slice) => slice.endpoints ?? [])
    .filter((endpoint) => endpoint.conditions?.ready !== false)
    .flatMap((endpoint) => endpoint.addresses ?? []);
  if (new Set(endpointAddresses).size < 2)
    throw new Error(
      "hyeboard-api Service has fewer than two ready endpoint addresses",
    );

  const workerHpa = hpas.items.find(
    (item) => item.metadata.name === "hyeboard-automation-worker",
  );
  if (workerHpa)
    throw new Error("hyeboard-automation-worker HPA must be absent");
  const apiHpa = hpas.items.find(
    (item) => item.metadata.name === "hyeboard-api",
  );
  validateCpuHpa(apiHpa, "hyeboard-api");
  if ((apiHpa.status.currentReplicas ?? 0) < 2)
    throw new Error("hyeboard-api HPA reports fewer than two current replicas");
  const active = apiHpa.status.conditions?.some(
    (condition) =>
      condition.type === "ScalingActive" && condition.status === "True",
  );
  if (!active) throw new Error("hyeboard-api HPA metrics are not active");
  validateBrowserless(deploymentByName.get("hyeboard-browserless"), hpas);
}

function snapshot() {
  const deployments = readJson(["get", "deployments", "-n", namespace]);
  const apiDeployment = deployments.items.find(
    (item) => item.metadata.name === "hyeboard-api",
  );
  const runtimeConfigName = apiRuntimeConfigName(apiDeployment);
  return {
    configMaps: {
      items: [
        readJson([
          "get",
          "configmap",
          runtimeConfigName,
          "-n",
          namespace,
        ]),
      ],
    },
    deployments,
    pods: readJson(["get", "pods", "-n", namespace]),
    endpointSlices: readJson([
      "get",
      "endpointslices",
      "-n",
      namespace,
      "-l",
      "kubernetes.io/service-name=hyeboard-api",
    ]),
    hpas: readJson(["get", "hpa", "-n", namespace]),
  };
}

const smokeProgram = String.raw`
const endpoints = process.env.HYEB_API_ENDPOINTS.split(",").filter(Boolean);
const request = async (url, init) => {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(url + " returned HTTP " + response.status);
  return response.json();
};
const imported = await request("http://hyeboard-api/api/mock/auth/import-session", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ studentCode: "HA-K8S-SMOKE" }),
});
const token = imported.data?.token;
if (!token) throw new Error("Mock session import did not return a token");
for (const endpoint of endpoints) {
  const host = endpoint.includes(":") ? "[" + endpoint + "]" : endpoint;
  await request("http://" + host + ":8787/api/mock/auth/session", {
    headers: { authorization: "Bearer " + token },
  });
}
for (let attempt = 0; attempt < 20; attempt += 1) {
  await request("http://hyeboard-api/api/ready");
}
`;

function readyEndpointAddresses(clusterSnapshot) {
  return clusterSnapshot.endpointSlices.items
    .flatMap((slice) => slice.endpoints ?? [])
    .filter((endpoint) => endpoint.conditions?.ready !== false)
    .flatMap((endpoint) => endpoint.addresses ?? []);
}

function probeService(clusterSnapshot, verifyEndpoints = true) {
  const name = `hyeboard-smoke-${Date.now()}`;
  const endpoints = verifyEndpoints
    ? readyEndpointAddresses(clusterSnapshot)
    : [];
  run([
    "run",
    name,
    "-n",
    namespace,
    `--image=${process.env.HYEB_K8S_PROBE_IMAGE ?? "node:22-alpine"}`,
    "--restart=Never",
    "--rm",
    "-i",
    "--quiet",
    `--env=HYEB_API_ENDPOINTS=${endpoints.join(",")}`,
    "--command",
    "--",
    "node",
    "--input-type=module",
    "--eval",
    smokeProgram,
  ]);
}

function waitForRollouts() {
  for (const name of ["hyeboard-api", "hyeboard-automation-worker"]) {
    run([
      "rollout",
      "status",
      `deployment/${name}`,
      "-n",
      namespace,
      "--timeout=180s",
    ]);
  }
}

function main() {
  waitForRollouts();
  let currentSnapshot = snapshot();
  const validationOptions = {
    allowCiAutomationExecutor:
      process.env.HYEB_K8S_ALLOW_CI_AUTOMATION_EXECUTOR === "true",
  };
  validateClusterSnapshot(currentSnapshot, validationOptions);
  probeService(currentSnapshot);

  if (failover) {
    const pods = currentSnapshot.pods.items.filter(
      (pod) =>
        pod.metadata.labels?.["app.kubernetes.io/name"] === "hyeboard-api" &&
        pod.status.conditions?.some(
          (condition) =>
            condition.type === "Ready" && condition.status === "True",
        ),
    );
    if (!pods[0])
      throw new Error("No ready API pod is available for failover test");
    run([
      "delete",
      "pod",
      pods[0].metadata.name,
      "-n",
      namespace,
      "--wait=false",
    ]);
    probeService(currentSnapshot, false);
    waitForRollouts();
    currentSnapshot = snapshot();
    validateClusterSnapshot(currentSnapshot, validationOptions);
    probeService(currentSnapshot);
  }

  console.log(
    `Kubernetes cluster validation passed in namespace ${namespace}${failover ? " with API pod failover" : ""}.`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
