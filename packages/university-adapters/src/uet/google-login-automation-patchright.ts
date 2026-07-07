import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "patchright";
import { getLogger, HyeboardError, type GoogleSessionCookie } from "@hyeboard/core";
import {
  CANVAS_SSO_URL,
  detectChallenge,
  HARD_TIMEOUT_MS,
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

export async function automateVnuGoogleLoginPatchright(
  headless: boolean,
  email: string,
  password: string,
  existingCookies?: GoogleSessionCookie[],
  onProgress?: (message: string) => void,
): Promise<GoogleLoginResult> {
  const log = getLogger();
  const result: GoogleLoginResult = {};
  log.debug({ connectionKind: "local-patchright", email }, "automateVnuGoogleLoginPatchright: starting");

  // Best-practice Patchright launch (see README "Best Practice" section):
  // a persistent context with the real "chrome" channel, no injected
  // viewport/userAgent overrides, avoids the fingerprint-injection path
  // that's easier to detect than just launching real Chrome.
  // launchPersistentContext requires a real userDataDir (an empty string
  // is invalid) — use a fresh temp directory, cleaned up in the finally
  // block below alongside context.close().
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
  log.debug("automateVnuGoogleLoginPatchright: browser context acquired");

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
    if (error instanceof HyeboardError) throw error;
    log.error({ err: error }, "automateVnuGoogleLoginPatchright: unexpected error");
    throw new HyeboardError("GOOGLE_AUTOMATION_BLOCKED", "Google blocked automated sign-in in this environment. Use the manual token option below.", 502);
  } finally {
    await context.close().catch(() => undefined);
    rmSync(userDataDir, { recursive: true, force: true });
  }
  log.debug({ hasStudenthub: Boolean(result.studenthub), hasCanvas: Boolean(result.canvas) }, "automateVnuGoogleLoginPatchright: finished");
  if (!result.studenthub && !result.canvas) {
    throw new HyeboardError("GOOGLE_AUTOMATION_BLOCKED", "Google did not complete the sign-in. Check your email and password, or use the manual token option below.", 502);
  }
  return result;
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

async function runFlow(
  context: BrowserContext,
  email: string,
  password: string,
  result: GoogleLoginResult,
  existingCookies?: GoogleSessionCookie[],
  onProgress?: (message: string) => void,
): Promise<void> {
  const report = (message: string) => onProgress?.(message);
  const log = getLogger();
  // launchPersistentContext opens with one blank tab already visible
  // (headless: false shows this immediately) — reuse it instead of opening
  // a second tab that context.newPage() would create, which is why the
  // visible browser window was previously stuck showing an untouched
  // about:blank tab while the real navigation happened in a background
  // tab the user never saw.
  const page = context.pages()[0] ?? (await context.newPage());
  await page.bringToFront().catch(() => undefined);
  let studenthubToken: string | null = null;

  // 0. Rehydrate a previously-captured Google/VNU-IDP session cookie (if
  // any). context.addCookies applies at the context/cookie-jar level, so
  // it also covers the popup opened in step 1 below (same context).
  // Best-effort: if the cookie is stale, the flow below simply falls
  // through to the normal interactive email/password/Keycloak steps.
  if (existingCookies?.length) {
    await context
      .addCookies(
        existingCookies.map((c) => ({
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
  if (existingCookies?.length) {
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
      // No Keycloak redirect observed for this account — fall back to
      // Google's own password step directly. Defensive fallback, not the
      // primary observed flow for @vnu.edu.vn accounts.
      const passwordInput = popup.locator('input[type="password"]');
      await passwordInput.waitFor({ state: "visible", timeout: 10_000 });
      await passwordInput.pressSequentially(password, { delay: 20 });
      await popup.locator("#passwordNext").click({ timeout: 10_000 });
      await popup.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
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

  // Capture both Google session cookies AND VNU IDP (Keycloak) session
  // cookies from the just-completed login, for the caller to persist and
  // pass back in on the next automateVnuGoogleLoginPatchright() call.
  const googleCookies = await context.cookies(["https://accounts.google.com", "https://www.google.com", "https://idp.vnu.edu.vn"]).catch(() => []);
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
