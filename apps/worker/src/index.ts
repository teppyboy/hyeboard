import { createApp, setCloudflareBrowserBinding, setRuntimeConfig } from "./app";
import { registerStaticAssets } from "./serve-static";

// Single entry point for all three supported runtimes (Cloudflare Workers,
// Node.js, Bun). Runtime detection + dynamic imports let one file replace
// what used to be three near-identical thin wrappers (index.ts/serve-node.ts/
// serve-bun.ts) without pulling runtime-specific modules into a static
// import graph that the *other* runtimes' module loaders can't resolve.
//
// `cloudflare:workers` in particular MUST stay a dynamic import: a static
// `import ... from "cloudflare:workers"` would make Node/Bun's ESM loader
// throw "Cannot find module" while resolving this file's imports, before any
// of the runtime-detection code below ever runs.

declare const Bun: unknown;
declare const process: { env: Record<string, string | undefined> };

const isBun = typeof Bun !== "undefined";
const isCloudflareWorkers = typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";

let workerExport: unknown;

if (isCloudflareWorkers) {
  const { env } = await import("cloudflare:workers");
  const { CloudflareAdapter } = await import("elysia/adapter/cloudflare-worker");
  const cfEnv = env as unknown as {
    HYEB_SESSION_SECRET: string;
    HYEB_ALLOWED_ORIGINS?: string;
    HYEB_BROWSER_WS_ENDPOINT?: string;
    BROWSER: { fetch: typeof fetch };
  };

  // Cloudflare Workers vars/secrets aren't guaranteed to be mirrored onto
  // process.env, so pass the real `env` object explicitly rather than
  // relying on app.ts's process.env default (used by Node/Bun below).
  setRuntimeConfig({
    HYEB_SESSION_SECRET: cfEnv.HYEB_SESSION_SECRET,
    HYEB_ALLOWED_ORIGINS: cfEnv.HYEB_ALLOWED_ORIGINS,
    HYEB_BROWSER_WS_ENDPOINT: cfEnv.HYEB_BROWSER_WS_ENDPOINT,
  });
  setCloudflareBrowserBinding(cfEnv.BROWSER);

  workerExport = createApp(CloudflareAdapter);
} else {
  // Self-hosted (Node or Bun): config from process.env, actively listen on
  // a port instead of exporting a fetch handler for a runtime to invoke.
  setRuntimeConfig({
    HYEB_SESSION_SECRET: process.env.HYEB_SESSION_SECRET,
    HYEB_ALLOWED_ORIGINS: process.env.HYEB_ALLOWED_ORIGINS,
    HYEB_BROWSER_WS_ENDPOINT: process.env.HYEB_BROWSER_WS_ENDPOINT,
  });

  const adapter = isBun
    ? (await import("elysia/adapter/bun")).BunAdapter
    : (await import("@elysiajs/node")).node();
  const app = createApp(adapter);

  const { fileURLToPath } = await import("node:url");
  const distDir = fileURLToPath(new URL("../../web/dist", import.meta.url));
  registerStaticAssets(app, distDir);

  const port = Number(process.env.PORT ?? 8787);
  app.listen(port);

  console.log(`Hyeboard (${isBun ? "Bun" : "Node"}) listening on http://localhost:${port}`);
}

export default workerExport;
