import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const chartPath = resolve(repositoryRoot, "deploy/helm/hyeboard");
const placeholderTag = "replace-with-release-tag";
const defaultReleaseName = "hyeboard";
const secretNames = [
  "HYEB_SESSION_SECRET",
  "HYEB_ADMIN_SESSION_SECRET",
  "HYEB_ADMIN_PASSWORD_HASH",
  "HYEB_ADMIN_GITHUB_CLIENT_SECRET",
  "HYEB_ADMIN_DISCORD_CLIENT_SECRET",
  "DATABASE_URL",
  "HYEB_POSTGRES_URL",
  "HYEB_REDIS_URL",
  "REDIS_URL",
  "AUTOMATION_KEY_CURRENT_ID",
  "AUTOMATION_KEY_CURRENT_B64",
  "AUTOMATION_KEY_PREVIOUS_ID",
  "AUTOMATION_KEY_PREVIOUS_B64",
  "BROWSERLESS_ENDPOINT",
  "BROWSERLESS_TOKEN",
];
const secretKeys = new Set(secretNames);
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
const allowUnpinnedImages = new Set([
  "quay.io/opstree/redis",
  "quay.io/opstree/redis-sentinel",
]);
const adminRuntimeCases = [
  ["accepts canonical admin runtime values", true, {
    HYEB_ADMIN_SESSION_TTL_SECONDS: "86400",
    HYEB_ADMIN_PUBLIC_ORIGIN: "https://admin.example.test:8443",
    HYEB_ADMIN_GITHUB_CLIENT_ID: "github-client",
    HYEB_ADMIN_GITHUB_IDS: "42, 7",
    HYEB_ADMIN_DISCORD_CLIENT_ID: "discord-client",
    HYEB_ADMIN_DISCORD_IDS: "123456789012345678",
  }],
  ["accepts localhost HTTP origin", true, { HYEB_ADMIN_PUBLIC_ORIGIN: "http://localhost:5173" }],
  ["accepts loopback HTTP origin with non-default port", true, { HYEB_ADMIN_PUBLIC_ORIGIN: "http://localhost:8787" }],
  ["accepts IPv4 loopback HTTP origin", true, { HYEB_ADMIN_PUBLIC_ORIGIN: "http://127.0.0.1:5173" }],
  ["accepts IPv6 loopback HTTP origin", true, { HYEB_ADMIN_PUBLIC_ORIGIN: "http://[::1]:5173" }],
  ["rejects zero TTL", false, { HYEB_ADMIN_SESSION_TTL_SECONDS: "0" }],
  ["rejects non-canonical TTL", false, { HYEB_ADMIN_SESSION_TTL_SECONDS: "03600" }],
  ["rejects TTL above runtime bound", false, { HYEB_ADMIN_SESSION_TTL_SECONDS: "86401" }],
  ["rejects non-loopback HTTP origin", false, { HYEB_ADMIN_PUBLIC_ORIGIN: "http://admin.example.test" }],
  ["rejects origin trailing slash", false, { HYEB_ADMIN_PUBLIC_ORIGIN: "https://admin.example.test/" }],
  ["rejects origin path", false, { HYEB_ADMIN_PUBLIC_ORIGIN: "https://admin.example.test/admin" }],
  ["rejects origin query", false, { HYEB_ADMIN_PUBLIC_ORIGIN: "https://admin.example.test?mode=admin" }],
  ["rejects origin fragment", false, { HYEB_ADMIN_PUBLIC_ORIGIN: "https://admin.example.test#login" }],
  ["rejects origin credentials", false, { HYEB_ADMIN_PUBLIC_ORIGIN: "https://operator:secret@admin.example.test" }],
  ["rejects origin port above URL bounds", false, { HYEB_ADMIN_PUBLIC_ORIGIN: "https://admin.example.test:65536" }],
  ["rejects empty client ID", false, { HYEB_ADMIN_GITHUB_CLIENT_ID: "" }],
  ["rejects oversized client ID", false, { HYEB_ADMIN_DISCORD_CLIENT_ID: "x".repeat(257) }],
  ["rejects zero ID", false, { HYEB_ADMIN_GITHUB_IDS: "0" }],
  ["rejects leading-zero ID", false, { HYEB_ADMIN_DISCORD_IDS: "007" }],
  ["rejects empty ID entry", false, { HYEB_ADMIN_GITHUB_IDS: "42,,7" }],
  ["rejects malformed ID", false, { HYEB_ADMIN_DISCORD_IDS: "42,user" }],
  ["allows duplicate ID shape for runtime rejection", true, { HYEB_ADMIN_GITHUB_IDS: "42, 7,42" }],
];
const prohibitedConfigMapKeys = [
  "HYEB_ADMIN_DB_PATH",
  ...secretNames,
];
const adminOriginCanonicalCases = [
  ["accepts HTTPS origin with non-default port", true, "https://admin.example.test:8443"],
  ["accepts loopback HTTP origin with non-default port", true, "http://localhost:8787"],
  ["rejects explicit HTTPS default port", false, "https://admin.example.test:443"],
  ["rejects explicit loopback HTTP default port", false, "http://localhost:80"],
];
const extraEnvCases = [
  ["accepts unrelated literal extraEnv", true, { name: "HYEB_CUSTOM_SETTING", value: "enabled" }],
  ["accepts unrelated valueFrom extraEnv", true, { name: "HYEB_CUSTOM_SOURCE", valueFrom: { fieldRef: { fieldPath: "metadata.name" } } }],
  ["rejects literal admin secret extraEnv", false, { name: "HYEB_ADMIN_SESSION_SECRET", value: "literal-secret" }],
  ["rejects admin secretKeyRef extraEnv", false, { name: "HYEB_ADMIN_SESSION_SECRET", valueFrom: { secretKeyRef: { name: "other-secret", key: "value" } } }],
  ["rejects local admin DB extraEnv", false, { name: "HYEB_ADMIN_DB_PATH", value: "/tmp/admin.sqlite" }],
  ["rejects managed HA mode extraEnv", false, { name: "HYEB_HA_MODE", value: "memory" }],
  ["rejects managed GitHub client ID extraEnv", false, { name: "HYEB_ADMIN_GITHUB_CLIENT_ID", value: "other-client" }],
  ["rejects managed Discord IDs extraEnv", false, { name: "HYEB_ADMIN_DISCORD_IDS", value: "42" }],
  ["rejects duplicate extraEnv names", false, [
    { name: "HYEB_CUSTOM_DUPLICATE", value: "one" },
    { name: "HYEB_CUSTOM_DUPLICATE", value: "two" },
  ]],
];
const apiTemplateEnvNames = [
  "HYEB_SESSION_SECRET",
  "HYEB_ADMIN_SESSION_SECRET",
  "HYEB_ADMIN_PASSWORD_HASH",
  "HYEB_ADMIN_GITHUB_CLIENT_SECRET",
  "HYEB_ADMIN_DISCORD_CLIENT_SECRET",
  "HYEB_POSTGRES_URL",
  "HYEB_REDIS_URL",
  "AUTOMATION_KEY_CURRENT_ID",
  "AUTOMATION_KEY_CURRENT_B64",
  "AUTOMATION_KEY_PREVIOUS_ID",
  "AUTOMATION_KEY_PREVIOUS_B64",
  "HYEB_HA_NODE_ID",
];
const chartManagedEnvNames = [
  ...prohibitedConfigMapKeys,
  ...apiTemplateEnvNames,
  "HYEB_HA_MODE",
  "HYEB_ADMIN_PUBLIC_ORIGIN",
  "HYEB_ADMIN_GITHUB_CLIENT_ID",
  "HYEB_ADMIN_GITHUB_IDS",
  "HYEB_ADMIN_DISCORD_CLIENT_ID",
  "HYEB_ADMIN_DISCORD_IDS",
  "REDIS_URL",
  "BROWSERLESS_ENDPOINT",
  "BROWSERLESS_TOKEN",
  "AUTOMATION_CONSUMER_NAME",
  "AUTOMATION_CONTROL_CONSUMER_NAME",
  "TOKEN",
];
const configMapKeyCases = [
  ["accepts arbitrary non-secret config.runtime key", true, "runtime", "HYEB_CUSTOM_RUNTIME_SETTING"],
  ["accepts arbitrary non-secret config.extraData key", true, "extraData", "CUSTOM_CONFIG_DATA"],
  ...prohibitedConfigMapKeys.flatMap((key) => [
    [`rejects config.runtime.${key}`, false, "runtime", key],
    [`rejects config.extraData.${key}`, false, "extraData", key],
  ]),
];

