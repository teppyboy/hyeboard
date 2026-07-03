import puppeteer from "@cloudflare/puppeteer";
import { HyeboardError } from "@hyeboard/core";
import type { BrowserBinding } from "../types";

export const STUDENTHUB_LOGIN_URL = "https://studenthub.uet.edu.vn/login";
export const CANVAS_SSO_URL = "https://portal.uet.vnu.edu.vn/login/saml";
// VERIFIED LIVE (2026-07-03): the originally-assumed 45s budget was too
// tight once the real flow was observed — VNU-domain accounts federate
// through a separate Keycloak IDP hop, a Google "verify it's you"
// interstitial, a forced redirect to Gmail, a short cool-down, and a
// second popup/account-chooser pass.
// The whole automated attempt was silently aborted by this timeout partway
// through (browser.close() tore everything down right after Gmail opened,
// before the close+retry step could run). Widened to give the full
// multi-hop flow enough headroom.
export const HARD_TIMEOUT_MS = 90_000;

export type GoogleLoginResult = {
  studenthub?: { accessToken: string; accountCode?: string };
  canvas?: { cookie: string; csrfToken?: string };
};

export type GoogleChallengeCode = "GOOGLE_2FA_REQUIRED" | "GOOGLE_AUTOMATION_BLOCKED" | "GOOGLE_CHALLENGE_REQUIRED";

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

// ── Browser orchestration (NOT unit-tested — mocked by adapter.ts's tests;
//    selectors below are NEEDS LIVE VERIFICATION, see plan Task 12) ──────

export async function automateVnuGoogleLogin(browserBinding: BrowserBinding, email: string, password: string): Promise<GoogleLoginResult> {
  const browser = await puppeteer.launch(browserBinding as never);
  const result: GoogleLoginResult = {};
  try {
    let timeoutId: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new HyeboardError("GOOGLE_AUTOMATION_TIMEOUT", "The automated sign-in took too long and was cancelled.", 504)), HARD_TIMEOUT_MS);
    });
    try {
      await Promise.race([runFlow(browser, email, password, result), timeout]);
    } finally {
      clearTimeout(timeoutId!);
    }
  } finally {
    await browser.close();
  }
  if (!result.studenthub && !result.canvas) {
    throw new HyeboardError("GOOGLE_AUTOMATION_BLOCKED", "Google did not complete the sign-in. Check your email and password, or use the manual token option below.", 502);
  }
  return result;
}

