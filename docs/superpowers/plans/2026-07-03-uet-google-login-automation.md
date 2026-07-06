# UET Google Login Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a UET user type their `@vnu.edu.vn` Google email + password once; Hyeboard's worker drives a real headless browser (Cloudflare Browser Rendering) through Google sign-in for StudentHub and, in the same browser session, silently through Canvas's Keycloak/SAML SSO — producing both credentials without the user copy-pasting devtools tokens. Manual paste stays as fallback.

**Architecture:** New `automateVnuGoogleLogin()` in `packages/university-adapters/src/uet/google-login-automation.ts` uses `@cloudflare/puppeteer` against a new `BROWSER` Worker binding. `uet` adapter's `importSession()` gains an optional `ImportSessionContext { browserBinding }` param and branches on new `uetGoogleEmail`/`uetGooglePassword` input fields. `EncryptedSessionPayload` gains an encrypted `uetGoogleCredential` field for lazy silent re-login, handled by a new `resolveSession()` wrapper in the worker that replaces the bare session decrypt for authenticated routes.

**Tech Stack:** TypeScript, Elysia (Cloudflare Worker), `@cloudflare/puppeteer`, Vitest (new — see Task 1), React 19 (apps/web), existing AES-GCM session encryption in `@hyeboard/core`.

**Reference spec:** `docs/superpowers/specs/2026-07-03-uet-google-login-automation-design.md` — read it if any task below seems to contradict this plan; the spec is the source of intent, this plan is the source of exact steps.

**Known open risk carried into implementation:** the exact DOM selectors for Google's sign-in form, StudentHub's "Sign in with Google" trigger, and Canvas/Keycloak's SSO entry point are **not verifiable from static analysis** (see spec's Testing section — no HAR captured these pages). Task 4 below implements the automation with best-effort selectors based on Google's/Canvas's known-stable patterns and copious comments marking `NEEDS LIVE VERIFICATION`. Task 12 is a mandatory live-verification pass against the real sites before this ships — do not skip it.

---

## Task 1: Add Vitest to `@hyeboard/university-adapters` and `@hyeboard/core`

The repo currently has no unit test runner (`test` scripts alias to `tsc --noEmit`; see `AGENTS.md`). This feature introduces real branching logic (rate limiting, expiry/refresh, payload roundtrip) that needs actual unit tests per the spec's Testing section, so we add Vitest to the two packages that gain new logic. Playwright (already present) remains the e2e layer; nothing about its setup changes.

**Files:**
- Modify: `packages/university-adapters/package.json`
- Modify: `packages/core/package.json`
- Create: `packages/university-adapters/vitest.config.ts`
- Create: `packages/core/vitest.config.ts`
- Create: `packages/core/src/smoke.test.ts` (throwaway, deleted in step 6)

- [ ] **Step 1: Add Vitest devDependency to both packages**

Edit `packages/university-adapters/package.json`:
```json
  "scripts": {
    "build": "tsc -p tsconfig.json --noEmit",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "tsc -p tsconfig.json --noEmit",
    "test": "tsc -p tsconfig.json --noEmit && vitest run"
  },
  "dependencies": {
    "@cloudflare/puppeteer": "^1.0.2",
    "@hyeboard/core": "workspace:*",
    "@hyeboard/schemas": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^6.0.3",
    "vitest": "^3.2.4"
  }
```

Edit `packages/core/package.json`:
```json
  "scripts": {
    "build": "tsc -p tsconfig.json --noEmit",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "tsc -p tsconfig.json --noEmit",
    "test": "tsc -p tsconfig.json --noEmit && vitest run"
  },
  "dependencies": {
    "@hyeboard/schemas": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^6.0.3",
    "vitest": "^3.2.4"
  }
```

- [ ] **Step 2: Install**

Run: `pnpm install` (repo root)
Expected: lockfile updates, `@cloudflare/puppeteer` and `vitest` appear under the two packages, no errors.

- [ ] **Step 3: Create minimal vitest configs**

`packages/university-adapters/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
```

`packages/core/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Write a throwaway smoke test to prove the runner works**

`packages/core/src/smoke.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { isExpired } from "./index";

describe("vitest wiring", () => {
  it("runs", () => {
    expect(isExpired(new Date(Date.now() - 1000).toISOString())).toBe(true);
  });
});
```

- [ ] **Step 5: Run it**

Run: `pnpm --filter @hyeboard/core test`
Expected: PASS (1 test), then run `pnpm --filter @hyeboard/university-adapters test` — expected: PASS (0 tests found is fine, no `*.test.ts` exists there yet, vitest exits 0 on empty suite by default... if it errors on "no tests found", add `passWithNoTests: true` to that package's vitest.config.ts test block).

- [ ] **Step 6: Delete the throwaway test, keep the config**

Delete `packages/core/src/smoke.test.ts` — the real roundtrip test for `uetGoogleCredential` lands in Task 2 and supersedes it.

- [ ] **Step 7: Commit**

```bash
git add packages/university-adapters/package.json packages/core/package.json packages/university-adapters/vitest.config.ts packages/core/vitest.config.ts pnpm-lock.yaml
git commit -m "chore: add vitest to core and university-adapters packages"
```

---

## Task 2: `EncryptedSessionPayload.uetGoogleCredential` + roundtrip test

**Files:**
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/src/session.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/core/src/session.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { decryptSession, encryptSession, type EncryptedSessionPayload } from "./index";

const SECRET = "a".repeat(32);

describe("encryptSession / decryptSession", () => {
  it("roundtrips a payload carrying uetGoogleCredential", async () => {
    const payload: EncryptedSessionPayload = {
      version: 1,
      universityId: "uet",
      studentCode: "20200001",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      studenthub: { kind: "bearer", value: "sh-token", expiresAt: new Date(Date.now() + 60_000).toISOString() },
      uetGoogleCredential: { email: "student@vnu.edu.vn", password: "correct horse battery staple" },
    };
    const token = await encryptSession(payload, SECRET);
    const decrypted = await decryptSession(token, SECRET);
    expect(decrypted.uetGoogleCredential).toEqual(payload.uetGoogleCredential);
    expect(decrypted.studenthub?.value).toBe("sh-token");
  });

  it("omits uetGoogleCredential when not set (manual-paste sessions unaffected)", async () => {
    const payload: EncryptedSessionPayload = {
      version: 1,
      universityId: "uet",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      studenthub: { kind: "bearer", value: "sh-token", expiresAt: new Date(Date.now() + 60_000).toISOString() },
    };
    const token = await encryptSession(payload, SECRET);
    const decrypted = await decryptSession(token, SECRET);
    expect(decrypted.uetGoogleCredential).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @hyeboard/core exec vitest run session.test.ts`
Expected: FAIL — TypeScript error, `uetGoogleCredential` does not exist on type `EncryptedSessionPayload`.

- [ ] **Step 3: Add the field**

Edit `packages/core/src/index.ts`, the `EncryptedSessionPayload` type:
```ts
export type EncryptedSessionPayload = {
  version: 1;
  universityId: string;
  studentCode?: string;
  studenthub?: UpstreamCredential;
  canvas?: UpstreamCredential;
  vnu?: UpstreamCredential;
  // Present only for uet sessions created via automated Google login (see
  // packages/university-adapters/src/uet/google-login-automation.ts). Lets
  // resolveSession() in apps/worker silently re-run the login when the
  // short-lived studenthub/canvas credentials expire, without forcing the
  // user to retype anything. Persisted per explicit user decision — a
  // HYEB_SESSION_SECRET compromise exposes this real password, not just a
  // scoped token. See spec's "Accepted risks" section.
  uetGoogleCredential?: { email: string; password: string };
  expiresAt: string;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @hyeboard/core exec vitest run session.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/index.ts packages/core/src/session.test.ts
git commit -m "feat(core): add uetGoogleCredential field to EncryptedSessionPayload"
```