const args = new Set(process.argv.slice(2));
const option = (name) => {
  const prefix = `--${name}=`;
  const value = process.argv.find((argument) => argument.startsWith(prefix));
  return value?.slice(prefix.length);
};
const strict = args.has("--strict") || process.env.HELM_VALIDATION_STRICT === "true";
const requireChart = args.has("--require-chart") || strict;
const requestedImageTag = option("image-tag");
const imageTag = requestedImageTag || "sha-validation000000000000000000000000000000000000";

function fail(message) {
  throw new Error(`Helm validation failed: ${message}`);
}

function listFiles(directory) {
  if (!statSync(directory).isDirectory()) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return listFiles(path);
    return /\.ya?ml$/i.test(entry.name) ? [path] : [];
  });
}

function findOverride(kind) {
  const candidates = listFiles(chartPath).filter((path) => {
    const name = path.toLowerCase();
    if (name.endsWith("/values.yaml")) return false;
    if (!name.includes("values") && !name.includes("override")) return false;
    if (kind === "example") return /example|sample/.test(name);
    return /production|prod|release/.test(name);
  });
  return candidates.sort((left, right) => left.length - right.length)[0];
}

function runHelm(arguments_, label) {
  const result = spawnSync("helm", arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) fail(`${label}: ${result.error.message}`);
  if (result.status !== 0) {
    const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
    fail(`${label} exited with ${result.status}:\n${output}`);
  }
  return result.stdout || "";
}

