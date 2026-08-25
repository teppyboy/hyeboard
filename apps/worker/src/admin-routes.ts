import { fail, HyeboardError, ok } from "@hyeboard/core";
import {
  publishFeaturePolicySchema,
  rollbackFeaturePolicySchema,
  type AdminPolicyView,
  type FeaturePolicyContent,
  type OperationalLimitKey,
  type University,
} from "@hyeboard/schemas";
import { listUniversities } from "@hyeboard/university-adapters";
import {
  adminOAuthCallbackUrl,
  assertAdminMutation,
  authenticateAdminRequest,
  buildAdminSessionCookie,
  buildClearAdminSessionCookie,
  buildClearOAuthStateCookie,
  buildOAuthStateCookie,
  createAdminSession,
  createOAuthAuthorization,
  decryptOAuthState,
  encryptAdminSession,
  exchangeOAuthCode,
  readCookie,
  verifyAdminPassword,
  type OAuthProvider,
} from "./admin-auth";
import type { AdminAuthConfig } from "./admin-config";
import { effectiveUniversity, validatePolicy } from "./feature-policy";
import type { FeaturePolicyRuntime } from "./feature-policy-store";

const LOGIN_LIMIT = 5;
const GLOBAL_LOGIN_LIMIT = 100;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const OAUTH_COOKIE = "hyeboard_admin_oauth";

export interface AdminLoginRateLimit {
  consume(bucketHash: string, limit: number, windowMs: number): Promise<{ allowed: boolean; retryAfterSeconds?: number }>;
}

export type AdminRoutesDependencies = {
  runtime: () => FeaturePolicyRuntime;
  config: () => AdminAuthConfig;
  rateLimit: AdminLoginRateLimit;
  clientIp: (request: Request) => string | undefined;
  authenticateStudent: (request: Request) => Promise<unknown>;
  nativeUniversities?: () => University[];
  hardLimits?: () => Partial<Record<OperationalLimitKey, number>>;
  fetch?: () => typeof fetch;
};

type RouteContext = { request: Request; params?: Record<string, string>; query?: Record<string, string | undefined> };
type RouteRegistrar = {
  get(path: string, handler: (context: RouteContext) => unknown): RouteRegistrar;
  post(path: string, handler: (context: RouteContext) => unknown): RouteRegistrar;
};

