# UET Google Login Automation — Design

Status: approved by user, pending spec self-review sign-off
Date: 2026-07-03

## Problem

Today, connecting a UET account (StudentHub + Canvas) requires the user to manually open each site, run a devtools snippet to copy a token from `localStorage`, and paste it into the Hyeboard login form (`apps/web/src/main.tsx:1010-1046`). This is unfriendly and error-prone. Both StudentHub and Canvas ultimately authenticate via the same VNU Google Workspace account (`@vnu.edu.vn`):

- **StudentHub** (`studenthub.uet.edu.vn`): Google's own Sign-In-With-Google (GSI) JS widget, hosted-domain-restricted to `vnu.edu.vn`, using StudentHub's own OAuth client ID. Produces a Google-signed ID token exchanged at `GET /api/auth/google/callback?code=<id_token>`.
- **Canvas** (`portal.uet.vnu.edu.vn`): redirects to a VNU/Keycloak-branded IDP login page, which itself brokers to Google, then SAML-posts back (`POST /login/saml`) to establish a Canvas session.

Hyeboard cannot register its own Google OAuth client for a safe client-side "Sign in with Google" button on its own origin — StudentHub's existing OAuth client does not have Hyeboard's origin in its allow-list, and Google's client will reject unregistered origins. The user has explicitly directed that login be automated **server-side** instead (see Q&A record). This is a **conscious, accepted risk trade-off** — the alternative (browser-extension helper reading tokens from the user's own normal login) was offered and declined in favor of full password automation.

## Accepted risks (explicit, not hidden)

1. Google actively detects and can block/challenge non-interactive or headless-browser logins (reCAPTCHA, "this browser or app may not be secure," device fingerprinting), even against real Chrome via Browser Rendering.
2. Hyeboard's server receives the user's actual Google/VNU password, not a scoped/revocable token. A `HYEB_SESSION_SECRET` compromise now exposes real passwords for any user who used automated login (compounded by the decision to persist the password encrypted for silent re-login).
3. The automation is built against undocumented Google/Keycloak/Canvas DOM — it can break silently on any UI change on their end, with no upstream API contract to rely on.
4. Repeated or malformed automated attempts risk the real Google account being flagged/challenged/locked by Google's abuse detection.

Mitigations for each are in the Guardrails section below. Manual paste login remains available as a fallback for users who don't want to hand over their password, or when automation fails.

## Architecture

```
apps/web (login page)
  └─ POST /api/uet/auth/import-session { uetGoogleEmail, uetGooglePassword }
        │
apps/worker (Elysia route — apps/worker/src/index.ts)
  └─ resolveSession()/import-session handler passes env.BROWSER through
  └─ getAdapter("uet").importSession(input, { browserBinding: env.BROWSER })
        │
packages/university-adapters/src/uet/
  ├─ google-login-automation.ts   (NEW)
  │     automateVnuGoogleLogin(browserBinding, email, password):
  │       1. puppeteer.launch(browserBinding) [@cloudflare/puppeteer]
  │       2. new page → studenthub.uet.edu.vn/login
  │       3. trigger Google sign-in → fill email → Next → fill password → Next
  │       4. detect challenge/CAPTCHA screens → fail fast (GOOGLE_CHALLENGE_REQUIRED)
  │       5. capture StudentHub's JWT (network response interception on
  │          /api/auth/google/callback, or localStorage read via page.evaluate)
  │       6. same browser context (Google session cookie persists) →
  │          navigate to portal.uet.vnu.edu.vn SSO entry point → Keycloak →
  │          Google (already authenticated, brokers silently) → SAML POST
  │          back to Canvas
  │       7. capture Canvas session cookie (page.cookies()) + CSRF token
  │          (meta[name="csrf-token"] or ENV.* JS global via page.evaluate)
  │       8. browser.close() in finally, always
  │       9. return best-effort partial result: { studenthub?, canvas? } —
  │          one succeeding while the other fails still commits the
  │          recoverable half instead of discarding both
  └─ adapter.ts — importSession branches on uetGoogleEmail/uetGooglePassword
        (mutually exclusive with existing manual token/cookie fields, same
        validation-against-real-upstream pattern already in place)
```

### Interface changes