---

## Task 3: `LoginImportInput` + `ImportSessionContext` types

**Files:**
- Modify: `packages/university-adapters/src/types.ts`

- [ ] **Step 1: Add the new input fields and context type**

Edit `packages/university-adapters/src/types.ts`:
```ts
import type { Fetcher } from "@cloudflare/workers-types";
```
(If `@cloudflare/workers-types` is not a dependency of this package — check first: it currently is NOT, only `apps/worker` has it as a devDependency. Use the ambient ES `Fetcher` type instead — Cloudflare's `@cloudflare/workers-types` augments the global scope with `Fetcher` when included via `tsconfig` `types`, but this package's `tsconfig.json` doesn't include it. To avoid adding a new dependency just for one type, declare a minimal structural type locally instead of importing anything:)

```ts
// Minimal structural type for the Cloudflare Browser Rendering binding
// (env.BROWSER). Avoids depending on @cloudflare/workers-types from this
// package — only apps/worker needs the full Cloudflare ambient types; this
// package only needs to call .fetch() on whatever binding it's handed
// (that's exactly what @cloudflare/puppeteer's puppeteer.launch() expects).
export type BrowserBinding = { fetch: typeof fetch };

export type ImportSessionContext = {
  browserBinding?: BrowserBinding;
};

export type LoginImportInput = {
  studenthubGoogleCredential?: string;
  studenthubToken?: string;
  studenthubCookie?: string;
  canvasToken?: string;
  canvasCookie?: string;
  canvasCsrfToken?: string;
  vnuUsername?: string;
  vnuPassword?: string;
  studentCode?: string;
  // Automated VNU Google-account login for the uet adapter (StudentHub +
  // Canvas). Deliberately NOT named vnuGoogle* — the unrelated vnu (daotao)
  // adapter already owns vnuUsername/vnuPassword for its own login form.
  uetGoogleEmail?: string;
  uetGooglePassword?: string;
};
```

- [ ] **Step 2: Update the interface signature**

In the same file:
```ts
export interface UniversityAdapter {
  university: University;
  importSession(input: LoginImportInput, context?: ImportSessionContext): Promise<ImportedSession>;
  ...
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @hyeboard/university-adapters typecheck`
Expected: FAIL — `mock`/`vnu`/`uet` adapters' `importSession(input: LoginImportInput)` implementations don't yet match the interface... actually TypeScript structural typing allows a narrower function to satisfy a wider one only if params are contravariant-compatible; an implementation with one fewer optional param than the interface **does** satisfy it (extra optional params on the interface side are fine to ignore). Expected: PASS, no changes needed in mock/vnu adapters.

- [ ] **Step 4: Commit**

```bash
git add packages/university-adapters/src/types.ts
git commit -m "feat(adapters): add uetGoogleEmail/uetGooglePassword input and ImportSessionContext"
```

---

## Task 4: `google-login-automation.ts` — the Puppeteer flow

**Files:**
- Create: `packages/university-adapters/src/uet/google-login-automation.ts`
- Create: `packages/university-adapters/src/uet/google-login-automation.test.ts`

This is the highest-risk file in the plan (unverifiable selectors — see plan header). Structure it so the *parsing/decision* helpers (challenge detection, cookie serialization) are pure functions that Task's unit tests can actually exercise, and the *browser driving* is a thin orchestration function that unit tests mock out entirely (consistent with the spec's testing approach).

- [ ] **Step 1: Write failing tests for the pure helper functions**

`packages/university-adapters/src/uet/google-login-automation.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { detectChallenge, serializeCookies } from "./google-login-automation";

describe("detectChallenge", () => {
  it("flags a 2-step-verification page", () => {
    expect(detectChallenge("https://accounts.google.com/signin/v2/challenge/totp", "")).toBe("GOOGLE_2FA_REQUIRED");
  });
  it("flags a captcha/unusual-activity page by body text", () => {
    expect(detectChallenge("https://accounts.google.com/signin/rejected", "This browser or app may not be secure")).toBe("GOOGLE_AUTOMATION_BLOCKED");
  });
  it("flags a generic challenge URL", () => {
    expect(detectChallenge("https://accounts.google.com/signin/challenge/az", "")).toBe("GOOGLE_CHALLENGE_REQUIRED");
  });
  it("returns undefined for a normal page", () => {
    expect(detectChallenge("https://studenthub.uet.edu.vn/dashboard", "Welcome back")).toBeUndefined();
  });
});

describe("serializeCookies", () => {
  it("joins cookie objects into a single Cookie header value", () => {
    const cookies = [
      { name: "_session_id", value: "abc123" },
      { name: "canvas_csrf", value: "xyz" },
    ];
    expect(serializeCookies(cookies)).toBe("_session_id=abc123; canvas_csrf=xyz");
  });
  it("returns an empty string for no cookies", () => {
    expect(serializeCookies([])).toBe("");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @hyeboard/university-adapters exec vitest run google-login-automation.test.ts`
Expected: FAIL — module `./google-login-automation` does not exist.

- [ ] **Step 3: Implement the module**

