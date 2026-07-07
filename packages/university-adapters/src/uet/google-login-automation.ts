import puppeteer from "@cloudflare/puppeteer";
import puppeteerCore from "puppeteer-core";
import { getLogger, HyeboardError, type GoogleSessionCookie } from "@hyeboard/core";
import type { BrowserConnection } from "../types";

// Structural type covering whichever of @cloudflare/puppeteer's or
// puppeteer-core's Browser we got — both packages implement the same
// Puppeteer API surface (newPage/close/on/off) that runFlow() relies on, so
// the rest of this file doesn't need to know which one produced the browser.
type AnyBrowser = Awaited<ReturnType<typeof puppeteer.launch>>;

export const STUDENTHUB_LOGIN_URL = "https://studenthub.uet.edu.vn/login";
export const CANVAS_SSO_URL = "https://portal.uet.vnu.edu.vn/login/saml";
// Confirmed: StudentHub redirects here (note "maintance", a typo on the real
// site, not ours) when the whole portal is down for maintenance — every
// login attempt during that window ends up here regardless of credentials,
// so it must be checked before treating a failed login as a credential or
// automation problem.
export const STUDENTHUB_MAINTENANCE_URL = "https://studenthub.uet.edu.vn/maintance/system-update";

export function isStudenthubMaintenance(url: string): boolean {
  return /\/maintance\/system-update(?:[/?#]|$)/.test(url);
}
// VNU-domain accounts federate through a separate Keycloak IDP hop, a
// Google "verify it's you" interstitial, a forced redirect to a Gmail
// dead end, a short cool-down, and a second popup/account-chooser pass —
// confirmed by live testing to take well over 45s in the worst case, so
// the budget below covers the full multi-hop flow with headroom.
export const HARD_TIMEOUT_MS = 90_000;

export type GoogleLoginResult = {
  studenthub?: { accessToken: string; accountCode?: string };
  canvas?: { cookie: string; csrfToken?: string };
  // Google session cookies captured after login, for the caller to persist
  // and pass back in on the next automateVnuGoogleLogin() call (see
  // EncryptedSessionPayload.uetGoogleCredential.googleCookies).
  googleCookies?: GoogleSessionCookie[];
};

export type GoogleChallengeCode = "GOOGLE_2FA_REQUIRED" | "GOOGLE_AUTOMATION_BLOCKED" | "GOOGLE_CHALLENGE_REQUIRED";

// Optional Patchright-based launcher for the "local" BrowserConnection kind
// (github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs — a patched Playwright
// fork with better anti-bot-detection stealth). Deliberately NOT imported
// directly by this file: patchright is a large, Node-only, Chromium-only
// dependency, and this file is shared by the Cloudflare Workers code path
// (via the "cloudflare" BrowserConnection kind) — a static or dynamic
// import here would make wrangler bundle patchright into the Cloudflare
// deployment even though it's never used there (confirmed: this
// balloons the Workers bundle from ~6MB to ~13MB, since Cloudflare Workers
// has no runtime package resolution and wrangler must inline every
// reachable module regardless of import style). Instead, whoever wants
// Patchright support registers a launcher via setPatchrightLauncher() from
// a Node-only entry point that Cloudflare's build never reaches (see
// apps/worker/src/index.node.ts) — the actual patchright import only ever
// exists in that Node-only file's dependency graph.
export type PatchrightLauncher = (
  headless: boolean,
  email: string,
  password: string,
  existingCookies?: GoogleSessionCookie[],
  onProgress?: (message: string) => void,
) => Promise<GoogleLoginResult>;
let patchrightLauncher: PatchrightLauncher | undefined;
export function setPatchrightLauncher(launcher: PatchrightLauncher | undefined): void {
  patchrightLauncher = launcher;
}

// Checked in this exact priority order: 2FA first, then automation-blocked
// (Google's "this browser or app may not be secure" / suspicious-activity
// messaging), then a generic challenge/rejected fallback.
export function detectChallenge(currentUrl: string, bodyText: string): GoogleChallengeCode | undefined {
  if (/\/signin\/v2\/challenge\/(totp|ipp|iap)/.test(currentUrl)) return "GOOGLE_2FA_REQUIRED";
  if (/may not be secure|verify it.?s you|unusual activity|suspicious/i.test(bodyText)) return "GOOGLE_AUTOMATION_BLOCKED";
  if (/\/signin\/(challenge|rejected)/.test(currentUrl)) return "GOOGLE_CHALLENGE_REQUIRED";
  return undefined;
}

export function serializeCookies(cookies: Array<{ name: string; value: string }>): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

// ── Browser orchestration. This drives a real, VNU-specific login UI
//    (Google account chooser + VNU's Keycloak IDP theme) via Puppeteer, so
//    it isn't unit-tested — adapter.ts's tests mock this function entirely.
//    Selectors are confirmed against live captures where noted; anything
//    marked "Unverified" below is a defensive best-effort branch that has
//    not been exercised against a real account in this state. ──────

export async function automateVnuGoogleLogin(
  connection: BrowserConnection,
  email: string,
  password: string,
  existingCookies?: GoogleSessionCookie[],
  // Optional interim-progress reporter, surfaced end-to-end as SSE events on
  // the /api/uet/auth/import-session route so the login UI can show what's
  // happening during this otherwise-opaque, potentially 90s+ flow.
  onProgress?: (message: string) => void,
): Promise<GoogleLoginResult> {
  // "local" + a registered Patchright launcher (see setPatchrightLauncher
  // above) + explicit opt-in via env var — dispatches to a completely
  // separate Playwright-based implementation instead of Puppeteer below.
  if (connection.kind === "local" && process.env.HYEB_BROWSER_PATCHRIGHT === "true" && patchrightLauncher) {
    return patchrightLauncher(connection.headless ?? true, email, password, existingCookies, onProgress);
  }

  let browser: AnyBrowser | undefined;
  const result: GoogleLoginResult = {};
  const log = getLogger();
  // Set HYEB_LOG_LEVEL=debug to see every step of this flow (browser
  // acquisition, navigation, token capture, Canvas SSO hop).
  log.debug({ connectionKind: connection.kind, email }, "automateVnuGoogleLogin: starting");
  try {
    if (connection.kind === "cloudflare") {
      browser = await puppeteer.launch(connection.binding as never);
    } else if (connection.kind === "self-hosted") {
      browser = (await puppeteerCore.connect({ browserWSEndpoint: connection.browserWSEndpoint })) as unknown as AnyBrowser;
    } else {
      browser = (await puppeteerCore.launch({
        headless: connection.headless ?? true,
        executablePath: process.env.HYEB_CHROME_PATH,
        args: ["--no-sandbox"],
      })) as unknown as AnyBrowser;
    }
    log.debug("automateVnuGoogleLogin: browser acquired");
    let timeoutId: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new HyeboardError("GOOGLE_AUTOMATION_TIMEOUT", "The automated sign-in took too long and was cancelled.", 504)), HARD_TIMEOUT_MS);
    });
    try {
      await Promise.race([runFlow(browser, email, password, result, existingCookies, onProgress), timeout]);
    } finally {
      clearTimeout(timeoutId!);
    }
  } catch (error) {
    if (error instanceof HyeboardError) throw error;
    log.error({ err: error }, "automateVnuGoogleLogin: unexpected error");
    throw new HyeboardError("GOOGLE_AUTOMATION_BLOCKED", "Google blocked automated sign-in in this environment. Use the manual token option below.", 502);
  } finally {
    await browser?.close().catch(() => undefined);
  }
  log.debug({ hasStudenthub: Boolean(result.studenthub), hasCanvas: Boolean(result.canvas) }, "automateVnuGoogleLogin: finished");
  if (!result.studenthub && !result.canvas) {
    throw new HyeboardError("GOOGLE_AUTOMATION_BLOCKED", "Google did not complete the sign-in. Check your email and password, or use the manual token option below.", 502);
  }
  return result;
}

