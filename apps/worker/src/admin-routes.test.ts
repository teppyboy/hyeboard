import { encryptSession, fail } from "@hyeboard/core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminPasswordHash } from "./admin-auth";
import { createApp, setAdminLoginRateLimit, setFeaturePolicyRuntime, setRuntimeConfig } from "./app";
import { FeaturePolicyRuntime, InProcessFeaturePolicyEvents, MemoryFeaturePolicyStore, type FeaturePolicyStore } from "./feature-policy-store";

const SESSION_SECRET = "student-session-secret-student-session-secret";
const ADMIN_SECRET = "admin-session-secret-admin-session-secret";
const PASSWORD = "synthetic-admin-password";
let passwordHash = "";
let runtime: FeaturePolicyRuntime;
let app: ReturnType<typeof createApp>;
let peerIp: string;

beforeAll(async () => {
  passwordHash = await createAdminPasswordHash(PASSWORD, new Uint8Array(16).fill(9));
});

beforeEach(() => {
  runtime = new FeaturePolicyRuntime(new MemoryFeaturePolicyStore(), new InProcessFeaturePolicyEvents());
  setFeaturePolicyRuntime(runtime);
  setAdminLoginRateLimit({ consume: vi.fn().mockResolvedValue({ allowed: true }) });
  setRuntimeConfig({
    HYEB_SESSION_SECRET: SESSION_SECRET,
    HYEB_ADMIN_SESSION_SECRET: ADMIN_SECRET,
    HYEB_ADMIN_PASSWORD_HASH: passwordHash,
  });
  peerIp = "192.0.2.10";
  app = createApp(undefined, { clientIp: () => peerIp });
});

afterEach(async () => {
  vi.useRealTimers();
  setAdminLoginRateLimit(undefined);
  setFeaturePolicyRuntime(undefined);
  await runtime.close();
});

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  return app.handle(new Request(`http://localhost${path}`, init));
}

async function requestUrl(url: string, init: RequestInit = {}): Promise<Response> {
  return app.handle(new Request(url, init));
}

async function login(password = PASSWORD, headers: HeadersInit = {}): Promise<Response> {
  return request("/api/admin/login/password", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ password }),
  });
}

async function adminAuth(): Promise<{ cookie: string; csrf: string }> {
  const response = await login();
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")!.split(";", 1)[0]!;
  const body = await response.json() as { data: { csrfToken: string } };
  return { cookie, csrf: body.data.csrfToken };
}

function mutationHeaders(auth: { cookie: string; csrf: string }, origin = "http://localhost"): HeadersInit {
  return { Cookie: auth.cookie, Origin: origin, "X-Hyeboard-CSRF": auth.csrf, "Content-Type": "application/json" };
}

function emptyPolicy() {
  return { global: { capabilities: {}, limits: {} }, universities: {} };
}