`packages/university-adapters/src/uet/google-login-automation.ts`:
```ts
import puppeteer from "@cloudflare/puppeteer";
import { HyeboardError } from "@hyeboard/core";
import type { BrowserBinding } from "../types";

const STUDENTHUB_LOGIN_URL = "https://studenthub.uet.edu.vn/login";
const CANVAS_SSO_URL = "https://portal.uet.vnu.edu.vn/login/saml";
const HARD_TIMEOUT_MS = 45_000;

export type GoogleLoginResult = {
  studenthub?: { accessToken: string; accountCode?: string };
  canvas?: { cookie: string; csrfToken?: string };
};

// ── Pure helpers (unit-tested directly, no browser needed) ──────────────

// Google's own challenge/verification/abuse-detection pages are keyed off
// stable URL path segments and page copy that has been true of Google's
// sign-in flow for years. This is intentionally checked BEFORE we try to
// find any input field, so a challenge page fails fast with a precise error
// instead of a confusing "selector not found" timeout.
export function detectChallenge(currentUrl: string, bodyText: string): "GOOGLE_2FA_REQUIRED" | "GOOGLE_AUTOMATION_BLOCKED" | "GOOGLE_CHALLENGE_REQUIRED" | undefined {
  if (/\/signin\/v2\/challenge\/(totp|ipp|iap)/.test(currentUrl)) return "GOOGLE_2FA_REQUIRED";
  if (/may not be secure|verify it.?s you|unusual activity|suspicious/i.test(bodyText)) return "GOOGLE_AUTOMATION_BLOCKED";
  if (/\/signin\/(challenge|rejected)/.test(currentUrl)) return "GOOGLE_CHALLENGE_REQUIRED";
  return undefined;
}

export function serializeCookies(cookies: Array<{ name: string; value: string }>): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

// ── Browser orchestration (NOT unit-tested — mocked by adapter.ts's tests;
//    selectors below are NEEDS LIVE VERIFICATION, see plan Task 12) ──────

export async function automateVnuGoogleLogin(browserBinding: BrowserBinding, email: string, password: string): Promise<GoogleLoginResult> {
  const browser = await puppeteer.launch(browserBinding as never);
  const result: GoogleLoginResult = {};
  try {
    await Promise.race([
      runFlow(browser, email, password, result),
      new Promise((_, reject) => setTimeout(() => reject(new HyeboardError("GOOGLE_AUTOMATION_TIMEOUT", "The automated sign-in took too long and was cancelled.", 504)), HARD_TIMEOUT_MS)),
    ]);
  } finally {
    await browser.close();
  }
  if (!result.studenthub && !result.canvas) {
    throw new HyeboardError("GOOGLE_AUTOMATION_BLOCKED", "Google did not complete the sign-in. Check your email and password, or use the manual token option below.", 502);
  }
  return result;
}

async function runFlow(browser: Awaited<ReturnType<typeof puppeteer.launch>>, email: string, password: string, result: GoogleLoginResult): Promise<void> {
  const page = await browser.newPage();

  // 1. StudentHub → Google sign-in (GSI widget).
  // NEEDS LIVE VERIFICATION: exact selector for StudentHub's "Sign in with
  // Google" button. GSI typically renders inside an iframe
  // (#credential_picker_container / div[id^="gsi-"] or a same-origin
  // button that triggers a Google popup at accounts.google.com). If the
  // GSI flow opens a POPUP window rather than navigating the same page,
  // this must listen for `browser.on("targetcreated")` and drive the new
  // page instead of `page` — verify which live before trusting this code.
  await page.goto(STUDENTHUB_LOGIN_URL, { waitUntil: "networkidle0" });
  await page.waitForSelector('div[role="button"][aria-label*="Google" i], #gsi-button', { timeout: 10_000 });
  await page.click('div[role="button"][aria-label*="Google" i], #gsi-button');

  await page.waitForNavigation({ waitUntil: "networkidle0" }).catch(() => undefined);
  let challenge = detectChallenge(page.url(), await page.evaluate(() => document.body.innerText));
  if (challenge) throw new HyeboardError(challenge, "Google requires additional verification that cannot be completed automatically.", 401);

  // 2. Google email step
  await page.waitForSelector('input[type="email"]', { timeout: 10_000 });
  await page.type('input[type="email"]', email, { delay: 20 });
  await page.click('#identifierNext, button[jsname]');
  await page.waitForNavigation({ waitUntil: "networkidle0" }).catch(() => undefined);
  challenge = detectChallenge(page.url(), await page.evaluate(() => document.body.innerText));
  if (challenge) throw new HyeboardError(challenge, "Google requires additional verification that cannot be completed automatically.", 401);

  // 3. Google password step
  await page.waitForSelector('input[type="password"]', { timeout: 10_000, visible: true });
  await page.type('input[type="password"]', password, { delay: 20 });
  await page.click('#passwordNext, button[jsname]');
  await page.waitForNavigation({ waitUntil: "networkidle0" }).catch(() => undefined);
  challenge = detectChallenge(page.url(), await page.evaluate(() => document.body.innerText));
  if (challenge) throw new HyeboardError(challenge, "Google requires additional verification that cannot be completed automatically.", 401);

  // 4. Capture StudentHub's JWT once redirected back with a session.
  // NEEDS LIVE VERIFICATION: whether StudentHub stores this in
  // localStorage.accessToken (matching the manual-paste instructions
  // already in apps/web/src/main.tsx) or only ever sets it via a
  // /api/auth/google/callback response body we'd need to intercept via
  // page.on("response", ...) registered BEFORE the click in step 1.
  const studenthubToken = await page.evaluate(() => window.localStorage.getItem("accessToken")).catch(() => null);
  if (studenthubToken) result.studenthub = { accessToken: studenthubToken };

  // 5. Same browser context/cookies → Canvas SSO (Keycloak brokers to the
  // already-authenticated Google session silently, no second password).
  // NEEDS LIVE VERIFICATION: portal.uet.vnu.edu.vn's actual SSO entry path
  // (har-notes.md only captured POST /login/saml post-authentication; the
  // pre-auth entry point that triggers the Keycloak redirect was never
  // captured in any HAR — this URL is a best guess and must be confirmed).
  await page.goto(CANVAS_SSO_URL, { waitUntil: "networkidle0" }).catch(() => undefined);
  challenge = detectChallenge(page.url(), await page.evaluate(() => document.body.innerText).catch(() => ""));
  if (!challenge) {
    const cookies = await page.cookies();
    const csrfCookie = cookies.find((c) => /csrf/i.test(c.name));
    if (cookies.length) {
      result.canvas = {
        cookie: serializeCookies(cookies),
        csrfToken: csrfCookie ? decodeURIComponent(csrfCookie.value) : undefined,
      };
    }
  }
}
```

- [ ] **Step 4: Run tests to verify the pure helpers pass**

Run: `pnpm --filter @hyeboard/university-adapters exec vitest run google-login-automation.test.ts`
Expected: PASS (6 tests) — note this only validates `detectChallenge`/`serializeCookies`, NOT `automateVnuGoogleLogin`'s browser flow (unverifiable without a live browser + real account, see plan header).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @hyeboard/university-adapters typecheck`
Expected: PASS. If `@cloudflare/puppeteer`'s exported types don't line up exactly with the `as never` cast used for `browserBinding`, adjust the cast — the important contract is "this compiles and the runtime call matches `@cloudflare/puppeteer`'s documented `puppeteer.launch(env.BROWSER)` signature," not the exact cast mechanics.

- [ ] **Step 6: Commit**

```bash
git add packages/university-adapters/src/uet/google-login-automation.ts packages/university-adapters/src/uet/google-login-automation.test.ts
git commit -m "feat(uet): add automateVnuGoogleLogin via Cloudflare Browser Rendering"
```

---

## Task 5: Wire automation into `uet` adapter's `importSession`

**Files:**
- Modify: `packages/university-adapters/src/uet/adapter.ts`
- Create: `packages/university-adapters/src/uet/adapter.test.ts`

- [ ] **Step 1: Write failing tests, mocking `automateVnuGoogleLogin`**

`packages/university-adapters/src/uet/adapter.test.ts`:
```ts
import { HyeboardError } from "@hyeboard/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUetAdapter } from "./adapter";

vi.mock("./google-login-automation", () => ({
  automateVnuGoogleLogin: vi.fn(),
}));
vi.mock("./studenthub-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./studenthub-client")>();
  return { ...actual, StudentHubClient: vi.fn().mockImplementation(() => ({ getProfile: vi.fn().mockResolvedValue({ studentCode: "20200001" }) })) };
});

import { automateVnuGoogleLogin } from "./google-login-automation";

describe("uet adapter importSession — Google automation path", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires a browserBinding when uetGoogleEmail/Password are provided", async () => {
    const adapter = createUetAdapter();
    await expect(adapter.importSession({ uetGoogleEmail: "a@vnu.edu.vn", uetGooglePassword: "x" })).rejects.toThrow(HyeboardError);
  });

  it("builds a session from a successful automation result and persists uetGoogleCredential with a long expiry", async () => {
    vi.mocked(automateVnuGoogleLogin).mockResolvedValue({
      studenthub: { accessToken: "sh-token", accountCode: "20200001" },
      canvas: { cookie: "a=b", csrfToken: "csrf" },
    });
    const adapter = createUetAdapter();
    const imported = await adapter.importSession(
      { uetGoogleEmail: "a@vnu.edu.vn", uetGooglePassword: "hunter2" },
      { browserBinding: { fetch: vi.fn() } },
    );
    expect(imported.session.uetGoogleCredential).toEqual({ email: "a@vnu.edu.vn", password: "hunter2" });
    expect(imported.session.studenthub).toEqual({ kind: "bearer", value: "sh-token", expiresAt: expect.any(String) });
    expect(imported.session.canvas).toEqual({ kind: "cookie", value: "a=b", csrfToken: "csrf", expiresAt: expect.any(String) });
    // 30-day window, not the ~1hr JWT-derived window used by manual paste.
    const days = (Date.parse(imported.expiresAt) - Date.now()) / (1000 * 60 * 60 * 24);
    expect(days).toBeGreaterThan(29);
  });

  it("commits a partial result when only one of studenthub/canvas succeeds", async () => {
    vi.mocked(automateVnuGoogleLogin).mockResolvedValue({ studenthub: { accessToken: "sh-token" } });
    const adapter = createUetAdapter();
    const imported = await adapter.importSession(
      { uetGoogleEmail: "a@vnu.edu.vn", uetGooglePassword: "hunter2" },
      { browserBinding: { fetch: vi.fn() } },
    );
    expect(imported.session.studenthub).toBeDefined();
    expect(imported.session.canvas).toBeUndefined();
  });

  it("propagates a HyeboardError thrown by automation (e.g. GOOGLE_2FA_REQUIRED) unchanged", async () => {
    vi.mocked(automateVnuGoogleLogin).mockRejectedValue(new HyeboardError("GOOGLE_2FA_REQUIRED", "2FA required", 401));
    const adapter = createUetAdapter();
    await expect(
      adapter.importSession({ uetGoogleEmail: "a@vnu.edu.vn", uetGooglePassword: "hunter2" }, { browserBinding: { fetch: vi.fn() } }),
    ).rejects.toMatchObject({ code: "GOOGLE_2FA_REQUIRED" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @hyeboard/university-adapters exec vitest run adapter.test.ts`
