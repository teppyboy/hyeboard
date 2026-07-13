import { cors } from "@elysiajs/cors";
import { decryptSession, encryptSession, fail, getLogger, HyeboardError, isExpired, ok, parseBearerToken, type EncryptedSessionPayload } from "@hyeboard/core";
import { DaotaoClient, getAdapter, listUniversities, type BrowserBinding, type BrowserConnection } from "@hyeboard/university-adapters";
import { Elysia, t } from "elysia";
import { LocalCaptchaRelayCoordinator, captchaRelayCancelled, captchaRelayNotFound, type CaptchaRelayCoordinator, type PreparedCaptchaRelay } from "./captcha-relay";

// ─── Runtime config ───────────────────────────────────────────
// Self-hosted (Node/Bun) loads config from config.json + env var overrides
// (see loadConfigFile below). Cloudflare Workers doesn't use config.json
// (no filesystem) — index.ts calls setRuntimeConfig directly with env var
// values from the `cloudflare:workers` binding.
//
// HYEB_SESSION_SECRET is NEVER read from config.json — only from env vars
// or setRuntimeConfig(), to keep it out of files that might be checked in.
interface RuntimeConfig {
  HYEB_SESSION_SECRET?: string;
  HYEB_ALLOWED_ORIGINS?: string;
  HYEB_BROWSER_WS_ENDPOINT?: string;
  HYEB_BROWSER_LOCAL?: string;
  HYEB_BROWSER_HEADLESS?: string;
  HYEB_CHROME_PATH?: string;
  HYEB_BROWSER_IDLE_EVICTION_MS?: string;
  HYEB_LOG_LEVEL?: string;
  HOST?: string;
  PORT?: string;
  HYEB_STATIC_DIR?: string;
}

let runtimeConfig: RuntimeConfig = {};

export function setRuntimeConfig(config: RuntimeConfig): void {
  runtimeConfig = config;
}

// Read non-secret config from a JSON file (Node/Bun only, no-op on CF Workers).
// The file path defaults to ./config.json relative to cwd, overridable via
// CONFIG_PATH env var. Returns a partial RuntimeConfig — callers merge with
// env vars (which take precedence) before passing to setRuntimeConfig.
//
// HYEB_SESSION_SECRET is intentionally never read from this file. It must
// come from an env var only.
// Structured config.json schema:
//   { "origins": [...], "browser": { "ws_endpoint", "local", "headless",
//     "chrome_path", "idle_eviction_minutes" }, "log_level", "host", "port",
//     "static_dir" }
// See apps/worker/config.json for the full default file.
export async function loadConfigFile(): Promise<RuntimeConfig> {
  const isNode = typeof process !== "undefined" && typeof process.cwd === "function";
  if (!isNode) return {};
  try {
    const configPath = process.env.CONFIG_PATH;
    const { join } = await import("node:path");
    const path = configPath || join(process.cwd(), "config.json");
    const { readFileSync, existsSync } = await import("node:fs");
    if (!existsSync(path)) return {};
    const raw = readFileSync(path, "utf-8");
    const cfg = JSON.parse(raw);
    const r: RuntimeConfig = {};
    if (Array.isArray(cfg.origins)) r.HYEB_ALLOWED_ORIGINS = cfg.origins.join(", ");
    if (cfg.browser && typeof cfg.browser === "object") {
      if (typeof cfg.browser.ws_endpoint === "string") r.HYEB_BROWSER_WS_ENDPOINT = cfg.browser.ws_endpoint;
      if (typeof cfg.browser.local === "boolean") r.HYEB_BROWSER_LOCAL = String(cfg.browser.local);
      if (typeof cfg.browser.headless === "boolean") r.HYEB_BROWSER_HEADLESS = String(cfg.browser.headless);
      if (typeof cfg.browser.chrome_path === "string") r.HYEB_CHROME_PATH = cfg.browser.chrome_path;
      if (typeof cfg.browser.idle_eviction_minutes === "number") r.HYEB_BROWSER_IDLE_EVICTION_MS = String(cfg.browser.idle_eviction_minutes * 60_000);
    }
    if (typeof cfg.log_level === "string") r.HYEB_LOG_LEVEL = cfg.log_level;
    if (typeof cfg.host === "string") r.HOST = cfg.host;
    if (typeof cfg.port === "number") r.PORT = String(cfg.port);
    // Empty string means "use the built-in default" (see config.json's
    // checked-in default) — only set it when non-empty, since start.ts's
    // `process.env.HYEB_STATIC_DIR ?? fileConfig.HYEB_STATIC_DIR ?? default`
    // fallback chain uses `??`, which does NOT treat an empty string as
    // nullish. Setting it unconditionally here would make config.json's
    // default "" silently win over the real default path, breaking static
    // asset serving (confirmed live: registerStaticAssets("") resolves to
    // the current working directory, not apps/web/dist).
    if (typeof cfg.static_dir === "string" && cfg.static_dir !== "") r.HYEB_STATIC_DIR = cfg.static_dir;
    return r;
  } catch {
    return {};
  }
}