describe("admin routes", () => {
  it("reports anonymous session, configured methods only, and no-store", async () => {
    const response = await request("/api/admin/session");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ data: { authenticated: false, methods: ["password"] }, error: null });
    const unavailableMethod = await request("/api/admin/oauth/github/start");
    expect(unavailableMethod.status).toBe(404);
    expect(unavailableMethod.headers.get("Cache-Control")).toBe("no-store");
    const invalid = await request("/api/admin/session", { headers: { Cookie: "hyeboard_admin=invalid" } });
    expect(invalid.status).toBe(200);
    expect(invalid.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("keeps one peer in one canonical rate-limit bucket despite spoofed forwarding headers", async () => {
    const consume = vi.fn().mockResolvedValue({ allowed: true });
    setAdminLoginRateLimit({ consume });

    await login("wrong-password", { "CF-Connecting-IP": "198.51.100.1", "X-Forwarded-For": "203.0.113.1" });
    await login("wrong-password", { "CF-Connecting-IP": "198.51.100.2", "X-Forwarded-For": "203.0.113.2" });
    expect(consume.mock.calls[1]?.[0]).toBe(consume.mock.calls[3]?.[0]);

    peerIp = "2001:0db8:0:0:0:0:0:1";
    await login("wrong-password");
    peerIp = "2001:db8::1";
    await login("wrong-password");
    expect(consume.mock.calls[5]?.[0]).toBe(consume.mock.calls[7]?.[0]);
  });

  it("stops before the per-IP bucket when the global login bucket is denied", async () => {
    const consume = vi.fn().mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });
    setAdminLoginRateLimit({ consume });

    expect((await login()).status).toBe(429);
    peerIp = "192.0.2.11";
    expect((await login()).status).toBe(429);

    expect(consume).toHaveBeenCalledTimes(2);
    expect(consume.mock.calls[0]?.[0]).toBe(consume.mock.calls[1]?.[0]);
  });

  it("purges expired process-local login buckets during consumption", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    setAdminLoginRateLimit(undefined);

    for (let attempt = 0; attempt < 5; attempt += 1) expect((await login("wrong-password")).status).toBe(401);
    vi.setSystemTime(new Date("2026-01-01T00:15:01Z"));
    peerIp = "192.0.2.11";
    expect((await login("wrong-password")).status).toBe(401);

    vi.setSystemTime(new Date("2026-01-01T00:10:00Z"));
    peerIp = "192.0.2.10";
    expect((await login("wrong-password")).status).toBe(401);
  });

  it("derives every admin cookie Secure attribute from canonical public origin or the direct URL only", async () => {
    setRuntimeConfig({
      HYEB_SESSION_SECRET: SESSION_SECRET,
      HYEB_ADMIN_SESSION_SECRET: ADMIN_SECRET,
      HYEB_ADMIN_PASSWORD_HASH: passwordHash,
      HYEB_ADMIN_PUBLIC_ORIGIN: "https://admin.example.test",
      HYEB_ADMIN_GITHUB_CLIENT_ID: "client",
      HYEB_ADMIN_GITHUB_CLIENT_SECRET: "secret",
      HYEB_ADMIN_GITHUB_IDS: "42",
    });
    app = createApp(undefined, { clientIp: () => peerIp });

    const secureLogin = await login();
    expect(secureLogin.headers.get("set-cookie")).toContain("; Secure");
    const secureBody = await secureLogin.json() as { data: { csrfToken: string } };
    const secureCookie = secureLogin.headers.get("set-cookie")!.split(";", 1)[0]!;
    const invalid = await request("/api/admin/session", { headers: { Cookie: "hyeboard_admin=invalid", "X-Forwarded-Proto": "http" } });
    expect(invalid.headers.get("set-cookie")).toContain("; Secure");

    const start = await request("/api/admin/oauth/github/start", { headers: { "X-Forwarded-Proto": "http" } });
    expect(start.headers.get("set-cookie")).toContain("; Secure");
    const location = new URL(start.headers.get("Location")!);
    const stateCookie = start.headers.get("set-cookie")!.split(";", 1)[0]!;
    const oauthFetch: typeof fetch = vi.fn(async (input) => String(input).includes("access_token")
      ? Response.json({ access_token: "provider-token" })
      : Response.json({ id: 42, login: "admin" }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = oauthFetch;
    try {
      const callback = await request(`/api/admin/oauth/github/callback?code=code&state=${location.searchParams.get("state")}`, {
        headers: { Cookie: stateCookie, "X-Forwarded-Proto": "http" },
      });
      expect(callback.headers.get("set-cookie")?.match(/; Secure/g)).toHaveLength(2);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const logout = await request("/api/admin/logout", {
      method: "POST",
      headers: mutationHeaders({ cookie: secureCookie, csrf: secureBody.data.csrfToken }, "https://admin.example.test"),
      body: "{}",
    });
    expect(logout.headers.get("set-cookie")).toContain("; Secure");

    setRuntimeConfig({
      HYEB_SESSION_SECRET: SESSION_SECRET,
      HYEB_ADMIN_SESSION_SECRET: ADMIN_SECRET,
      HYEB_ADMIN_PASSWORD_HASH: passwordHash,
      HYEB_ADMIN_PUBLIC_ORIGIN: "http://localhost",
    });
    app = createApp(undefined, { clientIp: () => peerIp });
    expect((await login()).headers.get("set-cookie")).not.toContain("; Secure");

    setRuntimeConfig({
      HYEB_SESSION_SECRET: SESSION_SECRET,
      HYEB_ADMIN_SESSION_SECRET: ADMIN_SECRET,
      HYEB_ADMIN_PASSWORD_HASH: passwordHash,
    });
    app = createApp(undefined, { clientIp: () => peerIp });
    expect((await requestUrl("https://localhost/api/admin/login/password", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "http" },
      body: JSON.stringify({ password: PASSWORD }),
    })).headers.get("set-cookie")).toContain("; Secure");
    expect((await login(PASSWORD, { "X-Forwarded-Proto": "https" })).headers.get("set-cookie")).not.toContain("; Secure");
  });

  it("rate limits HMAC buckets, sets only admin cookie, and returns one generic login failure", async () => {
    const consume = vi.fn().mockResolvedValue({ allowed: true });
    setAdminLoginRateLimit({ consume });
    const response = await login();
    expect(response.headers.get("set-cookie")).toMatch(/^hyeboard_admin=/);
    expect(response.headers.get("set-cookie")).not.toContain("hyeboard_admin_oauth");
    expect(consume).toHaveBeenCalledTimes(2);
    for (const [bucket] of consume.mock.calls) expect(bucket).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(consume.mock.calls)).not.toContain("192.0.2.10");
    expect(JSON.stringify(consume.mock.calls)).not.toContain(PASSWORD);

    const wrong = await login("wrong-password");
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ data: null, error: { code: "ADMIN_LOGIN_FAILED", message: "Sign-in failed." } });

    setAdminLoginRateLimit({ consume: vi.fn().mockResolvedValue({ allowed: false, retryAfterSeconds: 30 }) });
    const limited = await login();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ data: null, error: { code: "ADMIN_LOGIN_RATE_LIMITED", message: "Sign-in failed.", details: { retryAfterSeconds: 30 } } });
  });

  it("requires admin cookie for reads and exact Origin plus CSRF for mutations", async () => {
    const unauthenticated = await request("/api/admin/policy");
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("Cache-Control")).toBe("no-store");

    const auth = await adminAuth();
    const policy = await request("/api/admin/policy", { headers: { Cookie: auth.cookie } });
    expect(policy.status).toBe(200);
    expect((await policy.json() as { data: { snapshot: { revision: number } } }).data.snapshot.revision).toBe(0);

    for (const headers of [
      { Cookie: auth.cookie, "Content-Type": "application/json", "X-Hyeboard-CSRF": auth.csrf },
      mutationHeaders(auth, "https://evil.test"),
      { ...mutationHeaders(auth), "X-Hyeboard-CSRF": "wrong" },
    ]) {
      const response = await request("/api/admin/policy/validate", { method: "POST", headers, body: JSON.stringify(emptyPolicy()) });
      expect(response.status).toBe(401);
    }
  });

  it("fails admin policy reads explicitly while student enforcement retains last-known-good", async () => {
    const memory = new MemoryFeaturePolicyStore();
    let unavailable = false;
    const store: FeaturePolicyStore = {
      current: async () => {
        if (unavailable) throw new Error("store unavailable");
        return memory.current();
      },
      publish: (input) => memory.publish(input),
      history: async (input) => {
        if (unavailable) throw new Error("store unavailable");
        return memory.history(input);
      },
      revision: async (revision) => {
        if (unavailable) throw new Error("store unavailable");
        return memory.revision(revision);
      },
    };
    await runtime.close();
    runtime = new FeaturePolicyRuntime(store, new InProcessFeaturePolicyEvents());
    setFeaturePolicyRuntime(runtime);
    expect((await runtime.current()).revision).toBe(0);
    unavailable = true;
    expect((await runtime.current()).revision).toBe(0);

    const auth = await adminAuth();
    for (const path of ["/api/admin/policy", "/api/admin/policy/history", "/api/admin/policy/history/1"]) {
      const response = await request(path, { headers: { Cookie: auth.cookie } });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual(fail("FEATURE_POLICY_UNAVAILABLE", "Feature policy is unavailable."));
    }
  });

  it("validates complete policy, derives actor/time, returns typed stale 409, and bounds newest-first history", async () => {
    const auth = await adminAuth();
    const validate = await request("/api/admin/policy/validate", {
      method: "POST", headers: mutationHeaders(auth), body: JSON.stringify(emptyPolicy()),
    });
    expect(validate.status).toBe(200);
    const incomplete = await request("/api/admin/policy/validate", {
      method: "POST", headers: mutationHeaders(auth), body: JSON.stringify({ global: { capabilities: {} }, universities: {} }),
    });
    expect(incomplete.status).toBe(400);

    const first = await request("/api/admin/policy/publish", {
      method: "POST",
      headers: mutationHeaders(auth),
      body: JSON.stringify({ baseRevision: 0, policy: emptyPolicy(), reason: "first" }),
    });
    expect(first.status).toBe(200);
    const firstEntry = (await first.json() as { data: { actor: { method: string }; publishedAt: string } }).data;
    expect(firstEntry.actor.method).toBe("password");
    expect(Number.isFinite(Date.parse(firstEntry.publishedAt))).toBe(true);

    const stale = await request("/api/admin/policy/publish", {
      method: "POST",
      headers: mutationHeaders(auth),
      body: JSON.stringify({ baseRevision: 0, policy: emptyPolicy(), reason: "stale" }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ data: null, error: { code: "ADMIN_POLICY_CONFLICT", message: "Feature policy changed before publication.", details: { currentRevision: 1 } } });

    for (let revision = 1; revision <= 3; revision += 1) {
      await request("/api/admin/policy/publish", {
        method: "POST",
        headers: mutationHeaders(auth),
        body: JSON.stringify({ baseRevision: revision, policy: emptyPolicy(), reason: `revision-${revision + 1}` }),
      });
    }
    const history = await request("/api/admin/policy/history?limit=999", { headers: { Cookie: auth.cookie } });
    const page = (await history.json() as { data: { items: Array<{ revision: number }> } }).data;
    expect(page.items.map(({ revision }) => revision)).toEqual([4, 3, 2, 1]);
    const revision = await request("/api/admin/policy/history/2", { headers: { Cookie: auth.cookie } });
    expect((await revision.json() as { data: { revision: number } }).data.revision).toBe(2);
  });

  it("rolls back with server actor and exposes revision-only admin/student streams", async () => {
    const auth = await adminAuth();
    for (let baseRevision = 0; baseRevision < 2; baseRevision += 1) {
      await request("/api/admin/policy/publish", {
        method: "POST",
        headers: mutationHeaders(auth),
        body: JSON.stringify({
          baseRevision,
          policy: baseRevision === 0 ? emptyPolicy() : { ...emptyPolicy(), global: { capabilities: { grades: { enabled: false } }, limits: {} } },
          reason: `publish-${baseRevision + 1}`,
        }),
      });
    }
    const rollback = await request("/api/admin/policy/rollback", {
      method: "POST",
      headers: mutationHeaders(auth),
      body: JSON.stringify({ baseRevision: 2, targetRevision: 1, reason: "restore" }),
    });
    expect(rollback.status).toBe(200);
    expect((await rollback.json() as { data: { revision: number; actor: { method: string } } }).data).toMatchObject({ revision: 3, actor: { method: "password" } });

    const adminStream = await request("/api/admin/policy/events", { headers: { Cookie: auth.cookie } });
    expect(adminStream.headers.get("Content-Type")).toContain("text/event-stream");
    const adminReader = adminStream.body!.getReader();
    expect(new TextDecoder().decode((await adminReader.read()).value)).toBe("event: revision\ndata: 3\n\n");
    const nextAdmin = adminReader.read();
    await runtime.publish({ baseRevision: 3, policy: emptyPolicy(), reason: "stream", actor: { method: "password", subject: "test" } });
    expect(new TextDecoder().decode((await nextAdmin).value)).toBe("event: revision\ndata: 4\n\n");
    await adminReader.cancel();

    const studentToken = await encryptSession({ version: 1, universityId: "mock", expiresAt: "2099-01-01T00:00:00.000Z" }, SESSION_SECRET);
    const studentStream = await request("/api/policy/events", { headers: { Authorization: `Bearer ${studentToken}` } });
    const studentReader = studentStream.body!.getReader();
    expect(new TextDecoder().decode((await studentReader.read()).value)).toBe("event: revision\ndata: 4\n\n");
    const nextStudent = studentReader.read();
    await runtime.publish({ baseRevision: 4, policy: emptyPolicy(), reason: "student-stream", actor: { method: "password", subject: "test" } });
    expect(new TextDecoder().decode((await nextStudent).value)).toBe("event: revision\ndata: 5\n\n");
    await studentReader.cancel();

    const missingStudent = await request("/api/policy/events");
    expect(missingStudent.status).toBe(401);
    expect(await missingStudent.json()).toEqual(fail("MISSING_SESSION", "Missing Authorization bearer token"));
  });

  it.each([
    ["github", "GITHUB", "https://github.com/login/oauth/authorize", (input: unknown) => String(input).includes("access_token")],
    ["discord", "DISCORD", "https://discord.com/oauth2/authorize", (input: unknown) => String(input).includes("/token")],
  ] as const)("completes configured %s PKCE OAuth and clears provider state", async (provider, envName, authorizationOrigin, isTokenRequest) => {
    setRuntimeConfig({
      HYEB_SESSION_SECRET: SESSION_SECRET,
      HYEB_ADMIN_SESSION_SECRET: ADMIN_SECRET,
      HYEB_ADMIN_PUBLIC_ORIGIN: "http://localhost",
      [`HYEB_ADMIN_${envName}_CLIENT_ID`]: "client",
      [`HYEB_ADMIN_${envName}_CLIENT_SECRET`]: "secret",
      [`HYEB_ADMIN_${envName}_IDS`]: "42",
    });
    const oauthFetch: typeof fetch = vi.fn(async (input) => isTokenRequest(input)
      ? Response.json({ access_token: "provider-token" })
      : Response.json({ id: 42, login: "admin", username: "admin" }));
    const oauthApp = createApp(undefined);
    const start = await oauthApp.handle(new Request(`http://localhost/api/admin/oauth/${provider}/start?returnPath=/admin/history`));
    expect(start.status).toBe(302);
    expect(start.headers.get("Cache-Control")).toBe("no-store");
    const location = new URL(start.headers.get("Location")!);
    expect(location.origin + location.pathname).toBe(authorizationOrigin);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    const state = location.searchParams.get("state")!;
    const stateCookie = start.headers.get("set-cookie")!.split(";", 1)[0]!;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = oauthFetch;
    try {
      const callback = await oauthApp.handle(new Request(`http://localhost/api/admin/oauth/${provider}/callback?code=code&state=${state}`, { headers: { Cookie: stateCookie } }));
      expect(callback.status).toBe(302);
      expect(callback.headers.get("Location")).toBe("http://localhost/admin/history");
      expect(callback.headers.get("set-cookie")).toContain("hyeboard_admin=");
      expect(callback.headers.get("set-cookie")).toContain("hyeboard_admin_oauth=;");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
