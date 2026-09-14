import { describe, expect, it } from "vitest";
import { parseAdminConfig } from "./admin-config";
import { createAdminPasswordHash } from "./admin-auth";

const SECRET = "a".repeat(32);

function base(overrides: Record<string, string | undefined> = {}) {
  return { HYEB_ADMIN_SESSION_SECRET: SECRET, ...overrides };
}

function expectSafeConfigError(overrides: Record<string, string | undefined>, key: string, sensitiveValues = Object.values(overrides)): void {
  let thrown: unknown;
  try { parseAdminConfig(base(overrides)); } catch (error) { thrown = error; }
  expect(String(thrown)).toContain(key);
  for (const value of sensitiveValues) if (value) expect(String(thrown)).not.toContain(value);
}

describe("parseAdminConfig", () => {
  it("normalizes canonical settings and reports enabled methods", async () => {
    const passwordHash = await createAdminPasswordHash("synthetic-password", new Uint8Array(16).fill(7));
    const config = parseAdminConfig(base({
      HYEB_ADMIN_SESSION_TTL_SECONDS: "3600",
      HYEB_ADMIN_PUBLIC_ORIGIN: "https://admin.example.test",
      HYEB_ADMIN_DB_PATH: "./data/control.sqlite",
      HYEB_ADMIN_PASSWORD_HASH: passwordHash,
      HYEB_ADMIN_GITHUB_CLIENT_ID: "github-client",
      HYEB_ADMIN_GITHUB_CLIENT_SECRET: "github-secret",
      HYEB_ADMIN_GITHUB_IDS: "42, 7",
    }));

    expect(config).toMatchObject({
      sessionSecret: SECRET,
      sessionTtlSeconds: 3600,
      publicOrigin: "https://admin.example.test",
      databasePath: "./data/control.sqlite",
      methods: ["password", "github"],
      github: { clientId: "github-client", allowedIds: ["42", "7"] },
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("allows zero configured login methods", () => {
    expect(parseAdminConfig(base()).methods).toEqual([]);
  });

  it.each(["GITHUB", "DISCORD"])("accepts bounded %s OAuth client IDs", (provider) => {
    for (const clientId of ["x", "x".repeat(256)]) {
      const config = parseAdminConfig(base({
        HYEB_ADMIN_PUBLIC_ORIGIN: "https://admin.example.test",
        [`HYEB_ADMIN_${provider}_CLIENT_ID`]: clientId,
        [`HYEB_ADMIN_${provider}_CLIENT_SECRET`]: "provider-secret",
        [`HYEB_ADMIN_${provider}_IDS`]: "42",
      }));
      expect(config[provider.toLowerCase() as "github" | "discord"]?.clientId).toBe(clientId);
    }
  });

  it.each(["GITHUB", "DISCORD"])("rejects oversized %s OAuth client ID safely", (provider) => {
    const clientId = "x".repeat(257);
    expectSafeConfigError({
      HYEB_ADMIN_PUBLIC_ORIGIN: "https://admin.example.test",
      [`HYEB_ADMIN_${provider}_CLIENT_ID`]: clientId,
      [`HYEB_ADMIN_${provider}_CLIENT_SECRET`]: "provider-secret",
      [`HYEB_ADMIN_${provider}_IDS`]: "42",
    }, `HYEB_ADMIN_${provider}`, [clientId]);
  });

  it.each([
    "https://admin.example.test",
    "https://admin.example.test:8443",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://[::1]:5173",
  ])("allows canonical public origin %s", (publicOrigin) => {
    expect(parseAdminConfig(base({ HYEB_ADMIN_PUBLIC_ORIGIN: publicOrigin })).publicOrigin).toBe(publicOrigin);
  });

  it.each([
    "https://admin.example.test/",
    "https://admin.example.test/path",
    "https://admin.example.test?mode=admin",
    "https://admin.example.test#login",
    "https://operator@admin.example.test",
    "https://operator:secret@admin.example.test",
    "https://admin.example.test:443",
    "http://admin.example.test",
    "http://192.168.1.10:5173",
    "http://localhost.example.test:5173",
    "http://localhost:80",
  ])("rejects non-canonical public origin %s", (publicOrigin) => {
    expectSafeConfigError({ HYEB_ADMIN_PUBLIC_ORIGIN: publicOrigin }, "HYEB_ADMIN_PUBLIC_ORIGIN");
  });

  it.each([
    [{ HYEB_ADMIN_SESSION_SECRET: "short-private-session-secret" }, "HYEB_ADMIN_SESSION_SECRET"],
    [{ HYEB_ADMIN_SESSION_TTL_SECONDS: "03600" }, "HYEB_ADMIN_SESSION_TTL_SECONDS"],
    [{ HYEB_ADMIN_SESSION_TTL_SECONDS: "9007199254740991" }, "HYEB_ADMIN_SESSION_TTL_SECONDS"],
    [{ HYEB_ADMIN_PUBLIC_ORIGIN: "https://admin.example.test/" }, "HYEB_ADMIN_PUBLIC_ORIGIN"],
    [{ HYEB_ADMIN_GITHUB_CLIENT_ID: "private-github-client" }, "HYEB_ADMIN_GITHUB"],
    [{ HYEB_ADMIN_DISCORD_CLIENT_SECRET: "private-discord-secret" }, "HYEB_ADMIN_DISCORD"],
    [{ HYEB_ADMIN_DB_PATH: "" }, "HYEB_ADMIN_DB_PATH"],
    [{ HYEB_ADMIN_PASSWORD_HASH: "private-bad-password-hash" }, "HYEB_ADMIN_PASSWORD_HASH"],
  ])("rejects malformed config without exposing its value", (overrides, key) => {
    expectSafeConfigError(overrides, key);
  });

  it.each([
    ":memory:",
    "file::memory:",
    "file:memory-db?mode=memory&cache=shared",
    "file:./data/control.sqlite",
    "sqlite://data/control.sqlite",
    "postgres:admin-db",
    "./data/control\0.sqlite",
  ])("rejects non-durable database target %s", (databasePath) => {
    expectSafeConfigError({ HYEB_ADMIN_DB_PATH: databasePath }, "HYEB_ADMIN_DB_PATH");
  });

  it.each([
    ["GITHUB", "private-github-client", "private-github-secret", "42,not-a-numeric-id"],
    ["GITHUB", "private-github-client", "private-github-secret", "42, 7,42"],
    ["DISCORD", "private-discord-client", "private-discord-secret", "007"],
    ["DISCORD", "private-discord-client", "private-discord-secret", "0"],
  ])("rejects malformed %s numeric allowlists without exposing OAuth values", (provider, clientId, clientSecret, ids) => {
    const overrides = {
      HYEB_ADMIN_PUBLIC_ORIGIN: "https://admin.example.test",
      [`HYEB_ADMIN_${provider}_CLIENT_ID`]: clientId,
      [`HYEB_ADMIN_${provider}_CLIENT_SECRET`]: clientSecret,
      [`HYEB_ADMIN_${provider}_IDS`]: ids,
    };
    expectSafeConfigError(overrides, `HYEB_ADMIN_${provider}`, [clientId, clientSecret, ids]);
  });

  it("never exposes paired OAuth, session, or password values in errors", () => {
    const values = {
      HYEB_ADMIN_SESSION_SECRET: "private-short-session-secret",
      HYEB_ADMIN_PASSWORD_HASH: "private-password-hash",
      HYEB_ADMIN_GITHUB_CLIENT_ID: "private-github-client",
      HYEB_ADMIN_GITHUB_CLIENT_SECRET: "private-github-secret",
      HYEB_ADMIN_GITHUB_IDS: "private-github-ids",
      HYEB_ADMIN_DISCORD_CLIENT_ID: "private-discord-client",
      HYEB_ADMIN_DISCORD_CLIENT_SECRET: "private-discord-secret",
      HYEB_ADMIN_DISCORD_IDS: "private-discord-ids",
    };
    for (const [name, value] of Object.entries(values)) {
      expectSafeConfigError({ [name]: value }, name === "HYEB_ADMIN_SESSION_SECRET" ? name : name.replace(/_(CLIENT_ID|CLIENT_SECRET|IDS)$/, ""), [value]);
    }
  });
});
