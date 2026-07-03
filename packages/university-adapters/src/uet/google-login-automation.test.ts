import { describe, expect, it } from "vitest";
import { detectChallenge, serializeCookies } from "./google-login-automation";

describe("detectChallenge", () => {
  it("returns GOOGLE_2FA_REQUIRED for a totp challenge URL", () => {
    expect(detectChallenge("https://accounts.google.com/signin/v2/challenge/totp?x=1", "")).toBe("GOOGLE_2FA_REQUIRED");
  });

  it("returns GOOGLE_2FA_REQUIRED for an ipp challenge URL", () => {
    expect(detectChallenge("https://accounts.google.com/signin/v2/challenge/ipp", "")).toBe("GOOGLE_2FA_REQUIRED");
  });

  it("returns GOOGLE_2FA_REQUIRED for an iap challenge URL", () => {
    expect(detectChallenge("https://accounts.google.com/signin/v2/challenge/iap", "")).toBe("GOOGLE_2FA_REQUIRED");
  });

  it("returns GOOGLE_AUTOMATION_BLOCKED when body text warns the sign-in is unsafe", () => {
    expect(detectChallenge("https://accounts.google.com/signin/rejected", "This browser or app may not be secure")).toBe("GOOGLE_AUTOMATION_BLOCKED");
  });

  it("returns GOOGLE_CHALLENGE_REQUIRED for a generic challenge URL with no blocked phrasing", () => {
    expect(detectChallenge("https://accounts.google.com/signin/challenge", "please verify your identity")).toBe("GOOGLE_CHALLENGE_REQUIRED");
  });

  it("returns GOOGLE_CHALLENGE_REQUIRED for a rejected URL with no blocked phrasing", () => {
    expect(detectChallenge("https://accounts.google.com/signin/rejected", "sign-in was not successful")).toBe("GOOGLE_CHALLENGE_REQUIRED");
  });

  it("returns undefined for a normal successful URL and body", () => {
    expect(detectChallenge("https://studenthub.uet.edu.vn/dashboard", "Welcome back")).toBeUndefined();
  });

  it("prioritizes GOOGLE_2FA_REQUIRED over the blocked-phrase check when both could match", () => {
    expect(detectChallenge("https://accounts.google.com/signin/v2/challenge/totp", "unusual activity detected")).toBe("GOOGLE_2FA_REQUIRED");
  });
});

describe("serializeCookies", () => {
  it("joins multiple cookies as name=value pairs separated by semicolons", () => {
    expect(
      serializeCookies([
        { name: "a", value: "1" },
        { name: "b", value: "2" },
      ]),
    ).toBe("a=1; b=2");
  });

  it("returns an empty string for an empty array", () => {
    expect(serializeCookies([])).toBe("");
  });
});