// Clicks the "Đăng nhập với VNU mail" button on the given page and waits for
// the resulting popup window to open and settle on its first real URL.
// Confirmed by live testing: the button is a plain same-origin button with
// accessible name "Đăng nhập với VNU mail" ("Sign in with VNU mail") — not a
// Google Identity Services div/iframe widget. Clicking it opens Google's
// account chooser / sign-in as a real popup window
// (accounts.google.com/v3/signin/... with display=popup,
// response_type=id_token, response_mode=form_post), not a same-page
// navigation, so this listens for the browser's "targetcreated" event and
// drives the popup page rather than the opener `page`. Extracted into a
// helper because the Keycloak-federation recovery path below needs to
// invoke this same click-and-wait sequence a second time.
async function clickGoogleButtonAndWaitForPopup(
  page: import("@cloudflare/puppeteer").Page,
  browser: AnyBrowser,
): Promise<import("@cloudflare/puppeteer").Page> {
  const popupPromise = new Promise<import("@cloudflare/puppeteer").Page>((resolve, reject) => {
    const onTarget = async (target: import("@cloudflare/puppeteer").Target) => {
      const popupPage = await target.page();
      if (popupPage) {
        browser.off("targetcreated", onTarget);
        resolve(popupPage);
      }
    };
    browser.on("targetcreated", onTarget);
    setTimeout(() => {
      browser.off("targetcreated", onTarget);
      reject(new Error("Google sign-in popup did not open in time."));
    }, 10_000);
  });
  await page.waitForSelector("aria/Đăng nhập với VNU mail", { timeout: 10_000 });
  await page.click("aria/Đăng nhập với VNU mail");
  const popup = await popupPromise;
  // The popup target resolves as soon as it's created, often while it's
  // still on about:blank mid-redirect through Google's OAuth handshake —
  // wait for it to actually settle on a Google page before inspecting it.
  await popup.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => undefined);
  await popup.bringToFront().catch(() => undefined);
  return popup;
}

