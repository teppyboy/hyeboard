import { cors } from "@elysiajs/cors";
import { decryptSession, encryptSession, fail, HyeboardError, ok, parseBearerToken } from "@hyeboard/core";
import { getAdapter, listUniversities } from "@hyeboard/university-adapters";
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
  console.error(`[${id}]`, error);
  if (error instanceof HyeboardError)
    return new Response(JSON.stringify(fail(error.code, error.message, error.details)), { status: error.status, headers: { "Content-Type": "application/json" } });
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
});

const termCodeQuery = t.Object({ termCode: t.Optional(t.String()) });

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
    const imported = await adapter.importSession(body);
    const token = await encryptSession(imported.session, getSessionSecret());
    return ok({ token, session: { universityId: imported.universityId, studentCode: imported.studentCode, expiresAt: imported.expiresAt, authenticated: true } });
  }, { body: importSessionBody })
  .post("/api/:universityId/auth/logout", () => ok({ authenticated: false }))

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
