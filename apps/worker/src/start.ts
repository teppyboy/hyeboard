import { configureLogger, getLogger } from "@hyeboard/core";
import { createApp, setAppCache, setCaptchaRelayCoordinator, setDistributedAutomationBackend, setRateLimitCoordinator, setRuntimeConfig, setSessionRevocationStore, setVnuImportSingleFlight, setVnuProbeBudgetCoordinator, setVnuRefreshControlCoordinator, type AppCache, type RuntimeConfig } from "./app";
import { LocalCaptchaRelayCoordinator } from "./captcha-relay";
import { registerStaticAssets } from "./serve-static";
import { normalizeSelfHostedInteger } from "./vnu-runtime-config";
import { parseHaConfig, type HaConfig } from "./ha-contracts";
import { createHaLifecycle, type HaLifecycleController } from "./ha-lifecycle";
import type { RedisBlockingClient, RedisCommandClient } from "./node/redis";
import type { AutomationRedisClient } from "./node/automation";

// Node/Bun startup. Cloudflare has a separate entry point in index.ts so
// Durable Object exports and generated bindings never enter this graph.

declare const Bun: unknown;
declare const process: { env: Record<string, string | undefined>; cwd: () => string };

const isBun = typeof Bun !== "undefined";

type SelfHostedRuntimeConfig = RuntimeConfig & {
  HYEB_POSTGRES_POOL_MAX: string;
  HYEB_POSTGRES_CONNECT_TIMEOUT_MS: string;
};

