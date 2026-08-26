import type { FeaturePolicyContent } from "@hyeboard/schemas";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminApiError, adminApi } from "./admin-api";

const emptyPolicy: FeaturePolicyContent = {
  global: { capabilities: {}, limits: {} },
  universities: {},
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("adminApi", () => {
  it("uses only the credentialed admin cookie boundary", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      data: { authenticated: false, methods: ["password"] },
      error: null,
    }));

    await adminApi.session();

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init).toMatchObject({ credentials: "include" });
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
  });

  it("adds JSON and CSRF headers to mutations", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      data: { policy: emptyPolicy },
      error: null,
    }));

    await adminApi.validate(emptyPolicy, "csrf-token");

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify(emptyPolicy));
    expect(init?.credentials).toBe("include");
    expect(new Headers(init?.headers)).toEqual(new Headers({
      "Content-Type": "application/json",
      "X-Hyeboard-CSRF": "csrf-token",
    }));
  });

  it("preserves typed conflict details", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      data: null,
      error: {
        code: "ADMIN_POLICY_CONFLICT",
        message: "Feature policy changed before publication.",
        details: { currentRevision: 7 },
      },
    }, { status: 409 }));

    const error = await adminApi.publish({
      baseRevision: 6,
      policy: emptyPolicy,
      reason: "test conflict",
    }, "csrf-token").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AdminApiError);
    expect(error).toMatchObject({
      code: "ADMIN_POLICY_CONFLICT",
      status: 409,
      details: { currentRevision: 7 },
    });
  });

  it("uses the configured API origin for OAuth starts", async () => {
    vi.stubEnv("VITE_API_BASE_URL", "https://api.example.test");
    vi.resetModules();
    const { adminApi: configuredAdminApi } = await import("./admin-api");

    expect(configuredAdminApi.oauthStartUrl("discord", "/admin/history")).toBe(
      "https://api.example.test/api/admin/oauth/discord/start?returnPath=%2Fadmin%2Fhistory",
    );
  });

  it("exposes the complete admin route surface", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ data: {}, error: null }));

    await adminApi.loginPassword("secret");
    await adminApi.logout("csrf");
    await adminApi.policy();
    await adminApi.history({ limit: 10, beforeRevision: 4 });
    await adminApi.revision(3);
    await adminApi.rollback({ baseRevision: 4, targetRevision: 2, reason: "restore" }, "csrf");
    await adminApi.events(new AbortController().signal, 4);

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/admin/login/password",
      "/api/admin/logout",
      "/api/admin/policy",
      "/api/admin/policy/history?limit=10&beforeRevision=4",
      "/api/admin/policy/history/3",
      "/api/admin/policy/rollback",
      "/api/admin/policy/events",
    ]);
    expect(adminApi.oauthStartUrl("github", "/admin/history")).toBe(
      "/api/admin/oauth/github/start?returnPath=%2Fadmin%2Fhistory",
    );
    expect(new Headers(fetchMock.mock.calls.at(-1)?.[1]?.headers).get("Last-Event-ID")).toBe("4");
  });
});
