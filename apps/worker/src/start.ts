import { configureLogger, getLogger } from "@hyeboard/core";
import { createApp, setCloudflareBrowserBinding, setRuntimeConfig } from "./app";
import { registerStaticAssets } from "./serve-static";

// Shared startup logic for all three supported runtimes (Cloudflare
// Workers, Node.js, Bun). Runtime detection + dynamic imports let one
// function replace what used to be three near-identical thin wrappers
// (index.ts/serve-node.ts/serve-bun.ts) without pulling runtime-specific
// modules into a static import graph that the *other* runtimes' module
// loaders can't resolve.
//
// Exported as a plain async function (not run as a top-level side effect
// of importing this file) so that index.ts (the Cloudflare/default entry,
// wired to wrangler.jsonc's "main") and index.node.ts (the Node/Bun-only
// entry that additionally registers a Patchright browser launcher) can
// both import and invoke it exactly once, without either one triggering
// the other's invocation as an unwanted side effect of a plain import.
//
// `cloudflare:workers` in particular MUST stay a dynamic import: a static
// `import ... from "cloudflare:workers"` would make Node/Bun's ESM loader
// throw "Cannot find module" while resolving this file's imports, before
// any of the runtime-detection code below ever runs.

declare const Bun: unknown;
declare const process: { env: Record<string, string | undefined> };

const isBun = typeof Bun !== "undefined";
const isCloudflareWorkers = typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";

export async function start(): Promise<unknown> {
  if (isCloudflareWorkers) {
    const { env } = await import("cloudflare:workers");
    const { CloudflareAdapter } = await import("elysia/adapter/cloudflare-worker");
    const cfEnv = env as unknown as {
      HYEB_SESSION_SECRET: string;
      HYEB_ALLOWED_ORIGINS?: string;
      HYEB_BROWSER_WS_ENDPOINT?: string;
      HYEB_LOG_LEVEL?: string;
      BROWSER: { fetch: typeof fetch };
    };

    // Workers has no fs/worker_threads, so pino's normal destination
    // doesn't work here — "browser" mode formats logs and calls
    // console.<level>() instead, which wrangler tail / the dashboard Logs
    // tab already captures. Set HYEB_LOG_LEVEL=debug as a var/secret to
    // see per-request debug logs.
    configureLogger({ level: cfEnv.HYEB_LOG_LEVEL, mode: "browser" });

    // Cloudflare Workers vars/secrets aren't guaranteed to be mirrored
    // onto process.env, so pass the real `env` object explicitly rather
    // than relying on app.ts's process.env default (used by Node/Bun
    // below).
    setRuntimeConfig({
      HYEB_SESSION_SECRET: cfEnv.HYEB_SESSION_SECRET,
      HYEB_ALLOWED_ORIGINS: cfEnv.HYEB_ALLOWED_ORIGINS,
      HYEB_BROWSER_WS_ENDPOINT: cfEnv.HYEB_BROWSER_WS_ENDPOINT,
      HYEB_LOG_LEVEL: cfEnv.HYEB_LOG_LEVEL,
    });
    setCloudflareBrowserBinding(cfEnv.BROWSER);

    return createApp(CloudflareAdapter);
  } else {
    // Self-hosted (Node or Bun): config from process.env, actively listen
    // on a port instead of exporting a fetch handler for a runtime to
    // invoke.
    //
    // Bun auto-loads .env; Node does not. Load it explicitly via Node's
    // built-in process.loadEnvFile (20.6+) so `tsx src/index.ts` and the
    // built dist/index.js both pick up apps/worker/.env without needing a
    // --env-file flag threaded through every invocation (dev:node,
    // serve:node, wrappers like concurrently, etc). Silently no-ops if
    // the file is missing (e.g. real env vars injected directly in
    // production).
    if (!isBun) {
      const { fileURLToPath } = await import("node:url");
      const envPath = fileURLToPath(new URL("../.env", import.meta.url));
      try {
        (process as unknown as { loadEnvFile: (path?: string) => void }).loadEnvFile(envPath);
      } catch {
        // .env not present -- fine, real env vars are expected instead.
      }
    }

    setRuntimeConfig({
      HYEB_SESSION_SECRET: process.env.HYEB_SESSION_SECRET,
      HYEB_ALLOWED_ORIGINS: process.env.HYEB_ALLOWED_ORIGINS,
      HYEB_BROWSER_WS_ENDPOINT: process.env.HYEB_BROWSER_WS_ENDPOINT,
      HYEB_BROWSER_LOCAL: process.env.HYEB_BROWSER_LOCAL,
      HYEB_LOG_LEVEL: process.env.HYEB_LOG_LEVEL,
    });

    const isDev = process.env.NODE_ENV !== "production";
    const level = process.env.HYEB_LOG_LEVEL;
    if (isDev && !isBun) {
      // pino-pretty needs worker_threads to run pino's transport
      // machinery in a worker; reliable on plain Node, not on Bun
      // (partial/inconsistent worker_threads support there), so Bun
      // always gets plain JSON logs below. Constructed synchronously (not
      // via pino's string `transport` option) so no worker thread spawn
      // is needed at all, and pino-pretty is only ever required here —
      // never statically imported by this module — so it stays out of
      // the esbuild bundle used for `pnpm build:node` / production Bun
      // runs.
      const pretty = (await import("pino-pretty")).default;
      configureLogger({ level, destination: pretty({ colorize: true, translateTime: "SYS:standard", ignore: "pid,hostname" }) });
    } else {
      configureLogger({ level });
    }

    const adapter = isBun
      ? (await import("elysia/adapter/bun")).BunAdapter
      : (await import("@elysiajs/node")).node();
    const app = createApp(adapter);

    const { fileURLToPath } = await import("node:url");
    const distDir = fileURLToPath(new URL("../../web/dist", import.meta.url));
    registerStaticAssets(app, distDir);

    const port = Number(process.env.PORT ?? 8787);
    app.listen(port);

    getLogger().info(`Hyeboard (${isBun ? "Bun" : "Node"}) listening on http://localhost:${port}`);
    return undefined;
  }
}