// On Cloudflare, use the managed Browser Rendering binding (env.BROWSER),
// set once at module load by index.ts via setCloudflareBrowserBinding().
// Self-hosted deployments (Node/Bun + a Docker headless-Chrome container)
// have no such binding — instead they set HYEB_BROWSER_WS_ENDPOINT to a
// plain CDP WebSocket URL (e.g. ws://localhost:3000) and
// google-login-automation connects to it via puppeteer-core instead of
// @cloudflare/puppeteer.
let cloudflareBrowserBinding: BrowserBinding | undefined;

export function setCloudflareBrowserBinding(binding: BrowserBinding): void {
  cloudflareBrowserBinding = binding;
}

// ─── Config ───────────────────────────────────────────────────

function getSessionSecret(): string {
  const s = runtimeConfig.HYEB_SESSION_SECRET;
  if (!s) throw new HyeboardError("SERVER_CONFIG_ERROR", "HYEB_SESSION_SECRET not configured", 500);
  if (s.length < 32) throw new HyeboardError("WEAK_SESSION_SECRET", "HYEB_SESSION_SECRET must be >= 32 characters", 500);
  return s;
}

function browserHeadless(): boolean {
  const v = runtimeConfig.HYEB_BROWSER_HEADLESS;
  if (v === undefined || v === "") return true;
  return v === "true" || v === "1";
}

function browserConnection(): BrowserConnection {
  const wsEndpoint = runtimeConfig.HYEB_BROWSER_WS_ENDPOINT;
  if (wsEndpoint) return { kind: "self-hosted", browserWSEndpoint: wsEndpoint };
  // Explicit "true"/"1" check, not a truthy-string check: HYEB_BROWSER_LOCAL is
  // always a *string* here (from either an env var or loadConfigFile's
  // String(boolean) conversion of config.json's browser.local), so a naive
  // `if (runtimeConfig.HYEB_BROWSER_LOCAL)` would treat the string "false" as
  // truthy and force "local" mode even when the config explicitly disables it.
  if (runtimeConfig.HYEB_BROWSER_LOCAL === "true" || runtimeConfig.HYEB_BROWSER_LOCAL === "1") return { kind: "local", headless: browserHeadless() };
  return { kind: "cloudflare", binding: cloudflareBrowserBinding as BrowserBinding };
}

// ─── Auth ─────────────────────────────────────────────────────

async function getSession(headers: Headers | Record<string, string | undefined>) {
  const h = headers instanceof Headers ? headers : new Headers(headers as Record<string, string>);
  const token = parseBearerToken(h.get("Authorization"));
  if (!token) throw new HyeboardError("MISSING_SESSION", "Missing Authorization bearer token", 401);
  if (await isTokenRevoked(token)) throw new HyeboardError("SESSION_EXPIRED", "Session expired", 401);
  return decryptSession(token, getSessionSecret());
}

type ResolvedSession = { session: EncryptedSessionPayload; refreshedToken?: string };