Expected: FAIL — `importSession` doesn't accept a context param / doesn't know about `uetGoogleEmail`.

- [ ] **Step 3: Implement in `adapter.ts`**

Edit `packages/university-adapters/src/uet/adapter.ts`. Add import:
```ts
import { automateVnuGoogleLogin } from "./google-login-automation";
```

Add a helper near `jwtExpiry` (line ~89):
```ts
function addDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}
```

Replace the `importSession` method body (lines 105-140) with:
```ts
    async importSession(input: LoginImportInput, context?: ImportSessionContext): Promise<ImportedSession> {
      if (input.uetGoogleEmail || input.uetGooglePassword) {
        if (!input.uetGoogleEmail || !input.uetGooglePassword) {
          throw new HyeboardError("MISSING_UPSTREAM_CREDENTIAL", "Provide both your VNU Google email and password.", 400);
        }
        if (!context?.browserBinding) {
          throw new HyeboardError("SERVER_CONFIG_ERROR", "Automated sign-in is not configured on this server.", 500);
        }
        const result = await automateVnuGoogleLogin(context.browserBinding, input.uetGoogleEmail, input.uetGooglePassword);
        const expiresAt = addDays(30);
        const session: EncryptedSessionPayload = {
          version: 1,
          universityId: "uet",
          studentCode: result.studenthub?.accountCode,
          expiresAt,
          uetGoogleCredential: { email: input.uetGoogleEmail, password: input.uetGooglePassword },
          studenthub: result.studenthub ? { kind: "bearer", value: result.studenthub.accessToken, expiresAt: jwtExpiry(result.studenthub.accessToken) ?? expiresAt } : undefined,
          canvas: result.canvas ? { kind: "cookie", value: result.canvas.cookie, csrfToken: result.canvas.csrfToken, expiresAt } : undefined,
        };
        return { universityId: "uet", studentCode: session.studentCode, expiresAt, session };
      }

      if (!input.studenthubGoogleCredential && !input.studenthubToken && !input.studenthubCookie && !input.canvasToken && !input.canvasCookie) {
        throw new HyeboardError("MISSING_UPSTREAM_CREDENTIAL", "Provide a university portal token, portal cookie, learning-platform token, or learning-platform cookie.", 400);
      }
      const googleLogin = input.studenthubGoogleCredential
        ? await new StudentHubClient().exchangeGoogleCredential(input.studenthubGoogleCredential)
        : undefined;
      const studenthubToken = googleLogin?.accessToken ?? input.studenthubToken;
      const studenthubExpiresAt = studenthubToken ? jwtExpiry(studenthubToken) : undefined;
      const expiresAt = studenthubExpiresAt ?? addHours(8);
      const session: EncryptedSessionPayload = {
        version: 1,
        universityId: "uet",
        studentCode: googleLogin?.accountCode ?? input.studentCode,
        expiresAt,
        studenthub: studenthubToken ? { kind: "bearer", value: studenthubToken, expiresAt: studenthubExpiresAt ?? expiresAt } : input.studenthubCookie ? { kind: "cookie", value: input.studenthubCookie, expiresAt } : undefined,
        canvas: input.canvasToken ? { kind: "bearer", value: input.canvasToken, expiresAt } : input.canvasCookie ? { kind: "cookie", value: input.canvasCookie, csrfToken: input.canvasCsrfToken, expiresAt } : undefined,
      };
      if (session.studenthub) {
        try {
          await new StudentHubClient(session).getProfile();
        } catch {
          throw new HyeboardError("INVALID_STUDENTHUB_CREDENTIAL", "The university portal rejected this token or cookie. Copy a fresh token and try again.", 401);
        }
      } else if (session.canvas) {
        try {
          await new CanvasClient(session).getUnreadConversations();
        } catch {
          throw new HyeboardError("INVALID_CANVAS_CREDENTIAL", "The learning platform rejected this token or cookie. Copy a fresh token and try again.", 401);
        }
      }
      return { universityId: "uet", studentCode: session.studentCode, expiresAt, session };
    },
```

Note: the automated-login branch intentionally skips the extra "validate against real upstream" call the manual-paste branch does — automation only reaches the credential-capture step (§4/§5 in Task 4) after actually completing a real login against StudentHub/Canvas, so a captured token/cookie is proof-of-working by construction. Re-validating would spend an extra upstream round-trip for no new information.

