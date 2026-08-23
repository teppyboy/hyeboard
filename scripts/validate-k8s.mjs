import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { validateClusterSnapshot } from "./validate-k8s-cluster.mjs";

const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const option = (name) => {
  const prefix = `--${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument?.slice(prefix.length);
};
const api = read("deploy/k8s/base/api-deployment.yaml");
const worker = read("deploy/k8s/base/automation-deployment.yaml");
const kustomization = read("deploy/k8s/base/kustomization.yaml");
const overlays = ["example", "staging", "production"];
const overlayKustomizations = overlays.map((name) => ({
  name,
  text: read(`deploy/k8s/overlays/${name}/kustomization.yaml`),
}));
const config = kustomization;
const networkPolicy = read("deploy/k8s/base/network-policy.yaml");
const secret = read("deploy/k8s/base/secret.example.yaml");
const hpa = read("deploy/k8s/base/api-hpa.yaml");
const workerHpa = read("deploy/k8s/base/automation-hpa.yaml");
const apiPdb = read("deploy/k8s/base/api-pdb.yaml");
const workerPdb = read("deploy/k8s/base/automation-pdb.yaml");
const ingress = read("deploy/k8s/overlays/example/ingress.yaml");
const ciOverlay = read("deploy/k8s/overlays/ci/kustomization.yaml");
const ciDependencies = read("deploy/k8s/overlays/ci/dependencies.yaml");
const productionBrowserless = read("deploy/k8s/overlays/production/browserless-deployment.yaml");
const productionRedis = read("deploy/k8s/overlays/production/redis-replication.yaml");
const dockerfile = read("Dockerfile");
const workerDockerfile = read("apps/automation-worker/Dockerfile");
const count = (text, value) => text.split(value).length - 1;
const has = (text, pattern) => assert.match(text, pattern);
const templateImageTag = "replace-with-release-tag";
const mutableTags = new Set([
  "latest",
  "stable",
  "current",
  "main",
  "master",
  "develop",
  "development",
  "dev",
  "edge",
  "nightly",
]);

function resourceSection(text, kind, name) {
  const section = text.split(/^---\s*$/m).find(
    (candidate) =>
      new RegExp(`^kind:\\s*${kind}\\s*$`, "m").test(candidate) &&
      new RegExp(`^\\s+name:\\s*${name}\\s*$`, "m").test(candidate),
  );
  assert(section, `Missing ${kind} ${name}`);
  return section;
}

function imageReferences(text) {
  return [...text.matchAll(/^\s*image:\s*(?:>-\s*)?([A-Za-z0-9.-]+(?:\/[A-Za-z0-9._-]+)+)(?::([A-Za-z0-9][A-Za-z0-9._-]*)|@sha256:([a-f0-9]{64}))/gm)].map(
    (match) => ({
      image: match[1],
      tag: match[2],
      digest: match[3],
    }),
  );
}

function validateImageTags(text, { strict = false, expectedTag, requireReferences = true, allowedPinnedImages = [] } = {}) {
  const references = imageReferences(text);
  if (requireReferences) assert(references.length > 0, "No container image references found");
  for (const reference of references) {
    if (reference.digest) {
      assert(
        !strict || !/^([a-f0-9])\1{63}$/.test(reference.digest),
        `Image ${reference.image} still has a placeholder digest`,
      );
      continue;
    }
    if (reference.tag === templateImageTag) {
      assert(!strict, `Image ${reference.image} still has a placeholder tag`);
      continue;
    }
    assert(!mutableTags.has(reference.tag), `Image ${reference.image} uses mutable tag ${reference.tag}`);
    const pinnedDependency = allowedPinnedImages.some((pattern) => pattern.test(reference.image));
    if (!pinnedDependency) {
      assert(
        /^sha-[a-f0-9]{40}$/.test(reference.tag),
        `Image ${reference.image} must use a full SHA tag or digest, got ${reference.tag}`,
      );
      if (expectedTag) assert.equal(reference.tag, expectedTag);
    }
  }

  for (const match of text.matchAll(/^\s*digest:\s*sha256:([a-f0-9]{64})\s*$/gm)) {
    assert(
      !strict || !/^([a-f0-9])\1{63}$/.test(match[1]),
      "Kustomize image transform still has a placeholder digest",
    );
  }

  for (const match of text.matchAll(/^\s*newTag:\s*([^\s#]+)/gm)) {
    const tag = match[1].replace(/^['"]|['"]$/g, "");
    if (tag === templateImageTag) {
      assert(!strict, "Kustomize image transform still has a placeholder tag");
      continue;
    }
    assert(!mutableTags.has(tag), `Kustomize uses mutable image tag ${tag}`);
    assert(/^sha-[a-f0-9]{40}$/.test(tag), `Kustomize image tag is not immutable: ${tag}`);
    if (expectedTag) assert.equal(tag, expectedTag);
  }
}

function validateSecretTemplate(text) {
  has(text, /Template only\. Create the real Secret/);
  assert(!/^data:/m.test(text), "Secret template must not contain base64 data");
  const expectedKeys = [
    "HYEB_SESSION_SECRET",
    "HYEB_POSTGRES_URL",
    "HYEB_REDIS_URL",
    "AUTOMATION_KEY_CURRENT_ID",
    "AUTOMATION_KEY_CURRENT_B64",
    "BROWSERLESS_ENDPOINT",
    "BROWSERLESS_TOKEN",
  ];
  for (const key of expectedKeys) has(text, new RegExp(`^  ${key}:`, "m"));

  const secretBlocks = [...text.matchAll(/^  ([A-Z][A-Z0-9_]*):/gm)];
  for (const [index, match] of secretBlocks.entries()) {
    const end = secretBlocks[index + 1]?.index ?? text.length;
    const block = text.slice(match.index, end);
    assert(
      /replace-(?:with|me)|\.example\.|current-\d{4}-\d{2}/i.test(block),
      `Secret template value for ${match[1]} is not clearly marked as a placeholder`,
    );
  }
  assert(!/eyJ[A-Za-z0-9_-]{20,}/.test(text), "Secret template contains a JWT-like value");
  assert(!/-----BEGIN [^-]+-----/.test(text), "Secret template contains a private key");
  assert(!/(?:ghp_|github_pat_|AKIA[0-9A-Z]{16}|xox[baprs]-)/.test(text), "Secret template contains a provider token");
}

function validateDeploymentSecurity(text, name) {
  has(text, /automountServiceAccountToken:\s*false/);
  has(text, /runAsNonRoot:\s*true/);
  has(text, /seccompProfile:\s*\n\s+type:\s*RuntimeDefault/);
  has(text, /allowPrivilegeEscalation:\s*false/);
  has(text, /readOnlyRootFilesystem:\s*true/);
  has(text, /capabilities:\s*\n\s+drop:\s*(?:\[ALL\]|\n\s+-\s+ALL)/);
  has(text, /resources:[\s\S]*?requests:/);
  has(text, /resources:[\s\S]*?limits:/);
  has(text, /readinessProbe:/);
  has(text, /livenessProbe:/);
  has(text, /startupProbe:/);
  assert(!/^\s*(?:privileged|hostNetwork|hostPID|hostIPC):\s*true\s*$/m.test(text), `${name} enables a host or privileged setting`);
  assert(!/^\s*hostPath:/m.test(text), `${name} mounts a hostPath volume`);
  assert(!/name:\s*(?:HYEB_SESSION_SECRET|HYEB_POSTGRES_URL|HYEB_REDIS_URL|REDIS_URL|BROWSERLESS_TOKEN)\s*\n\s+value:/m.test(text), `${name} contains a literal secret value`);
}

function validateBrowserlessSecurity(text) {
  has(text, /automountServiceAccountToken:\s*false/);
  has(text, /runAsUser:\s*999/);
  has(text, /runAsNonRoot:\s*true/);
  has(text, /seccompProfile:\s*\n\s+type:\s*RuntimeDefault/);
  has(text, /allowPrivilegeEscalation:\s*false/);
  has(text, /capabilities:\s*\n\s+drop:\s*(?:\[ALL\]|\n\s+-\s+ALL)/);
  has(text, /mountPath:\s*\/dev\/shm/);
  has(text, /sizeLimit:\s*2Gi/);
  has(text, /readinessProbe:/);
  has(text, /livenessProbe:/);
  has(text, /startupProbe:/);
  assert(!/^\s*(?:privileged|hostNetwork|hostPID|hostIPC):\s*true\s*$/m.test(text), "Browserless enables a host or privileged setting");
  assert(!/^\s*hostPath:/m.test(text), "Browserless mounts a hostPath volume");
}

function validateRenderedManifest(text, expectedTag) {
  validateImageTags(text, {
    strict: true,
    expectedTag,
    allowedPinnedImages: [/^ghcr\.io\/browserless\/chromium$/, /^quay\.io\/opstree\/redis(?:-sentinel)?$/],
  });
  validateDeploymentSecurity(resourceSection(text, "Deployment", "hyeboard-api"), "hyeboard-api");
  validateDeploymentSecurity(resourceSection(text, "Deployment", "hyeboard-automation-worker"), "hyeboard-automation-worker");
  has(text, /kind:\s*NetworkPolicy/);
  has(text, /name:\s*hyeboard-api/);
  has(text, /name:\s*hyeboard-automation-worker/);
  if (/kind:\s*RedisReplication/.test(text)) {
    validateBrowserlessSecurity(resourceSection(text, "Deployment", "hyeboard-browserless"));
    resourceSection(text, "Service", "hyeboard-browserless");
    has(text, /kind:\s*RedisReplication/);
    has(text, /redisSecret:/);
    has(text, /sentinel:/);
    has(text, /clusterSize:\s*3/);
  }
}

validateImageTags(`${api}\n${worker}\n${kustomization}`);
for (const overlay of overlayKustomizations) {
  validateImageTags(`${kustomization}\n${overlay.text}`, { requireReferences: false });
  assert.equal(
    (overlay.text.match(/newTag:\s*replace-with-release-tag/g) ?? []).length,
    2,
    `${overlay.name} must declare both release image placeholders`,
  );
}
validateSecretTemplate(secret);
validateDeploymentSecurity(api, "hyeboard-api");
validateDeploymentSecurity(worker, "hyeboard-automation-worker");
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
assert(config.includes("HYEB_SHUTDOWN_TIMEOUT_MS=30000"));
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
assert(config.includes("HYEB_HA_MODE=distributed"));
assert(config.includes("AUTOMATION_EXECUTION_MODE=distributed"));
assert(config.includes("AUTOMATION_BROWSER_PROVIDER=browserless"));
assert(kustomization.includes("api-deployment.yaml"));
assert(kustomization.includes("automation-deployment.yaml"));
assert(!kustomization.includes("newTag: latest"));
assert(config.includes("HYEB_AUTOMATION_EXECUTOR_READY=false"));
assert(overlayKustomizations.find(({ name }) => name === "production").text.includes("browserless-deployment.yaml"));
assert(overlayKustomizations.find(({ name }) => name === "production").text.includes("redis-replication.yaml"));
validateBrowserlessSecurity(productionBrowserless);
has(productionBrowserless, /image: ghcr\.io\/browserless\/chromium:v2\.55\.4/);
assert(!productionBrowserless.includes(":latest"));
has(productionRedis, /apiVersion: redis\.redis\.opstreelabs\.in\/v1beta2/);
has(productionRedis, /clusterSize: 3/);
has(productionRedis, /redisSecret:/);
has(productionRedis, /name: hyeboard-redis-auth/);
has(productionRedis, /sentinel:/);
assert(!productionRedis.includes(":latest"));
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

const renderedPath = option("rendered");
if (renderedPath) {
  const rendered = readFileSync(renderedPath, "utf8");
  validateRenderedManifest(rendered, option("expected-tag"));
}

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
oneNode.pods.items.forEach((pod) => {
  pod.spec.nodeName = "single-test-node";
});
validateClusterSnapshot(oneNode);
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

console.log(
  renderedPath
    ? `Kubernetes manifest contract and rendered image validation passed (${renderedPath}).`
    : "Kubernetes manifest contract passed.",
);
