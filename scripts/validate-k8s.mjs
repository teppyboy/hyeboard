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
const apiPdb = read("deploy/k8s/base/api-pdb.yaml");
const workerPdb = read("deploy/k8s/base/automation-pdb.yaml");
const ingress = read("deploy/k8s/overlays/example/ingress.yaml");
const ciOverlay = read("deploy/k8s/overlays/ci/kustomization.yaml");
const ciConfig = read("deploy/k8s/overlays/ci/configmap-patch.yaml");
const ciDependencies = read("deploy/k8s/overlays/ci/dependencies.yaml");
const productionBrowserless = read("deploy/k8s/overlays/production/browserless-deployment.yaml");
const productionBrowserlessHpa = read("deploy/k8s/overlays/production/browserless-hpa.yaml");
const productionRedis = read("deploy/k8s/overlays/production/redis-replication.yaml");
const ingressScalingPatch = read("deploy/k8s/operator/ingress-nginx-scaling-patch.yaml");
const ingressPdb = read("deploy/k8s/operator/ingress-nginx-pdb.yaml");
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

function resourceSections(text) {
  return text.split(/^---\s*$/m);
}

function resourceSection(text, kind, name) {
  const section = resourceSections(text).find(
    (candidate) =>
      new RegExp(`^kind:\\s*${kind}\\s*$`, "m").test(candidate) &&
      new RegExp(`^\\s+name:\\s*${name}\\s*$`, "m").test(candidate),
  );
  assert(section, `Missing ${kind} ${name}`);
  return section;
}