function positiveIntegerSetting(value: string | undefined, name: string, fallback: number): string {
  if (value === undefined) return String(fallback);
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

export function selfHostedRuntimeConfig(
  environment: Record<string, string | undefined>,
  fileConfig: RuntimeConfig,
): SelfHostedRuntimeConfig {
  return {
    HYEB_SESSION_SECRET: environment.HYEB_SESSION_SECRET,
    HYEB_ALLOWED_ORIGINS: environment.HYEB_ALLOWED_ORIGINS ?? fileConfig.HYEB_ALLOWED_ORIGINS,
    HYEB_BROWSER_WS_ENDPOINT: environment.HYEB_BROWSER_WS_ENDPOINT ?? fileConfig.HYEB_BROWSER_WS_ENDPOINT,
    HYEB_BROWSER_LOCAL: environment.HYEB_BROWSER_LOCAL ?? fileConfig.HYEB_BROWSER_LOCAL,
    HYEB_BROWSER_HEADLESS: environment.HYEB_BROWSER_HEADLESS ?? fileConfig.HYEB_BROWSER_HEADLESS,
    HYEB_CHROME_PATH: environment.HYEB_CHROME_PATH ?? fileConfig.HYEB_CHROME_PATH,
    HYEB_BROWSER_IDLE_EVICTION_MS: environment.HYEB_BROWSER_IDLE_EVICTION_MS ?? fileConfig.HYEB_BROWSER_IDLE_EVICTION_MS,
    HYEB_LOG_LEVEL: environment.HYEB_LOG_LEVEL ?? fileConfig.HYEB_LOG_LEVEL,
    VNU_CODE_LOOKUP_CONCURRENCY: environment.VNU_CODE_LOOKUP_CONCURRENCY ?? fileConfig.VNU_CODE_LOOKUP_CONCURRENCY,
    VNU_CROSS_LOOKUP_BULK_MAX_TARGETS: environment.VNU_CROSS_LOOKUP_BULK_MAX_TARGETS ?? fileConfig.VNU_CROSS_LOOKUP_BULK_MAX_TARGETS,
    VNU_CROSS_LOOKUP_DIRECT_CHUNK_MAX_TARGETS: environment.VNU_CROSS_LOOKUP_DIRECT_CHUNK_MAX_TARGETS ?? fileConfig.VNU_CROSS_LOOKUP_DIRECT_CHUNK_MAX_TARGETS,
    VNU_CODE_LOOKUP_BULK_TARGET_CONCURRENCY: environment.VNU_CODE_LOOKUP_BULK_TARGET_CONCURRENCY ?? fileConfig.VNU_CODE_LOOKUP_BULK_TARGET_CONCURRENCY,
    VNU_CROSS_LOOKUP_REQUEST_TIMEOUT_MS: environment.VNU_CROSS_LOOKUP_REQUEST_TIMEOUT_MS ?? fileConfig.VNU_CROSS_LOOKUP_REQUEST_TIMEOUT_MS,
    VNU_CROSS_DETAIL_MAX_TARGETS: environment.VNU_CROSS_DETAIL_MAX_TARGETS ?? fileConfig.VNU_CROSS_DETAIL_MAX_TARGETS,
    VNU_CROSS_DETAIL_MAX_ROWS: environment.VNU_CROSS_DETAIL_MAX_ROWS ?? fileConfig.VNU_CROSS_DETAIL_MAX_ROWS,
    VNU_CROSS_DETAIL_CONCURRENCY: environment.VNU_CROSS_DETAIL_CONCURRENCY ?? fileConfig.VNU_CROSS_DETAIL_CONCURRENCY,
    VNU_CROSS_DETAIL_BUDGET: environment.VNU_CROSS_DETAIL_BUDGET ?? fileConfig.VNU_CROSS_DETAIL_BUDGET,
    VNU_CROSS_DETAIL_WINDOW_SECONDS: environment.VNU_CROSS_DETAIL_WINDOW_SECONDS ?? fileConfig.VNU_CROSS_DETAIL_WINDOW_SECONDS,
    VNU_CROSS_DETAIL_PERMIT_TTL_SECONDS: environment.VNU_CROSS_DETAIL_PERMIT_TTL_SECONDS ?? fileConfig.VNU_CROSS_DETAIL_PERMIT_TTL_SECONDS,
    VNU_CROSS_DETAIL_EXPORT_MODE: environment.VNU_CROSS_DETAIL_EXPORT_MODE ?? fileConfig.VNU_CROSS_DETAIL_EXPORT_MODE,
    HYEB_HA_MODE: environment.HYEB_HA_MODE ?? fileConfig.HYEB_HA_MODE,
    HYEB_HA_NODE_ID: environment.HYEB_HA_NODE_ID ?? fileConfig.HYEB_HA_NODE_ID,
    HYEB_HA_SESSION_EPOCH: environment.HYEB_HA_SESSION_EPOCH ?? fileConfig.HYEB_HA_SESSION_EPOCH,
    HYEB_HA_ENFORCE_SESSION_EPOCH: environment.HYEB_HA_ENFORCE_SESSION_EPOCH ?? fileConfig.HYEB_HA_ENFORCE_SESSION_EPOCH,
    DATABASE_URL: environment.DATABASE_URL ?? fileConfig.DATABASE_URL,
    REDIS_URL: environment.REDIS_URL ?? fileConfig.REDIS_URL,
    HYEB_POSTGRES_URL: environment.HYEB_POSTGRES_URL ?? fileConfig.HYEB_POSTGRES_URL,
    HYEB_POSTGRES_POOL_MAX: positiveIntegerSetting(
      environment.HYEB_POSTGRES_POOL_MAX,
      "HYEB_POSTGRES_POOL_MAX",
      5,
    ),
    HYEB_POSTGRES_CONNECT_TIMEOUT_MS: positiveIntegerSetting(
      environment.HYEB_POSTGRES_CONNECT_TIMEOUT_MS,
      "HYEB_POSTGRES_CONNECT_TIMEOUT_MS",
      5_000,
    ),
    HYEB_REDIS_URL: environment.HYEB_REDIS_URL ?? fileConfig.HYEB_REDIS_URL,
    HYEB_SHUTDOWN_TIMEOUT_MS: environment.HYEB_SHUTDOWN_TIMEOUT_MS ?? fileConfig.HYEB_SHUTDOWN_TIMEOUT_MS,
    AUTOMATION_JOB_STREAM: environment.AUTOMATION_JOB_STREAM ?? fileConfig.AUTOMATION_JOB_STREAM,
    AUTOMATION_EVENT_STREAM: environment.AUTOMATION_EVENT_STREAM ?? fileConfig.AUTOMATION_EVENT_STREAM,
    AUTOMATION_CONTROL_STREAM: environment.AUTOMATION_CONTROL_STREAM ?? fileConfig.AUTOMATION_CONTROL_STREAM,
    AUTOMATION_JOB_ENVELOPE_AAD: environment.AUTOMATION_JOB_ENVELOPE_AAD ?? fileConfig.AUTOMATION_JOB_ENVELOPE_AAD,
    AUTOMATION_CREDENTIAL_AAD_PREFIX: environment.AUTOMATION_CREDENTIAL_AAD_PREFIX ?? fileConfig.AUTOMATION_CREDENTIAL_AAD_PREFIX,
    AUTOMATION_RESULT_AAD_PREFIX: environment.AUTOMATION_RESULT_AAD_PREFIX ?? fileConfig.AUTOMATION_RESULT_AAD_PREFIX,
    AUTOMATION_EVENT_AAD_PREFIX: environment.AUTOMATION_EVENT_AAD_PREFIX ?? fileConfig.AUTOMATION_EVENT_AAD_PREFIX,
    AUTOMATION_IDEMPOTENCY_TTL_MS: environment.AUTOMATION_IDEMPOTENCY_TTL_MS ?? fileConfig.AUTOMATION_IDEMPOTENCY_TTL_MS,
    AUTOMATION_DEADLINE_MS: environment.AUTOMATION_DEADLINE_MS ?? fileConfig.AUTOMATION_DEADLINE_MS,
    AUTOMATION_EVENT_BLOCK_MS: environment.AUTOMATION_EVENT_BLOCK_MS ?? fileConfig.AUTOMATION_EVENT_BLOCK_MS,
    AUTOMATION_EVENT_BATCH_SIZE: environment.AUTOMATION_EVENT_BATCH_SIZE ?? fileConfig.AUTOMATION_EVENT_BATCH_SIZE,
    AUTOMATION_KEY_CURRENT_ID: environment.AUTOMATION_KEY_CURRENT_ID ?? fileConfig.AUTOMATION_KEY_CURRENT_ID,
    AUTOMATION_KEY_CURRENT_B64: environment.AUTOMATION_KEY_CURRENT_B64 ?? fileConfig.AUTOMATION_KEY_CURRENT_B64,
    AUTOMATION_KEY_PREVIOUS_ID: environment.AUTOMATION_KEY_PREVIOUS_ID ?? fileConfig.AUTOMATION_KEY_PREVIOUS_ID,
    AUTOMATION_KEY_PREVIOUS_B64: environment.AUTOMATION_KEY_PREVIOUS_B64 ?? fileConfig.AUTOMATION_KEY_PREVIOUS_B64,
    AUTOMATION_EXECUTOR_READY: environment.AUTOMATION_EXECUTOR_READY ?? fileConfig.AUTOMATION_EXECUTOR_READY,
    HYEB_AUTOMATION_EXECUTOR_READY: environment.HYEB_AUTOMATION_EXECUTOR_READY ?? fileConfig.HYEB_AUTOMATION_EXECUTOR_READY,
  };
}

export function selfHostedHaConfig(environment: Record<string, string | undefined>, fileConfig: RuntimeConfig): HaConfig {
  return parseHaConfig(environment, {
    ha: {
      mode: fileConfig.HYEB_HA_MODE,
      node_id: fileConfig.HYEB_HA_NODE_ID,
      session_epoch: fileConfig.HYEB_HA_SESSION_EPOCH,
      enforce_session_epoch: fileConfig.HYEB_HA_ENFORCE_SESSION_EPOCH,
    },
  });
}

export async function loadConfigFile(): Promise<RuntimeConfig> {
  try {
    const configPath = process.env.CONFIG_PATH;
    const { join } = await import("node:path");
    const path = configPath || join(process.cwd(), "config.json");
    const { readFileSync, existsSync } = await import("node:fs");
    if (!existsSync(path)) return {};
    const cfg: any = JSON.parse(readFileSync(path, "utf-8"));
    const result: RuntimeConfig = {};
    if (Array.isArray(cfg.origins)) result.HYEB_ALLOWED_ORIGINS = cfg.origins.join(", ");
    if (cfg.browser && typeof cfg.browser === "object") {
      if (typeof cfg.browser.ws_endpoint === "string") result.HYEB_BROWSER_WS_ENDPOINT = cfg.browser.ws_endpoint;
      if (typeof cfg.browser.local === "boolean") result.HYEB_BROWSER_LOCAL = String(cfg.browser.local);
      if (typeof cfg.browser.headless === "boolean") result.HYEB_BROWSER_HEADLESS = String(cfg.browser.headless);
      if (typeof cfg.browser.chrome_path === "string") result.HYEB_CHROME_PATH = cfg.browser.chrome_path;
      if (typeof cfg.browser.idle_eviction_minutes === "number") result.HYEB_BROWSER_IDLE_EVICTION_MS = String(cfg.browser.idle_eviction_minutes * 60_000);
    }
    if (cfg.vnu && typeof cfg.vnu === "object" && !Array.isArray(cfg.vnu)) {
      result.VNU_CODE_LOOKUP_CONCURRENCY = normalizeSelfHostedInteger(cfg.vnu.code_lookup_concurrency);
      result.VNU_CROSS_LOOKUP_BULK_MAX_TARGETS = normalizeSelfHostedInteger(cfg.vnu.cross_lookup_bulk_max_targets);
      result.VNU_CROSS_LOOKUP_DIRECT_CHUNK_MAX_TARGETS = normalizeSelfHostedInteger(cfg.vnu.cross_lookup_direct_chunk_max_targets);
      result.VNU_CODE_LOOKUP_BULK_TARGET_CONCURRENCY = normalizeSelfHostedInteger(cfg.vnu.code_lookup_bulk_target_concurrency);
      result.VNU_CROSS_LOOKUP_REQUEST_TIMEOUT_MS = normalizeSelfHostedInteger(cfg.vnu.cross_lookup_request_timeout_ms);
      result.VNU_CROSS_DETAIL_MAX_TARGETS = normalizeSelfHostedInteger(cfg.vnu.cross_detail_max_targets);
      result.VNU_CROSS_DETAIL_MAX_ROWS = normalizeSelfHostedInteger(cfg.vnu.cross_detail_max_rows);
      result.VNU_CROSS_DETAIL_CONCURRENCY = normalizeSelfHostedInteger(cfg.vnu.cross_detail_concurrency);
      result.VNU_CROSS_DETAIL_BUDGET = normalizeSelfHostedInteger(cfg.vnu.cross_detail_budget);
      result.VNU_CROSS_DETAIL_WINDOW_SECONDS = normalizeSelfHostedInteger(cfg.vnu.cross_detail_window_seconds);
      result.VNU_CROSS_DETAIL_PERMIT_TTL_SECONDS = normalizeSelfHostedInteger(cfg.vnu.cross_detail_permit_ttl_seconds);
      if (typeof cfg.vnu.cross_detail_export_mode === "string") result.VNU_CROSS_DETAIL_EXPORT_MODE = cfg.vnu.cross_detail_export_mode;
    }
    if (cfg.ha && typeof cfg.ha === "object" && !Array.isArray(cfg.ha)) {
      if (typeof cfg.ha.mode === "string") result.HYEB_HA_MODE = cfg.ha.mode;
      if (typeof cfg.ha.node_id === "string") result.HYEB_HA_NODE_ID = cfg.ha.node_id;
      if (typeof cfg.ha.session_epoch === "number") result.HYEB_HA_SESSION_EPOCH = String(cfg.ha.session_epoch);
      if (typeof cfg.ha.enforce_session_epoch === "boolean") result.HYEB_HA_ENFORCE_SESSION_EPOCH = String(cfg.ha.enforce_session_epoch);
    }
    if (typeof cfg.log_level === "string") result.HYEB_LOG_LEVEL = cfg.log_level;
    if (typeof cfg.host === "string") result.HOST = cfg.host;
    if (typeof cfg.port === "number") result.PORT = String(cfg.port);
    if (typeof cfg.static_dir === "string" && cfg.static_dir !== "") result.HYEB_STATIC_DIR = cfg.static_dir;
    return result;
  } catch {
    return {};
  }
}

export type GracefulShutdownOptions = {
  lifecycle: HaLifecycleController;
  exit?: (code: number) => void;
};

export function createGracefulShutdown(options: GracefulShutdownOptions): () => Promise<void> {
  let shutdownPromise: Promise<void> | undefined;
  return () => {
    shutdownPromise ??= (async () => {
      try {
        await options.lifecycle.stop();
      } finally {
        options.exit?.(0);
      }
    })();
    return shutdownPromise;
  };
}

function redisAppCache(cache: { get<T>(key: string): Promise<T | undefined>; set<T>(key: string, value: T, ttlMs?: number): Promise<void> }): AppCache {
  return {
    async match(request) {
      const key = new URL(request.url).pathname.replace(/^\/cache\//, "");
      const value = await cache.get<unknown>(key);
      return value === undefined ? undefined : new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
    },
    async put(request, response) {
      const key = new URL(request.url).pathname.replace(/^\/cache\//, "");
      const maxAge = Number(/max-age=(\d+)/.exec(response.headers.get("Cache-Control") ?? "")?.[1] ?? 0);
      if (maxAge > 0) await cache.set(key, await response.clone().json(), maxAge * 1000);
    },
  };
}

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
    const config = selfHostedRuntimeConfig(process.env, fileConfig);
    setRuntimeConfig(config);
    const haConfig = selfHostedHaConfig(process.env, fileConfig);
    if (haConfig.mode === "distributed" && process.env.HYEB_BROWSER_PATCHRIGHT === "true") {
      throw new Error("HYEB_BROWSER_PATCHRIGHT cannot be enabled in distributed HA mode");
    }

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
    setAppCache(undefined);
    setRateLimitCoordinator(undefined);
    setVnuImportSingleFlight(undefined);
    setSessionRevocationStore(undefined);
    setVnuRefreshControlCoordinator(undefined);

    const dependencyNames = [
      "postgres", "postgresMigrations", "sessionRevocation", "vnuRefreshCoordinator",
      "redis", "cache", "captchaRelayCoordinator", "probeBudgetCoordinator",
    ];
    const dependencies = haConfig.mode === "distributed"
      ? Object.fromEntries(dependencyNames.map((name) => [name, "unavailable" as const]))
      : undefined;
    let postgresPool: { close(): Promise<void> } | undefined;
    let closeRedisResources: (() => Promise<void>) | undefined;
    let stopServer: (() => Promise<void>) | undefined;
    const shutdownTimeout = Number(config.HYEB_SHUTDOWN_TIMEOUT_MS);
    const lifecycle = createHaLifecycle({
      config: haConfig,
      dependencies,
      shutdownTimeoutMs: Number.isFinite(shutdownTimeout) && shutdownTimeout >= 0 ? shutdownTimeout : undefined,
      onDrain: async () => { await stopServer?.(); },
      onStop: async () => {
        const [browser, redis, postgres] = await Promise.allSettled([
          import("@hyeboard/university-adapters").then(({ closeCachedBrowserSessions }) => closeCachedBrowserSessions()),
          closeRedisResources?.(),
          postgresPool?.close(),
        ]);
        if (browser.status === "rejected") getLogger().warn({ dependency: "browser" }, "browser cleanup failed during shutdown");
        if (redis.status === "rejected") getLogger().warn({ dependency: "redis" }, "Redis cleanup failed during shutdown");
        if (postgres.status === "rejected") getLogger().warn({ dependency: "postgres" }, "PostgreSQL cleanup failed during shutdown");
      },
    });

    if (haConfig.mode === "distributed") {
      const postgresUrl = config.HYEB_POSTGRES_URL ?? config.DATABASE_URL;
      const redisUrl = config.HYEB_REDIS_URL ?? config.REDIS_URL;

      if (postgresUrl) {
        try {
          const postgres = await import("./node/postgres");
          const pool = new postgres.PostgresPool({
            connectionString: postgresUrl,
            max: Number(config.HYEB_POSTGRES_POOL_MAX),
            connectionTimeoutMillis: Number(config.HYEB_POSTGRES_CONNECT_TIMEOUT_MS),
          });
          postgresPool = pool;
          await postgres.runPostgresMigrations(pool);
          setSessionRevocationStore(new postgres.PostgresSessionRevocationStore(pool, config.HYEB_SESSION_SECRET ?? ""));
          setVnuRefreshControlCoordinator(new postgres.PostgresVnuRefreshControlCoordinator(pool));
          lifecycle.setDependencyStatuses({ postgres: "ready", postgresMigrations: "ready", sessionRevocation: "ready", vnuRefreshCoordinator: "ready" });
        } catch (error) {
          getLogger().error({ dependency: "postgres", errorName: error instanceof Error ? error.name : typeof error }, "PostgreSQL HA initialization failed");
          lifecycle.setDependencyStatuses({ postgres: "unavailable", postgresMigrations: "unavailable", sessionRevocation: "unavailable", vnuRefreshCoordinator: "unavailable" });
          await postgresPool?.close().catch(() => undefined);
          postgresPool = undefined;
        }
      }

      if (redisUrl) {
        try {
          const redis = await import("./node/redis");
          const clients = redis.createRedisClients({ url: redisUrl });
          await redis.connectRedis(clients);
          closeRedisResources = () => redis.closeRedis(clients);
          const client = clients.client as unknown as RedisCommandClient;
          setAppCache(redisAppCache(new redis.RedisJsonCache({ client })));
          setRateLimitCoordinator({
            consumeFixedWindow: (key, amount, windowMs, limit) => redis.consumeFixedWindow(client, key, amount, windowMs, limit),
          });
          setVnuImportSingleFlight(new redis.RedisSingleFlight({
            client,
            blocking: clients.blocking as unknown as RedisBlockingClient,
          }));
          setCaptchaRelayCoordinator(new redis.RedisCaptchaRelayCoordinator({ client, blocking: clients.blocking as unknown as RedisBlockingClient }));
          const probeCoordinator = new redis.RedisVnuProbeBudgetCoordinator({ client });
          setVnuProbeBudgetCoordinator(probeCoordinator);
          try {
            const automation = await import("./node/automation");
            const backend = automation.createDistributedAutomationBackend(
              clients.client as unknown as AutomationRedisClient,
              config.HYEB_SESSION_SECRET ?? "",
              process.env,
            );
            setDistributedAutomationBackend(backend);
            lifecycle.setDependencyStatuses({
              redis: "ready",
              cache: "ready",
              captchaRelayCoordinator: "ready",
              probeBudgetCoordinator: "ready",
            });
          } catch (error) {
            setDistributedAutomationBackend(undefined);
            getLogger().error({ dependency: "automation", errorName: error instanceof Error ? error.name : typeof error }, "Distributed automation initialization failed");
            lifecycle.setDependencyStatuses({ redis: "ready", cache: "ready", captchaRelayCoordinator: "ready", probeBudgetCoordinator: "ready" });
          }
        } catch (error) {
          setRateLimitCoordinator(undefined);
          setVnuImportSingleFlight(undefined);
          setDistributedAutomationBackend(undefined);
          getLogger().error({ dependency: "redis", errorName: error instanceof Error ? error.name : typeof error }, "Redis HA initialization failed");
          lifecycle.setDependencyStatuses({ redis: "unavailable", cache: "unavailable", captchaRelayCoordinator: "unavailable", probeBudgetCoordinator: "unavailable" });
          await closeRedisResources?.().catch(() => undefined);
          closeRedisResources = undefined;
        }
      }
      else {
        setDistributedAutomationBackend(undefined);
      }
    }

    await lifecycle.start();

    const adapter = isBun
      ? (await import("elysia/adapter/bun")).BunAdapter
      : (await import("@elysiajs/node")).node();
    const app = createApp(adapter, { lifecycle });

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
    stopServer = async () => { await app.stop(); };
    const nodeProcess = process as unknown as { exit: (code: number) => void; on: (event: string, handler: () => void) => void };
    const shutdown = createGracefulShutdown({ lifecycle, exit: (code) => nodeProcess.exit(code) });
    nodeProcess.on("SIGINT", () => void shutdown());
    nodeProcess.on("SIGTERM", () => void shutdown());
    return undefined;
}
