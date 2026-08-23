import { execSync } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHIP = join(ROOT, "dist");

const VNU_CONFIG_KEYS = [
  "code_lookup_concurrency",
  "cross_lookup_bulk_max_targets",
  "cross_lookup_direct_chunk_max_targets",
  "code_lookup_bulk_target_concurrency",
  "cross_lookup_request_timeout_ms",
  "cross_detail_max_targets",
  "cross_detail_max_rows",
  "cross_detail_concurrency",
  "cross_detail_budget",
  "cross_detail_window_seconds",
  "cross_detail_permit_ttl_seconds",
  "cross_detail_export_mode",
];

const HA_CONFIG_KEYS = ["mode", "node_id", "session_epoch", "enforce_session_epoch"];
const FORBIDDEN_CONFIG_KEYS = new Set([
  "HYEB_SESSION_SECRET",
  "DATABASE_URL",
  "REDIS_URL",
  "HYEB_POSTGRES_URL",
  "HYEB_REDIS_URL",
  "password",
  "secret",
  "token",
  "cookie",
]);

function copyRequiredSection(sourceConfig, sectionName, keys) {
  const source = sourceConfig?.[sectionName];
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error(`apps/worker/config.json is missing its ${sectionName} section`);
  }

  const unexpectedKeys = Object.keys(source).filter((key) => !keys.includes(key));
  if (unexpectedKeys.length > 0) {
    throw new Error(`Unsupported ${sectionName} config keys: ${unexpectedKeys.join(", ")}`);
  }

  return Object.fromEntries(keys.map((key) => {
    if (!Object.hasOwn(source, key)) throw new Error(`apps/worker/config.json is missing ${sectionName}.${key}`);
    return [key, source[key]];
  }));
}

export function createPackagedConfig(sourceConfig) {
  const browser = sourceConfig?.browser;
  if (!browser || typeof browser !== "object" || Array.isArray(browser)) {
    throw new Error("apps/worker/config.json is missing its browser section");
  }

  const config = {
    // Origins and browser endpoints are deployment URLs and stay operator-configured.
    origins: [],
    browser: {
      ws_endpoint: "",
      local: browser.local,
      headless: browser.headless,
      chrome_path: browser.chrome_path,
      idle_eviction_minutes: browser.idle_eviction_minutes,
    },
    vnu: copyRequiredSection(sourceConfig, "vnu", VNU_CONFIG_KEYS),
    ha: copyRequiredSection(sourceConfig, "ha", HA_CONFIG_KEYS),
    log_level: sourceConfig.log_level,
    host: sourceConfig.host,
    port: sourceConfig.port,
    static_dir: "./public",
  };

  for (const key of ["local", "headless", "chrome_path", "idle_eviction_minutes"]) {
    if (!Object.hasOwn(browser, key)) throw new Error(`apps/worker/config.json is missing browser.${key}`);
  }
  for (const key of ["log_level", "host", "port"]) {
    if (!Object.hasOwn(sourceConfig, key)) throw new Error(`apps/worker/config.json is missing ${key}`);
  }

  return config;
}

export function assertPackagedConfig(config) {
  const visit = (value, path = "config") => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_CONFIG_KEYS.has(key)) throw new Error(`Packaged config contains forbidden field ${path}.${key}`);
      visit(child, `${path}.${key}`);
    }
  };
  visit(config);

  if (JSON.stringify(config.origins) !== "[]") throw new Error("Packaged config must not contain origins");
  if (config.browser?.ws_endpoint !== "") throw new Error("Packaged config must not contain a browser URL");
  for (const key of HA_CONFIG_KEYS) {
    if (!Object.hasOwn(config.ha ?? {}, key)) throw new Error(`Packaged config is missing ha.${key}`);
  }
  for (const key of VNU_CONFIG_KEYS) {
    if (!Object.hasOwn(config.vnu ?? {}, key)) throw new Error(`Packaged config is missing vnu.${key}`);
  }
  return config;
}