function resourceSectionMatching(text, kind, namePattern) {
  const section = resourceSections(text).find((candidate) => {
    if (!new RegExp(`^kind:\\s*${kind}\\s*$`, "m").test(candidate)) return false;
    const name = candidate.match(/^\s+name:\s*([^\s#]+)\s*$/m)?.[1];
    return namePattern.test(name ?? "");
  });
  assert(section, `Missing ${kind} matching ${namePattern}`);
  return section;
}

function yamlFieldBlock(document, field) {
  const lines = document.split("\n");
  const index = lines.findIndex((line) => line.trim() === `${field}:`);
  assert(index >= 0, `Missing ${field}`);
  const indent = lines[index].match(/^\s*/)[0].length;
  const block = [];
  for (const line of lines.slice(index + 1)) {
    const lineIndent = line.match(/^\s*/)[0].length;
    if (line.trim() && lineIndent <= indent && !line.trimStart().startsWith("-"))
      break;
    block.push(line);
  }
  return block;
}

function validateRenderedCpuHpa(text, name) {
  const section = resourceSection(text, "HorizontalPodAutoscaler", name);
  has(section, /^\s*minReplicas:\s*2\s*$/m);
  has(section, /^\s*maxReplicas:\s*8\s*$/m);
  has(section, /scaleUp:[\s\S]*?stabilizationWindowSeconds:\s*0/);
  has(section, /periodSeconds:\s*30\s*\n\s*type:\s*Percent\s*\n\s*value:\s*100/);
  has(section, /periodSeconds:\s*30\s*\n\s*type:\s*Pods\s*\n\s*value:\s*2/);
  has(section, /scaleDown:[\s\S]*?periodSeconds:\s*60\s*\n\s*type:\s*Percent\s*\n\s*value:\s*25/);
  has(section, /scaleDown:[\s\S]*?stabilizationWindowSeconds:\s*300/);
  const metrics = yamlFieldBlock(section, "metrics");
  const itemIndent = metrics.find((line) => /^\s*-\s+/.test(line))?.match(/^\s*/)[0].length;
  const items = metrics.filter(
    (line) => /^\s*-\s+/.test(line) && line.match(/^\s*/)[0].length === itemIndent,
  );
  assert.equal(items.length, 1, `${name} must have exactly one metric`);
  const metric = metrics.join("\n");
  assert.equal(count(metric, "type: Resource"), 1, `${name} must have one Resource metric`);
  assert.equal(count(metric, "name: cpu"), 1, `${name} must use CPU only`);
  assert.equal(
    (metric.match(/type:\s*Utilization\s*$/gm) ?? []).length,
    1,
    `${name} must have one utilization target`,
  );
  assert.equal(
    (metric.match(/averageUtilization:\s*60\s*$/gm) ?? []).length,
    1,
    `${name} must have one 60% CPU target`,
  );
  assert(
    !/^\s+(?:pods|object|external|containerResource):\s*$/m.test(metric),
    `${name} contains another metric source`,
  );
  assert(!metric.includes("name: memory"), `${name} must not use memory`);
}

function validateRenderedRuntime(text) {
  const configMap = resourceSectionMatching(text, "ConfigMap", /^hyeboard-runtime(?:-|$)/);
  for (const [name, value] of [
    ["HYEB_AUTOMATION_EXECUTOR_READY", "false"],
    ["HYEB_POSTGRES_POOL_MAX", "5"],
    ["HYEB_POSTGRES_CONNECT_TIMEOUT_MS", "5000"],
  ])
    has(configMap, new RegExp(`^\\s*${name}: ["']?${value}["']?\\s*$`, "m"));
}

function imageFields(text) {
  const lines = text.split("\n");
  const images = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s*image:\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[1];
    if (/^(?:>-?|\|-?)$/.test(value)) {
      value = lines.slice(index + 1).find((line) => line.trim())?.trim() ?? "";
    }
    images.push(value.replace(/^['"]|['"]$/g, ""));
  }
  return images;
}

function imageReferences(text) {
  return imageFields(text).map((reference) => {
    const digest = reference.match(/@sha256:([a-f0-9]{64})$/i)?.[1];
    const withoutDigest = digest ? reference.slice(0, reference.lastIndexOf("@")) : reference;
    const lastSlash = withoutDigest.lastIndexOf("/");
    const colon = withoutDigest.lastIndexOf(":");
    const tag = !digest && colon > lastSlash ? withoutDigest.slice(colon + 1) : undefined;
    const image = digest
      ? withoutDigest
      : tag
        ? withoutDigest.slice(0, colon)
        : withoutDigest;
    return { image, tag, digest, reference };
  });
}

function validateImageTags(text, { strict = false, expectedTag, requireReferences = true, allowedPinnedImages = [] } = {}) {
  const references = imageReferences(text);
  if (requireReferences) assert(references.length > 0, "No container image references found");
  for (const reference of references) {
    assert(
      reference.digest || reference.tag,
      `Image ${reference.reference || "<empty>"} must use a tag or digest`,
    );
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

function validateBoundedBrowserlessEnv(text, label) {
  for (const [name, value] of [
    ["CONCURRENT", "1"],
    ["QUEUED", "2"],
    ["TIMEOUT", "120000"],
    ["MAX_RECONNECT_TIME", "120000"],
  ]) {
    assert.equal(
      text.match(new RegExp(`^\\s*- name: ${name}\\s*$`, "gm"))?.length,
      1,
      `${label} must declare ${name} exactly once`,
    );
    has(
      text,
      new RegExp(
        `name: ${name}\\s*\\n\\s+value: ["']?${value}["']?\\s*$`,
        "m",
      ),
    );
  }
}

function validateBrowserlessSecurity(text) {
  has(text, /automountServiceAccountToken:\s*false/);
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
  validateRenderedRuntime(text);
  validateRenderedCpuHpa(text, "hyeboard-api");
  assert(
    !resourceSections(text).some(
      (section) =>
        /^kind:\s*HorizontalPodAutoscaler\s*$/m.test(section) &&
        /^\s+name:\s*hyeboard-automation-worker\s*$/m.test(section),
    ),
    "Rendered manifest must not contain an automation-worker HPA",
  );
  has(text, /kind:\s*NetworkPolicy/);
  has(text, /name:\s*hyeboard-api/);
  has(text, /name:\s*hyeboard-automation-worker/);
  const hasBrowserless = resourceSections(text).some(
    (section) =>
      /^kind:\s*Deployment\s*$/m.test(section) &&
      /^\s+name:\s*hyeboard-browserless\s*$/m.test(section),
  );
  if (hasBrowserless) {
    const browserless = resourceSection(text, "Deployment", "hyeboard-browserless");
    validateBrowserlessSecurity(browserless);
    validateBoundedBrowserlessEnv(browserless, "Rendered Browserless");
    validateRenderedCpuHpa(text, "hyeboard-browserless");
    resourceSection(text, "Service", "hyeboard-browserless");
  }
  if (/kind:\s*RedisReplication/.test(text)) {
    has(text, /redisSecret:/);
    has(text, /sentinel:/);
    has(text, /clusterSize:\s*3/);
  }
}

validateImageTags(`${api}\n${worker}\n${kustomization}`);
assert.throws(
  () =>
    validateImageTags("image: ghcr.io/im-yuuki/hyeboard-api", {
      strict: true,
    }),
  /must use a tag or digest/,
);
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
assert(config.includes("HYEB_POSTGRES_POOL_MAX=5"));
assert(config.includes("HYEB_POSTGRES_CONNECT_TIMEOUT_MS=5000"));
has(api, /requests:\s*\n\s+cpu: 100m\s*\n\s+memory: 192Mi/);
has(worker, /requests:\s*\n\s+cpu: 100m\s*\n\s+memory: 192Mi/);
has(hpa, /minReplicas: 2/);
has(hpa, /maxReplicas: 8/);
has(hpa, /scaleUp:\s*\n\s+stabilizationWindowSeconds: 0/);
has(hpa, /type: Percent\s*\n\s+value: 100\s*\n\s+periodSeconds: 30/);
has(hpa, /type: Pods\s*\n\s+value: 2\s*\n\s+periodSeconds: 30/);
has(hpa, /scaleDown:\s*\n\s+stabilizationWindowSeconds: 300/);
has(hpa, /type: Percent\s*\n\s+value: 25\s*\n\s+periodSeconds: 60/);
has(hpa, /averageUtilization: 60/);
assert(!hpa.includes("name: memory"));
assert(!kustomization.includes("automation-hpa.yaml"));
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
validateBoundedBrowserlessEnv(
  productionBrowserless,
  "Production Browserless",
);
assert.throws(
  () =>
    validateBoundedBrowserlessEnv(
      productionBrowserless.replace(
        "            - name: CONCURRENT",
        "            - name: CONCURRENT\n              value: \"1\"\n            - name: CONCURRENT",
      ),
      "Production Browserless",
    ),
  /must declare CONCURRENT exactly once/,
);
has(productionBrowserlessHpa, /minReplicas: 2/);
has(productionBrowserlessHpa, /maxReplicas: 8/);
has(productionBrowserlessHpa, /averageUtilization: 60/);
assert(!productionBrowserlessHpa.includes("name: memory"));
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
assert(ciConfig.includes('HYEB_AUTOMATION_EXECUTOR_READY: "true"'));
for (const overlay of overlayKustomizations)
  assert(!overlay.text.includes("HYEB_AUTOMATION_EXECUTOR_READY=true"));
has(ingressScalingPatch, /replicas: 2/);
has(ingressScalingPatch, /whenUnsatisfiable: ScheduleAnyway/);
has(ingressScalingPatch, /topologyKey: kubernetes\.io\/hostname/);
has(ingressPdb, /maxUnavailable: 1/);
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
  const expectedTag = option("expected-tag");
  validateRenderedManifest(rendered, expectedTag);
  const untaggedApi = rendered.replace(
    /^(\s*image:\s*[^\s#]*hyeboard-api)(?::[^\s#]+|@sha256:[a-f0-9]{64})\s*$/m,
    "$1",
  );
  assert.notEqual(untaggedApi, rendered, "Rendered API image was not found");
  assert.throws(
    () => validateRenderedManifest(untaggedApi, expectedTag),
    /must use a tag or digest/,
  );
  if (/^\s+name:\s*hyeboard-browserless\s*$/m.test(rendered)) {
    const duplicateBrowserlessEnv = rendered.replace(
      /^\s*- name: CONCURRENT\s*$/m,
      "        - name: CONCURRENT\n          value: \"1\"\n        - name: CONCURRENT",
    );
    assert.notEqual(
      duplicateBrowserlessEnv,
      rendered,
      "Rendered Browserless CONCURRENT variable was not found",
    );
    assert.throws(
      () => validateRenderedManifest(duplicateBrowserlessEnv, expectedTag),
      /CONCURRENT exactly once/,
    );
  }
}

const readyCondition = [{ type: "Ready", status: "True" }];
const activeCondition = [{ type: "ScalingActive", status: "True" }];
const cpuHpa = (name) => ({
  metadata: { name },
  spec: {
    minReplicas: 2,
    maxReplicas: 8,
    behavior: {
      scaleUp: {
        stabilizationWindowSeconds: 0,
        policies: [
          { type: "Percent", value: 100, periodSeconds: 30 },
          { type: "Pods", value: 2, periodSeconds: 30 },
        ],
      },
      scaleDown: {
        stabilizationWindowSeconds: 300,
        policies: [{ type: "Percent", value: 25, periodSeconds: 60 }],
      },
    },
    metrics: [
      {
        type: "Resource",
        resource: {
          name: "cpu",
          target: { type: "Utilization", averageUtilization: 60 },
        },
      },
    ],
  },
  status: { currentReplicas: 2, conditions: activeCondition },
});
const clusterSnapshot = {
  configMaps: {
    items: [
      {
        metadata: { name: "hyeboard-runtime-stale" },
        data: {
          HYEB_AUTOMATION_EXECUTOR_READY: "true",
          HYEB_POSTGRES_POOL_MAX: "50",
          HYEB_POSTGRES_CONNECT_TIMEOUT_MS: "50000",
        },
      },
      {
        metadata: { name: "hyeboard-runtime-test" },
        data: {
          HYEB_AUTOMATION_EXECUTOR_READY: "false",
          HYEB_POSTGRES_POOL_MAX: "5",
          HYEB_POSTGRES_CONNECT_TIMEOUT_MS: "5000",
        },
      },
    ],
  },
  deployments: {
    items: [
      {
        metadata: { name: "hyeboard-api" },
        spec: {
          replicas: 2,
          template: {
            spec: {
              containers: [
                {
                  name: "api",
                  image: "registry.example/hyeboard-api:release",
                  envFrom: [
                    { configMapRef: { name: "hyeboard-runtime-test" } },
                  ],
                },
              ],
            },
          },
        },
        status: { readyReplicas: 2 },
      },
      {
        metadata: { name: "hyeboard-automation-worker" },
        spec: {
          replicas: 2,
          template: {
            spec: {
              containers: [
                {
                  name: "automation-worker",
                  image:
                    "registry.example/hyeboard-automation-worker:release",
                },
              ],
            },
          },
        },
        status: { readyReplicas: 2 },
      },
    ],
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
  hpas: { items: [cpuHpa("hyeboard-api")] },
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
const missingReferencedRuntime = structuredClone(clusterSnapshot);
missingReferencedRuntime.deployments.items[0].spec.template.spec.containers[0].envFrom[0].configMapRef.name =
  "hyeboard-runtime-missing";
assert.throws(
  () => validateClusterSnapshot(missingReferencedRuntime),
  /Missing ConfigMap hyeboard-runtime-missing/,
);
const unsafeRuntime = structuredClone(clusterSnapshot);
unsafeRuntime.configMaps.items[1].data.HYEB_AUTOMATION_EXECUTOR_READY = "true";
assert.throws(
  () => validateClusterSnapshot(unsafeRuntime),
  /HYEB_AUTOMATION_EXECUTOR_READY=false outside disposable CI/,
);
assert.throws(
  () =>
    validateClusterSnapshot(unsafeRuntime, {
      allowCiAutomationExecutor: true,
    }),
  /HYEB_AUTOMATION_EXECUTOR_READY=false outside disposable CI/,
);
const ciSnapshot = structuredClone(unsafeRuntime);
ciSnapshot.deployments.items[0].spec.template.spec.containers[0].image =
  "hyeboard-api:ci";
ciSnapshot.deployments.items[1].spec.template.spec.containers[0].image =
  "hyeboard-automation-worker:ci";
for (const name of ["postgres", "redis", "browserless"])
  ciSnapshot.deployments.items.push({ metadata: { name }, spec: {} });
validateClusterSnapshot(ciSnapshot, { allowCiAutomationExecutor: true });
const ciWithoutAllow = structuredClone(ciSnapshot);
assert.throws(
  () => validateClusterSnapshot(ciWithoutAllow),
  /HYEB_AUTOMATION_EXECUTOR_READY=false outside disposable CI/,
);
const ciWithWrongImage = structuredClone(ciSnapshot);
ciWithWrongImage.deployments.items[0].spec.template.spec.containers[0].image =
  "registry.example/hyeboard-api:ci";
assert.throws(
  () =>
    validateClusterSnapshot(ciWithWrongImage, {
      allowCiAutomationExecutor: true,
    }),
  /HYEB_AUTOMATION_EXECUTOR_READY=false outside disposable CI/,
);
const ciWithoutDependency = structuredClone(ciSnapshot);
ciWithoutDependency.deployments.items = ciWithoutDependency.deployments.items.filter(
  (deployment) => deployment.metadata.name !== "redis",
);
assert.throws(
  () =>
    validateClusterSnapshot(ciWithoutDependency, {
      allowCiAutomationExecutor: true,
    }),
  /HYEB_AUTOMATION_EXECUTOR_READY=false outside disposable CI/,
);
const invalidApiHpa = structuredClone(clusterSnapshot);
invalidApiHpa.hpas.items[0].spec.metrics.push({
  type: "Resource",
  resource: {
    name: "memory",
    target: { type: "Utilization", averageUtilization: 75 },
  },
});
assert.throws(
  () => validateClusterSnapshot(invalidApiHpa),
  /must use only a 60% CPU target/,
);
const workerHpa = structuredClone(clusterSnapshot);
workerHpa.hpas.items.push(cpuHpa("hyeboard-automation-worker"));
assert.throws(
  () => validateClusterSnapshot(workerHpa),
  /automation-worker HPA must be absent/,
);
const browserlessSnapshot = structuredClone(clusterSnapshot);
browserlessSnapshot.deployments.items.push({
  metadata: { name: "hyeboard-browserless" },
  spec: {
    replicas: 2,
    template: {
      spec: {
        containers: [
          {
            env: [
              { name: "CONCURRENT", value: "1" },
              { name: "QUEUED", value: "2" },
              { name: "TIMEOUT", value: "120000" },
              { name: "MAX_RECONNECT_TIME", value: "120000" },
            ],
          },
        ],
      },
    },
  },
});
browserlessSnapshot.hpas.items.push(cpuHpa("hyeboard-browserless"));
validateClusterSnapshot(browserlessSnapshot);
const unboundedBrowserless = structuredClone(browserlessSnapshot);
unboundedBrowserless.deployments.items.at(-1).spec.template.spec.containers[0].env[0].value = "10";
assert.throws(
  () => validateClusterSnapshot(unboundedBrowserless),
  /must set CONCURRENT=1 exactly once/,
);
const duplicateBrowserless = structuredClone(browserlessSnapshot);
duplicateBrowserless.deployments.items.at(-1).spec.template.spec.containers[0].env.push(
  { name: "CONCURRENT", value: "1" },
);
assert.throws(
  () => validateClusterSnapshot(duplicateBrowserless),
  /must set CONCURRENT=1 exactly once/,
);

console.log(
  renderedPath
    ? `Kubernetes manifest contract and rendered image validation passed (${renderedPath}).`
    : "Kubernetes manifest contract passed.",
);
