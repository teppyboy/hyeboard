# Standalone workerd config for self-hosting Hyeboard outside of Cloudflare's
# managed platform. This is a hand-translation of apps/worker/wrangler.jsonc -
# see that file for the source of truth on bindings/compatibility settings when
# either file is updated.
#
# All paths below (embed/disk) are resolved relative to this file's own
# directory at parse time, EXCEPT the DiskDirectory `path`, which workerd
# resolves relative to the process's current working directory. The Dockerfile
# in this directory sets up /app so that all of these paths line up:
#   /app/config.capnp   (this file, copied in)
#   /app/gateway.js      (copied in)
#   /app/worker.js        (built by `pnpm --filter @hyeboard/worker build:workerd`,
#                           copied from apps/worker/dist-workerd/index.js)
#   /app/web-dist/         (built by `pnpm --filter @hyeboard/web build`,
#                           copied from apps/web/dist)
#
# Run with: workerd serve config.capnp

using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "gateway", worker = .gatewayWorker),
    (name = "main", worker = .hyeboardWorker),
    (name = "assets", disk = (path = "web-dist", writable = false)),
  ],
  sockets = [
    (name = "http", address = "*:8080", http = (), service = "gateway")
  ]
);

# Routes /api/* to the "main" worker, everything else to static assets (with
# SPA fallback to index.html) - see gateway.js for the routing logic. Mirrors
# wrangler.jsonc's `assets.run_worker_first`/`not_found_handling` behavior,
# which has no open-source equivalent in plain workerd.
const gatewayWorker :Workerd.Worker = (
  modules = [
    (name = "gateway.js", esModule = embed "gateway.js")
  ],
  compatibilityDate = "2026-06-30",
  bindings = [
    (name = "MAIN", service = "main"),
    (name = "ASSETS", service = "assets"),
  ],
);

# The actual Hyeboard API worker (apps/worker's bundled Elysia app). Bindings
# here correspond 1:1 to wrangler.jsonc's `secrets.required` + the
# HYEB_BROWSER_WS_ENDPOINT field added to apps/worker/worker-configuration.d.ts
# for self-hosted deployments. There is intentionally NO `BROWSER` binding here
# (Cloudflare's Browser Rendering has no open-source equivalent) - the worker's
# browserConnection() helper (apps/worker/src/index.ts) falls into the
# "self-hosted" branch whenever HYEB_BROWSER_WS_ENDPOINT is set, which is always
# true in this config, and never reads `env.BROWSER` in that branch.
const hyeboardWorker :Workerd.Worker = (
  modules = [
    (name = "worker.js", esModule = embed "worker.js")
  ],
  compatibilityDate = "2026-06-30",
  compatibilityFlags = ["nodejs_compat"],
  bindings = [
    (name = "HYEB_SESSION_SECRET", fromEnvironment = "HYEB_SESSION_SECRET"),
    (name = "HYEB_ALLOWED_ORIGINS", fromEnvironment = "HYEB_ALLOWED_ORIGINS"),
    (name = "HYEB_BROWSER_WS_ENDPOINT", fromEnvironment = "HYEB_BROWSER_WS_ENDPOINT"),
  ],
);
