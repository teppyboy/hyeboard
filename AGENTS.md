# AGENTS.md — Hyeboard

Multi-university student dashboard. UET (VNU-UET) first, StudentHub + Canvas adapter backend, Mock adapter for demo/dev/testing. pnpm monorepo with a git repository at the project root.

## Stack

- `apps/web`: React 19, Vite, TanStack Router (code-based routes, no file-based codegen), TanStack Query, Tailwind CSS v4, shadcn-style local UI primitives (`apps/web/src/components/ui/*`, not the shadcn CLI).
- `apps/api`: Elysia on Cloudflare Workers (via `wrangler`), thin BFF/proxy — the frontend never calls StudentHub/Canvas directly.
- `packages/schemas`: zod schemas + inferred TS types, shared by web/api/adapters.
- `packages/core`: Worker-safe helpers — `ok`/`fail` envelopes, `HyeboardError`, AES-GCM encrypted session token helpers (`encryptSession`/`decryptSession`), `assertSupported`.
- `packages/university-adapters`: `UniversityAdapter` interface + registry (`mock`, `uet`). All university-specific logic (StudentHub/Canvas clients, response mapping) lives here, isolated from the API layer.

## Commands

Run from repo root unless noted. Always use `pnpm` directly — do not wrap `pnpm`/`wrangler` in PowerShell `Start-Job`/`Start-Process`/background-script blocks; it produces misleading/missing output for long-running dev servers.

```bash
pnpm install
pnpm dev                 # runs web (Vite, :5173) + api (wrangler dev, :8787) in parallel
pnpm --filter @hyeboard/web dev
pnpm --filter @hyeboard/api dev
pnpm build                # tsc --noEmit + vite build across all packages
pnpm test                 # tsc --noEmit across all packages (no separate test runner configured)
pnpm --filter @hyeboard/web exec playwright test   # Playwright e2e (spins up web+api itself)
pnpm --filter @hyeboard/api exec wrangler deploy --dry-run   # verify Worker still deploys, no real deploy
```

`apps/api`'s `dev` script must keep the `--show-interactive-dev-session=false --log-level info` flags — wrangler's default interactive session redraws the terminal and hides log output when run under `pnpm --parallel`.

There is no separate lint tool wired up; `lint`/`typecheck`/`test` all alias to `tsc -p tsconfig.json --noEmit` per package. Treat a clean `pnpm build` + `pnpm test` + Playwright pass as the bar for "done," not just a green typecheck.

## Git hygiene

- This workspace is a git repo. Check `git status --short` before staging or committing.
- Never commit raw HAR captures, secrets, env files, Playwright reports, or test artifacts. `.gitignore` excludes `*.har`, `.env*`, `.dev.vars`, `node_modules/`, build output, `.wrangler/`, and Playwright result/report folders.
- Stage only intentional files. If unrelated user/agent changes are present, leave them alone unless explicitly asked.
- Do not amend, force-push, or rewrite history unless explicitly requested.
- Use concise commit messages. The initial repo commit is `Initial commit: Hyeboard monorepo` on `master`.

## Required env

- `apps/api/.dev.vars` (gitignored): `HYEB_SESSION_SECRET` (32+ random bytes, base64 is fine), `HYEB_ALLOWED_ORIGINS` (comma-separated origins, defaults to `http://localhost:5173`).
- `apps/web/.env.local` (optional): `VITE_API_BASE_URL` (defaults to `http://127.0.0.1:8787`).

## Session/auth model

Hyeboard issues its own opaque encrypted Bearer token (AES-GCM via `HYEB_SESSION_SECRET`), never forwards raw upstream cookies to the browser. The token wraps an `EncryptedSessionPayload` containing optional `studenthub` and `canvas` upstream credentials (`bearer` or `cookie` kind). StudentHub and Canvas are independent, optional credentials — a session can have one, the other, or both. `importSession` validates whichever credential(s) are present against the real upstream before declaring success (no silent "success" on garbage tokens).

Frontend session lifecycle lives in `apps/web/src/lib/api.ts`: only clear the local session token on genuine session-death error codes (`MISSING_SESSION`, `SESSION_EXPIRED`, `INVALID_SESSION`). Feature-specific errors (e.g. `CANVAS_LOGIN_REQUIRED` when a Canvas-only feature is hit without a Canvas credential) must NOT clear the session or force a re-login redirect — show an inline error instead (see `CanvasRequired`/`QueryErrorPanel` in `apps/web/src/main.tsx`).