Also update the import line at the top to bring in `ImportSessionContext`:
```ts
import type { AdapterRequest, ImportedSession, ImportSessionContext, LoginImportInput, UniversityAdapter } from "../types";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @hyeboard/university-adapters exec vitest run adapter.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Run full package test + typecheck to make sure the manual-paste path is untouched**

Run: `pnpm --filter @hyeboard/university-adapters test`
Expected: PASS (all suites, including `google-login-automation.test.ts` from Task 4)

- [ ] **Step 6: Commit**

```bash
git add packages/university-adapters/src/uet/adapter.ts packages/university-adapters/src/uet/adapter.test.ts
git commit -m "feat(uet): branch importSession on uetGoogleEmail/uetGooglePassword"
```

---

## Task 6: Worker — `BROWSER` binding, schema, rate limiting, wiring

**Files:**
- Modify: `apps/worker/wrangler.jsonc`
- Modify: `apps/worker/worker-configuration.d.ts`
- Modify: `apps/worker/src/index.ts`

- [ ] **Step 1: Add the Browser Rendering binding**

Edit `apps/worker/wrangler.jsonc`:
```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "hyeboard",
  "main": "src/index.ts",
  "compatibility_date": "2026-06-30",
  "observability": {
    "enabled": true,
    "head_sampling_rate": 0.1
  },
  "assets": {
    "directory": "../web/dist",
    "binding": "ASSETS",
    "html_handling": "auto-trailing-slash",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"]
  },
  "browser": {
    "binding": "BROWSER"
  },
  "secrets": {
    "required": ["HYEB_SESSION_SECRET"]
  }
}
```

Deployment note (not a code step — flag to whoever runs `pnpm deploy`): Cloudflare Browser Rendering requires the account to be on a plan that includes it and may need to be enabled once via the dashboard/`wrangler`; `wrangler dev`/`deploy` will error clearly if it isn't available, at which point this is an account-configuration task, not a code fix.

- [ ] **Step 2: Regenerate/update the Env type**

Run: `pnpm --filter @hyeboard/worker exec wrangler types`
Expected: `apps/worker/worker-configuration.d.ts` is regenerated and now includes a `BROWSER: Fetcher;` member on `interface Env`. If `wrangler types` requires an authenticated/linked Cloudflare account and fails in this environment, instead hand-edit the file to add the line, matching wrangler's normal output shape:
```ts
interface Env {
  HYEB_SESSION_SECRET: string;
  HYEB_ALLOWED_ORIGINS?: string;
  BROWSER: Fetcher;
}
```

- [ ] **Step 3: Typecheck to confirm `Fetcher` resolves**

Run: `pnpm --filter @hyeboard/worker typecheck`
Expected: PASS (`Fetcher` comes from `@cloudflare/workers-types`, already in this package's `tsconfig.json` `types` array).

- [ ] **Step 4: Add `uetGoogleEmail`/`uetGooglePassword` to the request schema**

Edit `apps/worker/src/index.ts`, `importSessionBody` (lines 59-69):
```ts
const importSessionBody = t.Object({
  studenthubGoogleCredential: t.Optional(t.String()),
  studenthubToken: t.Optional(t.String()),
  studenthubCookie: t.Optional(t.String()),
  canvasToken: t.Optional(t.String()),
  canvasCookie: t.Optional(t.String()),
  canvasCsrfToken: t.Optional(t.String()),
  vnuUsername: t.Optional(t.String()),
  vnuPassword: t.Optional(t.String()),
  studentCode: t.Optional(t.String()),
  uetGoogleEmail: t.Optional(t.String()),
  uetGooglePassword: t.Optional(t.String()),
});
```

- [ ] **Step 5: Add rate limiting + revocation cache helpers**

Add these functions near the existing `vnuImportCacheKey` (after line 131), reusing the established `hmacHex`/`cacheGet`/`cachePut` pattern:
```ts
// ── Google-login rate limiting + token revocation ───────────────────────

const GOOGLE_LOGIN_RATE_LIMIT = 5;
const GOOGLE_LOGIN_RATE_WINDOW_SECONDS = 15 * 60;

async function googleLoginRateLimitKey(email: string): Promise<string> {
  return `uet/google-login-attempts/${await hmacHex(email.trim().toLowerCase())}`;
}

// Best-effort fixed-window counter via the Cache API (same storage already
// used for vnu's import dedupe). Not perfectly race-free across concurrent
// requests in the same window, which is acceptable for an abuse-reduction
// guardrail, not a hard security boundary.
async function checkAndIncrementGoogleLoginAttempts(email: string): Promise<void> {
  const key = await googleLoginRateLimitKey(email);
  const existing = await cacheGet<{ count: number }>(key);
  const count = (existing?.count ?? 0) + 1;
  if (count > GOOGLE_LOGIN_RATE_LIMIT) {
    throw new HyeboardError("GOOGLE_LOGIN_RATE_LIMITED", "Too many sign-in attempts for this email. Wait 15 minutes and try again, or use the manual token option below.", 429);
  }
  await cachePut(key, { count }, GOOGLE_LOGIN_RATE_WINDOW_SECONDS);
}

async function revokedTokenKey(token: string): Promise<string> {
  return `revoked-token/${await hmacHex(token)}`;
}

async function revokeToken(token: string, expiresAt: string): Promise<void> {
  const ttlSeconds = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
  await cachePut(await revokedTokenKey(token), { revoked: true }, ttlSeconds);
}

async function isTokenRevoked(token: string): Promise<boolean> {
  return Boolean(await cacheGet<{ revoked: true }>(await revokedTokenKey(token)));
}
```

- [ ] **Step 6: Wire rate limiting + `browserBinding` context into the import-session route**

Edit the route (lines 196-212):
```ts
  .post("/api/:universityId/auth/import-session", async ({ params, body }) => {
    const adapter = getAdapter(params.universityId);
    if (params.universityId === "uet" && body.uetGoogleEmail) {
      await checkAndIncrementGoogleLoginAttempts(body.uetGoogleEmail);
      const imported = await adapter.importSession(body, { browserBinding: appEnv().BROWSER });
      const token = await encryptSession(imported.session, getSessionSecret());
      return ok({ token, session: { universityId: imported.universityId, studentCode: imported.studentCode, expiresAt: imported.expiresAt, authenticated: true } });
    }
    if (params.universityId === "vnu" && body.vnuUsername && body.vnuPassword) {
      const cacheKey = await vnuImportCacheKey(body.vnuUsername, body.vnuPassword);
      const cached = await cacheGet<{ token: string; session: { universityId: string; studentCode?: string; expiresAt: string; authenticated: true } }>(cacheKey);
      if (cached && Date.parse(cached.session.expiresAt) > Date.now()) return ok(cached);

      const imported = await adapter.importSession(body);
      const token = await encryptSession(imported.session, getSessionSecret());
      const payload = { token, session: { universityId: imported.universityId, studentCode: imported.studentCode, expiresAt: imported.expiresAt, authenticated: true as const } };
      await cachePut(cacheKey, payload, Math.floor((Date.parse(imported.expiresAt) - Date.now()) / 1000));
      return ok(payload);
    }
    const imported = await adapter.importSession(body);
    const token = await encryptSession(imported.session, getSessionSecret());
    return ok({ token, session: { universityId: imported.universityId, studentCode: imported.studentCode, expiresAt: imported.expiresAt, authenticated: true } });
  }, { body: importSessionBody })
```

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @hyeboard/worker typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add apps/worker/wrangler.jsonc apps/worker/worker-configuration.d.ts apps/worker/src/index.ts
git commit -m "feat(worker): add BROWSER binding, google-login rate limiting, uetGoogle* schema fields"
```

---

## Task 7: `resolveSession()` — lazy silent refresh + `meta.refreshedToken`

**Files:**
- Modify: `apps/worker/src/index.ts`

- [ ] **Step 1: Add `resolveSession()` replacing the group's bare `getSession()` call**

Add this function near `getSession` (after line 30):
```ts
type ResolvedSession = { session: EncryptedSessionPayload; refreshedToken?: string };

// Lazy, per-request refresh (no background jobs/Durable Object alarms — see
// spec's "lazy on next API call" decision). Only uet sessions created via
// automated Google login carry uetGoogleCredential; every other session
// (manual paste, vnu, mock) passes straight through the plain decrypt path
// with the shortcut check below being a cheap no-op.
async function resolveSession(headers: Headers | Record<string, string | undefined>): Promise<ResolvedSession> {
  const h = headers instanceof Headers ? headers : new Headers(headers as Record<string, string>);
  const token = parseBearerToken(h.get("Authorization"));
  if (!token) throw new HyeboardError("MISSING_SESSION", "Missing Authorization bearer token", 401);
  if (await isTokenRevoked(token)) throw new HyeboardError("SESSION_EXPIRED", "Session expired", 401);
  const session = await decryptSession(token, getSessionSecret());

  if (session.universityId !== "uet" || !session.uetGoogleCredential) return { session };
  const studenthubExpiresAt = session.studenthub?.expiresAt;
  if (studenthubExpiresAt && !isExpired(studenthubExpiresAt)) return { session };

  try {
    const adapter = getAdapter("uet");
    const refreshed = await adapter.importSession(
      { uetGoogleEmail: session.uetGoogleCredential.email, uetGooglePassword: session.uetGoogleCredential.password },
      { browserBinding: appEnv().BROWSER },
    );
    const refreshedToken = await encryptSession(refreshed.session, getSessionSecret());
    return { session: refreshed.session, refreshedToken };
  } catch (error) {
    const message = error instanceof HyeboardError ? error.message : "Automatic sign-in refresh failed.";
    throw new HyeboardError("GOOGLE_REFRESH_FAILED", `${message} Sign in again.`, 401);
  }
}
```

