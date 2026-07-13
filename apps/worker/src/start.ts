import { configureLogger, getLogger } from "@hyeboard/core";
import { createApp, loadConfigFile, setCaptchaRelayCoordinator, setRuntimeConfig } from "./app";
import { LocalCaptchaRelayCoordinator } from "./captcha-relay";
import { registerStaticAssets } from "./serve-static";

// Node/Bun startup. Cloudflare has a separate entry point in index.ts so
// Durable Object exports and generated bindings never enter this graph.

declare const Bun: unknown;
declare const process: { env: Record<string, string | undefined> };

const isBun = typeof Bun !== "undefined";

export async function start(): Promise<unknown> {
    // Self-hosted config comes from process.env and config.json.
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

    // Load non-secret config from config.json (if present), then let env vars
    // override. HYEB_SESSION_SECRET is ALWAYS from env var only.
    const fileConfig = await loadConfigFile();
    setRuntimeConfig({
      HYEB_SESSION_SECRET: process.env.HYEB_SESSION_SECRET,
      HYEB_ALLOWED_ORIGINS: process.env.HYEB_ALLOWED_ORIGINS ?? fileConfig.HYEB_ALLOWED_ORIGINS,
      HYEB_BROWSER_WS_ENDPOINT: process.env.HYEB_BROWSER_WS_ENDPOINT ?? fileConfig.HYEB_BROWSER_WS_ENDPOINT,
      HYEB_BROWSER_LOCAL: process.env.HYEB_BROWSER_LOCAL ?? fileConfig.HYEB_BROWSER_LOCAL,
      HYEB_BROWSER_HEADLESS: process.env.HYEB_BROWSER_HEADLESS ?? fileConfig.HYEB_BROWSER_HEADLESS,
      HYEB_CHROME_PATH: process.env.HYEB_CHROME_PATH ?? fileConfig.HYEB_CHROME_PATH,
      HYEB_BROWSER_IDLE_EVICTION_MS: process.env.HYEB_BROWSER_IDLE_EVICTION_MS ?? fileConfig.HYEB_BROWSER_IDLE_EVICTION_MS,
      HYEB_LOG_LEVEL: process.env.HYEB_LOG_LEVEL ?? fileConfig.HYEB_LOG_LEVEL,
    });

    // google-login-automation.ts (and its Patchright variant) live in
    // @hyeboard/university-adapters and read HYEB_CHROME_PATH /
    // HYEB_BROWSER_IDLE_EVICTION_MS straight off process.env — they have no
    // access to app.ts's runtimeConfig. If a value only came from
    // config.json (not a real env var), mirror it onto process.env here so
    // that package still sees it.
    if (!process.env.HYEB_CHROME_PATH && fileConfig.HYEB_CHROME_PATH) {
      process.env.HYEB_CHROME_PATH = fileConfig.HYEB_CHROME_PATH;
    }
    if (!process.env.HYEB_BROWSER_IDLE_EVICTION_MS && fileConfig.HYEB_BROWSER_IDLE_EVICTION_MS) {
      process.env.HYEB_BROWSER_IDLE_EVICTION_MS = fileConfig.HYEB_BROWSER_IDLE_EVICTION_MS;
    }

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
      // the bundle used for `pnpm build:node` / production Bun runs.
      const pretty = (await import("pino-pretty")).default;
      configureLogger({ level, destination: pretty({ colorize: true, translateTime: "SYS:standard", ignore: "pid,hostname" }) });
    } else {
      configureLogger({ level });
    }

    setCaptchaRelayCoordinator(new LocalCaptchaRelayCoordinator());

    const adapter = isBun
      ? (await import("elysia/adapter/bun")).BunAdapter
      : (await import("@elysiajs/node")).node();
    const app = createApp(adapter);

    const { fileURLToPath } = await import("node:url");
    const distDir = process.env.HYEB_STATIC_DIR ?? fileConfig.HYEB_STATIC_DIR ?? fileURLToPath(new URL("../../web/dist", import.meta.url));
    registerStaticAssets(app, distDir);

    const port = Number(process.env.PORT ?? fileConfig.PORT ?? 8787);
    const host = process.env.HOST ?? fileConfig.HOST ?? "127.0.0.1";
    app.listen({ port, hostname: host });

    const displayHost = host === "0.0.0.0" || host === "127.0.0.1" ? "localhost" : host;
    getLogger().info(`Hyeboard (${isBun ? "Bun" : "Node"}) listening on http://${displayHost}:${port}`);

    // The UET adapter keeps a live browser process open per Google account
    // (see browserSessionCache in google-login-automation.ts) so a session
    // refresh can reuse it instead of a full re-login. Close all of them on
    // shutdown so a restart/redeploy doesn't leak orphaned Chrome processes.
    const nodeProcess = process as unknown as { exit: (code: number) => void; on: (event: string, handler: () => void) => void };
    const shutdown = async () => {
      const { closeCachedBrowserSessions } = await import("@hyeboard/university-adapters");
      await closeCachedBrowserSessions().catch(() => undefined);
      nodeProcess.exit(0);
    };
    nodeProcess.on("SIGINT", () => void shutdown());
    nodeProcess.on("SIGTERM", () => void shutdown());
    return undefined;
}