async function runFlow(
  browser: AnyBrowser,
  email: string,
  password: string,
  result: GoogleLoginResult,
  existingCookies?: GoogleSessionCookie[],
  onProgress?: (message: string) => void,
): Promise<void> {
  const report = (message: string) => onProgress?.(message);
  const page = await browser.newPage();
  let studenthubToken: string | null = null;

  // 0. Rehydrate a previously-captured Google session cookie (if any)
  // before StudentHub even redirects to Google — CDP's setCookie applies
  // at the browser-context/cookie-jar level, not the currently-loaded
  // page, so it also covers the popup opened in step 1 below (same
  // context). Best-effort only: if Google no longer honors the cookie
  // (expired/revoked), the flow below simply falls through to the normal
  // interactive email/password/Keycloak steps, same as if no cookie were
  // passed at all.
  if (existingCookies?.length) {
    await page.setCookie(...(existingCookies as never[])).catch(() => undefined);
  }

  // 1. StudentHub → Google sign-in popup.
  report("Opening StudentHub...");
  await page.goto(STUDENTHUB_LOGIN_URL, { waitUntil: "networkidle0" });
  if (isStudenthubMaintenance(page.url())) {
    throw new HyeboardError("STUDENTHUB_MAINTENANCE", "StudentHub is currently under maintenance. Please try again later.", 503);
  }
  report("Signing in with Google...");
  let popup = await clickGoogleButtonAndWaitForPopup(page, browser);

  const checkPopupChallenge = async (p: import("@cloudflare/puppeteer").Page) => {
    const challenge = detectChallenge(p.url(), await p.evaluate(() => document.body.innerText).catch(() => ""));
    if (challenge) throw new HyeboardError(challenge, "Google requires additional verification that cannot be completed automatically.", 401);
  };

  // 1b. If we restored a Google session cookie, give the popup a brief
  // window to recognize it and complete the OAuth handshake on its own
  // (closing itself without any interactive step) before doing anything
  // else. Confirmed by live testing that this silent auto-close does not
  // actually occur in practice — Google's account chooser is shown instead
  // (handled by step 2b below) — but the check is cheap and kept as an
  // opportunistic fast path in case a session state exists where it does.
  let silentCookieLogin = false;
  if (existingCookies?.length) {
    getLogger().debug("runFlow: attempting silent cookie-based login");
    // Short timeout since the popup reliably does not auto-close (see
    // above) — waiting longer only delays the fall-through to step 2.
    silentCookieLogin = await new Promise<boolean>((resolve) => {
      popup.once("close", () => resolve(true));
      setTimeout(() => resolve(false), 1_500);
    });
    getLogger().debug({ silentCookieLogin }, "runFlow: silent cookie-based login attempt finished");
  }

  if (!silentCookieLogin) {
    // 2. Google account chooser (if a prior session exists, or an org-wide
    // login hint pre-populates a suggested account) — pick "use another
    // account" when present, otherwise the popup goes straight to the
    // email step. Unverified: a fresh, fully cookie-less session is
    // expected to skip straight to the email input below without ever
    // showing this chooser, but that specific case has not been exercised
    // live — this branch is a defensive best-effort, not a confirmed path.
    const useAnotherAccount = await popup.waitForSelector("aria/Sử dụng tài khoản khác", { timeout: 3_000 }).catch(() => null);
    if (useAnotherAccount) {
      await useAnotherAccount.click().catch(() => undefined);
      await popup.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => undefined);
    }

    // 2b. When cookie rehydration (step 0) placed the popup on Google's
    // account chooser with the logged-in account already listed, click that
    // tile instead of typing the email — clicking the tile silently
    // completes the OAuth consent via form_post/postMessage back to the
    // opener, and the popup closes itself. If no tile matches (cookie not
    // present or the popup isn't on the account chooser), this is a no-op
    // and the interactive flow below proceeds normally.
    const loggedInTile =
      (await popup.waitForSelector(`div[data-identifier="${email}"]`, { timeout: 3_000 }).catch(() => null)) ??
      (await popup.waitForSelector(`::-p-text(${email})`, { timeout: 3_000 }).catch(() => null));
    if (loggedInTile) {
      await loggedInTile.click().catch(() => undefined);
      await popup.waitForNavigation({ waitUntil: "networkidle0", timeout: 15_000 }).catch(() => undefined);
      if (popup.isClosed()) {
        silentCookieLogin = true;
      } else {
        // Confirmed by live testing: the initial navigation from the
        // account tile click can resolve on a Google interstitial before
        // the Google→Keycloak SAML federation redirect (a second
        // navigation) even starts — without this second wait, the
        // alreadyOnKeycloak check below sees a stale, non-Keycloak URL and
        // wrongly falls through to the email step. Non-fatal timeout: if no
        // second navigation happens, the check below simply proceeds with
        // the normal email/password flow.
        await popup.waitForNavigation({ waitUntil: "networkidle0", timeout: 8_000 }).catch(() => undefined);
        if (popup.isClosed()) silentCookieLogin = true;
      }
    }
  }

  if (!silentCookieLogin) {
    // 3. Google email step — but if the popup is already on Keycloak
    // (step 2b's account tile click redirected to VNU IDP because the
    // rehydrated Keycloak cookie was expired/revoked), skip email and
    // go straight to the Keycloak credential handling at step 4 below.
    const alreadyOnKeycloak = /idp\.vnu\.edu\.vn/.test(popup.url());

    if (!alreadyOnKeycloak) {
      const emailSelector = 'input[type="email"], input#identifierId';
      await popup.waitForSelector(emailSelector, { timeout: 15_000 });
      await popup.type(emailSelector, email, { delay: 20 });
      await popup.waitForSelector("#identifierNext", { timeout: 10_000 });
      await popup.click("#identifierNext");
      await popup.waitForNavigation({ waitUntil: "networkidle0" }).catch(() => undefined);
      await checkPopupChallenge(popup);
    }

    // 4. VNU-domain accounts are federated to VNU's own Keycloak IDP
    // (idp.vnu.edu.vn), not Google's own password page.
    // Confirmed by live testing (including a real HTML capture of the VNU
    // IDP login page): after the email step, Google redirects the popup to
    // idp.vnu.edu.vn/auth/realms/vnu/login-actions/authenticate — a Keycloak
    // form with #username/#password/#rememberMe inputs and a #kc-login
    // submit button (client_id=https://www.google.com/a/vnu.edu.vn in the
    // query string). Submitting it completes SSO federation, but the page's
    // own client-side script then forcibly does
    // `location.replace("https://mail.google.com/a/vnu.edu.vn")` — a dead
    // end for this OAuth flow, not an error. Recovery (confirmed live):
    // close this popup and click "Đăng nhập với VNU mail" again; the
    // browser's Google account session cookie is now set from the completed
    // federation, so the second popup goes straight to account selection
    // instead of asking for credentials again.
    // `alreadyOnKeycloak` also catches the re-auth path where step 2b's
    // account tile click landed on the VNU IDP directly (rehydrated
    // Keycloak cookie expired) — the same credential-fill logic applies.
    if (alreadyOnKeycloak || /idp\.vnu\.edu\.vn/.test(popup.url())) {
      report("Completing VNU sign-in...");
      // Confirmed by live testing: Keycloak's #username field expects the
      // bare local-part (before "@"), not the full email address.
      const keycloakUsername = email.includes("@") ? email.slice(0, email.indexOf("@")) : email;
      await popup.waitForSelector("#username", { timeout: 5_000 });
      await popup.type("#username", keycloakUsername, { delay: 20 });
      await popup.type("#password", password, { delay: 20 });
      // Tick the "Ghi nhớ" (remember me) checkbox before submitting —
      // Keycloak otherwise sets only a session cookie (lost on browser
      // close), making the saved VNU IDP cookie useless for re-auth on the
      // next login. Confirmed present at #rememberMe in the live-captured
      // VNU IDP page.
      const rememberMe = await popup.waitForSelector("#rememberMe", { timeout: 2_000 }).catch(() => null);
      if (rememberMe) {
        const isChecked = await popup.evaluate(() => (document.querySelector("#rememberMe") as HTMLInputElement | null)?.checked ?? false).catch(() => false);
        if (!isChecked) await rememberMe.click();
      }
      await popup.click("#kc-login");
      await popup.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => undefined);

      // Google can show an interstitial "We'd like to verify if this
      // account is yours" screen with a "Continue" button before the VNU
      // page's own script forces the mail.google.com redirect. Click
      // through it if present; if the VNU redirect fires directly instead
      // (the more common case, confirmed live), the selector simply times
      // out and this is a no-op.
      const verifyContinue =
        (await popup.waitForSelector("aria/Continue", { timeout: 5_000 }).catch(() => null)) ??
        (await popup.waitForSelector("aria/Tiếp tục", { timeout: 3_000 }).catch(() => null));
      if (verifyContinue) {
        getLogger().debug("runFlow: clicking 'verify it's you' Continue interstitial");
        await verifyContinue.click().catch(() => undefined);
        await popup.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10_000 }).catch(() => undefined);
      }

      if (popup.isClosed()) {
        // OAuth completed directly (popup closed itself during/near the
        // interstitial step) — no close+reopen dance needed.
        getLogger().debug("runFlow: popup closed itself after Keycloak login (OAuth completed directly)");
      } else {
        // Popup is on mail.google.com (the VNU JS redirect dead end) or
        // some other intermediate URL. Close and reopen via the opener's
        // "Đăng nhập với VNU mail" button; the now-set Google session
        // cookie makes the second popup skip straight to the account
        // chooser with a logged-in tile — no second password needed.
        await popup.close().catch(() => undefined);
        // Confirmed by live testing: clicking the button again immediately
        // after closing the Keycloak popup is too fast — the Google session
        // cookie from the just-completed federation isn't reliably available
        // to the next OAuth request yet, so a short wait before retrying is
        // required.
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        popup = await clickGoogleButtonAndWaitForPopup(page, browser);
        await checkPopupChallenge(popup);
        // Confirmed by live testing: the second popup opens an account
        // chooser. `data-identifier` matching the full email is Google's
        // account tile; the text-content fallback keeps this tolerant if
        // Google changes attributes.
        const accountTile =
          (await popup.waitForSelector(`div[data-identifier="${email}"]`, { timeout: 8_000 }).catch(() => null)) ??
          (await popup.waitForSelector(`::-p-text(${email})`, { timeout: 5_000 }).catch(() => null));
        if (accountTile) {
          await accountTile.click().catch(() => undefined);
          // MUST wait for the popup navigation (Google OAuth consent page)
          // before polling the opener — the postMessage that delivers the
          // credential to StudentHub only fires after this navigation.
          await popup.waitForNavigation({ waitUntil: "networkidle0", timeout: 15_000 }).catch(() => undefined);
          // Poll the opener for the StudentHub accessToken deposited by
          // Google's postMessage handshake.
          for (let attempt = 0; attempt < 20; attempt++) {
            await new Promise((r) => setTimeout(r, 500));
            if (studenthubToken || popup.isClosed()) break;
            studenthubToken = await page.evaluate(() => window.localStorage.getItem("accessToken")).catch(() => null);
          }
        }
      }
    } else {
      // No Keycloak redirect observed for this account — fall back to
      // Google's own password step directly. Kept as a defensive fallback,
      // not the primary observed flow for @vnu.edu.vn accounts.
      await popup.waitForSelector('input[type="password"]', { timeout: 10_000, visible: true });
      await popup.type('input[type="password"]', password, { delay: 20 });
      await popup.waitForSelector("#passwordNext", { timeout: 10_000 });
      await popup.click("#passwordNext");
      await popup.waitForNavigation({ waitUntil: "networkidle0" }).catch(() => undefined);
    }
    if (!popup.isClosed()) await checkPopupChallenge(popup);
  }

  // 5. The popup completes the OAuth handshake (response_mode=form_post)
  // and closes itself once Google Identity Services delivers the
  // credential back to the opener via postMessage — standard GIS popup
  // behavior (or, on the silent-cookie-login path, it may already be
  // closed from step 1b). Wait for that close, then poll the opener page
  // for the resulting session. Confirmed by live testing: StudentHub
  // stores the resulting JWT in localStorage.accessToken, matching the
  // manual-paste instructions already in apps/web/src/main.tsx.
  report("Finalizing StudentHub session...");
  await new Promise<void>((resolve) => {
    if (popup.isClosed()) { resolve(); return; }
    popup.once("close", () => resolve());
    setTimeout(resolve, 6_000);
  });

  for (let attempt = 0; attempt < 8 && !studenthubToken; attempt++) {
    studenthubToken = await page.evaluate(() => window.localStorage.getItem("accessToken")).catch(() => null);
    if (!studenthubToken) await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (studenthubToken) result.studenthub = { accessToken: studenthubToken };
  getLogger().debug({ gotStudenthubToken: Boolean(studenthubToken) }, "runFlow: StudentHub token capture attempt finished");
  if (!studenthubToken && isStudenthubMaintenance(page.url())) {
    throw new HyeboardError("STUDENTHUB_MAINTENANCE", "StudentHub is currently under maintenance. Please try again later.", 503);
  }

  // Capture both Google session cookies AND VNU IDP (Keycloak) session
  // cookies from the just-completed login. page.cookies(url) reads cookies
  // scoped to the given origins from the browser's cookie jar directly via
  // CDP — it does not require the page to currently be showing that origin,
  // so this works even though `page` itself is on StudentHub/Canvas by now.
  // Persisted by the caller (see EncryptedSessionPayload.uetGoogleCredential
  // .googleCookies) so the next automateVnuGoogleLogin() call can attempt
  // the silent cookie-based path above instead of a full interactive login.
  const googleCookies = await page.cookies("https://accounts.google.com", "https://www.google.com", "https://idp.vnu.edu.vn").catch(() => []);
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
  getLogger().debug({ gotGoogleCookies: googleCookies.length > 0 }, "runFlow: Google session cookie capture finished");

  // 5b. Let StudentHub's SPA finish transitioning into its authenticated
  // main page before navigating away to Canvas. The token landing in
  // localStorage triggers the SPA's own client-side redirect into the
  // dashboard; jumping to Canvas immediately was observed live to interrupt
  // that in-flight transition (Canvas opening then immediately closing,
  // restarting the whole flow). There is no confirmed DOM selector for
  // StudentHub's authenticated dashboard state, so this is a best-effort
  // network-idle wait rather than a specific assertion — non-fatal if it
  // times out, since we still proceed to Canvas either way.
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 8_000 }).catch(() => undefined);

  // 6. Same browser context/cookies → Canvas SSO (Keycloak brokers to the
  // already-authenticated Google session silently, no second password).
  // Unverified: portal.uet.vnu.edu.vn's pre-authentication SSO entry point
  // has never been captured directly (only the post-authentication POST
  // /login/saml was observed) — this URL is a best guess based on the
  // Canvas SAML login convention and has not been confirmed against a real
  // account.
  report("Connecting to Canvas...");
  getLogger().debug({ url: CANVAS_SSO_URL }, "runFlow: navigating to Canvas SSO");
  await page.goto(CANVAS_SSO_URL, { waitUntil: "networkidle0" }).catch(() => undefined);
  const canvasChallenge = detectChallenge(page.url(), await page.evaluate(() => document.body.innerText).catch(() => ""));
  if (canvasChallenge) getLogger().debug({ challenge: canvasChallenge, url: page.url() }, "runFlow: Canvas SSO hit a challenge");
  if (!canvasChallenge) {
    const cookies = await page.cookies();
    const csrfCookie = cookies.find((c) => /csrf/i.test(c.name));
    if (cookies.length) {
      result.canvas = {
        cookie: serializeCookies(cookies),
        csrfToken: csrfCookie ? decodeURIComponent(csrfCookie.value) : undefined,
      };
    }
    getLogger().debug({ gotCanvasCookies: cookies.length > 0 }, "runFlow: Canvas SSO finished");
  }
}