// Lazy, per-request refresh (no background jobs/Durable Object alarms — see
// spec's "lazy on next API call" decision). Only uet sessions created via
// automated Google login (uetGoogleCredential) or a parent/guardian direct
// login (uetParentCredential) carry a refreshable credential; every other
// session (manual paste, vnu, mock) passes straight through the plain
// decrypt path with the shortcut check below being a cheap no-op.
export async function resolveSession(headers: Headers | Record<string, string | undefined>): Promise<ResolvedSession> {
  const h = headers instanceof Headers ? headers : new Headers(headers as Record<string, string>);
  const token = parseBearerToken(h.get("Authorization"));
  if (!token) throw new HyeboardError("MISSING_SESSION", "Missing Authorization bearer token", 401);
  if (await isTokenRevoked(token)) throw new HyeboardError("SESSION_EXPIRED", "Session expired", 401);
  const session = await decryptSession(token, getSessionSecret());

  if (session.universityId !== "uet" || (!session.uetGoogleCredential && !session.uetParentCredential)) return { session };
  const studenthubExpiresAt = session.studenthub?.expiresAt;
  if (studenthubExpiresAt && !isExpired(studenthubExpiresAt)) return { session };

  try {
    const adapter = getAdapter("uet");
    // Parent/guardian accounts refresh through StudentHub's direct CAPTCHA
    // APIs. Google accounts still need browser automation below.
    const refreshed = session.uetParentCredential
      ? await adapter.importSession({
          uetGoogleEmail: session.uetParentCredential.username,
          uetGooglePassword: session.uetParentCredential.password,
        })
      : await adapter.importSession(
          {
            uetGoogleEmail: session.uetGoogleCredential!.email,
            uetGooglePassword: session.uetGoogleCredential!.password,
            uetGoogleCookies: session.uetGoogleCredential!.googleCookies,
          },
          { browserConnection: browserConnection() },
        );
    const refreshedToken = await encryptSession(refreshed.session, getSessionSecret());
    return { session: refreshed.session, refreshedToken };
  } catch (error) {
    // Preserve the real failure code/status instead of collapsing every
    // refresh failure into a generic GOOGLE_REFRESH_FAILED/401 — the
    // frontend and logs both need to distinguish e.g. STUDENTHUB_MAINTENANCE
    // (503, transient, not a "sign in again" situation) from a genuine
    // GOOGLE_AUTOMATION_TIMEOUT/GOOGLE_AUTOMATION_BLOCKED/challenge failure.
    if (session.uetParentCredential) {
      // Parent refresh errors stay sanitized: upstream bodies, credentials,
      // CAPTCHA values, IDs, images, account data, and tokens must not enter logs.
      getLogger().error({
        code: error instanceof HyeboardError ? error.code : "PARENT_REFRESH_FAILED",
        status: error instanceof HyeboardError ? error.status : 500,
        errorName: error instanceof Error ? error.name : typeof error,
      }, "resolveSession: parent sign-in refresh failed");
    } else {
      getLogger().error({ err: error }, "resolveSession: automatic sign-in refresh failed");
    }
    if (error instanceof HyeboardError) throw error;
    throw new HyeboardError("GOOGLE_REFRESH_FAILED", "Automatic sign-in refresh failed. Sign in again.", 401);
  }
}

// ─── Error handling ───────────────────────────────────────────

// Shared with the SSE import-session branch below, which can't rely on
// Elysia's onError hook (errors thrown inside a ReadableStream's start()
// callback don't propagate to Elysia at all — the stream must catch and
// report its own errors as an "error" SSE event instead).
function errorPayload(error: unknown): { code: string; message: string; status: number } {
  if (error instanceof HyeboardError) return { code: error.code, message: error.message, status: error.status };
  // A truly unexpected (non-HyeboardError) failure reaching this far means
  // the automation's own error handling didn't catch it — surface the real
  // message instead of a fully generic one, so it's actually diagnosable.
  const reason = error instanceof Error ? error.message : String(error);
  return { code: "GOOGLE_SIGNIN_FAILURE", message: `Google sign-in did not complete: ${reason}`, status: 502 };
}

function routeError(error: unknown, requestId?: string) {
  const id = requestId ?? "-";
  const log = getLogger();
  if (error instanceof HyeboardError) {
    const level = error.status >= 500 ? "error" : "warn";
    log[level]({ reqId: id, code: error.code, status: error.status }, error.message);
    return new Response(JSON.stringify(fail(error.code, error.message, error.details)), { status: error.status, headers: { "Content-Type": "application/json" } });
  }
  // Elysia's own error classes (ValidationError, ParseError, NotFoundError,
  // InternalServerError) are plain Errors with .code/.status, not
  // HyeboardError. Surface them as clean 4xx responses instead of masking
  // a client mistake (e.g. malformed request body) as a generic 500.
  if (error instanceof Error && "status" in error && typeof (error as { status?: unknown }).status === "number") {
    const status = (error as { status: number }).status;
    const code = "code" in error && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "REQUEST_ERROR";
    const level = status >= 500 ? "error" : "warn";
    log[level]({ reqId: id, code, status }, "request rejected");
    const message = status < 500 ? "The request was invalid. Check the fields you submitted and try again." : "Unexpected API error";
    return new Response(JSON.stringify(fail(code, message)), { status, headers: { "Content-Type": "application/json" } });
  }
  log.error({ reqId: id, errorType: typeof error, stack: error instanceof Error ? error.stack : undefined }, "Unhandled error type");
  return new Response(JSON.stringify(fail("INTERNAL_ERROR", "Unexpected API error")), { status: 500, headers: { "Content-Type": "application/json" } });
}