Add `isExpired` to the existing `@hyeboard/core` import at the top of the file:
```ts
import { decryptSession, encryptSession, fail, HyeboardError, isExpired, ok, parseBearerToken, type EncryptedSessionPayload } from "@hyeboard/core";
```

- [ ] **Step 2: Replace the authenticated group's `.resolve()` to use it and propagate `refreshedToken`**

Edit the group (lines 221-247):
```ts
  .group("/api/:universityId", (g) =>
    g
      .resolve(async ({ headers, params }) => {
        const { session, refreshedToken } = await resolveSession(headers);
        if (session.universityId !== params.universityId)
          throw new HyeboardError("SESSION_UNIVERSITY_MISMATCH", "Session university does not match route", 403);
        return { session, refreshedToken, adapter: getAdapter(params.universityId) };
      })
      .onAfterHandle(({ response, refreshedToken }) => {
        if (!refreshedToken || !response || typeof response !== "object") return response;
        const typed = response as { data?: unknown; error?: unknown; meta?: Record<string, unknown> };
        if (!("data" in typed)) return response;
        return { ...typed, meta: { ...(typed.meta ?? {}), refreshedToken } };
      })
      .get("/auth/session", ({ session }) => ok({ universityId: session.universityId, studentCode: session.studentCode, expiresAt: session.expiresAt, authenticated: true }))
      .get("/me", async ({ adapter, session }) => ok(await adapter.getStudentProfile({ session })))
      .get("/dashboard", async ({ adapter, session, query }) => ok(await adapter.getDashboard({ session, termCode: query.termCode })), { query: termCodeQuery })
      .get("/terms", async ({ adapter, session }) => ok(await adapter.getTerms({ session })))
      .get("/timetable", async ({ adapter, session, query }) => ok(await adapter.getTimetable({ session, termCode: query.termCode })), { query: termCodeQuery })
      .get("/courses", async ({ adapter, session }) => ok(await adapter.getCourses({ session })))
      .get("/courses/:courseId", async ({ adapter, session, params }) => ok(await adapter.getCourseDetail({ session, courseId: params.courseId })))
      .get("/assignments", async ({ adapter, session }) => ok(await adapter.getAssignments({ session })))
      .get("/grades", async ({ adapter, session }) => ok(await adapter.getGrades({ session })))
      .get("/gpa", async ({ adapter, session }) => ok(await adapter.getGpaSummary({ session })))
      .get("/exams", async ({ adapter, session, query }) => ok(await adapter.getExams({ session, termCode: query.termCode })), { query: termCodeQuery })
      .get("/attendance", async ({ adapter, session }) => ok(await adapter.getAttendance({ session })))
      .get("/notifications", async ({ adapter, session }) => ok(await adapter.getNotifications({ session })))
      .get("/news", async ({ adapter, session }) => ok(await adapter.getNews({ session })))
      .get("/documents", async ({ adapter, session }) => ok(await adapter.getDocuments({ session })))
      .get("/tuition", async ({ adapter, session }) => ok(await adapter.getTuition({ session })))
      .get("/training-points", async ({ adapter, session }) => ok(await adapter.getTrainingPoints({ session })))
      .get("/requests", async ({ adapter, session }) => ok(await adapter.getRequests({ session })))
  )
```

- [ ] **Step 3: Update the standalone `/api/vnu/raw/:page` route to keep using plain `getSession`**

That route (lines 214-218) is vnu-only and never carries `uetGoogleCredential`; leave it calling `getSession(headers)` as-is — no change needed, just confirm it still compiles after the `isExpired` import change.

- [ ] **Step 4: Add revocation to logout**

Edit the logout route (line 213):
```ts
  .post("/api/:universityId/auth/logout", async ({ headers }) => {
    const h = headers instanceof Headers ? headers : new Headers(headers as Record<string, string>);
    const token = parseBearerToken(h.get("Authorization"));
    if (token) {
      try {
        const session = await decryptSession(token, getSessionSecret());
        await revokeToken(token, session.expiresAt);
      } catch {
        // Already invalid/expired token — nothing to revoke.
      }
    }
    return ok({ authenticated: false });
  })
```

Note: this revokes the specific bearer token used to log out, which is the only place `uetGoogleCredential` is ever stored (there is no separate server-side session store — the encrypted token IS the storage). Revoking it makes both the token and the password inside it permanently unusable for `resolveSession()`'s silent refresh, which is what "purge uetGoogleCredential server-side" means in this stateless-token architecture.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @hyeboard/worker typecheck`
Expected: PASS. If Elysia's `.onAfterHandle` typing complains about `refreshedToken` not being known on its context type, confirm the resolved properties from `.resolve()` are merged into `.onAfterHandle`'s context per this Elysia version (`elysia": "^1.4.29"` in `apps/worker/package.json`) — if not, fall back to reading `store` via a `.derive()` instead, or manually add the `meta.refreshedToken` merge inline in each handler instead of via `.onAfterHandle` (more repetitive, but removes any dependency on cross-cutting context propagation working as expected).

- [ ] **Step 6: Manual verification (no unit test framework exists for Elysia routing in this repo — existing convention is manual `wrangler dev` + Playwright only)**

Run: `pnpm --filter @hyeboard/worker dev`
Then in a separate terminal: `curl -s -X POST http://localhost:8787/api/mock/auth/import-session -H "Content-Type: application/json" -d "{}"`
Expected: `{"data":{"token":"...","session":{...}},"error":null}` — confirms the route group still compiles and runs after the `.resolve()`/`.onAfterHandle()` changes (mock adapter never sets `uetGoogleCredential`, so this exercises the pass-through branch of `resolveSession()`).

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/index.ts
git commit -m "feat(worker): lazy silent session refresh via resolveSession() and token revocation on logout"
```

---

## Task 8: `apps/web/src/lib/api.ts` — new fields + transparent token refresh

**Files:**
- Modify: `apps/web/src/lib/api.ts`

- [ ] **Step 1: Extend `importSession`'s body type**

Edit line 144:
```ts
  importSession: async (universityId: string, body: { studentCode?: string; studenthubGoogleCredential?: string; studenthubToken?: string; studenthubCookie?: string; canvasToken?: string; canvasCookie?: string; canvasCsrfToken?: string; vnuUsername?: string; vnuPassword?: string; uetGoogleEmail?: string; uetGooglePassword?: string }) => {
    const data = await request<{ token: string }>(`/api/${universityId}/auth/import-session`, { method: "POST", body: JSON.stringify(body) });
    setSessionToken(data.token);
    return data;
  },
