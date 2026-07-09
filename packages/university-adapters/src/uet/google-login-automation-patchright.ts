import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "patchright";
import { getLogger, HyeboardError, type GoogleSessionCookie } from "@hyeboard/core";
import {
  CANVAS_SSO_URL,
  detectChallenge,
  HARD_TIMEOUT_MS,
  isRehydratableGoogleCookie,
  isStudenthubMaintenance,
  serializeCookies,
  STUDENTHUB_LOGIN_URL,
  type GoogleLoginResult,
} from "./google-login-automation";

// Patchright (github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs) is a
// patched Playwright fork that avoids common CDP-based automation
// fingerprints (Runtime.enable/Console.enable leaks, --enable-automation
// and related launch flags). It is a Node-only, Chromium-only library with
// no Cloudflare Workers equivalent, so it is ONLY used for the "local"
// BrowserConnection kind (self-hosted deployments that launch their own
// Chrome). The "cloudflare" and "self-hosted" (external CDP endpoint)
// connection kinds keep using @cloudflare/puppeteer / puppeteer-core
// unchanged — see google-login-automation.ts's runFlow() for that path.
// Most of Patchright's stealth benefit comes from HOW the browser is
// launched (flags, avoiding certain CDP calls at startup); since we don't
// control the launch for an external CDP endpoint, applying it only to
// "local" is where it can actually help.
//
// This is a parallel re-implementation of runFlow()'s VNU-specific
// automation logic (StudentHub → Google → VNU Keycloak IDP → Canvas SSO)
// ported from Puppeteer's API to Playwright's. The underlying site
// behavior (selectors, the Gmail dead-end redirect, the close+reopen
// recovery, cookie rehydration) is unchanged and was confirmed live against
// Puppeteer — this Playwright port has NOT itself been exercised against a
// real account; treat it as unverified until tested live.

// Process-local cache of live Patchright persistent contexts, keyed by
// Google account email, so a session refresh (see resolveSession() in
// apps/worker/src/app.ts) can reuse an already-authenticated browser
// context instead of always launching a brand-new Chrome process and
// profile directory. Mirrors the Puppeteer path's browserSessionCache in
// google-login-automation.ts, adapted for Playwright/Patchright's model
// where the persistent context IS the browser instance (there's no
// separate Browser handle to reconnect to later) — so the cached unit here
// is the context plus its temp userDataDir, both torn down together.
type CachedPatchrightSession = { context: BrowserContext; userDataDir: string; lastUsedAt: number; closed: boolean };
const patchrightSessionCache = new Map<string, CachedPatchrightSession>();
// Same value/reasoning as google-login-automation.ts's IDLE_EVICTION_MS
// (see that file's comment for the full explanation of why this must
// outlive the realistic login→refresh gap, not just be "housekeeping"),
// duplicated locally since these are separate modules with no shared
// export for it. Both read the same HYEB_BROWSER_IDLE_EVICTION_MS env var
// so a single config value governs whichever automation path is active.
const DEFAULT_IDLE_EVICTION_MS = 14 * 24 * 60 * 60_000;
const IDLE_EVICTION_MS = Number(process.env.HYEB_BROWSER_IDLE_EVICTION_MS) > 0 ? Number(process.env.HYEB_BROWSER_IDLE_EVICTION_MS) : DEFAULT_IDLE_EVICTION_MS;

// Failure codes that mean a fresh context/login attempt would fail
// identically — not a symptom of a stale/broken cached context. Retrying
// these once with a fresh context (as the generic reusingCache-eviction
// path below does for all other errors) only doubles the wall-clock cost
// of a doomed call (HARD_TIMEOUT_MS both times) before surfacing the same
// error anyway.
const NON_STALE_CACHE_ERROR_CODES = new Set(["STUDENTHUB_MAINTENANCE", "GOOGLE_2FA_REQUIRED", "GOOGLE_CHALLENGE_REQUIRED", "GOOGLE_AUTOMATION_BLOCKED"]);

function cacheKeyFor(email: string): string {
  // Patchright is only ever invoked for the "local" BrowserConnection kind
  // (see automateVnuGoogleLogin's dispatch check in
  // google-login-automation.ts: connection.kind === "local" &&
  // HYEB_BROWSER_PATCHRIGHT === "true" && patchrightLauncher), so unlike
  // the Puppeteer cache there's no Cloudflare-kind exclusion needed here.
  return email.trim().toLowerCase();
}