// Clicks the "Đăng nhập với VNU mail" button on the given page and waits for
// the resulting popup window to open and settle on its first real URL.
// VERIFIED LIVE (2026-07-03): the button is a plain same-origin button with
// accessible name "Đăng nhập với VNU mail" ("Sign in with VNU mail") — not a
// GSI div/iframe widget. Clicking it opens Google's account chooser / sign-in
// as a REAL POPUP WINDOW (accounts.google.com/v3/signin/... with
// display=popup, response_type=id_token, response_mode=form_post), not a
// same-page navigation. Must listen for the browser's "targetcreated" event
// and drive the popup page, not the opener `page`. Extracted into a helper
// because the Keycloak-federation branch below needs to invoke this same
// click-and-wait sequence a second time.
async function clickGoogleButtonAndWaitForPopup(
  page: import("@cloudflare/puppeteer").Page,
  browser: Awaited<ReturnType<typeof puppeteer.launch>>,
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

async function runFlow(browser: Awaited<ReturnType<typeof puppeteer.launch>>, email: string, password: string, result: GoogleLoginResult): Promise<void> {
  const page = await browser.newPage();

  // 1. StudentHub → Google sign-in popup.
  await page.goto(STUDENTHUB_LOGIN_URL, { waitUntil: "networkidle0" });
  let popup = await clickGoogleButtonAndWaitForPopup(page, browser);

  const checkPopupChallenge = async (p: import("@cloudflare/puppeteer").Page) => {
    const challenge = detectChallenge(p.url(), await p.evaluate(() => document.body.innerText).catch(() => ""));
    if (challenge) throw new HyeboardError(challenge, "Google requires additional verification that cannot be completed automatically.", 401);
  };

  // 2. Google account chooser (if a prior session exists, or an org-wide
  // login hint pre-populates a suggested account) — pick "use another
  // account" when present, otherwise the popup goes straight to the
  // email step. NEEDS LIVE VERIFICATION: this repo's own live check used
  // a browser with existing Google sessions, so it saw the account
  // chooser; a fresh Browser-Rendering session (no cookies) is expected
  // to skip straight to the email input below, but this remains
  // unconfirmed against a truly cookie-less session — this branch is a
  // defensive best-effort, not verified.
  const useAnotherAccount = await popup.waitForSelector("aria/Sử dụng tài khoản khác", { timeout: 3_000 }).catch(() => null);
  if (useAnotherAccount) {
    await useAnotherAccount.click().catch(() => undefined);
    await popup.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => undefined);
  }

  // 3. Google email step.
  const emailSelector = 'input[type="email"], input#identifierId';
  await popup.waitForSelector(emailSelector, { timeout: 15_000 });
  await popup.type(emailSelector, email, { delay: 20 });
  await popup.waitForSelector("#identifierNext", { timeout: 10_000 });
  await popup.click("#identifierNext");
  await popup.waitForNavigation({ waitUntil: "networkidle0" }).catch(() => undefined);
  await checkPopupChallenge(popup);

  // 4. VNU-domain accounts are federated to VNU's own Keycloak IDP
  // (idp.vnu.edu.vn), not Google's own password page.
  // VERIFIED LIVE (2026-07-03): after the email step, Google redirects the
  // popup to idp.vnu.edu.vn/auth/realms/vnu/login-actions/authenticate — a
  // Keycloak form with #username/#password inputs and a #kc-login submit
  // button (client_id=https://www.google.com/a/vnu.edu.vn in the query
  // string). Submitting it completes SSO federation, but the Keycloak
  // theme's own client-side script then FORCIBLY navigates the popup to
  // https://mail.google.com/a/vnu.edu.vn — a dead end for this OAuth flow.
  // Recovery (confirmed live by manual testing): close this popup and click
  // "Đăng nhập với VNU mail" again; the browser's Google account session
  // cookie is now set from the completed federation, so the second popup
  // goes straight to account selection instead of asking for credentials
  // again.
  if (/idp\.vnu\.edu\.vn/.test(popup.url())) {
    // NEEDS LIVE VERIFICATION: whether Keycloak's #username field expects
    // the bare local-part (before "@") or the full email address. Using the
    // local-part as the more common LDAP/Keycloak convention (matches how
    // VNU's other systems, e.g. the vnu/daotao adapter, use a bare student
    // code rather than a full email) — unconfirmed against this specific
    // IDP without a real submission.
    const keycloakUsername = email.includes("@") ? email.slice(0, email.indexOf("@")) : email;
    await popup.waitForSelector("#username", { timeout: 10_000 });
    await popup.type("#username", keycloakUsername, { delay: 20 });
    await popup.type("#password", password, { delay: 20 });
    await popup.click("#kc-login");
    await popup.waitForNavigation({ waitUntil: "networkidle0" }).catch(() => undefined);

    // VERIFIED LIVE (2026-07-03): after the Keycloak login, Google shows an
    // interstitial "We'd like to verify if this account is yours" screen
    // with a "Continue" button before it proceeds to the mail.google.com
    // dead end described above. Click through it if present; if this screen
    // doesn't appear (e.g. a different locale/account state), the selector
    // simply won't be found and this is skipped.
    const verifyContinue =
      (await popup.waitForSelector("aria/Continue", { timeout: 5_000 }).catch(() => null)) ??
      (await popup.waitForSelector("aria/Tiếp tục", { timeout: 3_000 }).catch(() => null));
    if (verifyContinue) {
      await verifyContinue.click().catch(() => undefined);
      // This navigation lands on the mail.google.com dead end (a heavy SPA
      // that keeps sockets/long-polls open) — "networkidle0" would likely
      // never resolve and burn the full navigation timeout every run.
      // "domcontentloaded" is enough since we only need the popup to have
      // settled before closing it, not for Gmail to finish loading.
      await popup.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => undefined);
    }

    // This navigation is expected to land on mail.google.com (the dead end
    // described above) — not treated as an error, just awaited so the popup
    // settles before we close it.
    await popup.close().catch(() => undefined);

    // VERIFIED LIVE (2026-07-03): clicking the button again immediately
    // after closing the Keycloak popup is too fast — the Google session
    // cookie from the just-completed federation isn't reliably available to
    // the next OAuth request yet. A short wait before retrying is required.
    // Confirmed working end-to-end; trimmed from 5s to 2s to shave time off
    // a successful run.
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    popup = await clickGoogleButtonAndWaitForPopup(page, browser);
    await checkPopupChallenge(popup);

    // VERIFIED LIVE (2026-07-03): the second popup opens an account chooser.
    // `data-identifier` matching the full email is Google's account tile; the
    // text-content fallback keeps this tolerant if Google changes attributes.
    const accountTile =
      (await popup.waitForSelector(`div[data-identifier="${email}"]`, { timeout: 8_000 }).catch(() => null)) ??
      (await popup.waitForSelector(`::-p-text(${email})`, { timeout: 5_000 }).catch(() => null));
    if (accountTile) {
      await accountTile.click().catch(() => undefined);
      await popup.waitForNavigation({ waitUntil: "networkidle0" }).catch(() => undefined);
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
  await checkPopupChallenge(popup);

  // 5. Popup completes the OAuth handshake (response_mode=form_post) and
  // is expected to close itself once GIS delivers the credential back to
  // the opener via postMessage — standard GIS popup behavior. Wait for
  // that close, then poll the opener page for the resulting session.
  // VERIFIED LIVE (2026-07-03): StudentHub stores the resulting JWT in
  // localStorage.accessToken, matching the manual-paste instructions already
  // in apps/web/src/main.tsx.
  // Confirmed working end-to-end; trimmed the close-wait ceiling from 15s
  // to 6s since the popup closing (or the JWT already landing) is the
  // common case and the full ceiling was rarely, if ever, needed.
  await new Promise<void>((resolve) => {
    popup.once("close", () => resolve());
    setTimeout(resolve, 6_000);
  });

  let studenthubToken: string | null = null;
  for (let attempt = 0; attempt < 8 && !studenthubToken; attempt++) {
    studenthubToken = await page.evaluate(() => window.localStorage.getItem("accessToken")).catch(() => null);
    if (!studenthubToken) await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (studenthubToken) result.studenthub = { accessToken: studenthubToken };

  // 6. Same browser context/cookies → Canvas SSO (Keycloak brokers to the
  // already-authenticated Google session silently, no second password).
  // NEEDS LIVE VERIFICATION: portal.uet.vnu.edu.vn's actual SSO entry path
  // (har-notes.md only captured POST /login/saml post-authentication; the
  // pre-auth entry point that triggers the Keycloak redirect was never
  // captured in any HAR — this URL is a best guess and must be confirmed).
  await page.goto(CANVAS_SSO_URL, { waitUntil: "networkidle0" }).catch(() => undefined);
  const canvasChallenge = detectChallenge(page.url(), await page.evaluate(() => document.body.innerText).catch(() => ""));
  if (!canvasChallenge) {
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
