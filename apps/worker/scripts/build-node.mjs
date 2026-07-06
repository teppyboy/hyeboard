import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
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
  ],
  banner: {
    js: `import{createRequire}from"module";var require=createRequire(import.meta.url);`,
  },
});