function helmAvailable() {
  const result = spawnSync("helm", ["version", "--short"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  return !result.error && result.status === 0;
}

function imageTagPaths(paths) {
  for (const path of listFiles(chartPath).filter((file) => /values\.ya?ml$/i.test(file))) {
    const lines = readFileSync(path, "utf8").split("\n");
    const stack = [];
    for (const line of lines) {
      const match = line.match(/^(\s*)([A-Za-z0-9_-]+):(?:\s*(.*))?\s*$/);
      if (!match || /^\s*#/.test(line) || /^\s*-/.test(line)) continue;
      const indent = match[1].length;
      while (stack.length && stack.at(-1).indent >= indent) stack.pop();
      const pathParts = [...stack.map((entry) => entry.key), match[2]];
      if (
        pathParts[0] === "images" &&
        ["api", "automationWorker"].includes(pathParts[1]) &&
        /(?:tag|imageTag)$/i.test(match[2])
      ) {
        paths.add(pathParts.join("."));
      }
      if (!match[3] || match[3] === "|" || match[3] === ">") {
        stack.push({ indent, key: match[2] });
      }
    }
  }
}

function setImageTagArguments(tag, paths) {
  return [...paths].flatMap((path) => ["--set-string", `${path}=${tag}`]);
}

function documentSections(rendered) {
  return rendered
    .split(/^---\s*$/m)
    .map((document) => document.trim())
    .filter((document) => /^apiVersion:\s*\S+/m.test(document) && /^kind:\s*\S+/m.test(document));
}

function resourceKind(document) {
  return document.match(/^kind:\s*([^\s#]+)/m)?.[1];
}

function resourceName(document) {
  const metadata = document.match(/^metadata:\s*\n([\s\S]*?)(?=^\S|$)/m)?.[1] || "";
  return metadata.match(/^\s+name:\s*([^\s#]+)/m)?.[1];
}

function resourceIdentity(document) {
  const name = resourceName(document) || "";
  const labels = document.match(/^\s+labels:\s*\n([\s\S]*?)(?=^\s{2}\S|$)/m)?.[1] || "";
  return `${name} ${labels}`.toLowerCase();
}

function findResource(documents, kind, pattern) {
  const resource = documents.find(
    (document) =>
      resourceKind(document) === kind &&
      (pattern.test(resourceName(document) || "") || pattern.test(resourceIdentity(document))),
  );
  assert(resource, `Missing ${kind} matching ${pattern}`);
  return resource;
}

function assertField(document, pattern, description) {
  assert(pattern.test(document), `Missing ${description} in ${resourceKind(document)} ${resourceName(document)}`);
}

function validateImages(rendered, { strictRelease }) {
  const images = [...rendered.matchAll(/^\s*image:\s*(?:>-\s*)?([^\s#]+)\s*$/gm)].map((match) => match[1]);
  assert(images.length >= 2, "Rendered chart must contain API and worker image references");
  const applicationImages = documentSections(rendered)
    .filter((document) => resourceKind(document) === "Deployment")
    .filter((document) => /api|automation-worker/.test(resourceName(document) || ""))
    .flatMap((document) => [...document.matchAll(/^\s*image:\s*(?:>-\s*)?([^\s#]+)\s*$/gm)].map((match) => match[1]));
  for (const image of images) {
    const digest = image.match(/@sha256:([a-f0-9]{64})$/i)?.[1];
    const tag = digest ? undefined : image.match(/:([^:/]+)$/)?.[1];
    assert(digest || tag || allowUnpinnedImages.has(image), `Image reference has no tag or digest: ${image}`);
    if (digest) {
      assert(!/^([a-f0-9])\1{63}$/i.test(digest), `Image ${image} uses a placeholder digest`);
      continue;
    }
    assert(!mutableTags.has(tag), `Image ${image} uses mutable tag ${tag}`);
    if (strictRelease && applicationImages.includes(image)) {
      assert(tag !== placeholderTag, `Image ${image} still uses the release placeholder tag`);
      if (requestedImageTag) assert.equal(tag, requestedImageTag, `Image ${image} does not use the requested release tag`);
    }
  }
}

function validateDeployment(document, role) {
  assertField(document, /^\s*automountServiceAccountToken:\s*false\s*$/m, `${role} service-account token restriction`);
  assertField(document, /^\s*runAsNonRoot:\s*true\s*$/m, `${role} non-root security context`);
  assertField(document, /seccompProfile:\s*\n[\s\S]*?type:\s*RuntimeDefault/m, `${role} RuntimeDefault seccomp profile`);
  assertField(document, /^\s*allowPrivilegeEscalation:\s*false\s*$/m, `${role} privilege-escalation restriction`);
  assertField(document, /^\s*readOnlyRootFilesystem:\s*true\s*$/m, `${role} read-only root filesystem`);
  assertField(document, /capabilities:\s*\n[\s\S]*?drop:\s*(?:\[?ALL\]?|\n\s+-\s+ALL)/m, `${role} dropped capabilities`);
  assertField(document, /resources:\s*\n[\s\S]*?requests:\s*\n/m, `${role} resource requests`);
  assertField(document, /resources:\s*\n[\s\S]*?limits:\s*\n/m, `${role} resource limits`);
  assertField(document, /^\s*readinessProbe:\s*$/m, `${role} readiness probe`);
  assertField(document, /^\s*livenessProbe:\s*$/m, `${role} liveness probe`);
  assertField(document, /^\s*startupProbe:\s*$/m, `${role} startup probe`);
  assert(!/^\s*(?:privileged|hostNetwork|hostPID|hostIPC):\s*true\s*$/m.test(document), `${role} enables a host or privileged setting`);
  assert(!/^\s*hostPath:/m.test(document), `${role} mounts a hostPath volume`);
}

function validateBrowserlessDeployment(document) {
  assertField(document, /^\s*automountServiceAccountToken:\s*false\s*$/m, "Browserless service-account token restriction");
  assertField(document, /^\s*runAsNonRoot:\s*true\s*$/m, "Browserless non-root security context");
  assertField(document, /seccompProfile:\s*\n[\s\S]*?type:\s*RuntimeDefault/m, "Browserless RuntimeDefault seccomp profile");
  assertField(document, /^\s*allowPrivilegeEscalation:\s*false\s*$/m, "Browserless privilege-escalation restriction");
  assertField(document, /capabilities:\s*\n[\s\S]*?drop:\s*(?:\[?ALL\]?|\n\s+-\s+ALL)/m, "Browserless dropped capabilities");
  assertField(document, /mountPath:\s*\/dev\/shm/m, "Browserless shared-memory volume");
  assertField(document, /sizeLimit:\s*\S+/m, "Browserless shared-memory size limit");
  assertField(document, /^\s*resources:\s*$/m, "Browserless resource limits");
  assertField(document, /^\s*readinessProbe:\s*$/m, "Browserless readiness probe");
  assertField(document, /^\s*livenessProbe:\s*$/m, "Browserless liveness probe");
  assertField(document, /^\s*startupProbe:\s*$/m, "Browserless startup probe");
  assert(!/^\s*(?:privileged|hostNetwork|hostPID|hostIPC):\s*true\s*$/m.test(document), "Browserless enables a host or privileged setting");
  assert(!/^\s*hostPath:/m.test(document), "Browserless mounts a hostPath volume");
}

function validateHpaReplicaOwnership(documents, deployment, hpaPattern, role) {
  const hpa = documents.find(
    (document) => resourceKind(document) === "HorizontalPodAutoscaler" && hpaPattern.test(resourceName(document) || ""),
  );
  if (!hpa) return;
  assert(!/^ {2}replicas:/m.test(deployment), `${role} Deployment must leave spec.replicas to its HPA`);
}

function validateRenderedManifest(rendered, label, { strictRelease, managedRuntimeNames }) {
  const documents = documentSections(rendered);
  assert(documents.length > 0, `${label} rendered no Kubernetes resources`);
  validateImages(rendered, { strictRelease });

  const api = findResource(documents, "Deployment", /(^|-)api($|-)/);
  const worker = findResource(documents, "Deployment", /worker|automation/);
  validateDeployment(api, "API deployment");
  validateRenderedApiEnv(api, managedRuntimeNames);
  for (const key of [
    "HYEB_ADMIN_SESSION_SECRET",
    "HYEB_ADMIN_PASSWORD_HASH",
    "HYEB_ADMIN_GITHUB_CLIENT_SECRET",
    "HYEB_ADMIN_DISCORD_CLIENT_SECRET",
  ]) assertField(api, new RegExp(`name: ${key}\\s+valueFrom:\\s+secretKeyRef:`, "m"), `${key} external Secret reference`);
  assert(!/HYEB_ADMIN_DB_PATH|admin\.sqlite/i.test(api), "distributed API deployment must not configure local SQLite");
  const configMap = findResource(documents, "ConfigMap", /runtime/);
  const publicOrigin = configMap.match(/^\s*HYEB_ADMIN_PUBLIC_ORIGIN:\s*["']?([^\s"']+)["']?\s*$/m)?.[1];
  if (publicOrigin) assert(isCanonicalOrigin(publicOrigin), `${label} renders non-canonical HYEB_ADMIN_PUBLIC_ORIGIN`);
  validateDeployment(worker, "worker deployment");
  validateHpaReplicaOwnership(documents, api, /api/, "API");
  validateHpaReplicaOwnership(documents, worker, /worker|automation/, "worker");
  findResource(documents, "Service", /(^|-)api($|-)/);
  assert(documents.some((document) => resourceKind(document) === "Ingress"), `${label} is missing an Ingress`);

  const browserless = documents.find(
    (document) => resourceKind(document) === "Deployment" && /browserless/.test(resourceName(document) || ""),
  );
  if (browserless) {
    validateBrowserlessDeployment(browserless);
    validateHpaReplicaOwnership(documents, browserless, /browserless/, "Browserless");
    findResource(documents, "Service", /browserless/);
  }

  if (strictRelease && label === "production") {
    const redisReplication = findResource(documents, "RedisReplication", /redis/);
    assert(!/helm\.sh\/chart:/.test(redisReplication), "RedisReplication must not pass the mutable chart label to operator-managed StatefulSets");
    const apiPolicy = findResource(documents, "NetworkPolicy", /api/);
    assertField(apiPolicy, /port:\s*53/m, "DNS egress access");
    const redisPolicy = findResource(documents, "NetworkPolicy", /redis/);
    assertField(redisPolicy, /namespaceSelector:[\s\S]*?kubernetes\.io\/metadata\.name:[\s\S]*?ot-operators/m, "Redis Operator namespace access");
    assertField(redisPolicy, /podSelector:[\s\S]*?name:\s*redis-operator/m, "Redis Operator pod access");
    assertField(redisPolicy, /app:\s*hyeboard-redis-s[\s\S]*?redis_setup_type:\s*sentinel/m, "Redis Sentinel pod access");
  }

  if (strictRelease) validateRenderedSecrets(rendered, label);
}

function isSecretKey(value) {
  const key = value.replace(/["']/g, "");
  return secretKeys.has(key) || /(?:secret|token|password|private[_-]?key|credential)/i.test(key);
}

function validateRenderedSecrets(rendered, label) {
  for (const document of documentSections(rendered)) {
    if (resourceKind(document) === "Secret" && /^\s*(?:data|stringData):/m.test(document)) {
      throw new Error(`Helm validation failed: ${label} renders Secret data instead of an external secret reference`);
    }

    const lines = document.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const nameMatch = lines[index].match(/^\s*-?\s*name:\s*([^\s#]+)/);
      if (!nameMatch || !isSecretKey(nameMatch[1])) continue;
      const block = lines
        .slice(index + 1)
        .join("\n")
        .split(/(?=^\s*-\s*name:)/m, 1)[0];
      assert(!/^\s*value:\s*\S+/m.test(block), `${label} renders a literal value for secret ${nameMatch[1]}`);
    }

    for (const line of lines) {
      const keyMatch = line.match(/^\s*(?:-\s*)?([A-Za-z][A-Za-z0-9_-]*):\s*(\S.*)$/);
      if (!keyMatch || !isSecretKey(keyMatch[1])) continue;
      assert(!keyMatch[2].startsWith("{{"), `${label} leaves a template expression for secret ${keyMatch[1]}`);
      assert(!/replace-(?:with|me)|change[-_]?me|changeit|changeme|placeholder|your[-_]|<[^>]+>|TODO/i.test(keyMatch[2]), `${label} renders a placeholder for secret ${keyMatch[1]}`);
    }
  }
}

function resolveDefinition(schema, definition) {
  return definition?.$ref ? schema.definitions?.[definition.$ref.split("/").at(-1)] : definition;
}

function matchesSchema(schema, definition, value) {
  definition = resolveDefinition(schema, definition);
  if (definition === false) return false;
  if (definition?.type && definition.type !== typeof value) return false;
  if (definition?.minLength !== undefined && value.length < definition.minLength) return false;
  if (definition?.maxLength !== undefined && value.length > definition.maxLength) return false;
  if (definition?.pattern && !new RegExp(definition.pattern).test(value)) return false;
  if (definition?.not?.pattern && new RegExp(definition.not.pattern).test(value)) return false;
  return true;
}

function isCanonicalOrigin(value) {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

function validateApiExtraEnv(entries, managedRuntimeNames) {
  const protectedNames = new Set([...prohibitedConfigMapKeys, ...managedRuntimeNames, ...apiTemplateEnvNames]);
  const seen = new Set();
  for (const entry of entries) {
    assert(!seen.has(entry.name), `api.extraEnv contains duplicate ${entry.name}`);
    assert(!protectedNames.has(entry.name), `api.extraEnv cannot override chart-managed ${entry.name}`);
    seen.add(entry.name);
  }
}

function envNames(document) {
  const lines = document.split("\n");
  const start = lines.findIndex((line) => line.trim() === "env:");
  if (start < 0) return [];
  const indent = lines[start].match(/^\s*/)[0].length;
  const block = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && line.match(/^\s*/)[0].length <= indent) break;
    block.push(line);
  }
  return block.flatMap((line) => line.match(/^\s*- name:\s*([^\s#]+)/)?.slice(1) ?? []);
}

function validateRenderedApiEnv(document, managedRuntimeNames) {
  const names = envNames(document);
  const counts = new Map();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  for (const [name, count] of counts) assert.equal(count, 1, `API deployment contains duplicate env ${name}`);
  for (const name of names.filter((candidate) => !apiTemplateEnvNames.includes(candidate))) {
    assert(!prohibitedConfigMapKeys.includes(name), `API deployment extraEnv uses protected ${name}`);
    assert(!managedRuntimeNames.has(name), `API deployment extraEnv overrides chart-managed ${name}`);
  }
}

function validateAdminRuntimeCasesWithSchema(schema) {
  const runtimeProperties = schema.properties?.config?.properties?.runtime?.properties ?? {};
  for (const [label, expectedValid, runtime] of adminRuntimeCases) {
    assert.equal(
      Object.entries(runtime).every(([key, value]) => matchesSchema(schema, runtimeProperties[key], value)),
      expectedValid,
      label,
    );
  }
  for (const [label, expectedValid, section, key] of configMapKeyCases) {
    const propertyNames = schema.properties?.config?.properties?.[section]?.propertyNames;
    assert.equal(matchesSchema(schema, propertyNames, key), expectedValid, label);
  }
}

function validateAdminRuntimeCasesWithHelm() {
  const cases = [
    ...adminRuntimeCases.map(([label, expectedValid, runtime]) => [label, expectedValid, "runtime", runtime]),
    ...configMapKeyCases.map(([label, expectedValid, section, key]) => [label, expectedValid, section, { [key]: "synthetic-value" }]),
  ];
  for (const [label, expectedValid, section, values] of cases) {
    const arguments_ = ["lint", chartPath];
    for (const [key, value] of Object.entries(values)) arguments_.push("--set-json", `config.${section}.${key}=${JSON.stringify(value)}`);
    const result = spawnSync("helm", arguments_, { cwd: repositoryRoot, encoding: "utf8" });
    assert.equal(result.status === 0, expectedValid, `${label}:\n${result.stdout || ""}\n${result.stderr || ""}`);
  }
}

function validateHelmSemanticCases(managedRuntimeNames) {
  const renderCases = [
    ["rejects config.extraData-runtime collision", false, [
      "--set-string", "config.runtime.HYEB_COLLISION=runtime-value-sentinel",
      "--set-string", "config.extraData.HYEB_COLLISION=extra-value-sentinel",
    ], "HYEB_COLLISION", ["runtime-value-sentinel", "extra-value-sentinel"]],
    ["rejects config.extraData secret", false, [
      "--set-string", "config.extraData.HYEB_SESSION_SECRET=secret-value-sentinel",
    ], "HYEB_SESSION_SECRET", ["secret-value-sentinel"]],
    ["rejects config.runtime local DB", false, [
      "--set-string", "config.runtime.HYEB_ADMIN_DB_PATH=local-db-value-sentinel",
    ], "HYEB_ADMIN_DB_PATH", ["local-db-value-sentinel"]],
    ["rejects api.extraEnv managed name", false, [
      "--set-json", 'api.extraEnv=[{"name":"HYEB_HA_MODE","value":"managed-value-sentinel"}]',
    ], "HYEB_HA_MODE", ["managed-value-sentinel"]],
    ["rejects duplicate api.extraEnv names", false, [
      "--set-json", 'api.extraEnv=[{"name":"HYEB_DUPLICATE","value":"first-value-sentinel"},{"name":"HYEB_DUPLICATE","value":"second-value-sentinel"}]',
    ], "HYEB_DUPLICATE", ["first-value-sentinel", "second-value-sentinel"]],
    ["renders unrelated config.extraData and api.extraEnv", true, [
      "--set-string", "config.extraData.HYEB_CUSTOM_DATA=custom-data-value",
      "--set-json", 'api.extraEnv=[{"name":"HYEB_CUSTOM_ENV","value":"custom-env-value"}]',
    ], undefined, []],
  ];
  for (const [label, expectedValid, caseArguments, expectedKey, prohibitedOutput] of renderCases) {
    const result = spawnSync("helm", [
      "template", defaultReleaseName, chartPath, "--skip-schema-validation", ...caseArguments,
    ], { cwd: repositoryRoot, encoding: "utf8" });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    assert.equal(result.status === 0, expectedValid, `${label}:\n${output}`);
    if (expectedKey) assert(output.includes(expectedKey), `${label} must report only the rejected key`);
    for (const value of prohibitedOutput) assert(!output.includes(value), `${label} leaked a rejected value`);
    if (expectedValid) {
      assert(output.includes("HYEB_CUSTOM_DATA"), `${label} omitted unrelated config.extraData`);
      assert(output.includes("HYEB_CUSTOM_ENV"), `${label} omitted unrelated api.extraEnv`);
    }
  }

  for (const [label, expectedValid, origin] of adminOriginCanonicalCases) {
    const result = spawnSync("helm", ["template", defaultReleaseName, chartPath, "--set-string", `config.runtime.HYEB_ADMIN_PUBLIC_ORIGIN=${origin}`], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${label} must pass the coarse schema:\n${result.stdout || ""}\n${result.stderr || ""}`);
    const configMap = findResource(documentSections(result.stdout), "ConfigMap", /runtime/);
    const renderedOrigin = configMap.match(/^\s*HYEB_ADMIN_PUBLIC_ORIGIN:\s*["']?([^\s"']+)["']?\s*$/m)?.[1];
    assert.equal(isCanonicalOrigin(renderedOrigin), expectedValid, label);
  }

  for (const [label, expectedValid, value] of extraEnvCases) {
    const entries = Array.isArray(value) ? value : [value];
    const result = spawnSync("helm", ["template", defaultReleaseName, chartPath, "--set-json", `api.extraEnv=${JSON.stringify(entries)}`], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    let valid = result.status === 0;
    if (valid) {
      try {
        validateRenderedApiEnv(findResource(documentSections(result.stdout), "Deployment", /(^|-)api($|-)/), managedRuntimeNames);
      } catch {
        valid = false;
      }
    }
    assert.equal(valid, expectedValid, `${label}:\n${result.stdout || ""}\n${result.stderr || ""}`);
  }
}

function validateSourceContracts() {
  const values = readFileSync(resolve(chartPath, "values.yaml"), "utf8");
  const schema = JSON.parse(readFileSync(resolve(chartPath, "values.schema.json"), "utf8"));
  const apiTemplate = readFileSync(resolve(chartPath, "templates/api-deployment.yaml"), "utf8");
  const configMapTemplate = readFileSync(resolve(chartPath, "templates/configmap.yaml"), "utf8");
  const helpersTemplate = readFileSync(resolve(chartPath, "templates/_helpers.tpl"), "utf8");
  assert(configMapTemplate.includes('include "hyeboard.validateConfig" .'), "ConfigMap template does not invoke chart-level config validation");
  assert(apiTemplate.includes('include "hyeboard.validateApiExtraEnv" .'), "API template does not invoke chart-level extraEnv validation");
  assert(helpersTemplate.includes('define "hyeboard.validateConfig"'), "Helm helpers do not define config validation");
  assert(helpersTemplate.includes('define "hyeboard.validateApiExtraEnv"'), "Helm helpers do not define api.extraEnv validation");
  assert(helpersTemplate.includes("hasKey $.Values.config.runtime $key"), "Helm config validation does not reject extraData-runtime collisions");
  assert(helpersTemplate.includes("hasKey $seen $name"), "Helm api.extraEnv validation does not reject duplicates");
  assert(helpersTemplate.includes("range $key, $_ := .Values.config.runtime"), "Helm api.extraEnv validation does not protect config.runtime envFrom names");
  assert(helpersTemplate.includes("range $key, $_ := .Values.config.extraData"), "Helm api.extraEnv validation does not protect config.extraData envFrom names");
  for (const key of prohibitedConfigMapKeys) {
    assert(helpersTemplate.includes(key), `Helm config validation does not prohibit ${key}`);
  }
  for (const name of chartManagedEnvNames) {
    assert(helpersTemplate.includes(name), `Helm api.extraEnv validation does not protect ${name}`);
  }
  const requiredKeys = schema.properties?.secrets?.properties?.keys?.required ?? [];
  for (const [valueKey, envKey] of Object.entries({
    adminSessionSecret: "HYEB_ADMIN_SESSION_SECRET",
    adminPasswordHash: "HYEB_ADMIN_PASSWORD_HASH",
    adminGithubClientSecret: "HYEB_ADMIN_GITHUB_CLIENT_SECRET",
    adminDiscordClientSecret: "HYEB_ADMIN_DISCORD_CLIENT_SECRET",
  })) {
    assert(requiredKeys.includes(valueKey), `values schema does not require secrets.keys.${valueKey}`);
    assert(values.includes(`${valueKey}: ${envKey}`), `values.yaml is missing secrets.keys.${valueKey}`);
    assert(apiTemplate.includes(`key: {{ .Values.secrets.keys.${valueKey} }}`), `API template is missing ${valueKey}`);
  }
  const runtimeSchema = schema.properties?.config?.properties?.runtime;
  const extraDataSchema = schema.properties?.config?.properties?.extraData;
  const runtimeProperties = runtimeSchema?.properties ?? {};
  for (const key of [
    "HYEB_ADMIN_SESSION_TTL_SECONDS",
    "HYEB_ADMIN_PUBLIC_ORIGIN",
    "HYEB_ADMIN_GITHUB_CLIENT_ID",
    "HYEB_ADMIN_GITHUB_IDS",
    "HYEB_ADMIN_DISCORD_CLIENT_ID",
    "HYEB_ADMIN_DISCORD_IDS",
  ]) assert(runtimeProperties[key], `values schema does not explicitly validate config.runtime.${key}`);
  assert.equal(runtimeSchema?.additionalProperties?.$ref, "#/definitions/runtimePrimitive");
  assert.equal(extraDataSchema?.additionalProperties?.$ref, "#/definitions/runtimePrimitive");
  assert.equal(runtimeSchema?.propertyNames?.$ref, "#/definitions/nonSecretConfigMapKey");
  assert.equal(extraDataSchema?.propertyNames?.$ref, "#/definitions/nonSecretConfigMapKey");
  assert.equal(runtimeProperties.HYEB_ADMIN_DB_PATH, false, "distributed values schema must reject config.runtime.HYEB_ADMIN_DB_PATH");
  validateAdminRuntimeCasesWithSchema(schema);
  const extraEnvSchema = resolveDefinition(schema, schema.definitions?.api?.allOf?.[1]?.properties?.extraEnv?.items);
  assert(extraEnvSchema, "values schema does not define extraEnv items");
  const managedRuntimeNames = new Set([
    ...Object.keys(runtimeProperties),
    ...[...values.matchAll(/^ {4}([A-Z][A-Z0-9_]*):/gm)].map((match) => match[1]),
  ]);
  assert(values.includes("HYEB_HA_MODE: distributed"), "values.yaml is missing managed HYEB_HA_MODE");
  assert(values.includes("HYEB_POSTGRES_POOL_MAX: \"5\""), "values.yaml is missing PostgreSQL pool maximum");
  assert(values.includes("HYEB_POSTGRES_CONNECT_TIMEOUT_MS: \"5000\""), "values.yaml is missing PostgreSQL connect timeout");
  assert(values.includes("cpu: 100m") && values.includes("memory: 192Mi"), "values.yaml is missing calibrated application requests");
  assert(values.includes('averageUtilization: 60'), "values.yaml is missing CPU-only HPA targets");
  assert(!values.includes("name: memory"), "values.yaml must not use memory HPA metrics");
  for (const [name, value] of [["CONCURRENT", "1"], ["QUEUED", "2"], ["TIMEOUT", "120000"], ["MAX_RECONNECT_TIME", "120000"]]) {
    assert.equal((values.match(new RegExp(`- name: ${name}\\s*\\n\\s+value: ["']?${value}["']?`, "g")) ?? []).length, 1, `values.yaml must declare Browserless ${name} exactly once`);
  }
  assert(values.includes("  automationWorker:\n    enabled: false"), "values.yaml must disable worker HPA while automation is gated");
  assert(values.includes("HYEB_ADMIN_GITHUB_CLIENT_ID") || runtimeProperties.HYEB_ADMIN_GITHUB_CLIENT_ID, "values schema is missing managed provider IDs");
  for (const [label, expectedValid, value] of extraEnvCases) {
    const entries = Array.isArray(value) ? value : [value];
    for (const env of entries) {
      const schemaValid = matchesSchema(schema, extraEnvSchema.properties?.name, env.name);
      assert.equal(schemaValid, !prohibitedConfigMapKeys.includes(env.name), `${label} schema`);
    }
    if (expectedValid) assert.doesNotThrow(() => validateApiExtraEnv(entries, managedRuntimeNames), label);
    else assert.throws(() => validateApiExtraEnv(entries, managedRuntimeNames), label);
  }
  for (const [label, expectedValid, origin] of adminOriginCanonicalCases) {
    assert.equal(isCanonicalOrigin(origin), expectedValid, label);
  }
  assert(values.includes('HYEB_ADMIN_SESSION_TTL_SECONDS: "3600"'), "values.yaml is missing the admin session TTL default");
  assert(!/HYEB_ADMIN_DB_PATH|admin\.sqlite/i.test(`${values}\n${apiTemplate}`), "distributed Helm chart must not configure local SQLite");
  return managedRuntimeNames;
}

function validateChart() {
  if (!statSync(chartPath, { throwIfNoEntry: false })) {
    if (requireChart) fail(`chart directory does not exist: ${relative(repositoryRoot, chartPath)}`);
    console.log(`Helm chart not present; skipping local validation (${relative(repositoryRoot, chartPath)}).`);
    return;
  }

  const managedRuntimeNames = validateSourceContracts();
  if (!helmAvailable()) {
    console.log("Helm is not installed; source contracts passed, render validation skipped.");
    return;
  }

  validateAdminRuntimeCasesWithHelm();
  validateHelmSemanticCases(managedRuntimeNames);
  const overrides = [
    { name: "default", path: undefined },
    { name: "example", path: findOverride("example") },
    { name: "production", path: findOverride("production") },
  ];
  const imagePaths = new Set();
  imageTagPaths(imagePaths);

  for (const override of overrides) {
    const valuesArguments = override.path
      ? ["--values", override.path]
      : override.name === "example"
        ? ["--set-string", "config.runtime.HYEB_ALLOWED_ORIGINS=https://hyeboard.example.com"]
      : override.name === "production"
        ? [
            "--set",
            "api.replicaCount=3",
            "--set",
            "automationWorker.replicaCount=3",
          ]
        : [];
    const contractArguments = ["--set", "ingress.enabled=true"];
    const imageArguments = strict
      ? setImageTagArguments(imageTag, imagePaths)
      : override.name === "default"
        ? setImageTagArguments(placeholderTag, imagePaths)
        : [];
    const lintArguments = [...valuesArguments, ...contractArguments, ...imageArguments];
    const templateArguments = [
      "--namespace",
      "hyeboard",
      ...valuesArguments,
      ...contractArguments,
      ...imageArguments,
    ];
    runHelm(
      ["lint", chartPath, ...(strict ? ["--strict"] : []), ...lintArguments],
      `${override.name} helm lint`,
    );
    const rendered = runHelm(
      ["template", defaultReleaseName, chartPath, ...templateArguments],
      `${override.name} helm template`,
    );
    validateRenderedManifest(rendered, override.name, { strictRelease: strict, managedRuntimeNames });
    console.log(`Validated Helm ${override.name} values.`);
  }
}

try {
  validateChart();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