// ─── Schemas ──────────────────────────────────────────────────

const importSessionBody = t.Object({
  studenthubGoogleCredential: t.Optional(t.String()),
  studenthubToken: t.Optional(t.String()),
  studenthubCookie: t.Optional(t.String()),
  canvasToken: t.Optional(t.String()),
  canvasCookie: t.Optional(t.String()),
  canvasCsrfToken: t.Optional(t.String()),
  vnuUsername: t.Optional(t.String()),
  vnuPassword: t.Optional(t.String()),
  studentCode: t.Optional(t.String()),
  uetGoogleEmail: t.Optional(t.String()),
  uetGooglePassword: t.Optional(t.String()),
});

const termCodeQuery = t.Object({ termCode: t.Optional(t.String()) });

const vnuRawQuery = t.Object({
  selUniv: t.Optional(t.String()),
  selStd: t.Optional(t.String()),
  vTermID: t.Optional(t.String()),
});

// ─── Cache abstraction ────────────────────────────────────────
// The Cloudflare Cache API (`caches.default`) is native to Workers/workerd
// but doesn't exist on plain Node or Bun. To keep rate-limiting/session
// revocation working identically across all three runtimes, fall back to a
// tiny in-memory Map-based Cache-like shim implementing just the
// `.match(request)`/`.put(request, response)` surface that cacheGet/cachePut
// actually use. This is already documented as a best-effort guardrail, not a
// hard security boundary, so an in-memory Map is an equivalent-strength
// (if anything, more consistent within a single process) substitute.

interface CacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

function createMemoryCache(): CacheLike {
  const store = new Map<string, { response: Response; expiresAt: number }>();
  return {
    async match(request: Request) {
      const entry = store.get(request.url);
      if (!entry) return undefined;
      if (entry.expiresAt <= Date.now()) {
        store.delete(request.url);
        return undefined;
      }
      return entry.response.clone();
    },
    async put(request: Request, response: Response) {
      const cacheControl = response.headers.get("Cache-Control") ?? "";
      const maxAgeMatch = /max-age=(\d+)/.exec(cacheControl);
      const maxAgeSeconds = maxAgeMatch ? Number(maxAgeMatch[1]) : 0;
      store.set(request.url, { response: response.clone(), expiresAt: Date.now() + maxAgeSeconds * 1000 });
    },
  };
}

const memoryCache: CacheLike = createMemoryCache();

// Safe request-ID generator. crypto.randomUUID() is available on all modern
// browsers and Node 19+/14.17.0 via the crypto module, but the bundled
// worker references the global Web Crypto API (globalThis.crypto), which
// doesn't exist or lacks randomUUID on Node <19. Fall back to Math.random
// for those environments.
function requestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().slice(0, 8);
  }
  if (typeof require === "function") {
    try { return require("crypto").randomUUID().slice(0, 8); } catch { /* fall through */ }
  }
  return Math.random().toString(36).substring(2, 10);
}

// ── CAPTCHA human-relay coordination ─────────────────────────────────
// The uet adapter's parent/guardian direct-login flow (see adapter.ts,
// captcha.ts) receives an image from StudentHub's CAPTCHA API that OCR
// couldn't confidently solve. When that happens mid-login, the
// server needs to pause and wait for the end user (on the OTHER side of
// the currently-open SSE connection) to look at the image and type an
// answer. Cloudflare configures a Durable Object coordinator; Node/Bun use
// an abort-aware process-local coordinator.
let captchaRelayCoordinator: CaptchaRelayCoordinator = new LocalCaptchaRelayCoordinator();

const CAPTCHA_RELAY_TOKEN_DOMAIN = "hyeboard:captcha-relay:v1\0";
const CAPTCHA_RELAY_ID_PATTERN = /^[A-Za-z0-9_-]{16,80}$/;
const CAPTCHA_RELAY_SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;

