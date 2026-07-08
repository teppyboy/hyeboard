# Hyeboard

Multi-university student dashboard. VNU-UET (StudentHub + Canvas) first, with a Mock adapter for demo/dev use, built as a pnpm monorepo.

## Structure

- `apps/web` — React 19, Vite, TanStack Router/Query, Tailwind CSS v4, local shadcn-style UI primitives.
- `apps/worker` — Elysia API/BFF. Deploys as a Cloudflare Worker (serving the built web app as static assets) or self-hosts on plain Node.js/Bun.
- `packages/schemas` — shared Zod schemas + inferred TypeScript types.
- `packages/core` — Worker-safe helpers: API response envelopes, `HyeboardError`, AES-GCM encrypted session token helpers.
- `packages/university-adapters` — the `UniversityAdapter` interface and registry (`mock`, `uet`). All university-specific integration logic (StudentHub/Canvas clients, response mapping, Google-login automation) lives here.

## Development

```bash
pnpm install
pnpm dev          # runs web (Vite, :5173) + worker (wrangler dev, :8787) together
```

Required env for local dev, `apps/worker/.dev.vars` (gitignored):

```txt
HYEB_SESSION_SECRET=replace-with-at-least-32-random-bytes
HYEB_ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
```

Optional, `apps/web/.env.local`:

```txt
VITE_API_BASE_URL=http://localhost:8787
```

## Building & testing

```bash
pnpm build        # builds web (Vite) + typechecks the worker
pnpm test         # typecheck + vitest across every package
pnpm --filter @hyeboard/web exec playwright test   # e2e (spins up worker + web itself)
```

## Deployment

Two supported targets:

**Cloudflare Workers** (single Worker serving the API + the built web app as static assets):

```bash
pnpm deploy        # wrangler deploy
```

**Self-hosted (Node.js/Bun)** — produces a standalone `dist/` directory with the bundled worker, the built web app, and a runtime `config.json`:

```bash
pnpm package        # builds + assembles dist/
cd dist
npm install --omit=dev
cp .env.example .env   # fill in HYEB_SESSION_SECRET
node dist/index.js      # or: bun run dist/index.js
```

All non-secret runtime configuration (allowed origins, host/port, browser automation settings) lives in `dist/config.json`; only `HYEB_SESSION_SECRET` is read from the environment.

## Security

Raw HAR captures and any file containing real credentials/cookies/tokens must never be committed — `.gitignore` excludes `*.har`, `cred.txt`, `.env*`, and `.dev.vars`. See `docs/har-security.md` for HAR-handling guidance.

## License

Hyeboard is licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only).
