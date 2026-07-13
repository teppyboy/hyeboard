import { execSync } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHIP = join(ROOT, "dist");

async function main() {
  console.log("[package] Building web…");
  execSync("pnpm build:web", { cwd: ROOT, stdio: "inherit" });

  console.log("[package] Building worker (Node)…");
  execSync("pnpm build:node", { cwd: ROOT, stdio: "inherit" });

  console.log(`[package] Preparing ${SHIP}…`);
  if (existsSync(SHIP)) {
    await rm(join(SHIP, "dist"), { recursive: true, force: true });
    await rm(join(SHIP, "public"), { recursive: true, force: true });
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
  const config = {
    origins: [],
    browser: {
      ws_endpoint: "",
      local: false,
      headless: true,
      chrome_path: "",
      idle_eviction_minutes: 20160,
    },
    log_level: "info",
    host: "127.0.0.1",
    port: 8787,
    static_dir: "./public",
  };
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

main().catch((err) => {
  console.error("[package] Failed:", err);
  process.exit(1);
});
