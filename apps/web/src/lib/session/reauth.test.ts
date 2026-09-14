import { describe, expect, it } from "vitest";
import { REAUTH_SUCCESS_COOLDOWN_MS, shouldAttemptInlineReauth } from "./reauth";

const NOW = 1_000_000;

describe("shouldAttemptInlineReauth", () => {
  it("allows an inline re-auth for a uet account with stored credentials", () => {
    expect(shouldAttemptInlineReauth({ universityId: "uet", hasCredentials: true, lastSuccessAt: Number.NEGATIVE_INFINITY, now: NOW })).toBe(true);
  });

  it("rejects non-uet accounts", () => {
    expect(shouldAttemptInlineReauth({ universityId: "vnu", hasCredentials: true, lastSuccessAt: Number.NEGATIVE_INFINITY, now: NOW })).toBe(false);
    expect(shouldAttemptInlineReauth({ universityId: "mock", hasCredentials: true, lastSuccessAt: Number.NEGATIVE_INFINITY, now: NOW })).toBe(false);
    expect(shouldAttemptInlineReauth({ universityId: undefined, hasCredentials: true, lastSuccessAt: Number.NEGATIVE_INFINITY, now: NOW })).toBe(false);
  });

  it("rejects when no credentials are stored", () => {
    expect(shouldAttemptInlineReauth({ universityId: "uet", hasCredentials: false, lastSuccessAt: Number.NEGATIVE_INFINITY, now: NOW })).toBe(false);
  });

  it("rejects while inside the post-success cooldown window (loop safety)", () => {
    expect(shouldAttemptInlineReauth({ universityId: "uet", hasCredentials: true, lastSuccessAt: NOW - REAUTH_SUCCESS_COOLDOWN_MS + 1, now: NOW })).toBe(false);
  });

  it("allows again once the cooldown window has fully elapsed", () => {
    expect(shouldAttemptInlineReauth({ universityId: "uet", hasCredentials: true, lastSuccessAt: NOW - REAUTH_SUCCESS_COOLDOWN_MS, now: NOW })).toBe(true);
  });
});