```

- [ ] **Step 2: Adopt `meta.refreshedToken` transparently in the shared `request()` function**

Edit `request()` (lines 41-63):
```ts
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getSessionToken();
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  let payload: ApiResponse<T>;
  try {
    payload = (await response.json()) as ApiResponse<T>;
  } catch {
    throw new ApiError(`Request failed: ${response.status} ${response.statusText}`, undefined, response.status);
  }
  if (!response.ok || payload.error) {
    const code = payload.error?.code;
    if (code ? SESSION_INVALID_CODES.has(code) : response.status === 401) clearSessionToken();
    throw new ApiError(payload.error?.message ?? `Request failed: ${response.status}`, code, response.status);
  }
  const refreshedToken = payload.meta?.refreshedToken;
  if (typeof refreshedToken === "string" && refreshedToken) setSessionToken(refreshedToken);
  return payload.data as T;
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @hyeboard/web typecheck`
Expected: PASS. If `ApiResponse<T>["meta"]` isn't typed as `Record<string, unknown> | undefined` already in `@hyeboard/schemas`, check that type — it already exists as an optional `meta?: Record<string, unknown>` field per `packages/core/src/index.ts`'s `ok()` signature, so no schema change should be needed.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/api.ts
git commit -m "feat(web): support uetGoogle* import fields and transparent session token refresh"
```

---

## Task 9: `LoginPage()` — Google form leads, manual paste stays as fallback

**Files:**
- Modify: `apps/web/src/main.tsx`

- [ ] **Step 1: Add state for the new form and a fallback-reveal flag**

Edit `LoginPage()` (around line 890-902), add:
```tsx
  const [uetGoogleEmail, setUetGoogleEmail] = useState("");
  const [uetGooglePassword, setUetGooglePassword] = useState("");
  const [showManualFallback, setShowManualFallback] = useState(false);
```

- [ ] **Step 2: Add the Google-login submit handler next to `importUetSession`**

Add after `importUetSession` (after line 955):
```tsx
  const AUTOMATION_FAILURE_CODES = new Set(["GOOGLE_CHALLENGE_REQUIRED", "GOOGLE_2FA_REQUIRED", "GOOGLE_AUTOMATION_BLOCKED", "GOOGLE_LOGIN_RATE_LIMITED", "GOOGLE_AUTOMATION_TIMEOUT"]);

  const importUetGoogleSession = async () => {
    setBusy(true);
    setStatus("Signing in with your VNU Google account...");
    try {
      await api.importSession("uet", { uetGoogleEmail: uetGoogleEmail || undefined, uetGooglePassword: uetGooglePassword || undefined });
      state.selectUniversity("uet", { clearSession: false });
      state.refreshSession();
      setStatus("University session ready. Opening dashboard...");
      await navigate({ to: "/" });
    } catch (error) {
      const code = error instanceof ApiError ? error.code : undefined;
      if (code && AUTOMATION_FAILURE_CODES.has(code)) setShowManualFallback(true);
      setStatus(error instanceof Error ? error.message : "Google sign-in did not complete. Try the manual option below.");
    } finally {
      setBusy(false);
    }
  };
```

Add `ApiError` to the existing import from `../lib/api` (check the top of `main.tsx` for the current import line and extend it — do not duplicate the import statement, add `ApiError` to the existing named-import list from `./lib/api`).

- [ ] **Step 3: Rebuild the UET branch of the login card (replace lines 1010-1046)**

```tsx
            {selectedUniversity === "uet" ? (
              <>
                <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
                  <p className="font-medium text-foreground">Sign in with your VNU Google account</p>
                  <p className="mt-1">Hyeboard signs in on a secure server-side browser session using your email and password, then connects both the university portal and the learning platform automatically. Your password is encrypted and stored only to keep you signed in — you can remove it anytime by signing out.</p>
                </div>
                <Input type="email" autoComplete="username" placeholder="you@vnu.edu.vn" value={uetGoogleEmail} onChange={(event) => setUetGoogleEmail(event.target.value)} onKeyDown={(event) => submitOnEnter(event, importUetGoogleSession)} />
                <Input type="password" autoComplete="current-password" placeholder="Google account password" value={uetGooglePassword} onChange={(event) => setUetGooglePassword(event.target.value)} onKeyDown={(event) => submitOnEnter(event, importUetGoogleSession)} />
                <Button onClick={importUetGoogleSession} disabled={busy} className="w-full">Sign in with Google</Button>

                {!showManualFallback ? (
                  <button type="button" className="w-full text-center text-xs text-muted-foreground underline underline-offset-2" onClick={() => setShowManualFallback(true)}>
                    Having trouble? Use a manual token instead
                  </button>
                ) : (
                  <>
                    <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
                      <p className="font-medium text-foreground">Connect your university portal manually</p>
                      <ol className="mt-2 list-decimal space-y-1 pl-4">
                        <li>Open the university portal and sign in with your university account.</li>
                        <li>Open the browser console on the portal.</li>
                        <li>Run <code className="select-all rounded bg-background px-1 text-foreground">copy(localStorage.getItem(&apos;accessToken&apos;))</code>.</li>
                        <li>Paste the copied token below.</li>
                      </ol>
                    </div>
                    <Button className="w-full" type="button" variant="secondary" onClick={() => window.open("https://studenthub.uet.edu.vn", "_blank", "noopener,noreferrer")}><ExternalLink size={16} /> Open university portal</Button>
                    <Input type="password" autoComplete="off" placeholder="University portal access token" value={studenthubToken} onChange={(event) => setStudenthubToken(event.target.value)} onKeyDown={(event) => submitOnEnter(event, importUetSession)} />
                    <Button className="w-full" type="button" variant="secondary" onClick={() => window.open("https://portal.uet.vnu.edu.vn", "_blank", "noopener,noreferrer")}><ExternalLink size={16} /> Open learning platform</Button>
                    <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
                      <p className="font-medium text-foreground">Optional: connect the learning platform</p>
                      <ol className="mt-2 list-decimal space-y-1 pl-4">
                        <li>Open the learning platform. It should sign in with your existing university account.</li>
                        <li>Open <strong className="text-foreground">Account</strong> (bottom-left) → <strong className="text-foreground">Settings</strong>.</li>
                        <li>Scroll to <strong className="text-foreground">Approved Integrations</strong> → click <strong className="text-foreground">+ New Access Token</strong> → Generate Token.</li>
                        <li>Copy the token shown once and paste it below.</li>
                      </ol>
                    </div>
                    <Input type="password" autoComplete="off" placeholder="Learning platform access token" value={canvasToken} onChange={(event) => { setCanvasToken(event.target.value); setSessionStored(RELOGIN_KEYS.uetCanvasToken, event.target.value); }} onKeyDown={(event) => submitOnEnter(event, importUetSession)} />
                    <details className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
                      <summary className="cursor-pointer font-medium text-foreground">Advanced cookie options</summary>
                      <div className="mt-3 space-y-3">
                        <Input type="password" autoComplete="off" placeholder="University portal cookie, if token import is unavailable" value={studenthubCookie} onChange={(event) => setStudenthubCookie(event.target.value)} onKeyDown={(event) => submitOnEnter(event, importUetSession)} />
                        <Input type="password" autoComplete="off" placeholder="Learning platform cookie, if access tokens are disabled" value={canvasCookie} onChange={(event) => setCanvasCookie(event.target.value)} onKeyDown={(event) => submitOnEnter(event, importUetSession)} />
                        <Input type="password" autoComplete="off" placeholder="Learning platform CSRF token, only when using cookie mode" value={canvasCsrfToken} onChange={(event) => setCanvasCsrfToken(event.target.value)} onKeyDown={(event) => submitOnEnter(event, importUetSession)} />
                      </div>
                    </details>
                    <Button onClick={importUetSession} disabled={busy} variant="outline" className="w-full">Import university session</Button>
                  </>
                )}
              </>
            ) : selectedUniversity === "vnu" ? (
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @hyeboard/web typecheck`
Expected: PASS