async function evictCachedSession(key: string): Promise<void> {
  const cached = patchrightSessionCache.get(key);
  if (!cached) return;
  patchrightSessionCache.delete(key);
  await cached.context.close().catch(() => undefined);
  rmSync(cached.userDataDir, { recursive: true, force: true });
}

async function evictStaleIfIdle(key: string): Promise<void> {
  const cached = patchrightSessionCache.get(key);
  if (cached && Date.now() - cached.lastUsedAt > IDLE_EVICTION_MS) {
    await evictCachedSession(key);
  }
}

// Exported for apps/worker/src/start.ts's shutdown handler (via the
// setPatchrightCloseHandler indirection registered in index.node.ts) to
// close every cached Patchright context + delete its temp profile dir on
// SIGINT/SIGTERM, so a restart/redeploy doesn't leak orphaned Chrome
// processes or temp directories.
export async function closeCachedPatchrightSessions(): Promise<void> {
  const sessions = [...patchrightSessionCache.values()];
  patchrightSessionCache.clear();
  await Promise.all(
    sessions.map(async (s) => {
      await s.context.close().catch(() => undefined);
      rmSync(s.userDataDir, { recursive: true, force: true });
    }),
  );
}

async function launchPatchrightContext(headless: boolean): Promise<{ context: BrowserContext; userDataDir: string }> {
  // Best-practice Patchright launch (see README "Best Practice" section):
  // a persistent context with the real "chrome" channel, no injected
  // viewport/userAgent overrides, avoids the fingerprint-injection path
  // that's easier to detect than just launching real Chrome.
  // launchPersistentContext requires a real userDataDir (an empty string
  // is invalid) — use a fresh temp directory, cleaned up alongside
  // context.close() whenever this context is evicted/closed.
  const userDataDir = mkdtempSync(join(tmpdir(), "hyeboard-patchright-"));
  // channel and executablePath are mutually exclusive in Playwright's
  // launch API — passing both (as an earlier version of this file did,
  // copied from the Puppeteer flow where executablePath is the only
  // selector) was confirmed live to hang launchPersistentContext
  // indefinitely (180s timeout, Chrome process alive but the CDP
  // handshake over --remote-debugging-pipe never completing). Prefer
  // HYEB_CHROME_PATH (explicit override) when set; otherwise fall back to
  // Patchright's recommended real "chrome" channel.
  // Diagnostic escape hatch: HYEB_BROWSER_PATCHRIGHT_CHROMIUM=true skips
  // both HYEB_CHROME_PATH and the real "chrome" channel entirely, using
  // Patchright's own bundled Chromium instead (requires `npx patchright
  // install chromium` first). Use this to isolate whether a launch hang
  // is specific to the real installed Chrome binary + its interaction
  // with Patchright's --remote-debugging-pipe CDP handshake (observed
  // live: launchPersistentContext hanging the full 180s default timeout
  // with real Chrome on Windows, Chrome process alive the whole time)
  // versus a more general Patchright/environment issue.
  const useBundledChromium = process.env.HYEB_BROWSER_PATCHRIGHT_CHROMIUM === "true";
  const chromePath = process.env.HYEB_CHROME_PATH;
  const context = await chromium.launchPersistentContext(userDataDir, {
    ...(useBundledChromium ? {} : chromePath ? { executablePath: chromePath } : { channel: "chrome" }),
    headless,
    viewport: null,
    args: ["--no-sandbox"],
    timeout: 60_000,
  });
  return { context, userDataDir };
}