- `UniversityAdapter.importSession(input: LoginImportInput, context?: ImportSessionContext)` — new optional second parameter. `ImportSessionContext = { browserBinding?: Fetcher }` (new type in `packages/university-adapters/src/types.ts`). Mock and vnu adapters ignore it; only uet uses it.
- `LoginImportInput` gains `uetGoogleEmail?: string` and `uetGooglePassword?: string` (named `uetGoogle*`, deliberately distinct from the existing `vnuUsername`/`vnuPassword` fields already used by the unrelated `vnu`/daotao adapter).
- New Cloudflare Browser Rendering binding `BROWSER` added to `apps/worker/wrangler.jsonc` (`"browser": { "binding": "BROWSER" }`).
- New dependency: `@cloudflare/puppeteer`, added to `packages/university-adapters/package.json` (it only executes inside the Worker bundle at runtime, consistent with the package's existing Workers-only assumptions — e.g. `fetch`-based clients).

## Session/expiry model

Today `EncryptedSessionPayload.expiresAt` (checked by `decryptSession`, `packages/core/src/index.ts`) is set to the earliest upstream credential's expiry — for UET, StudentHub's JWT expiry (~1hr). `decryptSession` rejects the **entire** encrypted bearer token once this passes, forcing a full re-login regardless of whether we hold a password to silently refresh with. This must change for silent re-login to be meaningful.

**New field**: `EncryptedSessionPayload.uetGoogleCredential?: { email: string; password: string }` — encrypted inside the existing AES-GCM envelope (no new crypto surface, just a new field in the payload that's already encrypted).

**New expiry policy**: when a session was created via automated Google login, set the **outer** `expiresAt` to a long-lived window (recommend 30 days as a starting point) — this becomes "how long before the user must retype their password," decoupled from the individual `studenthub`/`canvas` `UpstreamCredential.expiresAt` fields, which keep their real short-lived values as observed from each JWT/cookie.

**Lazy refresh** (per user's explicit choice — no background jobs/Durable Object alarms): a new `resolveSession()` wrapper in `apps/worker/src/index.ts` replaces the bare `getSession()` call for uet routes. On each authenticated request it:

1. Decrypts as before.
2. Checks `isExpired(session.studenthub?.expiresAt)` (cheap, no network call).
3. If expired **and** `session.uetGoogleCredential` is present, re-runs `automateVnuGoogleLogin`, rebuilds `studenthub`/`canvas` credentials, re-encrypts (keeping the same outer `expiresAt`/`uetGoogleCredential`), and uses the refreshed session for the current request.
4. Returns the refreshed token to the client via a `meta.refreshedToken` field on the response so `apps/web/src/lib/api.ts` can transparently swap its locally stored token with zero user-visible interruption.
5. If the refresh attempt itself fails (Google blocked it, password changed, challenge triggered), surface a distinct error code (e.g. `GOOGLE_REFRESH_FAILED`) so the frontend routes the user back to a real login screen instead of silently failing on every subsequent request.

## Guardrails

- **Rate limiting**: automated-login attempts capped per email via Cache API (e.g. 5 attempts / 15 min) to reduce risk of Google's abuse detection flagging the account from repeated bad attempts (typos, transient bugs, retries).
- **Hard timeout**: ~45s ceiling on the Puppeteer session — Browser Rendering is billed per duration, and a hang must not run indefinitely.
- **Challenge detection**: explicitly check for Google's CAPTCHA/"verify it's you"/2FA challenge screens by selector or page text; fail fast with a distinct error code (`GOOGLE_CHALLENGE_REQUIRED` / `GOOGLE_2FA_REQUIRED`) rather than hanging until timeout or misinterpreting the page.
- **No password logging**: raw password must never appear in logs, error messages, or thrown exceptions on any code path.
- **Always cleanup**: `browser.close()` in a `finally` block regardless of success/failure.
- **Graceful degradation**: any automation failure must degrade to the existing manual-paste fallback UI, never a hard crash or dead end.

## Frontend changes (apps/web)

- UET section of `LoginPage()` (`apps/web/src/main.tsx`) leads with an email + password form ("Sign in with your VNU Google account") submitting `uetGoogleEmail`/`uetGooglePassword` to `import-session`.
- Consent copy adjacent to the password field, stating plainly: the password is sent to a real Google/VNU login page inside a secure server-side browser session; Hyeboard stores it encrypted to enable automatic re-login; the user can revoke this by logging out (which must also purge `uetGoogleCredential` from storage).
- On any automation failure (`GOOGLE_CHALLENGE_REQUIRED`, `GOOGLE_2FA_REQUIRED`, `GOOGLE_AUTOMATION_BLOCKED`, generic failure), show a clear inline error and reveal the existing manual token/cookie paste form (kept as-is, not removed) as fallback.
- `apps/web/src/lib/api.ts`: after any authenticated request, if the response carries `meta.refreshedToken`, transparently update the locally stored session token.
- Logout flow must purge any persisted `uetGoogleCredential` server-side (not just client-side token clear), consistent with "you can revoke this anytime."

## Testing

Real Google/Keycloak login **cannot** be exercised in CI/Playwright — there's no safe way to hold test credentials, and Google's abuse detection will treat CI infrastructure the same as any other automated traffic (same risk category as production).

- Unit/integration test everything that doesn't require a real Google session: rate limiter, expiry/refresh branching logic in `resolveSession()`, `EncryptedSessionPayload` roundtrip with the new `uetGoogleCredential` field, `LoginImportInput` validation — all with `automateVnuGoogleLogin` mocked.
- Add a smoke-spec case (`apps/web/tests/smoke.spec.ts`) verifying the new login form renders and falls back to the manual-paste UI cleanly on a simulated `import-session` failure response.
- The actual Puppeteer DOM automation (selectors for Google's sign-in form, StudentHub's Google button, Canvas/Keycloak's SSO entry point) is **not verifiable from static analysis** — none of the available HAR captures include the full GSI popup or Keycloak/SAML page DOM. This must be hand-verified live against the real sites during implementation, and is flagged here as an open risk rather than a solved problem.

## Open risks / non-goals

- Selector fragility against Google/Keycloak/Canvas UI changes — no upstream contract, will break silently, requires monitoring/alerting on automation failure rates post-launch (not designed here, worth a follow-up).
- Users with 2FA enabled (a minority, per org default) get a hard failure and must use manual paste — no automated bypass is in scope or possible.
- Long-lived (30-day) outer session token combined with a persisted plaintext-equivalent password inside the encrypted payload meaningfully raises the value of a `HYEB_SESSION_SECRET` compromise. This is an explicit accepted trade-off per user decision, not an oversight.
