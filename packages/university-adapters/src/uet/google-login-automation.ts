import puppeteer from "@cloudflare/puppeteer";
import { HyeboardError } from "@hyeboard/core";
import type { BrowserBinding } from "../types";

export const STUDENTHUB_LOGIN_URL = "https://studenthub.uet.edu.vn/login";
export const CANVAS_SSO_URL = "https://portal.uet.vnu.edu.vn/login/saml";
export const HARD_TIMEOUT_MS = 45_000;

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