## University adapters

- Adding a university = implementing `UniversityAdapter` (see `packages/university-adapters/src/types.ts`) and registering it in `packages/university-adapters/src/registry.ts`.
- Never claim a capability (`University.capabilities.*`) is `true` unless the adapter genuinely implements it against a real, verified upstream response shape. If unverified, set the capability `false` and call `assertSupported(false, "Feature name")` — do not ship hardcoded placeholder/stub data as if it were real (see `getTrainingPoints`/`getRequests` in the UET adapter for the pattern of "not implemented" vs faking it).
- StudentHub's `sessionStart`/`sessionEnd` in timetable data are period ("tiết học") ordinals, not clock hours — do not treat them as raw hours. There is no verified period→clock-time lookup table for VNU-UET; render period numbers honestly (`periodStart`/`periodEnd` on `ClassSession`) instead of fabricating times.
- `weekday` on `ClassSession` is 1=Monday..7=Sunday (ISO convention), confirmed against real captured StudentHub timetable data with weekday values 1/2/3 across a normal week spread.

## HAR handling (critical)

Raw `.har` files may be present in the repo root during investigation (currently: `studenthub.uet.edu.vn.har`, `portal.uet.vnu.edu.vn.har`, `2studenthub.uet.edu.vn.har`) — these contain real cookies, bearer/JWT tokens, SAML assertions, and PII.

- **Never commit raw `.har` files.** `.gitignore` excludes `*.har` except `samples/har-redacted/*.har`.
- Never paste raw header values, cookies, SAML payloads, tokens, or PII-bearing response bodies into docs, commit messages, or chat output — summarize field names/shapes only.
- To inspect a HAR programmatically, `rg`/grep frequently fails on large HAR JSON (quantifier/size limits); write small Python scripts instead (HAR is just JSON, response bodies are often base64-encoded).
- Chrome DevTools strips `Cookie`/`Authorization` request headers from HAR exports by default — most captures will not contain literal secrets unless "Allow to generate HAR with sensitive data" was explicitly enabled at capture time.

## Testing conventions

- E2e coverage lives in `apps/web/tests/smoke.spec.ts` (Playwright). It exercises: login-gate redirect, login school-picker sections, account menu, demo login, dark/light toggle, sidebar collapse, mobile nav drawer, header search, notifications, grades term-grouping, and that every feature route renders real UI (no raw JSON dumps, no leftover `<pre>`).
- Config: `apps/web/playwright.config.ts` starts both `wrangler dev` and `vite dev` as `webServer`s with `reuseExistingServer: true` — if a test run behaves like it's using stale code, check for orphaned processes on ports 5173/8787 first (`Get-NetTCPConnection -LocalPort 5173,8787 | Stop-Process -Force`) before assuming a real bug.
- When adding a feature that changes visible DOM structure (icons, labels, aria-labels), update the smoke spec in the same change — several past regressions were only caught by real bounding-box/CSS assertions, not just "element exists" checks.

## UI/design conventions

- Tailwind v4 with CSS custom properties for theming (`apps/web/src/styles.css`): `:root` = light default (Geist/mock palette), `:root[data-theme="uet"]` = UET palette, `:root[data-mode="dark"]` = dark overrides, combined selectors for UET-dark. UET's accent color is user-customizable via a hue picker (Settings page) that sets `--primary`/`--accent`/`--ring`/`--sidebar` as inline style overrides on `documentElement` — keep the `:root[data-theme="uet"]` CSS block as the pre-JS fallback (avoids flash of wrong color), don't remove it.
- No gradient text, no side-stripe (`border-left`/`border-right` > 1px) accents on cards/alerts, no glassmorphism, no glow/box-shadow hover effects, no "cards inside cards." Prefer flat `.list-row`/`divide-y` lists inside a single bordered `Card` over grids of individually-boxed items. These rules came from an explicit user redesign pass — don't regress them.
- Every feature route must render real bound data through `useFeatureQuery`/`FeatureFrame`, never a JSON dump. Every list/grid section needs an explicit empty-state (`<Empty />`), not silent nothing.

## Communication style

Repo owner prefers terse, technical responses — no filler, no hedging, direct fixes with file:line references when relevant.