async function main() {
  console.log("[package] Building web…");
  execSync("pnpm build:web", { cwd: ROOT, stdio: "inherit" });

  console.log("[package] Building worker (Node)…");
  execSync("pnpm build:node", { cwd: ROOT, stdio: "inherit" });

  console.log(`[package] Preparing ${SHIP}…`);
  if (existsSync(SHIP)) {
    await rm(join(SHIP, "dist"), { recursive: true, force: true });
    await rm(join(SHIP, "public"), { recursive: true, force: true });
    await rm(join(SHIP, "migrations"), { recursive: true, force: true });
  }

  await mkdir(join(SHIP, "dist"), { recursive: true });
  await mkdir(join(SHIP, "public"), { recursive: true });

  console.log("[package] Copying worker bundle…");
  await cp(join(ROOT, "apps/worker/dist/index.js"), join(SHIP, "dist/index.js"));
  const mapSrc = join(ROOT, "apps/worker/dist/index.js.map");
  if (existsSync(mapSrc)) {
    await cp(mapSrc, join(SHIP, "dist/index.js.map"));
  }

  console.log("[package] Copying web static files…");
  await cp(join(ROOT, "apps/web/dist"), join(SHIP, "public"), { recursive: true });

  console.log("[package] Copying PostgreSQL migrations…");
  await cp(join(ROOT, "apps/worker/migrations"), join(SHIP, "migrations"), { recursive: true });

  console.log("[package] Writing package.json…");
  await cp(join(ROOT, "apps/worker/package.json"), join(SHIP, "package.json"));
  // Patch the package.json to remove obsolete fields and set the main entry point
  const pkgJsonPath = join(SHIP, "package.json");
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
  pkgJson.main = "dist/index.js";
  pkgJson.name = "hyeboard";
  // Delete wrangler-related scripts
  delete pkgJson.scripts.wrangler;
  delete pkgJson.scripts.deploy;
  delete pkgJson.devDependencies["wrangler"];
  // Delete @hyeboard ones
  delete pkgJson.dependencies["@hyeboard/core"];
  delete pkgJson.dependencies["@hyeboard/schemas"];
  delete pkgJson.dependencies["@hyeboard/university-adapters"];
  // Add missing dependencies (from packages)
  // @hyeboard/core
  // Read the package.json of @hyeboard/core to get its dependencies
  const corePkgJsonPath = join(ROOT, "packages/core/package.json");
  const universityAdaptersPkgJsonPath = join(ROOT, "packages/university-adapters/package.json");
  const corePkgJson = JSON.parse(readFileSync(corePkgJsonPath, "utf-8"));
  const universityAdaptersPkgJson = JSON.parse(readFileSync(universityAdaptersPkgJsonPath, "utf-8"));
  pkgJson.optionalDependencies ??= {};
  for (const [dep, version] of Object.entries({ ...corePkgJson.dependencies, ...universityAdaptersPkgJson.dependencies })) {
    if (dep.includes("@hyeboard/") || dep.includes("@cloudflare") || dep.includes("@sinclair")) continue; // Skip unnecessary dependencies
    // Large Node-only opt-in dependencies remain optional. Their local
    // registration modules are bundled; packages resolve only when enabled.
    if (dep === "patchright" || dep === "tesseract.js") {
      if (!pkgJson.optionalDependencies[dep]) pkgJson.optionalDependencies[dep] = version;
      continue;
    }
    if (!pkgJson.dependencies[dep]) {
      pkgJson.dependencies[dep] = version;
    }
  }
  for (const [dep, version] of Object.entries(universityAdaptersPkgJson.optionalDependencies ?? {})) {
    if (!dep.includes("@hyeboard/") && !dep.includes("@cloudflare") && !dep.includes("@sinclair")) {
      pkgJson.optionalDependencies[dep] ??= version;
    }
  }
  await writeFile(pkgJsonPath, JSON.stringify(pkgJson, null, 2));

  console.log("[package] Writing config.json…");
  const workerConfig = JSON.parse(readFileSync(join(ROOT, "apps/worker/config.json"), "utf-8"));
  const config = assertPackagedConfig(createPackagedConfig(workerConfig));
  await writeFile(join(SHIP, "config.json"), JSON.stringify(config, null, 2) + "\n");

  console.log("[package] Writing .env.example…");
  await cp(join(ROOT, "apps/worker/.env.example"), join(SHIP, ".env.example"));

  console.log("[package] Checking output size…");
  function sizeStr(p) {
    const bytes = statSync(p).size;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  for (const entry of ["dist/index.js", "public/index.html"]) {
    const full = join(SHIP, entry);
    if (existsSync(full)) {
      console.log(`  ${entry}: ${sizeStr(full)}`);
    }
  }

  console.log(`[package] Done → ${SHIP}`);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("[package] Failed:", err);
    process.exit(1);
  });
}
