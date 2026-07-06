import pino from "pino";

// Shared structured logger for all three runtimes (Cloudflare Workers, Node,
// Bun) plus packages/university-adapters (e.g. the Google-login automation
// flow). A single module-level instance is configured once at process
// startup by each entry point (apps/worker/src/index.ts) and then read via
// getLogger() everywhere else — mirrors the existing
// setRuntimeConfig()/runtimeConfig pattern in apps/worker/src/app.ts.
//
// Cloudflare Workers has no filesystem/worker_threads, so pino's normal
// destination (a sonic-boom stream writing to a file descriptor) does not
// work there even with nodejs_compat enabled. pino's "browser" mode sidesteps
// that entirely — it formats the log line then calls the matching
// console.<level>(), which is exactly what Workers' own logging
// (wrangler tail / dashboard Logs) already captures. Node/Bun use pino's
// normal (fast, async, file-descriptor-based) destination instead — either
// plain JSON, or in Node dev, a synchronously-constructed pino-pretty stream
// passed in by index.ts (this module never imports pino-pretty itself, so it
// stays out of the Cloudflare Workers bundle and the Bun path).

export type Logger = pino.Logger;

export interface LoggerInit {
  /** pino level name: "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "silent". Defaults to "info". */
  level?: string;
  /**
   * "browser": console-based output, safe anywhere (used for Cloudflare
   * Workers, which has no fs/worker_threads for pino's normal destination).
   * "node": pino's normal destination — plain JSON unless `destination` is
   * supplied.
   */
  mode?: "browser" | "node";
  /**
   * A pre-built, already-constructed pino-compatible destination stream
   * (e.g. `pinoPretty({ colorize: true, ... })`). Only meaningful when
   * `mode` is "node". Passed in synchronously (not via pino's `transport`
   * option) so no worker_threads spawn is required — keeps this working
   * identically on Bun, where worker_threads support is inconsistent.
   */
  destination?: pino.DestinationStream;
}

let logger: Logger = pino({ level: "info" });

export function configureLogger(init: LoggerInit): Logger {
  const level = init.level && init.level.length > 0 ? init.level : "info";
  logger =
    init.mode === "browser"
      ? pino({ level, browser: { asObject: true } })
      : init.destination
        ? pino({ level }, init.destination)
        : pino({ level });
  return logger;
}

export function getLogger(): Logger {
  return logger;
}
