import { cors } from "@elysiajs/cors";
import { decryptSession, encryptSession, fail, HyeboardError, ok, parseBearerToken, type EncryptedSessionPayload } from "@hyeboard/core";
import { DaotaoClient, getAdapter, listUniversities } from "@hyeboard/university-adapters";
import { env } from "cloudflare:workers";
import { Elysia, t } from "elysia";
import { CloudflareAdapter } from "elysia/adapter/cloudflare-worker";

type AppEnv = Env;

function appEnv(): AppEnv {
  return env as unknown as AppEnv;
}

// ─── Config ───────────────────────────────────────────────────

function getSessionSecret(): string {
  const s = appEnv().HYEB_SESSION_SECRET;
  if (!s) throw new HyeboardError("SERVER_CONFIG_ERROR", "HYEB_SESSION_SECRET not configured; run `wrangler secret put HYEB_SESSION_SECRET`", 500);
  if (s.length < 32) throw new HyeboardError("WEAK_SESSION_SECRET", "HYEB_SESSION_SECRET must be >= 32 characters", 500);
  return s;
}

// ─── Auth ─────────────────────────────────────────────────────

function getSession(headers: Headers | Record<string, string | undefined>) {
  const h = headers instanceof Headers ? headers : new Headers(headers as Record<string, string>);
  const token = parseBearerToken(h.get("Authorization"));
  if (!token) throw new HyeboardError("MISSING_SESSION", "Missing Authorization bearer token", 401);
  return decryptSession(token, getSessionSecret());
}

// ─── Error handling ───────────────────────────────────────────

function routeError(error: unknown, requestId?: string) {
  const id = requestId ?? "-";
  if (error instanceof HyeboardError) {
    const log = error.status >= 500 ? console.error : console.warn;
    log(`[${id}] ${error.code} (${error.status}): ${error.message}`);
    return new Response(JSON.stringify(fail(error.code, error.message, error.details)), { status: error.status, headers: { "Content-Type": "application/json" } });
  }
  // Elysia's own error classes (ValidationError, ParseError, NotFoundError,
  // InternalServerError) are plain Errors with .code/.status, not
  // HyeboardError. Surface them as clean 4xx responses instead of masking
  // a client mistake (e.g. malformed request body) as a generic 500.
  if (error instanceof Error && "status" in error && typeof (error as { status?: unknown }).status === "number") {
    const status = (error as { status: number }).status;
    const code = "code" in error && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "REQUEST_ERROR";
    const log = status >= 500 ? console.error : console.warn;
    log(`[${id}] ${code} (${status}): request rejected`);
    const message = status < 500 ? "The request was invalid. Check the fields you submitted and try again." : "Unexpected API error";
    return new Response(JSON.stringify(fail(code, message)), { status, headers: { "Content-Type": "application/json" } });
  }
  console.error(`[${id}] Unhandled error type:`, typeof error, error instanceof Error ? error.stack : "");
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

// ─── Worker Cache API ─────────────────────────────────────────

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
    if (!cache) return undefined;
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
    if (!cache) return;
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
    // Cache API is best-effort. Auth must keep working even when a colo/runtime
    // rejects cache access for synthetic requests.
  }
}

async function appCache(): Promise<Cache | undefined> {
  const storage = globalThis.caches as (CacheStorage & { default?: Cache }) | undefined;
  if (!storage) return undefined;
  if (storage.default) return storage.default;
  return typeof storage.open === "function" ? storage.open("hyeboard") : undefined;
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

// Best-effort fixed-window counter via the Cache API (same storage already
// used for vnu's import dedupe). Not perfectly race-free across concurrent
// requests in the same window, which is acceptable for an abuse-reduction
// guardrail, not a hard security boundary.
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
// Enabled in dev only when HYEB_ALLOWED_ORIGINS is set in .dev.vars.
// Skipped in production — same-origin, no CORS needed.

const corsPlugin = (() => {
  const raw = appEnv().HYEB_ALLOWED_ORIGINS;
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
})();

// ─── App ──────────────────────────────────────────────────────

const app = new Elysia({ adapter: CloudflareAdapter });

if (corsPlugin) app.use(corsPlugin);

app
  .onRequest(({ request }) => {
    (request as any)._hyebReqId = crypto.randomUUID().slice(0, 8);
  })
  .onError(({ error, request }) => routeError(error, (request as any)._hyebReqId))

  // ── Public — no session required ──
  .get("/api/health", () => ok({ status: "ok", service: "hyeboard" }))
  .get("/api/universities", () => ok(listUniversities()))
  .post("/api/:universityId/auth/import-session", async ({ params, body }) => {
    const adapter = getAdapter(params.universityId);
    if (params.universityId === "uet" && body.uetGoogleEmail) {
      await checkAndIncrementGoogleLoginAttempts(body.uetGoogleEmail);
      const imported = await adapter.importSession(body, { browserBinding: appEnv().BROWSER });
      const token = await encryptSession(imported.session, getSessionSecret());
      return ok({ token, session: { universityId: imported.universityId, studentCode: imported.studentCode, expiresAt: imported.expiresAt, authenticated: true } });
    }
    if (params.universityId === "vnu" && body.vnuUsername && body.vnuPassword) {
      const cacheKey = await vnuImportCacheKey(body.vnuUsername, body.vnuPassword);
      const cached = await cacheGet<{ token: string; session: { universityId: string; studentCode?: string; expiresAt: string; authenticated: true } }>(cacheKey);
      if (cached && Date.parse(cached.session.expiresAt) > Date.now()) return ok(cached);

      const imported = await adapter.importSession(body);
      const token = await encryptSession(imported.session, getSessionSecret());
      const payload = { token, session: { universityId: imported.universityId, studentCode: imported.studentCode, expiresAt: imported.expiresAt, authenticated: true as const } };
      await cachePut(cacheKey, payload, Math.floor((Date.parse(imported.expiresAt) - Date.now()) / 1000));
      return ok(payload);
    }
    const imported = await adapter.importSession(body);
    const token = await encryptSession(imported.session, getSessionSecret());
    return ok({ token, session: { universityId: imported.universityId, studentCode: imported.studentCode, expiresAt: imported.expiresAt, authenticated: true } });
  }, { body: importSessionBody })
  .post("/api/:universityId/auth/logout", () => ok({ authenticated: false }))
  .get("/api/vnu/raw/:page", async ({ headers, params, query }) => {
    const session = await getSession(headers);
    if (session.universityId !== "vnu") throw new HyeboardError("SESSION_UNIVERSITY_MISMATCH", "Session university does not match route", 403);
    return ok({ html: await vnuRawHtml(session, params.page, query) });
  }, { query: vnuRawQuery })

  // ── Authenticated — session+adapter injected via resolve() ──
  .group("/api/:universityId", (g) =>
    g
      .resolve(async ({ headers, params }) => {
        const session = await getSession(headers);
        if (session.universityId !== params.universityId)
          throw new HyeboardError("SESSION_UNIVERSITY_MISMATCH", "Session university does not match route", 403);
        return { session, adapter: getAdapter(params.universityId) };
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

export default app;
