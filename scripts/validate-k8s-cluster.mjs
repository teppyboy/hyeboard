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

export function validateClusterSnapshot({
  deployments,
  pods,
  endpointSlices,
  hpas,
}) {
  const deploymentByName = new Map(
    deployments.items.map((item) => [item.metadata.name, item]),
  );
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

  const hpaByName = new Map(
    hpas.items.map((item) => [item.metadata.name, item]),
  );
  for (const name of ["hyeboard-api", "hyeboard-automation-worker"]) {
    const hpa = hpaByName.get(name);
    if (!hpa) throw new Error(`Missing HorizontalPodAutoscaler ${name}`);
    if ((hpa.status.currentReplicas ?? 0) < 2)
      throw new Error(`${name} HPA reports fewer than two current replicas`);
    const active = hpa.status.conditions?.some(
      (condition) =>
        condition.type === "ScalingActive" && condition.status === "True",
    );
    if (!active) throw new Error(`${name} HPA metrics are not active`);
  }
}

function snapshot() {
  return {
    deployments: readJson(["get", "deployments", "-n", namespace]),
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
  validateClusterSnapshot(currentSnapshot);
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
    validateClusterSnapshot(currentSnapshot);
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
