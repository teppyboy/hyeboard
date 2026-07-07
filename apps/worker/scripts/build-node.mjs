import { build } from "esbuild";

await build({
  // index.node.ts (not index.ts) — the Node/Bun-only entry point that
  // additionally wires up the optional Patchright browser launcher. See
  // that file's doc comment for why the split exists.
  entryPoints: ["src/index.node.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/index.js",
  sourcemap: true,
  external: [
    "cloudflare:workers",
    "elysia/adapter/cloudflare-worker",
    "@elysiajs/node",
    "elysia/adapter/bun",
    // Only ever dynamically imported in index.ts's Node-dev branch; keep it
    // out of the bundle entirely so it's resolved from node_modules only
    // when that branch actually runs (never in production/Bun).
    "pino-pretty",
    // Optional (HYEB_BROWSER_PATCHRIGHT=true) and large — kept out of the
    // self-hosted bundle so deployments that don't use it aren't paying
    // for its size. Resolved from node_modules at runtime via
    // @hyeboard/university-adapters' own dependency on patchright.
    //
    // Both the package AND the file that statically imports it must be
    // external: index.node.ts's dynamic import() of the patchright module
    // is only truly lazy at runtime if esbuild leaves it as an untouched
    // external specifier. Without this, esbuild inlines the dynamically
    // imported file's code into the single output chunk (no code
    // splitting is configured), which hoists ITS static `import
    // "patchright"` into a top-level import in dist/index.js — making
    // Node require patchright unconditionally at startup, breaking any
    // deployment that hasn't installed it (confirmed live).
    "patchright",
    "@hyeboard/university-adapters/src/uet/google-login-automation-patchright",
  ],
  banner: {
    js: `import{createRequire}from"module";var require=createRequire(import.meta.url);`,
  },
});