export async function automateVnuGoogleLoginPatchright(
  headless: boolean,
  email: string,
  password: string,
  existingCookies?: GoogleSessionCookie[],
  onProgress?: (message: string) => void,
): Promise<GoogleLoginResult> {
  const log = getLogger();
  const key = cacheKeyFor(email);
  await evictStaleIfIdle(key);

  for (let attempt = 0; attempt < 2; attempt++) {
    const result: GoogleLoginResult = {};
    const cached = patchrightSessionCache.get(key);
    const reusingCache = Boolean(cached && !cached.closed);
    log.debug({ connectionKind: "local-patchright", email, reusingCache, attempt }, "automateVnuGoogleLoginPatchright: starting");

    let context: BrowserContext;
    let userDataDir: string;
    if (reusingCache && cached) {
      context = cached.context;
      userDataDir = cached.userDataDir;
      log.debug("automateVnuGoogleLoginPatchright: reusing cached browser context");
    } else {
      const launched = await launchPatchrightContext(headless);
      context = launched.context;
      userDataDir = launched.userDataDir;
      log.debug("automateVnuGoogleLoginPatchright: browser context acquired");
    }

    let timeoutId: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new HyeboardError("GOOGLE_AUTOMATION_TIMEOUT", "The automated sign-in took too long and was cancelled.", 504)), HARD_TIMEOUT_MS);
    });
    try {
      try {
        await Promise.race([runFlow(context, email, password, result, existingCookies, onProgress), timeout]);
      } finally {
        clearTimeout(timeoutId!);
      }
    } catch (error) {
      // Hard failures whose cause has nothing to do with a stale/broken
      // cached context — a fresh context will hit the exact same failure,
      // so retrying just wastes another ~90s HARD_TIMEOUT_MS window (this
      // was previously always retried once on any error when reusingCache,
      // which could double the wall-clock time of a doomed refresh call
      // before finally surfacing an error).
      const isNonRetryableFailure = error instanceof HyeboardError && NON_STALE_CACHE_ERROR_CODES.has(error.code);
      if (reusingCache && !isNonRetryableFailure) {
        // The cached context is stale/broken — evict it and retry once
        // with a freshly launched context, so a broken cached session
        // never surfaces as a caller-visible error.
        log.debug({ err: error }, "automateVnuGoogleLoginPatchright: cached context failed, evicting and retrying fresh");
        await evictCachedSession(key);
        continue;
      }
      if (reusingCache) await evictCachedSession(key);
      else {
        await context.close().catch(() => undefined);
        rmSync(userDataDir, { recursive: true, force: true });
      }
      if (error instanceof HyeboardError) throw error;
      log.error({ err: error }, "automateVnuGoogleLoginPatchright: unexpected error");
      // Carry the real underlying error message through instead of a fully
      // generic "Google blocked" message — see the Puppeteer flow's
      // equivalent comment. GOOGLE_AUTOMATION_BLOCKED is reserved for
      // detectChallenge()'s output (Google's own UI actually blocking the
      // sign-in) — this is a different situation: an unexpected exception
      // in our own automation.
      const reason = error instanceof Error ? error.message : String(error);
      throw new HyeboardError("GOOGLE_SIGNIN_FAILURE", `Google sign-in automation failed: ${reason}`, 502, { originalMessage: reason, originalName: error instanceof Error ? error.name : undefined });
    }

    log.debug({ hasStudenthub: Boolean(result.studenthub), hasCanvas: Boolean(result.canvas) }, "automateVnuGoogleLoginPatchright: finished");
    if (!result.studenthub && !result.canvas) {
      if (reusingCache) {
        log.debug("automateVnuGoogleLoginPatchright: cached context produced no session, evicting and retrying fresh");
        await evictCachedSession(key);
        continue;
      }
      await context.close().catch(() => undefined);
      rmSync(userDataDir, { recursive: true, force: true });
      throw new HyeboardError("GOOGLE_SIGNIN_FAILURE", "Google did not complete the sign-in. Check your email and password, or use the manual token option below.", 502);
    }

    // Success — keep the context alive in the cache instead of closing it,
    // so the next refresh call can reuse it. Register a "close" listener
    // the first time a fresh context is cached, to track liveness across
    // reuse attempts (Playwright's BrowserContext extends EventEmitter and
    // emits "close"; there's no simple .connected-style getter the way
    // Puppeteer's Browser has, hence the explicit flag + listener).
    const entry: CachedPatchrightSession = cached ?? { context, userDataDir, lastUsedAt: Date.now(), closed: false };
    entry.lastUsedAt = Date.now();
    entry.closed = false;
    if (!cached) {
      context.once("close", () => {
        entry.closed = true;
      });
    }
    patchrightSessionCache.set(key, entry);
    return result;
  }

  // Unreachable in practice (the loop above always returns or throws), but
  // keeps TypeScript's control-flow analysis happy.
  throw new HyeboardError("GOOGLE_SIGNIN_FAILURE", "Google did not complete the sign-in. Check your email and password, or use the manual token option below.", 502);
}

