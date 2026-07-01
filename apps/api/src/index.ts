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

function allowedOrigins(env: AppEnv): string[] {
  return (env.HYEB_ALLOWED_ORIGINS || "http://localhost:5173").split(",").map((origin) => origin.trim()).filter(Boolean);
}

function originAllowed(origin: string | undefined, env: AppEnv): boolean {
  if (!origin) return true;
  return allowedOrigins(env).includes(origin);
}

type RequestHeaders = Headers | Record<string, string | undefined>;

function headerValue(headers: RequestHeaders, name: string): string | undefined | null {
  if (headers instanceof Headers) return headers.get(name);
  return headers[name] ?? headers[name.toLowerCase()];
}

async function getSession(headers: RequestHeaders, env: AppEnv) {
  const token = parseBearerToken(headerValue(headers, "Authorization"));
  if (!token) throw new HyeboardError("MISSING_SESSION", "Missing Authorization bearer token", 401);
  return decryptSession(token, env.HYEB_SESSION_SECRET);
}

function routeError(error: unknown) {
  if (error instanceof HyeboardError) return new Response(JSON.stringify(fail(error.code, error.message, error.details)), { status: error.status, headers: { "Content-Type": "application/json" } });
  return new Response(JSON.stringify(fail("INTERNAL_ERROR", "Unexpected API error")), { status: 500, headers: { "Content-Type": "application/json" } });
}

const importSessionBody = t.Object({
  studenthubToken: t.Optional(t.String()),
  studenthubCookie: t.Optional(t.String()),
  canvasToken: t.Optional(t.String()),
  canvasCookie: t.Optional(t.String()),
  canvasCsrfToken: t.Optional(t.String()),
  studentCode: t.Optional(t.String()),
});

const app = new Elysia({ adapter: CloudflareAdapter })
  .use(cors({
    origin: ({ headers }) => originAllowed(headers.get("Origin") ?? undefined, appEnv()),
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
    credentials: false,
  }))
  .onError(({ error }) => routeError(error))
  .get("/health", () => ok({ status: "ok", service: "hyeboard-api" }))
  .get("/api/universities", () => ok(listUniversities()))
  .post("/api/:universityId/auth/import-session", async ({ params, body }) => {
    const adapter = getAdapter(params.universityId);
    const imported = await adapter.importSession(body);
    const token = await encryptSession(imported.session, appEnv().HYEB_SESSION_SECRET);
    return ok({ token, session: { universityId: imported.universityId, studentCode: imported.studentCode, expiresAt: imported.expiresAt, authenticated: true } });
  }, { body: importSessionBody })
  .post("/api/:universityId/auth/logout", () => ok({ authenticated: false }))
  .get("/api/:universityId/auth/session", async ({ params, headers }) => {
    const session = await getSession(headers, appEnv());
    if (session.universityId !== params.universityId) throw new HyeboardError("SESSION_UNIVERSITY_MISMATCH", "Session university does not match route", 403);
    return ok({ universityId: session.universityId, studentCode: session.studentCode, expiresAt: session.expiresAt, authenticated: true });
  })
  .get("/api/:universityId/me", async ({ params, headers }) => ok(await getAdapter(params.universityId).getStudentProfile({ session: await getSession(headers, appEnv()) })))
  .get("/api/:universityId/dashboard", async ({ params, query, headers }) => ok(await getAdapter(params.universityId).getDashboard({ session: await getSession(headers, appEnv()), termCode: query.termCode })), { query: t.Object({ termCode: t.Optional(t.String()) }) })
  .get("/api/:universityId/terms", async ({ params, headers }) => ok(await getAdapter(params.universityId).getTerms({ session: await getSession(headers, appEnv()) })))
  .get("/api/:universityId/timetable", async ({ params, query, headers }) => ok(await getAdapter(params.universityId).getTimetable({ session: await getSession(headers, appEnv()), termCode: query.termCode })), { query: t.Object({ termCode: t.Optional(t.String()) }) })
  .get("/api/:universityId/courses", async ({ params, headers }) => ok(await getAdapter(params.universityId).getCourses({ session: await getSession(headers, appEnv()) })))
  .get("/api/:universityId/courses/:courseId", async ({ params, headers }) => ok(await getAdapter(params.universityId).getCourseDetail({ session: await getSession(headers, appEnv()), courseId: params.courseId })))
  .get("/api/:universityId/assignments", async ({ params, headers }) => ok(await getAdapter(params.universityId).getAssignments({ session: await getSession(headers, appEnv()) })))
  .get("/api/:universityId/grades", async ({ params, headers }) => ok(await getAdapter(params.universityId).getGrades({ session: await getSession(headers, appEnv()) })))
  .get("/api/:universityId/gpa", async ({ params, headers }) => ok(await getAdapter(params.universityId).getGpaSummary({ session: await getSession(headers, appEnv()) })))
  .get("/api/:universityId/exams", async ({ params, query, headers }) => ok(await getAdapter(params.universityId).getExams({ session: await getSession(headers, appEnv()), termCode: query.termCode })), { query: t.Object({ termCode: t.Optional(t.String()) }) })
  .get("/api/:universityId/attendance", async ({ params, headers }) => ok(await getAdapter(params.universityId).getAttendance({ session: await getSession(headers, appEnv()) })))
  .get("/api/:universityId/notifications", async ({ params, headers }) => ok(await getAdapter(params.universityId).getNotifications({ session: await getSession(headers, appEnv()) })))
  .get("/api/:universityId/news", async ({ params, headers }) => ok(await getAdapter(params.universityId).getNews({ session: await getSession(headers, appEnv()) })))
  .get("/api/:universityId/documents", async ({ params, headers }) => ok(await getAdapter(params.universityId).getDocuments({ session: await getSession(headers, appEnv()) })))
  .get("/api/:universityId/tuition", async ({ params, headers }) => ok(await getAdapter(params.universityId).getTuition({ session: await getSession(headers, appEnv()) })))
  .get("/api/:universityId/training-points", async ({ params, headers }) => ok(await getAdapter(params.universityId).getTrainingPoints({ session: await getSession(headers, appEnv()) })))
  .get("/api/:universityId/requests", async ({ params, headers }) => ok(await getAdapter(params.universityId).getRequests({ session: await getSession(headers, appEnv()) })))
  .compile();

export default app;