export function setCaptchaRelayCoordinator(coordinator: CaptchaRelayCoordinator): void {
  captchaRelayCoordinator = coordinator;
}

export async function createCaptchaRelayToken(relayId: string): Promise<string> {
  if (!CAPTCHA_RELAY_ID_PATTERN.test(relayId)) throw new Error("Invalid CAPTCHA relay ID");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(getSessionSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${CAPTCHA_RELAY_TOKEN_DOMAIN}${relayId}`)));
  return `${relayId}.${signature}`;
}

async function verifyCaptchaRelayToken(token: string): Promise<string | undefined> {
  try {
    const separator = token.indexOf(".");
    if (separator === -1 || separator !== token.lastIndexOf(".")) return undefined;
    const relayId = token.slice(0, separator);
    const signature = token.slice(separator + 1);
    if (!CAPTCHA_RELAY_ID_PATTERN.test(relayId) || !CAPTCHA_RELAY_SIGNATURE_PATTERN.test(signature)) return undefined;

    const signatureBytes = new Uint8Array(32);
    for (let index = 0; index < signatureBytes.length; index += 1) {
      signatureBytes[index] = Number.parseInt(signature.slice(index * 2, index * 2 + 2), 16);
    }
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(getSessionSecret()),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const authentic = await crypto.subtle.verify(
      "HMAC",
      key,
      signatureBytes,
      new TextEncoder().encode(`${CAPTCHA_RELAY_TOKEN_DOMAIN}${relayId}`),
    );
    return authentic ? relayId : undefined;
  } catch {
    return undefined;
  }
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(getSessionSecret()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

async function cacheGet<T>(key: string): Promise<T | undefined> {
  try {
    const cache = await appCache();
    const response = await cache.match(new Request(`https://hyeboard.internal/cache/${key}`));
    if (!response) return undefined;
    return (await response.json()) as T;
  } catch {
    return undefined;
  }
}

