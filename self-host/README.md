# Self-hosting Hyeboard on standalone workerd

Runs Hyeboard on Cloudflare's open-source Workers runtime (`workerd`,
[cloudflare/workerd](https://github.com/cloudflare/workerd)) instead of
Cloudflare's managed platform. Same worker code, same build output as
`wrangler deploy` - just served by `workerd serve` in a container you control.

## What works unmodified

- The whole Elysia API, session encryption (AES-GCM via `HYEB_SESSION_SECRET`),
  and the Cache-API-backed rate limiting / token revocation (`apps/worker/src/index.ts`)
  all run as-is - the Workers `caches.default` API is native to open-source
  workerd, not a Cloudflare-proprietary add-on.

## What's different from the Cloudflare-hosted deployment

1. **Static asset serving + `/api/*` routing.** Cloudflare's managed `assets`
   binding (`wrangler.jsonc`'s `run_worker_first`/`not_found_handling`) has no
   open-source equivalent. `gateway.js` re-implements the same routing
   (API calls to the worker, everything else served as static files with an
   `index.html` SPA fallback for extensionless paths) in front of two workerd
   services.
2. **UET Google-login automation's headless browser.** Cloudflare's Browser
   Rendering (`env.BROWSER`) is a separate managed Chrome farm with no
   open-source equivalent. This setup runs its own headless Chrome
   (`browserless/chrome`) and points
   `packages/university-adapters/src/uet/google-login-automation.ts` at it via
   `puppeteer-core`'s `.connect({ browserWSEndpoint })`, gated by the
   `HYEB_BROWSER_WS_ENDPOINT` env var (see `BrowserConnection` in
   `packages/university-adapters/src/types.ts` and `browserConnection()` in
   `apps/worker/src/index.ts`). **This path has not been live-verified against
   a real self-hosted setup** - the Cloudflare-hosted path (used when
   `HYEB_BROWSER_WS_ENDPOINT` is unset) remains the only one confirmed working
   in production.

## Running it

```bash
cd self-host
cp .env.example .env   # fill in HYEB_SESSION_SECRET (see comment in the file)
docker compose up --build
```

This builds `apps/web`'s static bundle and `apps/worker`'s bundled worker
script (`pnpm --filter @hyeboard/worker build:workerd`, i.e.
`wrangler deploy --dry-run --outdir dist-workerd` - wrangler's own bundler,
just not actually deploying), then starts:

- `chrome`: a `browserless/chrome` container exposing a CDP WebSocket on `:3000`.
- `workerd`: `workerd serve config.capnp` on `:8080`, serving the app and
  proxying Google-login automation through `chrome`.

Visit `http://localhost:8080`.

## Updating after code changes

`docker compose up --build` rebuilds the worker/web bundles from source each
time (see the Dockerfile's `build` stage) - no separate manual build step is
required, but expect Docker's build cache to still pick up unchanged layers.

## Known limitations / unverified assumptions

- The SPA-fallback logic in `gateway.js` is a best-effort re-implementation,
  not a byte-for-byte match of Cloudflare's managed asset-serving semantics
  (no immutable-asset cache headers, no content-negotiation beyond what
  workerd's `disk` service provides).
- `puppeteer-core`'s `.connect()` mode running inside self-hosted workerd
  under `nodejs_compat` has not been exercised end-to-end. If it breaks,
  check `packages/university-adapters/src/uet/google-login-automation.ts`'s
  `automateVnuGoogleLogin` function - the self-hosted branch is clearly
  commented.
- `browserless/chrome`'s CDP endpoint may require a `?token=` query param
  depending on the image/version in use; if `puppeteer-core.connect()` fails
  to authenticate, check that image's docs and adjust
  `HYEB_BROWSER_WS_ENDPOINT` in `docker-compose.yml` accordingly.