export function registerAdminRoutes(app: RouteRegistrar, dependencies: AdminRoutesDependencies): void {
  const fetcher = dependencies.fetch ?? (() => fetch);
  const nativeUniversities = dependencies.nativeUniversities ?? listUniversities;
  const hardLimits = dependencies.hardLimits ?? (() => ({}));

  app
    .get("/api/admin/session", async ({ request }: { request: Request }) => {
      const config = dependencies.config();
      if (request.headers.has("Authorization")) return json(ok({ authenticated: false, methods: config.methods }));
      const token = readCookie(request, "hyeboard_admin");
      if (!token) return json(ok({ authenticated: false, methods: config.methods }));
      try {
        const session = await authenticateAdminRequest(request, config.sessionSecret);
        return json(ok({ authenticated: true, actor: session.actor, csrfToken: session.csrfToken, methods: config.methods }));
      } catch {
        return json(ok({ authenticated: false, methods: config.methods }), {
          "Set-Cookie": buildClearAdminSessionCookie(isSecure(request, config)),
        });
      }
    })
    .post("/api/admin/login/password", async ({ request }: { request: Request }) => {
      const config = dependencies.config();
      if (!config.passwordHash) throw notFound();
      let body: Record<string, unknown>;
      try { body = await readJsonObject(request); } catch { throw loginFailed(); }
      const password = body.password;
      if (typeof password !== "string" || password.length === 0) throw loginFailed();
      await checkLoginLimit(request, config.sessionSecret, dependencies.rateLimit, dependencies.clientIp);
      if (!await verifyAdminPassword(password, config.passwordHash)) throw loginFailed();
      const session = createAdminSession({ method: "password", subject: "password-admin" }, config.sessionTtlSeconds);
      const token = await encryptAdminSession(session, config.sessionSecret);
      return json(ok({ authenticated: true, actor: session.actor, csrfToken: session.csrfToken, methods: config.methods }), {
        "Set-Cookie": buildAdminSessionCookie(token, config.sessionTtlSeconds, isSecure(request, config)),
      });
    })
    .get("/api/admin/oauth/:provider/start", async ({ params = {}, query = {}, request }) => {
      const config = dependencies.config();
      const provider = configuredProvider(params.provider ?? "", config);
      const redirectUri = adminOAuthCallbackUrl(config.publicOrigin!, provider);
      const authorization = await createOAuthAuthorization(
        provider,
        config.sessionSecret,
        config[provider]!.clientId,
        typeof query.returnPath === "string" ? query.returnPath : "/admin",
        new Date(),
        redirectUri,
      );
      return new Response(null, {
        status: 302,
        headers: noStoreHeaders({ Location: authorization.url, "Set-Cookie": buildOAuthStateCookie(authorization.stateCookieValue, isSecure(request, config)) }),
      });
    })
    .get("/api/admin/oauth/:provider/callback", async ({ params = {}, query = {}, request }) => {
      const config = dependencies.config();
      const provider = configuredProvider(params.provider ?? "", config);
      const code = typeof query.code === "string" ? query.code : "";
      const stateValue = typeof query.state === "string" ? query.state : "";
      const stateCookie = readCookie(request, OAUTH_COOKIE);
      if (!stateCookie) throw loginFailed();
      try {
        const state = await decryptOAuthState(stateCookie, config.sessionSecret, provider, stateValue);
        const actor = await exchangeOAuthCode(provider, config[provider]!, code, state.verifier, adminOAuthCallbackUrl(config.publicOrigin!, provider), fetcher());
        const session = createAdminSession(actor, config.sessionTtlSeconds);
        const token = await encryptAdminSession(session, config.sessionSecret);
        const headers = noStoreHeaders({ Location: `${config.publicOrigin}${state.returnPath}` });
        headers.append("Set-Cookie", buildAdminSessionCookie(token, config.sessionTtlSeconds, isSecure(request, config)));
        headers.append("Set-Cookie", buildClearOAuthStateCookie(isSecure(request, config)));
        return new Response(null, { status: 302, headers });
      } catch {
        return json(fail("ADMIN_LOGIN_FAILED", "Sign-in failed."), {
          "Set-Cookie": buildClearOAuthStateCookie(isSecure(request, config)),
        }, 401);
      }
    })
    .post("/api/admin/logout", async ({ request }: { request: Request }) => {
      const config = dependencies.config();
      const session = await requireAdmin(request, config);
      requireAdminMutation(request, session, config.publicOrigin);
      await readJsonObject(request);
      return json(ok({ authenticated: false }), { "Set-Cookie": buildClearAdminSessionCookie(isSecure(request, config)) });
    })
    .get("/api/admin/policy", async ({ request }: { request: Request }) => {
      const config = dependencies.config();
      await requireAdmin(request, config);
      const native = nativeUniversities();
      const limits = hardLimits();
      const snapshot = await dependencies.runtime().currentAuthoritative();
      const view: AdminPolicyView = {
        snapshot,
        nativeUniversities: native,
        effectiveUniversities: native.map((university) => effectiveUniversity(university, snapshot, limits)),
        hardLimits: limits,
      };
      return json(ok(view));
    })
    .post("/api/admin/policy/validate", async ({ request }: { request: Request }) => {
      const config = dependencies.config();
      const session = await requireAdmin(request, config);
      requireAdminMutation(request, session, config.publicOrigin);
      const policy = validateCompletePolicy(await readJsonObject(request), nativeUniversities(), hardLimits());
      return json(ok({ policy }));
    })
    .post("/api/admin/policy/publish", async ({ request }: { request: Request }) => {
      const config = dependencies.config();
      const session = await requireAdmin(request, config);
      requireAdminMutation(request, session, config.publicOrigin);
      const input = parseMutation(publishFeaturePolicySchema, await readJsonObject(request));
      return json(ok(await dependencies.runtime().publish({ ...input, actor: session.actor })));
    })
    .get("/api/admin/policy/history", async ({ request, query = {} }) => {
      const config = dependencies.config();
      await requireAdmin(request, config);
      return json(ok(await dependencies.runtime().history({
        limit: canonicalPositiveInteger(query.limit, 25),
        ...(query.beforeRevision === undefined ? {} : { beforeRevision: canonicalPositiveInteger(query.beforeRevision) }),
      })));
    })
    .get("/api/admin/policy/history/:revision", async ({ params = {}, request }) => {
      const config = dependencies.config();
      await requireAdmin(request, config);
      const revision = canonicalPositiveInteger(params.revision);
      const entry = await dependencies.runtime().revision(revision);
      if (!entry) throw new HyeboardError("ADMIN_POLICY_REVISION_NOT_FOUND", "Feature policy revision was not found.", 404, { targetRevision: revision });
      return json(ok(entry));
    })
    .post("/api/admin/policy/rollback", async ({ request }: { request: Request }) => {
      const config = dependencies.config();
      const session = await requireAdmin(request, config);
      requireAdminMutation(request, session, config.publicOrigin);
      const input = parseMutation(rollbackFeaturePolicySchema, await readJsonObject(request));
      return json(ok(await dependencies.runtime().rollback({ ...input, actor: session.actor })));
    })
    .get("/api/admin/policy/events", async ({ request }: { request: Request }) => {
      const config = dependencies.config();
      await requireAdmin(request, config);
      return dependencies.runtime().stream(lastRevision(request), request.signal);
    })
    .get("/api/policy/events", async ({ request }: { request: Request }) => {
      await dependencies.authenticateStudent(request);
      return dependencies.runtime().stream(lastRevision(request), request.signal);
    });
}

