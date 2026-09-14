// Inline session re-authentication support. When a UET session dies (or the
// worker's lazy StudentHub refresh stalls on a CAPTCHA its own OCR couldn't
// solve) and this tab still holds the user's sign-in credentials, the app
// re-runs the login in place - relaying a CAPTCHA dialog when needed -
// instead of clearing the session and bouncing the user to /login.
//
// This module is intentionally free of react/state.tsx imports so lib/api.ts
// (a plain module) can consult it without creating a dependency cycle.

// Listened for by SessionReauthGate (components/reauth.tsx); dispatched by
// lib/api.ts when a request dies with a session-death code but an inline
// re-authentication looks possible.
export const SESSION_REAUTH_REQUIRED_EVENT = "hyeboard:session-reauth-required";

// sessionStorage keys for the UET sign-in credentials captured on the last
// successful login. state.tsx folds these into RELOGIN_KEYS so an explicit
// sign-out wipes them together with the other per-tab relogin secrets.
export const UET_REAUTH_CREDENTIAL_KEYS = {
  email: "hyeboard.relogin.uet.googleEmail",
  password: "hyeboard.relogin.uet.googlePassword",
} as const;

export type UetReauthCredentials = { email: string; password: string };

export function readUetReauthCredentials(): UetReauthCredentials | undefined {
  const email = sessionStorage.getItem(UET_REAUTH_CREDENTIAL_KEYS.email);
  const password = sessionStorage.getItem(UET_REAUTH_CREDENTIAL_KEYS.password);
  if (!email || !password) return undefined;
  return { email, password };
}

export function clearUetReauthCredentials(): void {
  sessionStorage.removeItem(UET_REAUTH_CREDENTIAL_KEYS.email);
  sessionStorage.removeItem(UET_REAUTH_CREDENTIAL_KEYS.password);
}

// If requests keep dying right after a re-auth just succeeded, something
// beyond an expired session is wrong - re-triggering would loop the dialog
// forever, so within this window callers fall back to clear-and-redirect.
export const REAUTH_SUCCESS_COOLDOWN_MS = 30_000;

let lastReauthSucceededAt = Number.NEGATIVE_INFINITY;

export function markReauthSucceeded(at: number = Date.now()): void {
  lastReauthSucceededAt = at;
}

// Pure decision helper (unit-tested); canReauthenticateInline below binds it
// to real storage and the real clock.
export function shouldAttemptInlineReauth(input: { universityId: string | undefined; hasCredentials: boolean; lastSuccessAt: number; now: number }): boolean {
  if (input.universityId !== "uet") return false;
  if (!input.hasCredentials) return false;
  return input.now - input.lastSuccessAt >= REAUTH_SUCCESS_COOLDOWN_MS;
}

export function canReauthenticateInline(universityId: string | undefined): boolean {
  return shouldAttemptInlineReauth({
    universityId,
    hasCredentials: readUetReauthCredentials() !== undefined,
    lastSuccessAt: lastReauthSucceededAt,
    now: Date.now(),
  });
}

export function requestInlineReauth(): void {
  window.dispatchEvent(new CustomEvent(SESSION_REAUTH_REQUIRED_EVENT));
}