// Waits for a new popup Page to open as a result of the given action, then
// waits for it to settle on its first real URL (Playwright's "popup" event
// fires as soon as the page target exists, often still on about:blank
// mid-redirect through Google's OAuth handshake).
async function clickGoogleButtonAndWaitForPopup(page: Page): Promise<Page> {
  const [popup] = await Promise.all([
    page.waitForEvent("popup", { timeout: 10_000 }),
    page.getByRole("link", { name: "Đăng nhập với VNU mail" }).click({ timeout: 10_000 }).catch(() =>
      page.getByText("Đăng nhập với VNU mail").click({ timeout: 10_000 }),
    ),
  ]);
  await popup.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
  await popup.bringToFront().catch(() => undefined);
  return popup;
}

// Outer wrapper: owns the page (tab) lifecycle only. The context itself may
// now be kept alive across multiple calls (see the cache in
// automateVnuGoogleLoginPatchright above), so only the page/tab used for
// this particular call is closed here, never the whole context.
async function runFlow(
  context: BrowserContext,
  email: string,
  password: string,
  result: GoogleLoginResult,
  existingCookies?: GoogleSessionCookie[],
  onProgress?: (message: string) => void,
): Promise<void> {
  // launchPersistentContext opens with one blank tab already visible
  // (headless: false shows this immediately) — reuse it instead of opening
  // a second tab that context.newPage() would create, which is why the
  // visible browser window was previously stuck showing an untouched
  // about:blank tab while the real navigation happened in a background
  // tab the user never saw. On a cache-reuse call, the previous call's
  // page was already closed below, so context.pages()[0] will be
  // undefined and context.newPage() runs instead — this line works
  // unchanged for both the first (fresh-launch) and subsequent
  // (cache-reuse) calls.
  const page = context.pages()[0] ?? (await context.newPage());
  try {
    await runFlowBody(context, page, email, password, result, existingCookies, onProgress);
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function runFlowBody(
  context: BrowserContext,
  page: Page,
  email: string,
  password: string,
  result: GoogleLoginResult,
  existingCookies: GoogleSessionCookie[] | undefined,
  onProgress?: (message: string) => void,
): Promise<void> {
  const report = (message: string) => onProgress?.(message);
  const log = getLogger();
  await page.bringToFront().catch(() => undefined);
  let studenthubToken: string | null = null;

  // 0. Rehydrate a previously-captured Google/VNU-IDP session cookie (if
  // any). context.addCookies applies at the context/cookie-jar level, so
  // it also covers the popup opened in step 1 below (same context).
  // Best-effort: if the cookie is stale, the flow below simply falls
  // through to the normal interactive email/password/Keycloak steps.
  // Filtered to Google/IDP cookies only — existingCookies may also contain
  // StudentHub/Canvas cookies now that capture is broad (see
  // isRehydratableGoogleCookie's comment in google-login-automation.ts).
  const rehydratableCookies = existingCookies?.filter((c) => isRehydratableGoogleCookie(c.domain)) ?? [];
  if (rehydratableCookies.length) {
    await context
      .addCookies(
        rehydratableCookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expires,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite,
        })),
      )
      .catch(() => undefined);
  }

  // 1. StudentHub → Google sign-in popup. "networkidle" is avoided
  // throughout this file (per Playwright's own guidance) — StudentHub/
  // Google/Canvas are all persistent-connection SPAs that may never go
  // fully network-idle, and this was one of two confirmed live hangs
  // (the other being launchPersistentContext itself) where the wait
  // never resolved. "domcontentloaded" plus an explicit timeout on every
  // wait below is used instead, so a genuinely stuck step surfaces as a
  // clear timeout error rather than an indefinite hang.
  report("Opening StudentHub...");
  log.debug({ url: STUDENTHUB_LOGIN_URL }, "runFlow(patchright): navigating to StudentHub login");
  await page.goto(STUDENTHUB_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 20_000 });
  if (isStudenthubMaintenance(page.url())) {
    throw new HyeboardError("STUDENTHUB_MAINTENANCE", "StudentHub is currently under maintenance. Please try again later.", 503);
  }

  // On a reused cached context (see the persistent-context cache in
  // automateVnuGoogleLoginPatchright above), a stale StudentHub
  // localStorage.accessToken from the PREVIOUS call can still be present
  // in the profile even though the server has since expired it — this
  // makes StudentHub's SPA render its authenticated dashboard instead of
  // the "Đăng nhập với VNU mail" button, so clickGoogleButtonAndWaitForPopup
  // below would wait 10s for a popup that never opens (this was the
  // primary confirmed cause of "refresh triggers full re-login every
  // time" style failures on the reuse path). Detect that and force a
  // clean, logged-out reload before proceeding.
  const googleSignInButtonVisible = await page
    .getByRole("link", { name: "Đăng nhập với VNU mail" })
    .isVisible({ timeout: 3_000 })
    .catch(() => false);
  if (!googleSignInButtonVisible) {
    log.debug("runFlow(patchright): sign-in button not visible on a reused context — clearing stale localStorage and reloading");
    await page.evaluate(() => window.localStorage.clear()).catch(() => undefined);
    await page.goto(STUDENTHUB_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 20_000 });
    if (isStudenthubMaintenance(page.url())) {
      throw new HyeboardError("STUDENTHUB_MAINTENANCE", "StudentHub is currently under maintenance. Please try again later.", 503);
    }
  }

  log.debug("runFlow(patchright): StudentHub login page loaded, clicking Google sign-in button");
  report("Signing in with Google...");
  let popup = await clickGoogleButtonAndWaitForPopup(page);
  log.debug({ popupUrl: popup.url() }, "runFlow(patchright): Google sign-in popup opened");

  const checkPopupChallenge = async (p: Page) => {
    const challenge = detectChallenge(p.url(), await p.evaluate(() => document.body.innerText).catch(() => ""));
    if (challenge) throw new HyeboardError(challenge, "Google requires additional verification that cannot be completed automatically.", 401);
  };

  // 1b. Opportunistic fast path: give a rehydrated-cookie popup a brief
  // window to auto-close (OAuth completed silently). Ported from the
  // Puppeteer flow where this was observed to essentially never happen in
  // practice (the account chooser is shown instead, handled by step 2b) —
  // kept cheap and non-blocking regardless.
  let silentCookieLogin = false;
  if (rehydratableCookies.length) {
    log.debug("runFlow(patchright): attempting silent cookie-based login");
    silentCookieLogin = await popup
      .waitForEvent("close", { timeout: 1_500 })
      .then(() => true)
      .catch(() => false);
    log.debug({ silentCookieLogin }, "runFlow(patchright): silent cookie-based login attempt finished");
  }

  if (!silentCookieLogin) {
    // 2. Google account chooser — pick "use another account" if present,
    // otherwise fall through to the email step.
    const useAnotherAccount = popup.getByRole("link", { name: "Sử dụng tài khoản khác" });
    if (await useAnotherAccount.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await useAnotherAccount.click().catch(() => undefined);
      await popup.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
    }

    // 2b. If a logged-in account tile is shown (cookie rehydration worked
    // enough to reach the chooser), click it instead of typing the email.
    const accountTileLocator = popup.locator(`div[data-identifier="${email}"]`).or(popup.getByText(email));
    if (await accountTileLocator.first().isVisible({ timeout: 3_000 }).catch(() => false)) {
      await accountTileLocator.first().click().catch(() => undefined);
      await popup.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
      if (popup.isClosed()) {
        silentCookieLogin = true;
      } else {
        // The initial navigation can resolve on a Google interstitial
        // before the Google→Keycloak SAML redirect (a second navigation)
        // even starts — wait once more for the chain to settle.
        await popup.waitForLoadState("domcontentloaded", { timeout: 8_000 }).catch(() => undefined);
        if (popup.isClosed()) silentCookieLogin = true;
      }
    }
  }

  if (!silentCookieLogin) {
    // 3. Google email step — skipped if step 2b already landed on Keycloak
    // (rehydrated Keycloak cookie was expired/revoked).
    const alreadyOnKeycloak = /idp\.vnu\.edu\.vn/.test(popup.url());

    if (!alreadyOnKeycloak) {
      const emailInput = popup.locator('input[type="email"], input#identifierId');
      await emailInput.waitFor({ timeout: 15_000 });
      await emailInput.pressSequentially(email, { delay: 20 });
      await popup.locator("#identifierNext").click({ timeout: 10_000 });
      await popup.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
      await checkPopupChallenge(popup);
    }

    // 4. VNU-domain accounts federate to VNU's own Keycloak IDP
    // (idp.vnu.edu.vn/auth/realms/vnu/login-actions/authenticate) with
    // #username/#password/#rememberMe inputs and a #kc-login submit
    // button. Submitting completes SSO federation, but the page's own
    // client-side script then forcibly does location.replace to
    // mail.google.com — a dead end, not an error. Recovery: close the
    // popup and click "Đăng nhập với VNU mail" again; the Google session
    // cookie from the just-completed federation makes the second popup
    // skip straight to account selection.
    if (alreadyOnKeycloak || /idp\.vnu\.edu\.vn/.test(popup.url())) {
      report("Completing VNU sign-in...");
      const keycloakUsername = email.includes("@") ? email.slice(0, email.indexOf("@")) : email;
      await popup.locator("#username").waitFor({ timeout: 5_000 });
      await popup.locator("#username").pressSequentially(keycloakUsername, { delay: 20 });
      await popup.locator("#password").pressSequentially(password, { delay: 20 });

      const rememberMe = popup.locator("#rememberMe");
      if (await rememberMe.isVisible({ timeout: 2_000 }).catch(() => false)) {
        if (!(await rememberMe.isChecked().catch(() => false))) await rememberMe.click().catch(() => undefined);
      }
      await popup.locator("#kc-login").click();
      await popup.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);

      // Google can show a "verify it's you" interstitial with a
      // "Continue" button before the VNU page's own script forces the
      // mail.google.com redirect. Click through it if present.
      const verifyContinue = popup.getByRole("button", { name: "Continue" }).or(popup.getByRole("button", { name: "Tiếp tục" }));
      if (await verifyContinue.first().isVisible({ timeout: 5_000 }).catch(() => false)) {
        log.debug("runFlow(patchright): clicking 'verify it's you' Continue interstitial");
        await verifyContinue.first().click().catch(() => undefined);
        await popup.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
      }

      if (popup.isClosed()) {
        log.debug("runFlow(patchright): popup closed itself after Keycloak login (OAuth completed directly)");
      } else {
        await popup.close().catch(() => undefined);
        // A short cool-down before retrying — the Google session cookie
        // from the just-completed federation isn't reliably available to
        // the next OAuth request immediately (confirmed in the Puppeteer
        // flow; assumed to still apply here).
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        popup = await clickGoogleButtonAndWaitForPopup(page);
        await checkPopupChallenge(popup);
        const accountTile = popup.locator(`div[data-identifier="${email}"]`).or(popup.getByText(email));
        if (await accountTile.first().isVisible({ timeout: 8_000 }).catch(() => false)) {
          await accountTile.first().click().catch(() => undefined);
          // Must wait for the popup's navigation (Google OAuth consent
          // page) before polling the opener — the postMessage that
          // delivers the credential to StudentHub only fires after this.
          await popup.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
          for (let attempt = 0; attempt < 20; attempt++) {
            await new Promise((r) => setTimeout(r, 500));
            if (studenthubToken || popup.isClosed()) break;
            studenthubToken = await page.evaluate(() => window.localStorage.getItem("accessToken")).catch(() => null);
          }
        }
      }
    } else {
      // @vnu.edu.vn accounts are always federated to VNU's own Keycloak
      // IDP — there is no legitimate path where Google shows its own
      // password page for these accounts. See the Puppeteer flow's
      // equivalent comment (google-login-automation.ts) for why the old
      // "defensive fallback" here (blind-typing the password into
      // whatever page the popup happened to be on) was removed. Fail fast
      // and specifically instead.
      await checkPopupChallenge(popup);
      log.error({ url: popup.url() }, "runFlow(patchright): expected a Keycloak (idp.vnu.edu.vn) redirect after the email step but never got one");
      throw new HyeboardError("GOOGLE_KEYCLOAK_REDIRECT_MISSING", "Google did not redirect to the VNU sign-in page as expected. Try again, or use the manual token option below.", 502);
    }
    if (!popup.isClosed()) await checkPopupChallenge(popup);
  }

  // 5. The popup completes the OAuth handshake and closes itself once
  // Google Identity Services delivers the credential back to the opener
  // via postMessage (or, on the silent-cookie-login path, it may already
  // be closed from step 1b). Wait for that close, then poll the opener
  // page for the resulting session. StudentHub stores the resulting JWT in
  // localStorage.accessToken (confirmed in the Puppeteer flow).
  report("Finalizing StudentHub session...");
  await popup
    .waitForEvent("close", { timeout: 6_000 })
    .catch(() => undefined);

  for (let attempt = 0; attempt < 8 && !studenthubToken; attempt++) {
    studenthubToken = await page.evaluate(() => window.localStorage.getItem("accessToken")).catch(() => null);
    if (!studenthubToken) await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (studenthubToken) result.studenthub = { accessToken: studenthubToken };
  log.debug({ gotStudenthubToken: Boolean(studenthubToken) }, "runFlow(patchright): StudentHub token capture attempt finished");
  if (!studenthubToken && isStudenthubMaintenance(page.url())) {
    throw new HyeboardError("STUDENTHUB_MAINTENANCE", "StudentHub is currently under maintenance. Please try again later.", 503);
  }

  // Capture EVERY cookie in the context, not just a URL allow-list —
  // unlike the Puppeteer flow (whose shared @cloudflare/puppeteer type
  // surface has no no-args "all cookies" method, see cookieCaptureUrls's
  // comment in google-login-automation.ts), Playwright's BrowserContext
  // genuinely supports this: context.cookies() with no argument returns
  // every cookie in the context, not just cookies for the current page's
  // origin. Persisted by the caller for the next
  // automateVnuGoogleLoginPatchright() call. Safe to capture broadly here —
  // isRehydratableGoogleCookie (see step 0 above) still filters what
  // actually gets rehydrated on the next call.
  const googleCookies = await context.cookies().catch(() => []);
  if (googleCookies.length) {
    result.googleCookies = googleCookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite as GoogleSessionCookie["sameSite"],
    }));
  }
  log.debug({ gotGoogleCookies: googleCookies.length > 0 }, "runFlow(patchright): Google session cookie capture finished");

  // 5b. Let StudentHub's SPA finish transitioning into its authenticated
  // main page before navigating away to Canvas (see the Puppeteer flow's
  // step 5b for why — jumping to Canvas immediately can interrupt that
  // in-flight transition). No confirmed DOM selector for the authenticated
  // state exists, so this is a best-effort wait.
  await page.waitForLoadState("domcontentloaded", { timeout: 8_000 }).catch(() => undefined);

  // 6. Same browser context/cookies → Canvas SSO. Unverified: this URL is
  // a best guess based on the Canvas SAML login convention (see the
  // Puppeteer flow's step 6 comment) and has not been confirmed against a
  // real account.
  report("Connecting to Canvas...");
  log.debug({ url: CANVAS_SSO_URL }, "runFlow(patchright): navigating to Canvas SSO");
  await page.goto(CANVAS_SSO_URL, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => undefined);
  const canvasChallenge = detectChallenge(page.url(), await page.evaluate(() => document.body.innerText).catch(() => ""));
  if (canvasChallenge) log.debug({ challenge: canvasChallenge, url: page.url() }, "runFlow(patchright): Canvas SSO hit a challenge");
  if (!canvasChallenge) {
    const cookies = await context.cookies();
    const csrfCookie = cookies.find((c) => /csrf/i.test(c.name));
    if (cookies.length) {
      result.canvas = {
        cookie: serializeCookies(cookies),
        csrfToken: csrfCookie ? decodeURIComponent(csrfCookie.value) : undefined,
      };
    }
    log.debug({ gotCanvasCookies: cookies.length > 0 }, "runFlow(patchright): Canvas SSO finished");
  }
}