async function cachePut(key: string, value: unknown, maxAgeSeconds: number): Promise<void> {
  if (maxAgeSeconds <= 0) return;
  try {
    const cache = await appCache();
    await cache.put(
      new Request(`https://hyeboard.internal/cache/${key}`),
      new Response(JSON.stringify(value), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, max-age=${Math.floor(maxAgeSeconds)}`,
        },
      }),
    );
  } catch {
    // Cache is best-effort. Auth must keep working even when cache access
    // fails for any reason (colo rejection, memory pressure, etc.).
  }
}

async function appCache(): Promise<CacheLike> {
  const storage = globalThis.caches as (CacheStorage & { default?: Cache }) | undefined;
  if (!storage) return memoryCache;
  if (storage.default) return storage.default;
  if (typeof storage.open === "function") return storage.open("hyeboard");
  return memoryCache;
}

async function vnuImportCacheKey(username: string, password: string): Promise<string> {
  return `vnu/import/${await hmacHex(`${username.trim()}\n${password}`)}`;
}

// ── Google-login rate limiting + token revocation ───────────────────────

const GOOGLE_LOGIN_RATE_LIMIT = 5;
const GOOGLE_LOGIN_RATE_WINDOW_SECONDS = 15 * 60;

async function googleLoginRateLimitKey(email: string): Promise<string> {
  return `uet/google-login-attempts/${await hmacHex(email.trim().toLowerCase())}`;
}

// Best-effort fixed-window counter via the cache abstraction (same storage
// already used for vnu's import dedupe). Not perfectly race-free across
// concurrent requests in the same window, which is acceptable for an
// abuse-reduction guardrail, not a hard security boundary.
async function checkAndIncrementGoogleLoginAttempts(email: string): Promise<void> {
  const key = await googleLoginRateLimitKey(email);
  const existing = await cacheGet<{ count: number }>(key);
  const count = (existing?.count ?? 0) + 1;
  if (count > GOOGLE_LOGIN_RATE_LIMIT) {
    throw new HyeboardError("GOOGLE_LOGIN_RATE_LIMITED", "Too many sign-in attempts for this email. Wait 15 minutes and try again, or use the manual token option below.", 429);
  }
  await cachePut(key, { count }, GOOGLE_LOGIN_RATE_WINDOW_SECONDS);
}

async function revokedTokenKey(token: string): Promise<string> {
  return `revoked-token/${await hmacHex(token)}`;
}

async function revokeToken(token: string, expiresAt: string): Promise<void> {
  const ttlSeconds = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
  await cachePut(await revokedTokenKey(token), { revoked: true }, ttlSeconds);
}

async function isTokenRevoked(token: string): Promise<boolean> {
  return Boolean(await cacheGet<{ revoked: true }>(await revokedTokenKey(token)));
}

async function vnuRawCacheKey(session: EncryptedSessionPayload, page: string, params: Record<string, string | undefined>): Promise<string> {
  return `vnu/raw/${await hmacHex(JSON.stringify({ cookie: session.vnu?.value ?? "", page, params }))}`;
}

async function vnuRawHtml(session: EncryptedSessionPayload, page: string, params: { selUniv?: string; selStd?: string; vTermID?: string }): Promise<string> {
  if (!session.vnu?.value) throw new HyeboardError("VNU_LOGIN_REQUIRED", "VNU (daotao) data needs a saved daotao.vnu.edu.vn session. Sign in again.", 401);
  const cacheKey = await vnuRawCacheKey(session, page, params);
  const cached = await cacheGet<{ html: string }>(cacheKey);
  if (cached) return cached.html;

  const client = new DaotaoClient(session);
  let html: string;
  if (page === "profile") html = await client.getProfileHtml();
  else if (page === "grades") html = await client.getGradesHtml();
  else if (page === "progress") html = await client.getStudyProgressHtml();
  else if (page === "exam-base") html = await client.getExamBaseHtml();
  else if (page === "syllabus") html = await client.getSyllabusHtml();
  else if (page === "exams") {
    if (!params.selUniv || !params.selStd || !params.vTermID) throw new HyeboardError("VNU_EXAM_QUERY_INCOMPLETE", "Exam lookup needs university id, student id, and term id from the VNU (daotao) profile page.", 400);
    html = await client.getExamsHtml({ selUniv: params.selUniv, selStd: params.selStd, vTermID: params.vTermID });
  } else {
    throw new HyeboardError("VNU_RAW_PAGE_UNKNOWN", `Unknown VNU raw page: ${page}`, 404);
  }

  await cachePut(cacheKey, { html }, page === "exams" ? 60 : 300);
  return html;
}

// ─── CORS ─────────────────────────────────────────────────────
// Enabled only when HYEB_ALLOWED_ORIGINS is set (dev, or a self-hosted
// deployment serving the frontend from a different origin). Skipped when
// unset — same-origin, no CORS needed.

function corsPlugin() {
  const raw = runtimeConfig.HYEB_ALLOWED_ORIGINS;
  if (!raw) return undefined;
  const allowed = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return cors({
    origin: ({ headers }) => {
      const origin = headers.get("Origin");
      if (!origin) return true;
      return allowed.includes(origin);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
    credentials: false,
  });
}

// ─── App ──────────────────────────────────────────────────────
// Builds the full Elysia app for a given adapter (Cloudflare Workers, Node,
// or Bun). Route logic is identical across all three runtimes — only the
// adapter (and, via setRuntimeConfig/setCloudflareBrowserBinding, how config
// values are sourced) differs per entry point.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createApp(adapter: any) {
  const app = new Elysia({ adapter });

  const plugin = corsPlugin();
  if (plugin) app.use(plugin);

  return app
    .onRequest(({ request }) => {
      const req = request as unknown as { _hyebReqId?: string; _hyebStart?: number };
      req._hyebReqId = requestId();
      req._hyebStart = Date.now();
      // Set HYEB_LOG_LEVEL=debug (Node/Bun .env, or a Cloudflare secret/var)
      // to see one line per incoming request here.
      getLogger().debug({ reqId: req._hyebReqId, method: request.method, url: request.url }, "request received");
    })
    .onAfterResponse(({ request, set }) => {
      const req = request as unknown as { _hyebReqId?: string; _hyebStart?: number };
      getLogger().debug({ reqId: req._hyebReqId, status: set.status, durationMs: req._hyebStart ? Date.now() - req._hyebStart : undefined }, "request completed");
    })
    .onError(({ error, request }) => routeError(error, (request as unknown as { _hyebReqId?: string })._hyebReqId))

    // ── Public — no session required ──
    .get("/api/health", () => ok({ status: "ok", service: "hyeboard" }))
    .get("/api/universities", () => ok(listUniversities()))
    .post("/api/:universityId/auth/import-session", async ({ params, body, request }) => {
      const adapterInstance = getAdapter(params.universityId);
      // Keep parent/guardian direct API logins on this SSE route so a
      // server-side OCR miss can relay the CAPTCHA image to the user. The
      // same rate limit remains shared with Google automation.
      if (params.universityId === "uet" && body.uetGoogleEmail) {
        await checkAndIncrementGoogleLoginAttempts(body.uetGoogleEmail);
        // Google automation can take 90s+; parent direct login may pause for
        // a human CAPTCHA answer. Stream both as Server-Sent Events. Every
        // other branch below (vnu, manual-token/cookie paste, mock)
        // resolves almost instantly and keeps the plain JSON response.
        const encoder = new TextEncoder();
        let activeRelay: PreparedCaptchaRelay | undefined;
        let cancelled = false;
        let closed = false;
        const cancelRelay = async () => {
          if (cancelled) return;
          cancelled = true;
          const relay = activeRelay;
          activeRelay = undefined;
          await relay?.cancel().catch(() => undefined);
        };
        const stream = new ReadableStream({
          async start(controller) {
            const send = (event: string, data: unknown) => {
              if (cancelled || closed) return;
              try {
                controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
              } catch {
                void cancelRelay();
              }
            };
            const close = () => {
              if (cancelled || closed) return;
              closed = true;
              controller.close();
            };
            const onAbort = () => void cancelRelay();
            request.signal.addEventListener("abort", onAbort, { once: true });
            try {
              const imported = await adapterInstance.importSession(body, {
                browserConnection: browserConnection(),
                onProgress: (message) => send("progress", { message }),
                onCaptchaNeeded: async (image) => {
                  const relay = await captchaRelayCoordinator.prepare(image);
                  activeRelay = relay;
                  try {
                    const relayToken = await createCaptchaRelayToken(relay.challengeId);
                    if (cancelled || request.signal.aborted) throw captchaRelayCancelled();
                    send("captcha_required", { challengeId: relayToken, image: relay.image });
                    return await relay.wait(request.signal);
                  } catch (error) {
                    if (activeRelay === relay) await relay.cancel().catch(() => undefined);
                    throw error;
                  } finally {
                    if (activeRelay === relay) activeRelay = undefined;
                  }
                },
              });
              const token = await encryptSession(imported.session, getSessionSecret());
              send("done", { token, session: { universityId: imported.universityId, studentCode: imported.studentCode, expiresAt: imported.expiresAt, authenticated: true } });
            } catch (error) {
              if (!cancelled) {
                const { code, message, status } = errorPayload(error);
                const level = status >= 500 ? "error" : "warn";
                getLogger()[level]({ code, status }, message);
                send("error", { code, message, status });
              }
            } finally {
              request.signal.removeEventListener("abort", onAbort);
              close();
            }
          },
          cancel: cancelRelay,
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            // Disables response buffering on proxies that respect this
            // (e.g. nginx) so progress events actually stream incrementally
            // instead of arriving all at once when the connection closes.
            "X-Accel-Buffering": "no",
          },
        });
      }
      if (params.universityId === "vnu" && body.vnuUsername && body.vnuPassword) {
        const cacheKey = await vnuImportCacheKey(body.vnuUsername, body.vnuPassword);
        const cached = await cacheGet<{ token: string; session: { universityId: string; studentCode?: string; expiresAt: string; authenticated: true } }>(cacheKey);
        if (cached && Date.parse(cached.session.expiresAt) > Date.now()) return ok(cached);

        const imported = await adapterInstance.importSession(body);
        const token = await encryptSession(imported.session, getSessionSecret());
        const payload = { token, session: { universityId: imported.universityId, studentCode: imported.studentCode, expiresAt: imported.expiresAt, authenticated: true as const } };
        await cachePut(cacheKey, payload, Math.floor((Date.parse(imported.expiresAt) - Date.now()) / 1000));
        return ok(payload);
      }
      const imported = await adapterInstance.importSession(body);
      const token = await encryptSession(imported.session, getSessionSecret());
      return ok({ token, session: { universityId: imported.universityId, studentCode: imported.studentCode, expiresAt: imported.expiresAt, authenticated: true } });
    }, { body: importSessionBody })
    // Answers a CAPTCHA challenge raised mid-login by the "captcha_required"
    // SSE event above. No session token exists
    // yet at this point in the flow (the whole point is to finish logging
    // in), so this is deliberately unauthenticated. Verify the signed relay
    // token before coordinator access so forged IDs cannot instantiate DOs.
    .post("/api/uet/auth/solve-captcha", async ({ body }) => {
      const relayId = await verifyCaptchaRelayToken(body.challengeId);
      if (!relayId) throw captchaRelayNotFound();
      await captchaRelayCoordinator.answer(relayId, body.answer);
      return ok({ accepted: true });
    }, {
      body: t.Object({
        challengeId: t.String({ minLength: 1, maxLength: 160 }),
        answer: t.String({ minLength: 1, maxLength: 64 }),
      }),
    })
    .post("/api/:universityId/auth/logout", async ({ headers }) => {
      const h = headers instanceof Headers ? headers : new Headers(headers as Record<string, string>);
      const token = parseBearerToken(h.get("Authorization"));
      if (token) {
        try {
          const session = await decryptSession(token, getSessionSecret());
          await revokeToken(token, session.expiresAt);
        } catch {
          // Already invalid/expired token — nothing to revoke.
        }
      }
      return ok({ authenticated: false });
    })
    .get("/api/vnu/raw/:page", async ({ headers, params, query }) => {
      const session = await getSession(headers);
      if (session.universityId !== "vnu") throw new HyeboardError("SESSION_UNIVERSITY_MISMATCH", "Session university does not match route", 403);
      return ok({ html: await vnuRawHtml(session, params.page, query) });
    }, { query: vnuRawQuery })

    // ── Authenticated — session+adapter injected via resolve() ──
    .group("/api/:universityId", (g) =>
      g
        .resolve(async ({ headers, params }) => {
          const { session, refreshedToken } = await resolveSession(headers);
          if (session.universityId !== params.universityId)
            throw new HyeboardError("SESSION_UNIVERSITY_MISMATCH", "Session university does not match route", 403);
          return { session, refreshedToken, adapter: getAdapter(params.universityId) };
        })
        .onAfterHandle(({ response, refreshedToken }) => {
          if (!refreshedToken || !response || typeof response !== "object") return response;
          const typed = response as { data?: unknown; error?: unknown; meta?: Record<string, unknown> };
          if (!("data" in typed)) return response;
          return { ...typed, meta: { ...(typed.meta ?? {}), refreshedToken } };
        })
        .get("/auth/session", ({ session }) => ok({ universityId: session.universityId, studentCode: session.studentCode, expiresAt: session.expiresAt, authenticated: true }))
        .get("/me", async ({ adapter, session }) => ok(await adapter.getStudentProfile({ session })))
        .get("/dashboard", async ({ adapter, session, query }) => ok(await adapter.getDashboard({ session, termCode: query.termCode })), { query: termCodeQuery })
        .get("/terms", async ({ adapter, session }) => ok(await adapter.getTerms({ session })))
        .get("/timetable", async ({ adapter, session, query }) => ok(await adapter.getTimetable({ session, termCode: query.termCode })), { query: termCodeQuery })
        .get("/courses", async ({ adapter, session }) => ok(await adapter.getCourses({ session })))
        .get("/courses/:courseId", async ({ adapter, session, params }) => ok(await adapter.getCourseDetail({ session, courseId: params.courseId })))
        .get("/assignments", async ({ adapter, session }) => ok(await adapter.getAssignments({ session })))
        .get("/grades", async ({ adapter, session }) => ok(await adapter.getGrades({ session })))
        .get("/gpa", async ({ adapter, session }) => ok(await adapter.getGpaSummary({ session })))
        .get("/exams", async ({ adapter, session, query }) => ok(await adapter.getExams({ session, termCode: query.termCode })), { query: termCodeQuery })
        .get("/attendance", async ({ adapter, session }) => ok(await adapter.getAttendance({ session })))
        .get("/notifications", async ({ adapter, session }) => ok(await adapter.getNotifications({ session })))
        .get("/news", async ({ adapter, session }) => ok(await adapter.getNews({ session })))
        .get("/documents", async ({ adapter, session }) => ok(await adapter.getDocuments({ session })))
        .get("/tuition", async ({ adapter, session }) => ok(await adapter.getTuition({ session })))
        .get("/training-points", async ({ adapter, session }) => ok(await adapter.getTrainingPoints({ session })))
        .get("/requests", async ({ adapter, session }) => ok(await adapter.getRequests({ session })))
    )
    .compile();
}