function validateCompletePolicy(value: unknown, universities: readonly University[], limits: Partial<Record<OperationalLimitKey, number>>): FeaturePolicyContent {
  return validatePolicy(value as FeaturePolicyContent, universities, limits);
}

async function requireAdmin(request: Request, config: AdminAuthConfig) {
  try {
    return await authenticateAdminRequest(request, config.sessionSecret);
  } catch {
    throw unauthorized();
  }
}

function requireAdminMutation(request: Request, session: Awaited<ReturnType<typeof authenticateAdminRequest>>, allowedOrigin?: string): void {
  try {
    assertAdminMutation(request, session, allowedOrigin);
  } catch {
    throw unauthorized();
  }
}

function configuredProvider(value: string, config: AdminAuthConfig): OAuthProvider {
  if ((value === "github" || value === "discord") && config[value] && config.publicOrigin) return value;
  throw notFound();
}

async function checkLoginLimit(
  request: Request,
  secret: string,
  limiter: AdminLoginRateLimit,
  clientIp: AdminRoutesDependencies["clientIp"],
): Promise<void> {
  const global = await limiter.consume(await hmacHex(secret, "global"), GLOBAL_LOGIN_LIMIT, LOGIN_WINDOW_MS);
  if (!global.allowed) throw loginRateLimited(global.retryAfterSeconds);
  const address = await limiter.consume(await hmacHex(secret, canonicalClientIp(clientIp(request))), LOGIN_LIMIT, LOGIN_WINDOW_MS);
  if (!address.allowed) throw loginRateLimited(address.retryAfterSeconds);
}

function canonicalClientIp(value: string | undefined): string {
  const address = value?.trim().toLowerCase();
  if (!address || address.includes("%")) return "unknown";
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(address)) {
    const octets = address.split(".").map(Number);
    return octets.every((octet) => octet <= 255) ? octets.join(".") : "unknown";
  }
  try {
    const hostname = new URL(`http://[${address}]/`).hostname;
    return hostname.slice(1, -1);
  } catch {
    return "unknown";
  }
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HyeboardError("ADMIN_REQUEST_INVALID", "The request was invalid.", 400);
  }
}

function parseMutation<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HyeboardError("ADMIN_POLICY_INVALID", "Feature policy request is invalid.", 400);
  return parsed.data;
}

function canonicalPositiveInteger(value: unknown, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) throw invalidHistory();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw invalidHistory();
  return parsed;
}

function lastRevision(request: Request): number | undefined {
  const value = request.headers.get("Last-Event-ID");
  if (!value || !/^(0|[1-9]\d*)$/.test(value)) return undefined;
  const revision = Number(value);
  return Number.isSafeInteger(revision) ? revision : undefined;
}

function json(value: unknown, headers?: HeadersInit, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: noStoreHeaders(headers) });
}

function noStoreHeaders(headers?: HeadersInit): Headers {
  const result = new Headers(headers);
  result.set("Cache-Control", "no-store");
  if (!result.has("Content-Type") && !result.has("Location")) result.set("Content-Type", "application/json");
  return result;
}

function isSecure(request: Request, config: AdminAuthConfig): boolean {
  return new URL(config.publicOrigin ?? request.url).protocol === "https:";
}

function loginFailed(): HyeboardError { return new HyeboardError("ADMIN_LOGIN_FAILED", "Sign-in failed.", 401); }
function loginRateLimited(retryAfterSeconds?: number): HyeboardError {
  return new HyeboardError("ADMIN_LOGIN_RATE_LIMITED", "Sign-in failed.", 429, { retryAfterSeconds: Math.max(retryAfterSeconds ?? 0, 1) });
}
function unauthorized(): HyeboardError { return new HyeboardError("ADMIN_UNAUTHORIZED", "Admin authentication required.", 401); }
function notFound(): HyeboardError { return new HyeboardError("NOT_FOUND", "Not found.", 404); }
function invalidHistory(): HyeboardError { return new HyeboardError("ADMIN_POLICY_INVALID", "Feature policy history request is invalid.", 400); }
