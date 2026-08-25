import { describe, expect, it } from "vitest";
import {
  adminOAuthCallbackUrl,
  assertAdminMutation,
  authenticateAdminRequest,
  buildAdminSessionCookie,
  buildClearAdminSessionCookie,
  buildClearOAuthStateCookie,
  buildOAuthStateCookie,
  createAdminPasswordHash,
  createAdminSession,
  createOAuthAuthorization,
  decryptAdminSession,
  decryptOAuthState,
  derivePkceS256Challenge,
  encryptAdminSession,
  exchangeOAuthCode,
  parseAdminPasswordHash,
  timingSafeEqual,
  verifyAdminPassword,
} from "./admin-auth";

const SECRET = "s".repeat(32);

describe("admin passwords", () => {
  it("creates and verifies the fixed versioned PBKDF2 format", async () => {
    const hash = await createAdminPasswordHash("correct horse", new Uint8Array(16).fill(3));
    expect(hash).toMatch(/^pbkdf2-sha256\$310000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(parseAdminPasswordHash(hash).iterations).toBe(310_000);
    expect(await verifyAdminPassword("correct horse", hash)).toBe(true);
    expect(await verifyAdminPassword("wrong", hash)).toBe(false);
  });

  it.each([
    "pbkdf2-sha256$1$Aw$Aw",
    "pbkdf2-sha512$310000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "pbkdf2-sha256$310000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  ])("rejects malformed or weak hashes", (hash) => {
    expect(() => parseAdminPasswordHash(hash)).toThrow("Admin password hash is invalid");
  });

  it("compares exactly 32 bytes across equal, different, and invalid lengths", () => {
    expect(timingSafeEqual(new Uint8Array(32).fill(7), new Uint8Array(32).fill(7))).toBe(true);
    expect(timingSafeEqual(new Uint8Array(32).fill(7), new Uint8Array(32).fill(8))).toBe(false);
    expect(() => timingSafeEqual(new Uint8Array(31), new Uint8Array(32))).toThrow("Admin password hash is invalid");
    expect(() => timingSafeEqual(new Uint8Array(32), new Uint8Array(33))).toThrow("Admin password hash is invalid");
  });
});

describe("admin session and request checks", () => {
  it("round trips only exact unexpired admin envelopes", async () => {
    const now = new Date("2030-01-01T00:00:00.000Z");
    const session = createAdminSession({ method: "password", subject: "password-admin" }, 60, now);
    const encrypted = await encryptAdminSession(session, SECRET);
    expect(await decryptAdminSession(encrypted, SECRET, new Date(now.getTime() + 30_000))).toEqual(session);
    await expect(decryptAdminSession(encrypted, "x".repeat(32), now)).rejects.toThrow("Admin session is invalid");
    await expect(decryptAdminSession(encrypted, SECRET, new Date(now.getTime() + 60_000))).rejects.toThrow("Admin session is invalid");
  });

  it("rejects cross-purpose session and OAuth envelopes", async () => {
    const now = new Date("2030-01-01T00:00:00.000Z");
    const sessionToken = await encryptAdminSession(createAdminSession({ method: "password", subject: "password-admin" }, 600, now), SECRET);
    const authorization = await createOAuthAuthorization("github", SECRET, "client", "/admin", now);
    const state = new URL(authorization.url).searchParams.get("state")!;
    await expect(decryptOAuthState(sessionToken, SECRET, "github", state, new Date(now.getTime() + 1_000))).rejects.toThrow("OAuth state is invalid");
    await expect(decryptAdminSession(authorization.stateCookieValue, SECRET, new Date(now.getTime() + 1_000))).rejects.toThrow("Admin session is invalid");
  });

  it("uses isolated production cookies and clears them", () => {
    expect(buildAdminSessionCookie("token", 3600, true)).toBe("hyeboard_admin=token; Max-Age=3600; Path=/api/admin; HttpOnly; SameSite=Lax; Secure");
    expect(buildClearAdminSessionCookie(true)).toContain("Max-Age=0");
    expect(buildClearAdminSessionCookie(false)).not.toContain("Secure");

    expect(buildOAuthStateCookie("state-token", true)).toBe("hyeboard_admin_oauth=state-token; Max-Age=600; Path=/api/admin; HttpOnly; SameSite=Lax; Secure");
    expect(buildClearOAuthStateCookie(true)).toBe("hyeboard_admin_oauth=; Max-Age=0; Path=/api/admin; HttpOnly; SameSite=Lax; Secure");
    expect(buildOAuthStateCookie("state-token", false)).not.toContain("Secure");
    expect(buildClearOAuthStateCookie(false)).not.toContain("Secure");
  });

  it("requires exact Origin, CSRF, and JSON; student Bearer is never admin", async () => {
    const now = new Date("2030-01-01T00:00:00.000Z");
    const session = createAdminSession({ method: "password", subject: "password-admin" }, 60, now);
    const token = await encryptAdminSession(session, SECRET);
    const headers = { Origin: "https://admin.example.test", "Content-Type": "application/json; charset=utf-8", "X-Hyeboard-CSRF": session.csrfToken };
    const request = new Request("https://api.example.test/api/admin/policy", { method: "POST", headers });
    expect(() => assertAdminMutation(request, session, "https://admin.example.test")).not.toThrow();
    for (const invalidHeaders of [
      { ...headers, Origin: "https://evil.example.test" },
      { ...headers, "X-Hyeboard-CSRF": "wrong" },
      { ...headers, "Content-Type": "text/plain" },
    ]) expect(() => assertAdminMutation(new Request(request.url, { method: "POST", headers: invalidHeaders }), session, "https://admin.example.test")).toThrow("unauthorized");
    const bearerRequest = new Request(request.url, { headers: { Authorization: "Bearer student-token", Cookie: `hyeboard_admin=${token}` } });
    await expect(authenticateAdminRequest(bearerRequest, SECRET, now)).rejects.toThrow("unauthorized");
  });
});

describe("admin OAuth", () => {
  it("derives the exact RFC 7636 S256 challenge", async () => {
    await expect(derivePkceS256Challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
      .resolves.toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("creates provider-bound PKCE state with /admin-only return paths", async () => {
    const callbackUrl = adminOAuthCallbackUrl("https://admin.example.test", "github");
    const authorization = await createOAuthAuthorization("github", SECRET, "client", "/admin/history", new Date("2030-01-01T00:00:00.000Z"), callbackUrl);
    const url = new URL(authorization.url);
    expect(url.searchParams.get("redirect_uri")).toBe(callbackUrl);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const stateValue = url.searchParams.get("state")!;
    const state = await decryptOAuthState(authorization.stateCookieValue, SECRET, "github", stateValue, new Date("2030-01-01T00:01:00.000Z"));
    expect(state.returnPath).toBe("/admin/history");
    await expect(decryptOAuthState(authorization.stateCookieValue, SECRET, "discord", stateValue, new Date("2030-01-01T00:01:00.000Z"))).rejects.toThrow("OAuth state is invalid");
    await expect(decryptOAuthState(authorization.stateCookieValue, SECRET, "github", stateValue, new Date("2030-01-01T00:10:00.000Z"))).rejects.toThrow("OAuth state is invalid");
    await expect(createOAuthAuthorization("github", SECRET, "client", "//evil.test", new Date())).rejects.toThrow("OAuth state is invalid");
  });

  it("exchanges server-side and authorizes immutable numeric IDs only", async () => {
    const calls: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = String(input); calls.push(url);
      if (url.includes("login/oauth/access_token")) return Response.json({ access_token: "private-token" });
      return Response.json({ id: 42, login: "display" });
    };
    const actor = await exchangeOAuthCode("github", { clientId: "id", clientSecret: "secret", allowedIds: ["42"] }, "code", "verifier", "https://app.test/api/admin/oauth/github/callback", fetcher);
    expect(actor).toEqual({ method: "github", subject: "42", label: "display" });
    expect(JSON.stringify(calls)).not.toContain("private-token");

    const usernameOnly: typeof fetch = async (input) => String(input).includes("access_token")
      ? Response.json({ access_token: "private-token" })
      : Response.json({ login: "42" });
    await expect(exchangeOAuthCode("github", { clientId: "id", clientSecret: "secret", allowedIds: ["42"] }, "code", "verifier", "https://app.test/callback", usernameOnly)).rejects.toThrow("unauthorized");

    const discordFetch: typeof fetch = async (input) => String(input).includes("/token")
      ? Response.json({ access_token: "private-token" })
      : Response.json({ id: "7", username: "display" });
    await expect(exchangeOAuthCode("discord", { clientId: "id", clientSecret: "secret", allowedIds: ["8"] }, "code", "verifier", "https://app.test/callback", discordFetch)).rejects.toThrow("unauthorized");
    await expect(exchangeOAuthCode("discord", { clientId: "id", clientSecret: "secret", allowedIds: ["7"] }, "code", "verifier", "https://app.test/callback", discordFetch)).resolves.toEqual({ method: "discord", subject: "7", label: "display" });
  });
});