- [ ] **Step 5: Manual visual check**

Run: `pnpm dev` (repo root), open `http://localhost:5173/login`, select "VNU-UET".
Expected: Google email/password form renders first, "Having trouble? Use a manual token instead" link reveals the old manual form when clicked, both forms are usable (submitting the Google form against a dev worker without `BROWSER` configured should surface a clear `SERVER_CONFIG_ERROR` status message rather than crashing the page).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/main.tsx
git commit -m "feat(web): lead UET login with Google sign-in, keep manual paste as fallback"
```

---

## Task 10: Logout purges the persisted Google credential client-side too

**Files:**
- Modify: `apps/web/src/main.tsx` (or wherever `state.logout()` is defined — check `useHyeboard`'s implementation first)

- [ ] **Step 1: Locate the logout implementation**

Run: `rg "function logout|logout:" apps/web/src -n` (or use Grep tool) to find where `state.logout()` is defined (referenced at `SettingsPage()` line 1071: `state.logout()`).

- [ ] **Step 2: Confirm it calls the `/auth/logout` endpoint before clearing the local token**

If `state.logout()` currently only calls `clearSessionToken()` locally without hitting `POST /api/:universityId/auth/logout`, add that call (using the current university id and the token about to be cleared) so Task 7's server-side revocation actually runs. Read the surrounding hook code before editing — do not guess the exact call site; this step requires reading the real implementation first, since it lives outside the range already read in this plan's research (`apps/web/src/main.tsx` above line 890 or a separate hooks file).

- [ ] **Step 3: Typecheck + manual check**

Run: `pnpm --filter @hyeboard/web typecheck`, then manually sign in with the mock adapter, sign out, and confirm no console errors.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "fix(web): call server-side logout endpoint so uetGoogleCredential is revoked"
```

---

## Task 11: Playwright smoke-spec coverage

**Files:**
- Modify: `apps/web/tests/smoke.spec.ts`

- [ ] **Step 1: Read the existing login-related smoke tests first**

Read `apps/web/tests/smoke.spec.ts` in full before editing — this plan does not have its exact current contents in context; find the existing login-page test(s) (per `AGENTS.md`: "login-gate redirect, login school-picker sections... demo login") and follow their established Playwright patterns (selectors, `test.describe` grouping, any test fixtures/helpers already defined in that file).

- [ ] **Step 2: Add a case for the Google form rendering + falling back to manual paste**

Using this file's existing conventions, add a test that: selects "VNU-UET" in the school picker, asserts the email+password inputs and "Sign in with Google" button are visible, asserts the manual-paste form is NOT visible by default, clicks "Having trouble? Use a manual token instead", and asserts the manual-paste inputs (portal token, learning-platform token) become visible. Do not attempt to simulate an actual failed `import-session` network response unless the existing smoke-spec file already has an established pattern for mocking/intercepting API responses (e.g. `page.route`) — if it does, follow that pattern to also cover the failure→fallback-reveal path from Task 9's `AUTOMATION_FAILURE_CODES` handling; if no such pattern exists yet in this file, keep the test to the toggle-visibility assertion above and note the network-failure path as covered by Task 9's manual check instead.

- [ ] **Step 3: Run it**

Run: `pnpm --filter @hyeboard/web exec playwright test -g "uet"` (adjust the grep string to match whatever test name/description you gave it)
Expected: PASS

- [ ] **Step 4: Run the full smoke suite to confirm nothing else regressed**

Run: `pnpm --filter @hyeboard/web exec playwright test`
Expected: PASS (all existing cases + the new one)

- [ ] **Step 5: Commit**

```bash
git add apps/web/tests/smoke.spec.ts
git commit -m "test(web): cover UET Google login form and manual-fallback toggle"
```

---

## Task 12: Mandatory live verification against the real sites

This task cannot be automated or unit-tested (per spec's Testing section — no HAR captured the GSI popup or Keycloak/SAML DOM, and Google's abuse detection makes CI-based verification unsafe). It must be done by a human/agent with access to a real `@vnu.edu.vn` test account, run against a real `wrangler dev` (or a deployed preview) with the `BROWSER` binding actually available.

- [ ] **Step 1: Deploy or run locally with Browser Rendering enabled**

Run: `pnpm --filter @hyeboard/worker dev` (Browser Rendering bindings work in local `wrangler dev` via Cloudflare's remote proxy — confirm this is the case for the account in use; if not, use `pnpm --filter @hyeboard/worker exec wrangler deploy --dry-run` first, then a real preview deploy).

- [ ] **Step 2: Submit a real `@vnu.edu.vn` email + password through the login form (Task 9's UI)**

Watch the worker logs (`console.error`/`console.warn` from `routeError`) for any thrown `HyeboardError` from `automateVnuGoogleLogin`.

- [ ] **Step 3: Fix selectors in `google-login-automation.ts` against what's actually observed**

Every `NEEDS LIVE VERIFICATION` comment in Task 4's `runFlow()` is a candidate for a wrong selector or wrong assumption (e.g. GSI opening a popup instead of navigating in-page, StudentHub's JWT living somewhere other than `localStorage.accessToken`, Canvas's SSO entry URL being different from `/login/saml`). Update the selectors/logic to match reality. If GSI turns out to open a popup, replace the `page.click(...)` + same-page `waitForNavigation` sequence with a `browser.on("targetcreated")` listener that grabs the new page and drives that instead — do not fake a fix, get this working against the real flow.

- [ ] **Step 4: Re-run Task 4's unit tests to confirm the pure helpers weren't broken by the fix**

Run: `pnpm --filter @hyeboard/university-adapters exec vitest run google-login-automation.test.ts`
Expected: PASS

- [ ] **Step 5: Confirm the full combined flow end-to-end**

Confirm: StudentHub dashboard data loads (`GET /api/uet/dashboard` returns real data), AND Canvas-backed features load (`GET /api/uet/courses` returns real data) from the single email+password submission, per the spec's "single browser session, get both" requirement.

- [ ] **Step 6: Confirm a 2FA-enabled test account (if available) fails cleanly**

If a second test account with 2FA enabled is available, confirm it produces `GOOGLE_2FA_REQUIRED` and the frontend reveals the manual-paste fallback rather than hanging or crashing.

- [ ] **Step 7: Commit any selector fixes from this task**

```bash
git add packages/university-adapters/src/uet/google-login-automation.ts
git commit -m "fix(uet): correct Google/Canvas automation selectors verified against live sites"
```

---

## Task 13: Full repo verification

- [ ] **Step 1: Full build**

Run: `pnpm build`
Expected: PASS (both `build:web` and `build:worker`)

- [ ] **Step 2: Full typecheck/test across all packages**

Run: `pnpm test`
Expected: PASS (`tsc --noEmit` in every package, plus the new Vitest suites in `@hyeboard/core` and `@hyeboard/university-adapters`)

- [ ] **Step 3: Full Playwright suite**

Run: `pnpm --filter @hyeboard/web exec playwright test`
Expected: PASS

- [ ] **Step 4: Dry-run deploy check**

Run: `pnpm --filter @hyeboard/worker exec wrangler deploy --dry-run`
Expected: PASS, and confirms the `browser` binding in `wrangler.jsonc` is accepted by wrangler's config validation.

- [ ] **Step 5: `git status --short` review before considering this done**

Run: `git status --short`
Expected: clean working tree (everything already committed task-by-task above), no stray `.har`/`.env`/build-artifact files staged at any point per `AGENTS.md`'s git hygiene rules.
</content>
