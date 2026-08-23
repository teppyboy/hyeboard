import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const chartPath = resolve(repositoryRoot, "deploy/helm/hyeboard");
const placeholderTag = "replace-with-release-tag";
const defaultReleaseName = "hyeboard";
const secretKeys = new Set([
  "HYEB_SESSION_SECRET",
  "HYEB_POSTGRES_URL",
  "HYEB_REDIS_URL",
  "REDIS_URL",
  "AUTOMATION_KEY_CURRENT_ID",
  "AUTOMATION_KEY_CURRENT_B64",
  "AUTOMATION_KEY_PREVIOUS_ID",
  "AUTOMATION_KEY_PREVIOUS_B64",
  "BROWSERLESS_ENDPOINT",
  "BROWSERLESS_TOKEN",
]);
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
    assert(digest || tag, `Image reference has no tag or digest: ${image}`);
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

function validateRenderedManifest(rendered, label, { strictRelease }) {
  const documents = documentSections(rendered);
  assert(documents.length > 0, `${label} rendered no Kubernetes resources`);
  validateImages(rendered, { strictRelease });

  const api = findResource(documents, "Deployment", /(^|-)api($|-)/);
  const worker = findResource(documents, "Deployment", /worker|automation/);
  validateDeployment(api, "API deployment");
  validateDeployment(worker, "worker deployment");
  findResource(documents, "Service", /(^|-)api($|-)/);
  assert(documents.some((document) => resourceKind(document) === "Ingress"), `${label} is missing an Ingress`);

  const browserless = documents.find(
    (document) => resourceKind(document) === "Deployment" && /browserless/.test(resourceName(document) || ""),
  );
  if (browserless) {
    validateBrowserlessDeployment(browserless);
    findResource(documents, "Service", /browserless/);
  }

  if (strictRelease && label === "production") {
    findResource(documents, "RedisReplication", /redis/);
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

function validateChart() {
  if (!statSync(chartPath, { throwIfNoEntry: false })) {
    if (requireChart) fail(`chart directory does not exist: ${relative(repositoryRoot, chartPath)}`);
    console.log(`Helm chart not present; skipping local validation (${relative(repositoryRoot, chartPath)}).`);
    return;
  }

  if (!helmAvailable()) {
    console.log("Helm is not installed; skipping Helm chart validation.");
    return;
  }

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
    validateRenderedManifest(rendered, override.name, { strictRelease: strict });
    console.log(`Validated Helm ${override.name} values.`);
  }
}

try {
  validateChart();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
