import { cors } from "@elysiajs/cors";
import { createVnuRefreshAccessDescriptor, createVnuRefreshGrant, decryptSession, decryptSessionForVnuLogout, decryptSessionForVnuRefresh, decryptVnuCrossDetailPermitEnvelope, decryptVnuRefreshGrant, decryptVnuRefreshGrantForLogout, deriveVnuRefreshPrincipal, encryptSession, encryptVnuRefreshGrant, fail, getLogger, HyeboardError, isExpired, ok, parseBearerToken, rotateVnuRefreshGrant, VNU_REFRESH_GRANT_MAX_LENGTH, type EncryptedSessionPayload, type VnuRefreshAccessDescriptor, type VnuRefreshGrantPayload } from "@hyeboard/core";
import { apiErrorDetailsSchema, type AuthResult, type CapabilityKey, type OperationalLimitKey, type University, type UniversityCapabilities } from "@hyeboard/schemas";
import { DaotaoClient, findPointDetailSelector, getAdapter, isDaotaoSessionExpired, listUniversities, parseProfileHtml, parseTranscriptHeader, parseTranscriptHtml, type BrowserBinding, type BrowserConnection, type VnuTranscript } from "@hyeboard/university-adapters";
import { StudentHubClient } from "@hyeboard/university-adapters/src/uet/studenthub-client";
import { Elysia, t } from "elysia";
import { LocalCaptchaRelayCoordinator, captchaRelayCancelled, captchaRelayNotFound, type CaptchaRelayCoordinator, type PreparedCaptchaRelay } from "./captcha-relay";
import { probeBudgetUnavailable, VNU_BRC1_PERMIT_LIMIT, type VnuCrossDetailLimits, type VnuProbeBudgetCoordinator } from "./vnu-probe-budget";
import { vnuRefreshUnavailable, type BeginRefreshResult, type LinkedPair, type VnuRefreshControlCoordinator } from "./vnu-refresh-control";
import { resolveVnuStudentId, VNU_STUDENT_ID_RESOLVER_MAX_PROBES } from "./vnu-student-id-resolver";
import { parseVnuRuntimeConfig, type EffectiveVnuRuntimeConfig } from "./vnu-runtime-config";
import { buildVnuCrossDetailConsumeInput, createVnuCrossDetailMinter, crossDetailUnavailable, parseVnuCrossDetailPermitString, readVnuCrossDetailBody } from "./vnu-cross-detail";
import { checkSessionEpoch, parseHaConfig, type HaConfig } from "./ha-contracts";
import { createHaLifecycle, safeHaDiagnostics, type HaLifecycleController } from "./ha-lifecycle";
import { parseAdminConfig } from "./admin-config";
import { registerAdminRoutes, type AdminLoginRateLimit } from "./admin-routes";
import { effectiveUniversity, filterDashboardSummary } from "./feature-policy";
import type { FeaturePolicyRuntime } from "./feature-policy-store";

// ─── Runtime config ───────────────────────────────────────────
// Self-hosted (Node/Bun) loads config from config.json + env var overrides
// (see loadConfigFile in start.ts). Cloudflare Workers doesn't use config.json
// (no filesystem) — index.ts calls setRuntimeConfig directly with env var
// values from the `cloudflare:workers` binding.
//
// HYEB_SESSION_SECRET is NEVER read from config.json — only from env vars
// or setRuntimeConfig(), to keep it out of files that might be checked in.
export interface RuntimeConfig {
  HYEB_SESSION_SECRET?: string;
  HYEB_ALLOWED_ORIGINS?: string;
  HYEB_BROWSER_WS_ENDPOINT?: string;
  HYEB_BROWSER_LOCAL?: string;
  HYEB_BROWSER_HEADLESS?: string;
  HYEB_CHROME_PATH?: string;
  HYEB_BROWSER_IDLE_EVICTION_MS?: string;
  HYEB_LOG_LEVEL?: string;
  VNU_CODE_LOOKUP_CONCURRENCY?: string;
  VNU_CROSS_LOOKUP_BULK_MAX_TARGETS?: string;
  VNU_CROSS_LOOKUP_DIRECT_CHUNK_MAX_TARGETS?: string;
  VNU_CODE_LOOKUP_BULK_TARGET_CONCURRENCY?: string;
  VNU_CROSS_LOOKUP_REQUEST_TIMEOUT_MS?: string;
  VNU_CROSS_DETAIL_MAX_TARGETS?: string;
  VNU_CROSS_DETAIL_MAX_ROWS?: string;
  VNU_CROSS_DETAIL_CONCURRENCY?: string;
  VNU_CROSS_DETAIL_BUDGET?: string;
  VNU_CROSS_DETAIL_WINDOW_SECONDS?: string;
  VNU_CROSS_DETAIL_PERMIT_TTL_SECONDS?: string;
  VNU_CROSS_DETAIL_EXPORT_MODE?: string;
  HOST?: string;
  PORT?: string;
  HYEB_STATIC_DIR?: string;
  HYEB_HA_MODE?: string;
  HYEB_HA_NODE_ID?: string;
  HYEB_HA_SESSION_EPOCH?: string;
  HYEB_HA_ENFORCE_SESSION_EPOCH?: string;
  DATABASE_URL?: string;
  REDIS_URL?: string;
  HYEB_POSTGRES_URL?: string;
  HYEB_REDIS_URL?: string;
  HYEB_SHUTDOWN_TIMEOUT_MS?: string;
  HYEB_ADMIN_SESSION_SECRET?: string;
  HYEB_ADMIN_SESSION_TTL_SECONDS?: string;
  HYEB_ADMIN_PASSWORD_HASH?: string;
  HYEB_ADMIN_PUBLIC_ORIGIN?: string;
  HYEB_ADMIN_DB_PATH?: string;
  HYEB_ADMIN_GITHUB_CLIENT_ID?: string;
  HYEB_ADMIN_GITHUB_CLIENT_SECRET?: string;
  HYEB_ADMIN_GITHUB_IDS?: string;
  HYEB_ADMIN_DISCORD_CLIENT_ID?: string;
  HYEB_ADMIN_DISCORD_CLIENT_SECRET?: string;
  HYEB_ADMIN_DISCORD_IDS?: string;
  AUTOMATION_JOB_STREAM?: string;
  AUTOMATION_EVENT_STREAM?: string;
  AUTOMATION_CONTROL_STREAM?: string;
  AUTOMATION_JOB_ENVELOPE_AAD?: string;
  AUTOMATION_CREDENTIAL_AAD_PREFIX?: string;
  AUTOMATION_RESULT_AAD_PREFIX?: string;
  AUTOMATION_EVENT_AAD_PREFIX?: string;
  AUTOMATION_IDEMPOTENCY_TTL_MS?: string;
  AUTOMATION_DEADLINE_MS?: string;
  AUTOMATION_EVENT_BLOCK_MS?: string;
  AUTOMATION_EVENT_BATCH_SIZE?: string;
  AUTOMATION_KEY_CURRENT_ID?: string;
  AUTOMATION_KEY_CURRENT_B64?: string;
  AUTOMATION_KEY_PREVIOUS_ID?: string;
  AUTOMATION_KEY_PREVIOUS_B64?: string;
  AUTOMATION_EXECUTOR_READY?: string;
  HYEB_AUTOMATION_EXECUTOR_READY?: string;
}

export type DistributedAutomationEvent = {
  type: string;
  jobId: string;
  accountId: string;
  fence: number;
  sequence: number;
  challengeId?: string;
  image?: string;
  phase?: "queue" | "login" | "captcha" | "import" | "finalize";
  percent?: number;
  resultEnvelope?: string;
  code?: string;
  retryable?: boolean;
  reason?: "requested" | "expired" | "superseded" | "shutdown";
};

export type DistributedImportedSession = {
  universityId: string;
  studentCode?: string;
  expiresAt: string;
  session: EncryptedSessionPayload;
};

export type DistributedAutomationImportRequest = {
  email: string;
  password: string;
  googleCookies?: unknown[];
  expectedStudentCode?: string;
  idempotencyKey: string;
};

export interface DistributedAutomationBackend {
  isAvailable(): boolean;
  isAutomationChallengeToken(value: string): boolean;
  importUetGoogle(
    input: DistributedAutomationImportRequest,
    options: {
      signal?: AbortSignal;
      cursor?: number;
      onJob?: (ownershipToken: string) => void;
      onEvent?: (event: DistributedAutomationEvent) => Promise<void> | void;
    },
  ): Promise<DistributedImportedSession>;
  createChallengeToken(event: DistributedAutomationEvent, ownershipToken: string): string;
  answerCaptcha(token: string, answer: string): Promise<void>;
  cancelCaptcha(token: string): Promise<void>;
  cancelAutomation(token: string): Promise<void>;
}

let runtimeConfig: RuntimeConfig = {};
let effectiveVnuRuntimeConfig: EffectiveVnuRuntimeConfig = parseVnuRuntimeConfig({});
let haConfig: HaConfig = parseHaConfig();
let distributedAutomationBackend: DistributedAutomationBackend | undefined;
let featurePolicyRuntime: FeaturePolicyRuntime | undefined;
let adminLoginRateLimit: AdminLoginRateLimit | undefined;
let adminConfigEnabled = false;

export function setRuntimeConfig(config: RuntimeConfig): void {
  runtimeConfig = config;
  adminConfigEnabled = config.HYEB_ADMIN_SESSION_SECRET !== undefined;
  haConfig = parseHaConfig(config as Readonly<Record<string, string | undefined>>, {}, (setting, effectiveFallback) => {
    getLogger().warn({ setting, effectiveFallback }, "invalid HA runtime setting; using safe fallback");
  });
  effectiveVnuRuntimeConfig = parseVnuRuntimeConfig({
    codeLookupConcurrency: config.VNU_CODE_LOOKUP_CONCURRENCY,
    crossLookupBulkMaxTargets: config.VNU_CROSS_LOOKUP_BULK_MAX_TARGETS,
    crossLookupDirectChunkMaxTargets: config.VNU_CROSS_LOOKUP_DIRECT_CHUNK_MAX_TARGETS,
    codeLookupBulkTargetConcurrency: config.VNU_CODE_LOOKUP_BULK_TARGET_CONCURRENCY,
    crossLookupRequestTimeoutMs: config.VNU_CROSS_LOOKUP_REQUEST_TIMEOUT_MS,
    crossDetailMaxTargets: config.VNU_CROSS_DETAIL_MAX_TARGETS,
    crossDetailMaxRows: config.VNU_CROSS_DETAIL_MAX_ROWS,
    crossDetailConcurrency: config.VNU_CROSS_DETAIL_CONCURRENCY,
    crossDetailBudget: config.VNU_CROSS_DETAIL_BUDGET,
    crossDetailWindowSeconds: config.VNU_CROSS_DETAIL_WINDOW_SECONDS,
    crossDetailPermitTtlSeconds: config.VNU_CROSS_DETAIL_PERMIT_TTL_SECONDS,
    crossDetailExportMode: config.VNU_CROSS_DETAIL_EXPORT_MODE,
  }, (setting, effectiveFallback) => {
    getLogger().warn({ setting, effectiveFallback }, "invalid VNU runtime setting; using safe fallback");
  });
}

export function setDistributedAutomationBackend(backend: DistributedAutomationBackend | undefined): void {
  distributedAutomationBackend = backend;
}

export function setFeaturePolicyRuntime(runtime: FeaturePolicyRuntime | undefined): void {
  if (featurePolicyRuntime === runtime) return;
  featurePolicyRuntime = runtime;
}

export function setAdminLoginRateLimit(limiter: AdminLoginRateLimit | undefined): void {
  adminLoginRateLimit = limiter;
}

export function getEffectiveVnuRuntimeConfig(): EffectiveVnuRuntimeConfig {
  return effectiveVnuRuntimeConfig;
}

export function getHaConfig(): HaConfig {
  return haConfig;
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
  if (runtimeConfig.HYEB_HA_MODE === undefined) {
    haConfig = { ...haConfig, mode: "cloudflare" };
  }
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
  // always a *string* here (from either an env var or start.ts's config loader
  // String(boolean) conversion of config.json's browser.local), so a naive
  // `if (runtimeConfig.HYEB_BROWSER_LOCAL)` would treat the string "false" as
  // truthy and force "local" mode even when the config explicitly disables it.
  if (runtimeConfig.HYEB_BROWSER_LOCAL === "true" || runtimeConfig.HYEB_BROWSER_LOCAL === "1") return { kind: "local", headless: browserHeadless() };
  return { kind: "cloudflare", binding: cloudflareBrowserBinding as BrowserBinding };
}

function distributedDependencyUnavailable(dependency: string): HyeboardError {
  return new HyeboardError("HA_DEPENDENCY_UNAVAILABLE", `The distributed ${dependency} dependency is unavailable.`, 503, { dependency });
}

function ensureInlineAutomationAllowed(): void {
  if (haConfig.mode === "distributed" && (!distributedAutomationBackend || !distributedAutomationBackend.isAvailable())) {
    throw new HyeboardError(
      "AUTOMATION_BACKEND_UNCONFIGURED",
      "Distributed browser automation is not configured; use the manual credential flow or configure an automation backend.",
      503,
    );
  }
}

function requireDistributedAutomationBackend(): DistributedAutomationBackend {
  if (!distributedAutomationBackend || !distributedAutomationBackend.isAvailable()) throw new HyeboardError(
    "AUTOMATION_BACKEND_UNCONFIGURED",
    "Distributed browser automation is not configured; configure a worker executor before using Google sign-in.",
    503,
  );
  return distributedAutomationBackend;
}

// ─── Auth ─────────────────────────────────────────────────────

async function getSession(headers: Headers | Record<string, string | undefined>) {
  const h = headers instanceof Headers ? headers : new Headers(headers as Record<string, string>);
  const token = parseBearerToken(h.get("Authorization"));
  if (!token) throw new HyeboardError("MISSING_SESSION", "Missing Authorization bearer token", 401);
  return resolveOrdinaryAccessToken(token);
}

type ResolvedSession = { session: EncryptedSessionPayload; refreshedToken?: string };

function missingVnuCredential(): HyeboardError {
  return new HyeboardError(
    "VNU_LOGIN_REQUIRED",
    "VNU data needs an active university portal credential.",
    401,
    { reason: "MISSING_VNU_CREDENTIAL" },
  );
}

function incompleteVnuProfile(): HyeboardError {
  return new HyeboardError("VNU_PROFILE_INCOMPLETE", "The university portal profile is incomplete.", 500);
}

// Lazy, per-request refresh (no background jobs/Durable Object alarms — see
// spec's "lazy on next API call" decision). Only uet sessions created via
// automated Google login (uetGoogleCredential) or a parent/guardian direct
// login (uetParentCredential) carry a refreshable credential; every other
// session (manual paste, vnu, mock) passes straight through the plain
// decrypt path with the shortcut check below being a cheap no-op.
export async function resolveSession(headers: Headers | Record<string, string | undefined>, signal?: AbortSignal): Promise<ResolvedSession> {
  const h = headers instanceof Headers ? headers : new Headers(headers as Record<string, string>);
  const token = parseBearerToken(h.get("Authorization"));
  if (!token) throw new HyeboardError("MISSING_SESSION", "Missing Authorization bearer token", 401);
  const session = await resolveOrdinaryAccessToken(token);

  if (session.universityId !== "uet" || (!session.uetGoogleCredential && !session.uetParentCredential)) return { session };
  const studenthubExpiresAt = session.studenthub?.expiresAt;
  if (studenthubExpiresAt && !isExpired(studenthubExpiresAt)) return { session };

  try {
    const adapter = getAdapter("uet");
    // Parent/guardian accounts refresh through StudentHub's direct CAPTCHA
    // APIs. Google accounts still need browser automation below.
    if (!session.uetParentCredential) ensureInlineAutomationAllowed();
    const refreshed = session.uetParentCredential
      ? signal === undefined
        ? await adapter.importSession({
            uetGoogleEmail: session.uetParentCredential.username,
            uetGooglePassword: session.uetParentCredential.password,
          })
        : await adapter.importSession({
            uetGoogleEmail: session.uetParentCredential.username,
            uetGooglePassword: session.uetParentCredential.password,
          }, { signal })
      : haConfig.mode === "distributed"
        ? await requireDistributedAutomationBackend().importUetGoogle({
            email: session.uetGoogleCredential!.email,
            password: session.uetGoogleCredential!.password,
            googleCookies: session.uetGoogleCredential!.googleCookies,
            expectedStudentCode: session.studentCode,
            idempotencyKey: `refresh:${session.sessionId ?? session.uetGoogleCredential!.email}`,
          }, signal === undefined ? {} : { signal })
        : await adapter.importSession(
            {
              uetGoogleEmail: session.uetGoogleCredential!.email,
              uetGooglePassword: session.uetGoogleCredential!.password,
              uetGoogleCookies: session.uetGoogleCredential!.googleCookies,
            },
            { browserConnection: browserConnection(), ...(signal === undefined ? {} : { signal }) },
          );
    if (signal) throwIfRequestCancelled(signal);
    const refreshedToken = await encryptSession(sessionTokenPayload(refreshed.session, session), getSessionSecret());
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

function descriptorPair(descriptor: VnuRefreshAccessDescriptor) {
  return {
    accessTokenId: descriptor.accessTokenId,
    accessExpiresAt: Date.parse(descriptor.accessExpiresAt),
    grantId: descriptor.grantId,
    grantExpiresAt: Date.parse(descriptor.grantExpiresAt),
  };
}

function vnuRefreshIdentityMismatch(): HyeboardError {
  return new HyeboardError("VNU_REFRESH_IDENTITY_MISMATCH", "The VNU reconnect identity did not match the signed-in account.", 409);
}

function ensureVnuIdentityMatch(session: EncryptedSessionPayload, grant: VnuRefreshGrantPayload): void {
  if (session.universityId !== "vnu" || !session.studentCode || session.studentCode !== grant.expectedStudentCode) throw vnuRefreshIdentityMismatch();
}

function beginResultError(result: Exclude<BeginRefreshResult, { kind: "accepted" }>): never {
  if (result.kind === "revoked") throw new HyeboardError("VNU_REFRESH_GRANT_REVOKED", "The VNU reconnect grant has been revoked.", 401);
  if (result.kind === "in-progress") throw new HyeboardError("VNU_REFRESH_UNAVAILABLE", "VNU reconnect is already in progress. Try again shortly.", 503, { retryAfterSeconds: result.retryAfterSeconds });
  if (result.kind === "rate-limited") throw new HyeboardError("VNU_REFRESH_RATE_LIMITED", "Too many VNU reconnect attempts. Wait and try again.", 429, {
    retryAfterSeconds: result.retryAfterSeconds,
    limit: result.limit,
    windowSeconds: result.windowSeconds,
  });
  throw new Error("Accepted refresh result cannot be converted to an error");
}

function isTerminalVnuRefreshFailure(error: unknown): boolean {
  return error instanceof HyeboardError && (error.code === "INVALID_VNU_CREDENTIAL" || error.code === "VNU_REFRESH_IDENTITY_MISMATCH");
}

function approvedVnuRefreshDetails(error: HyeboardError) {
  const parsed = apiErrorDetailsSchema.safeParse(error.details);
  return parsed.success ? parsed.data : undefined;
}

function publicVnuRefreshError(error: unknown): HyeboardError {
  if (!(error instanceof HyeboardError)) return new HyeboardError("VNU_REQUEST_FAILED", "The VNU reconnect request failed. Try again.", 502);
  if (error.code === "INVALID_VNU_CREDENTIAL") return new HyeboardError(error.code, "The VNU username or password is no longer valid.", 401);
  if (error.code === "VNU_REFRESH_IDENTITY_MISMATCH") return vnuRefreshIdentityMismatch();
  if (error.code === "VNU_RATE_LIMITED") return new HyeboardError(error.code, "VNU is rate limiting requests. Wait and try again.", 429, approvedVnuRefreshDetails(error));
  if (error.code === "VNU_UPSTREAM_UNAVAILABLE") return new HyeboardError(error.code, "The VNU portal is temporarily unavailable. Try again.", 502, approvedVnuRefreshDetails(error));
  if (error.code === "VNU_REQUEST_FAILED") return new HyeboardError(error.code, "The VNU reconnect request failed. Try again.", 502, approvedVnuRefreshDetails(error));
  if (error.code === "VNU_REFRESH_UNAVAILABLE") return vnuRefreshUnavailable();
  if (error.code === "VNU_REFRESH_GRANT_REVOKED") return new HyeboardError(error.code, "The VNU reconnect grant has been revoked.", 401);
  if (error.code === "VNU_REFRESH_RATE_LIMITED") return new HyeboardError(error.code, "Too many VNU reconnect attempts. Wait and try again.", 429, approvedVnuRefreshDetails(error));
  return new HyeboardError("VNU_REQUEST_FAILED", "The VNU reconnect request failed. Try again.", 502);
}

async function linkedRefreshInputs(session: EncryptedSessionPayload, grant: VnuRefreshGrantPayload, secret: string): Promise<{
  descriptor: VnuRefreshAccessDescriptor;
  oldPair: LinkedPair;
}> {
  const descriptor = session.vnuRefresh!;
  const principalKey = await deriveVnuRefreshPrincipal(grant.username, secret);
  if (principalKey !== descriptor.principalKey || grant.grantId !== descriptor.grantId || grant.expiresAt !== descriptor.grantExpiresAt) throw vnuRefreshIdentityMismatch();
  return { descriptor, oldPair: descriptorPair(descriptor) };
}

function decodeCanonicalBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid access token encoding");
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  const canonical = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  if (canonical !== value) throw new Error("Invalid access token encoding");
  return bytes;
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function decryptAuthenticatedLegacyVnuSession(token: string, secret: string): Promise<EncryptedSessionPayload> {
  try {
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("Invalid access token");
    const iv = decodeCanonicalBase64Url(parts[0]);
    const encrypted = decodeCanonicalBase64Url(parts[1]);
    if (iv.byteLength !== 12 || encrypted.byteLength < 17) throw new Error("Invalid access token");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
    const key = await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["decrypt"]);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: exactArrayBuffer(iv) }, key, exactArrayBuffer(encrypted));
    const value: unknown = JSON.parse(new TextDecoder().decode(decrypted));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid legacy session");
    const payload = value as Record<string, unknown>;
    if (Object.hasOwn(payload, "vnuRefresh")) throw new Error("Descriptor-bearing session is not legacy");
    if (payload.version !== 1 || payload.universityId !== "vnu" || typeof payload.expiresAt !== "string" || new Date(payload.expiresAt).toISOString() !== payload.expiresAt) throw new Error("Invalid legacy session");
    if (!payload.vnu || typeof payload.vnu !== "object" || Array.isArray(payload.vnu)) throw new Error("Invalid legacy session");
    const credential = payload.vnu as Record<string, unknown>;
    if (credential.kind !== "cookie" || typeof credential.value !== "string" || credential.value.length === 0) throw new Error("Invalid legacy session");
    return payload as EncryptedSessionPayload;
  } catch {
    throw new HyeboardError("INVALID_SESSION", "Invalid or malformed session token", 401);
  }
}

async function resolveOrdinaryAccessToken(token: string): Promise<EncryptedSessionPayload> {
  const session = await decryptSession(token, getSessionSecret());
  const epoch = checkSessionEpoch(session, haConfig);
  if (!epoch.accepted) throw new HyeboardError("SESSION_EXPIRED", "Session expired", 401);
  if (haConfig.mode === "distributed" && !sessionRevocationStore) throw distributedDependencyUnavailable("PostgreSQL session revocation");
  if (session.sessionId && await isSessionRevoked(session.sessionId)) throw new HyeboardError("SESSION_EXPIRED", "Session expired", 401);
  if (session.universityId === "vnu" && !session.vnu?.value) throw missingVnuCredential();
  const descriptor = session.vnuRefresh;
  if (!descriptor) {
    if (await isTokenRevoked(token)) throw new HyeboardError("SESSION_EXPIRED", "Session expired", 401);
    return session;
  }

  try {
    const result = await requireVnuRefreshControlCoordinator().checkAccess(descriptor.principalKey, descriptorPair(descriptor));
    if (result.kind === "revoked") throw new HyeboardError("SESSION_EXPIRED", "Session expired", 401);
    return session;
  } catch (error) {
    if (error instanceof HyeboardError && error.code === "SESSION_EXPIRED") throw error;
    const unavailable = vnuRefreshUnavailable();
    getLogger().error({ operation: "access-authority", code: unavailable.code, status: unavailable.status }, "VNU session authority check failed");
    throw unavailable;
  }
}

// ─── Error handling ───────────────────────────────────────────

// Shared with the SSE import-session branch below, which can't rely on
// Elysia's onError hook (errors thrown inside a ReadableStream's start()
// callback don't propagate to Elysia at all — the stream must catch and
// report its own errors as an "error" SSE event instead).
function errorPayload(error: unknown): { code: string; message: string; status: number } {
  if (error instanceof HyeboardError) return { code: error.code, message: error.message, status: error.status };
  return { code: "GOOGLE_SIGNIN_FAILURE", message: "Google sign-in did not complete. Try again.", status: 502 };
}

function routeError(error: unknown, requestId?: string, requestUrl?: string) {
  const id = requestId ?? "-";
  const log = getLogger();
  const headers = new Headers({ "Content-Type": "application/json" });
  const requestPath = requestUrl ? new URL(requestUrl).pathname : undefined;
  const isVnuRoute = requestPath?.startsWith("/api/vnu/") ?? false;
  const isVnuAuthMutation = requestPath === "/api/vnu/auth/refresh" || requestPath === "/api/vnu/auth/logout";
  const isVnuRawExpiry = requestPath?.startsWith("/api/vnu/raw/") && error instanceof HyeboardError && error.code === "VNU_SESSION_EXPIRED";
  if (isVnuCrossDetailResponsePath(requestPath) || requestPath?.startsWith("/api/uet/raw/") || requestPath?.startsWith("/api/vnu/class-lookup/")) headers.set("Cache-Control", "no-store, private");
  else if (isImportSessionPath(requestPath) || requestPath?.startsWith("/api/vnu/cross-lookup/") || isVnuAuthMutation || isVnuRawExpiry) headers.set("Cache-Control", "no-store");
  if (error instanceof HyeboardError) {
    const level = error.status >= 500 ? "error" : "warn";
    if (isVnuRoute) log[level]({ operation: "route", code: error.code, status: error.status }, "VNU request failed");
    else log[level]({ reqId: id, code: error.code, status: error.status }, error.message);
    const parsedDetails = apiErrorDetailsSchema.safeParse(error.details);
    return new Response(JSON.stringify(fail(error.code, error.message, parsedDetails.success ? parsedDetails.data : undefined)), { status: error.status, headers });
  }
  if (isVnuRoute) {
    const trustedFrameworkErrors = new Map<string, number>([["VALIDATION", 422], ["PARSE", 400], ["NOT_FOUND", 404]]);
    const candidateCode = error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : undefined;
    const candidateStatus = error instanceof Error && "status" in error && typeof (error as { status?: unknown }).status === "number"
      ? (error as { status: number }).status
      : undefined;
    const trustedFrameworkError = candidateCode !== undefined && trustedFrameworkErrors.get(candidateCode) === candidateStatus;
    const status = trustedFrameworkError ? (isVnuAuthMutation && candidateCode === "VALIDATION" ? 400 : candidateStatus!) : 500;
    const code = trustedFrameworkError ? candidateCode! : "INTERNAL_ERROR";
    const level = status >= 500 ? "error" : "warn";
    log[level]({ operation: "route", code, status }, "VNU request failed");
    const message = status < 500 ? "The request was invalid. Check the fields you submitted and try again." : "Unexpected API error";
    return new Response(JSON.stringify(fail(code, message)), { status, headers });
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
    return new Response(JSON.stringify(fail(code, message)), { status, headers });
  }
  log.error({ reqId: id, errorType: typeof error, stack: error instanceof Error ? error.stack : undefined }, "Unhandled error type");
  return new Response(JSON.stringify(fail("INTERNAL_ERROR", "Unexpected API error")), { status: 500, headers });
}

// Cross-detail permits are issued by the transcript route, then consumed by
// the detail and selected-export routes. Keep the entire permit lifecycle
// private, including failures which bypass individual route handlers.
function isVnuCrossDetailResponsePath(path: string | undefined): boolean {
  return path === "/api/vnu/cross-lookup/transcript" || path?.startsWith("/api/vnu/cross-lookup/detail") === true;
}

function isImportSessionPath(path: string | undefined): boolean {
  return /^\/api\/[^/]+\/auth\/import-session$/.test(path ?? "");
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

type VnuRefreshBody = { refreshGrant: string };
type VnuLogoutBody = { refreshGrant?: string };

const VNU_REFRESH_GRANT_JSON_OVERHEAD_BYTES = new TextEncoder().encode('{"refreshGrant":""}').byteLength;
const VNU_AUTH_BODY_WHITESPACE_ALLOWANCE_BYTES = 32;
// Canonical grant ceiling plus exact JSON syntax and small whitespace allowance.
// The reader stops before retaining any byte beyond this limit, including chunks.
const VNU_AUTH_BODY_MAX_BYTES = VNU_REFRESH_GRANT_MAX_LENGTH
  + VNU_REFRESH_GRANT_JSON_OVERHEAD_BYTES
  + VNU_AUTH_BODY_WHITESPACE_ALLOWANCE_BYTES;

async function parseStrictVnuAuthBody(request: Request, kind: "refresh" | "logout"): Promise<VnuRefreshBody | VnuLogoutBody> {
  const declaredLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > VNU_AUTH_BODY_MAX_BYTES) {
    throw new HyeboardError("PAYLOAD_TOO_LARGE", "The request body is too large.", 413);
  }
  if (!request.body) throw new HyeboardError("VALIDATION", "The request body is invalid.", 400);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (byteLength + value.byteLength > VNU_AUTH_BODY_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new HyeboardError("PAYLOAD_TOO_LARGE", "The request body is too large.", 413);
      }
      chunks.push(value);
      byteLength += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  let value: unknown;
  try {
    const encoded = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      encoded.set(chunk, offset);
      offset += chunk.byteLength;
    }
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(encoded));
  } catch (error) {
    if (error instanceof HyeboardError) throw error;
    throw new HyeboardError("VALIDATION", "The request body is invalid.", 400);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HyeboardError("VALIDATION", "The request body is invalid.", 400);
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => key !== "refreshGrant")) throw new HyeboardError("VALIDATION", "The request body is invalid.", 400);
  if (record.refreshGrant !== undefined && (typeof record.refreshGrant !== "string" || record.refreshGrant.length < 1 || record.refreshGrant.length > VNU_REFRESH_GRANT_MAX_LENGTH)) {
    throw new HyeboardError("VALIDATION", "The request body is invalid.", 400);
  }
  if (kind === "refresh" && typeof record.refreshGrant !== "string") throw new HyeboardError("VALIDATION", "The request body is invalid.", 400);
  return record as VnuRefreshBody | VnuLogoutBody;
}

const termCodeQuery = t.Object({ termCode: t.Optional(t.String()) });

const uetRawCapabilities: Record<string, CapabilityKey> = {
  profile: "profile",
  terms: "terms",
  timetable: "timetable",
  grades: "grades",
  gpa: "grades",
  exams: "exams",
  tuition: "tuition",
  news: "news",
};

const vnuRawCapabilities: Record<string, CapabilityKey> = {
  profile: "profile",
  grades: "grades",
  progress: "trainingPoints",
  "exam-base": "exams",
  syllabus: "documents",
  exams: "exams",
  "point-detail": "grades",
};

async function uetRawRead(session: EncryptedSessionPayload, resource: string, termCode?: string): Promise<unknown> {
  const client = new StudentHubClient(session);
  switch (resource) {
    case "profile": return client.getProfile();
    case "terms": return client.getTerms();
    case "timetable": return client.getTimetable(termCode);
    case "grades": return client.getGrades();
    case "gpa": return client.getGpa();
    case "exams": return client.getExams(termCode);
    case "tuition": return client.getBills();
    case "news": return client.getNews();
    default: throw new HyeboardError("UET_RAW_RESOURCE_UNKNOWN", "Unknown UET raw resource", 404);
  }
}

const vnuRawQuery = t.Object({
  // selUniv/selStd are still accepted so stale clients don't break, but they
  // are NEVER honored: vnuRawHtml strips them before cache keying and derives
  // server-owned selectors where required. vTermID stays client-supplied — it
  // is a term selector, not a per-student id.
  selUniv: t.Optional(t.String()),
  selStd: t.Optional(t.String()),
  vTermID: t.Optional(t.String()),
  // point-detail key only: class id and term ordinal. val is ignored.
  id: t.Optional(t.String()),
  val: t.Optional(t.String()),
  Term: t.Optional(t.String()),
});

// Cross-student lookup (vnu-only, see the crossLookup capability flag). Kept
// off the /api/vnu/raw/:page allow-list so the access pattern stays auditable
// and gated in exactly one place. allowCrossLookup must be the literal string
// "true" — an explicit, obviously-named opt-in, never a neutral flag.
const vnuCrossLookupQuery = t.Object({
  stdId: t.Optional(t.String()),
  stdCode: t.Optional(t.String()),
  allowCrossLookup: t.Optional(t.String()),
});

type VnuBulkLookupMode = "stdid-to-code" | "code-to-stdid" | "stdid-to-transcript";
type VnuBulkLookupBody = { mode: VnuBulkLookupMode; targets: unknown[]; allowCrossLookup: true };

function vnuBulkModeLimit(mode: VnuBulkLookupMode, limits: University["limits"]): number {
  const crossLookup = limits?.crossLookup;
  if (!crossLookup) return 0;
  return Math.min(
    crossLookup.bulkMaxTargets,
    crossLookup.bulkDirectChunkMaxTargets ?? crossLookup.bulkMaxTargets,
    crossLookup.bulkModeMaxTargets?.[mode] ?? crossLookup.bulkMaxTargets,
  );
}

function parseVnuBulkLookupBody(value: unknown, limits: University["limits"]): VnuBulkLookupBody {
  if (!isRecord(value)) throw new HyeboardError("VNU_CROSS_LOOKUP_BODY_INVALID", "Bulk cross-lookup needs a JSON object body.", 400);
  if (value.allowCrossLookup !== true) throw new HyeboardError("VNU_CROSS_LOOKUP_NOT_EXPLICITLY_ALLOWED", "Cross-student lookup requires the literal allowCrossLookup: true opt-in.", 400);
  if (value.mode !== "stdid-to-code" && value.mode !== "code-to-stdid" && value.mode !== "stdid-to-transcript") {
    throw new HyeboardError("VNU_CROSS_LOOKUP_MODE_INVALID", "Bulk cross-lookup mode is invalid.", 400);
  }
  if (!Array.isArray(value.targets) || value.targets.length === 0) throw new HyeboardError("VNU_CROSS_LOOKUP_TARGETS_INVALID", "Bulk cross-lookup needs at least one target.", 400);
  if (value.targets.length > vnuBulkModeLimit(value.mode, limits)) throw new HyeboardError("VNU_CROSS_LOOKUP_CHUNK_TOO_LARGE", "Bulk cross-lookup chunk exceeds the selected mode limit.", 400);
  return { mode: value.mode, targets: value.targets, allowCrossLookup: true };
}

async function parseVnuBulkLookupRequest(request: Request, limits: University["limits"]): Promise<VnuBulkLookupBody> {
  try {
    return parseVnuBulkLookupBody(await request.json(), limits);
  } catch (error) {
    if (error instanceof HyeboardError) throw error;
    throw new HyeboardError("VNU_CROSS_LOOKUP_BODY_INVALID", "Bulk cross-lookup needs a valid JSON object body.", 400);
  }
}

type VnuCrossLookupTranscript = Omit<VnuTranscript, "notice">;

function parseVnuCrossLookupTranscript(html: string): VnuCrossLookupTranscript {
  const { notice: _upstreamNotice, ...transcript } = parseTranscriptHtml(html);
  return transcript;
}

const VNU_PORTAL_STD_ID_PATTERN = /^\d{1,11}$/;
const VNU_PORTAL_STUDENT_CODE_PATTERN = /^\d{8}$/;

type VnuOwnIdentity = { ownStdId: number; ownCode?: number };

// Parse, don't validate: the session owner's portal identity is parsed into
// trusted positive integers exactly once, at this boundary, and every cross
// route below consumes only that result. A malformed profile value fails
// closed here with VNU_PROFILE_INCOMPLETE instead of slipping past a self-target
// guard through NaN semantics — Number(garbage) is NaN, NaN === NaN is false,
// so a raw Number() comparison can never be trusted as a guard.
function parseVnuOwnIdentity(
  profile: { internalStudentId?: string; studentCode?: string },
  options: { requireStudentCode: true },
): { ownStdId: number; ownCode: number };
function parseVnuOwnIdentity(
  profile: { internalStudentId?: string; studentCode?: string },
  options: { requireStudentCode: boolean },
): VnuOwnIdentity;
function parseVnuOwnIdentity(
  profile: { internalStudentId?: string; studentCode?: string },
  options: { requireStudentCode: boolean },
): VnuOwnIdentity {
  const stdIdText = profile.internalStudentId ?? "";
  const ownStdId = Number(stdIdText);
  const stdIdValid = VNU_PORTAL_STD_ID_PATTERN.test(stdIdText) && Number.isSafeInteger(ownStdId) && ownStdId > 0;
  if (!stdIdValid) throw incompleteVnuProfile();

  const codeText = profile.studentCode ?? "";
  const ownCode = Number(codeText);
  const codeValid = VNU_PORTAL_STUDENT_CODE_PATTERN.test(codeText) && Number.isSafeInteger(ownCode) && ownCode > 0;
  if (codeValid) return { ownStdId, ownCode };
  if (options.requireStudentCode) throw incompleteVnuProfile();
  return { ownStdId };
}

// Normalized numeric self-target comparisons. Targets reaching these helpers
// have already passed their own regex gates (^\d{1,11}$ / ^\d{8}$), so
// Number() on them is always a safe integer and leading-zero spellings of the
// same id ("00000001000" vs "1000") correctly compare equal.
function isOwnStdId(identity: VnuOwnIdentity, targetStdId: string): boolean {
  return Number(targetStdId) === identity.ownStdId;
}

function isOwnStudentCode(identity: VnuOwnIdentity, targetStdCode: string): boolean {
  return identity.ownCode !== undefined && Number(targetStdCode) === identity.ownCode;
}

type VnuProbeAllowance = { consume(): void };

function createVnuProbeAllowance(units: number): VnuProbeAllowance {
  let remaining = units;
  return {
    consume() {
      if (remaining <= 0) throw new Error("Reserved VNU probe allowance exhausted");
      remaining -= 1;
    },
  };
}

function vnuBulkReservationUnits(body: VnuBulkLookupBody): number {
  const unitsPerTarget = body.mode === "code-to-stdid" ? VNU_STUDENT_ID_RESOLVER_MAX_PROBES : 1;
  return body.targets.length * unitsPerTarget;
}

function bulkResolverCandidateWidth(activeWorkerCount: number): number {
  if (!Number.isSafeInteger(activeWorkerCount) || activeWorkerCount < 1 || activeWorkerCount > VNU_BRC1_PERMIT_LIMIT) {
    throw new Error("VNU bulk resolver worker count is invalid");
  }
  return Math.floor(VNU_BRC1_PERMIT_LIMIT / activeWorkerCount);
}

function throwIfRequestCancelled(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

function createBulkRequestDeadline(requestSignal: AbortSignal, timeoutMs: number): { signal: AbortSignal; abort: (reason: unknown) => void; cancel: () => void } {
  const controller = new AbortController();
  const abortFromRequest = (): void => controller.abort(requestSignal.reason ?? new DOMException("This operation was aborted", "AbortError"));
  if (requestSignal.aborted) abortFromRequest();
  else requestSignal.addEventListener("abort", abortFromRequest, { once: true });
  const timeout = setTimeout(() => controller.abort(new DOMException("Bulk cross-lookup request timed out", "TimeoutError")), timeoutMs);
  return {
    signal: controller.signal,
    abort: (reason) => controller.abort(reason),
    cancel: () => {
      clearTimeout(timeout);
      requestSignal.removeEventListener("abort", abortFromRequest);
    },
  };
}

function isIsolatedBulkLookupError(error: unknown): error is HyeboardError {
  return error instanceof HyeboardError
    && (error.code === "VNU_CROSS_LOOKUP_NOT_FOUND" || error.code === "VNU_CROSS_LOOKUP_NOT_CONVERGED");
}

// ─── Cache abstraction ────────────────────────────────────────
// The Cloudflare Cache API (`caches.default`) is native to Workers/workerd
// but doesn't exist on plain Node or Bun. To keep rate-limiting/session
// revocation working identically across all three runtimes, fall back to a
// tiny in-memory Map-based Cache-like shim implementing just the
// `.match(request)`/`.put(request, response)` surface that cacheGet/cachePut
// actually use. This is already documented as a best-effort guardrail, not a
// hard security boundary, so an in-memory Map is an equivalent-strength
// (if anything, more consistent within a single process) substitute.

export interface AppCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export interface RateLimitCoordinator {
  /** Atomically consumes amount from a fixed window shared by all workers. */
  consumeFixedWindow(key: string, amount: number, windowMs: number, limit: number): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
}

export interface VnuImportSingleFlight {
  run<T>(key: string, work: () => Promise<T>): Promise<T>;
}

function createMemoryCache(): AppCache {
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

const memoryCache: AppCache = createMemoryCache();
let injectedCache: AppCache | undefined;
let rateLimitCoordinator: RateLimitCoordinator | undefined;
let vnuImportSingleFlight: VnuImportSingleFlight | undefined;

export function setAppCache(cache: AppCache | undefined): void {
  injectedCache = cache;
}

export function setRateLimitCoordinator(coordinator: RateLimitCoordinator | undefined): void {
  rateLimitCoordinator = coordinator;
}

export function setVnuImportSingleFlight(coordinator: VnuImportSingleFlight | undefined): void {
  vnuImportSingleFlight = coordinator;
}

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

export function requestLogPath(url: string): string {
  return new URL(url).pathname;
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
let sharedCaptchaRelayCoordinatorInstalled = false;

const CAPTCHA_RELAY_TOKEN_DOMAIN = "hyeboard:captcha-relay:v1\0";
const CAPTCHA_RELAY_ID_PATTERN = /^[A-Za-z0-9_-]{16,80}$/;
const CAPTCHA_RELAY_SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;

export function setCaptchaRelayCoordinator(coordinator: CaptchaRelayCoordinator): void {
  captchaRelayCoordinator = coordinator;
  sharedCaptchaRelayCoordinatorInstalled = !(coordinator instanceof LocalCaptchaRelayCoordinator);
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
    if (haConfig.mode === "distributed") throw distributedDependencyUnavailable("Redis cache");
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
    if (haConfig.mode === "distributed") throw distributedDependencyUnavailable("Redis cache");
  }
}

async function appCache(): Promise<AppCache> {
  if (injectedCache) return injectedCache;
  if (haConfig.mode === "distributed") throw distributedDependencyUnavailable("Redis cache");
  const storage = globalThis.caches as (CacheStorage & { default?: Cache }) | undefined;
  if (!storage) return memoryCache;
  if (storage.default) return storage.default;
  if (typeof storage.open === "function") return storage.open("hyeboard");
  return memoryCache;
}

let vnuProbeBudgetCoordinator: VnuProbeBudgetCoordinator = {
  async consume() { throw probeBudgetUnavailable(); },
  async reserve() { throw probeBudgetUnavailable(); },
  async acquireBrc1Permit() { throw probeBudgetUnavailable(); },
  async releaseBrc1Permit() { throw probeBudgetUnavailable(); },
  async issueCrossDetailPermits() { throw probeBudgetUnavailable(); },
  async consumeCrossDetailPermit() { throw probeBudgetUnavailable(); },
  async releaseCrossDetailLease() { throw probeBudgetUnavailable(); },
};

// True only once a genuinely shared probe-budget coordinator backs the
// cross-lookup routes — in practice the authoritative Cloudflare Durable
// Object coordinator installed by index.ts. Self-hosted Node/Bun runtimes
// never install one, so their cross-lookup routes always fail closed with
// 503 and the capability must serialize as unavailable (see
// serializeUniversities below) rather than teasing UI that can only error.
let probeBudgetCoordinatorInstalled = false;

export function setVnuProbeBudgetCoordinator(coordinator: VnuProbeBudgetCoordinator): void {
  vnuProbeBudgetCoordinator = coordinator;
  probeBudgetCoordinatorInstalled = true;
}

let vnuRefreshControlCoordinator: VnuRefreshControlCoordinator | undefined;

export function setVnuRefreshControlCoordinator(coordinator: VnuRefreshControlCoordinator | undefined): void {
  vnuRefreshControlCoordinator = coordinator;
}

export interface SessionRevocationStore {
  revokeToken(token: string, expiresAt: string | Date | number): Promise<void>;
  isTokenRevoked(token: string, now?: number): Promise<boolean>;
  revokeSession(sessionId: string, expiresAt: string | Date | number): Promise<void>;
  isSessionRevoked(sessionId: string, now?: number): Promise<boolean>;
}

let sessionRevocationStore: SessionRevocationStore | undefined;

export function setSessionRevocationStore(store: SessionRevocationStore | undefined): void {
  sessionRevocationStore = store;
}

function requireVnuRefreshControlCoordinator(): VnuRefreshControlCoordinator {
  if (!vnuRefreshControlCoordinator) throw vnuRefreshUnavailable();
  return vnuRefreshControlCoordinator;
}

async function vnuProbeBudgetKey(session: EncryptedSessionPayload): Promise<string> {
  if (session.universityId !== "vnu" || !session.vnu?.value) throw missingVnuCredential();
  return hmacHex(`${session.vnu.value}\n${session.expiresAt}`);
}

// Sole Durable Object boundary for Brc1 oracle capacity. The opaque HMAC
// identity binds one coordinator to one VNU session without exposing cookies
// or student identifiers in its name or storage.
async function reserveVnuOracleProbes(session: EncryptedSessionPayload, amount: number): Promise<void> {
  try {
    await vnuProbeBudgetCoordinator.reserve(await vnuProbeBudgetKey(session), amount);
  } catch (error) {
    if (error instanceof HyeboardError) throw error;
    throw probeBudgetUnavailable();
  }
}

async function withVnuOraclePermit<T>(session: EncryptedSessionPayload, parentSignal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const abortParent = (): void => controller.abort(parentSignal.reason ?? new DOMException("This operation was aborted", "AbortError"));
  if (parentSignal.aborted) abortParent();
  else parentSignal.addEventListener("abort", abortParent, { once: true });
  const routeTimer = setTimeout(() => controller.abort(new DOMException("VNU cross-lookup request timed out", "TimeoutError")), effectiveVnuRuntimeConfig.crossLookupRequestTimeoutMs);
  const identity = await vnuProbeBudgetKey(session);
  let permit: { leaseId: string; expiresAt: number } | undefined;
  let leaseTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    permit = await vnuProbeBudgetCoordinator.acquireBrc1Permit(identity, controller.signal);
    leaseTimer = setTimeout(() => controller.abort(new DOMException("Brc1 permit expired", "TimeoutError")), Math.max(1, permit.expiresAt - Date.now()));
    throwIfRequestCancelled(controller.signal);
    return await work(controller.signal);
  } finally {
    clearTimeout(routeTimer);
    if (leaseTimer) clearTimeout(leaseTimer);
    parentSignal.removeEventListener("abort", abortParent);
    if (permit) await vnuProbeBudgetCoordinator.releaseBrc1Permit(identity, permit.leaseId).catch(() => undefined);
  }
}

function crossDetailLimits(effective: University): VnuCrossDetailLimits {
  const limits = effective.limits?.crossLookup?.crossDetail;
  if (!limits || !effectiveVnuRuntimeConfig.crossDetailEnabled || !probeBudgetCoordinatorInstalled) throw crossDetailUnavailable();
  return {
    ...limits,
    budget: effectiveVnuRuntimeConfig.crossDetailBudget,
    windowSeconds: effectiveVnuRuntimeConfig.crossDetailWindowSeconds,
  };
}

async function consumeVnuCrossDetailPermit(session: EncryptedSessionPayload, requesterToken: string, permit: string, limits: VnuCrossDetailLimits) {
  const parsed = parseVnuCrossDetailPermitString(permit);
  const envelope = await decryptVnuCrossDetailPermitEnvelope(parsed.envelope, getSessionSecret());
  const identity = await vnuProbeBudgetKey(session);
  const input = await buildVnuCrossDetailConsumeInput(getSessionSecret(), requesterToken, parsed, envelope);
  const consumed = await vnuProbeBudgetCoordinator.consumeCrossDetailPermit(identity, input, limits);
  return { consumed, envelope };
}

async function fetchVnuCrossDetail(
  session: EncryptedSessionPayload,
  requesterToken: string,
  permit: string,
  signal: AbortSignal,
  warmClient?: DaotaoClient,
  limits?: VnuCrossDetailLimits,
) {
  const effectiveLimits = limits ?? crossDetailLimits(await requireFeature("vnu", "crossLookup"));
  const { consumed, envelope } = await consumeVnuCrossDetailPermit(session, requesterToken, permit, effectiveLimits);
  try {
    const selector = {
      id: envelope.selector.classId,
      stdId: envelope.selector.stdId,
      term: envelope.selector.termOrdinal,
    };

    // First attempt — no proactive validateSession; let the request fail naturally.
    try {
      const client = warmClient ?? new DaotaoClient(session);
      if (!warmClient) {
        await client.getTranscriptByStdIdHtml(envelope.selector.stdId, signal);
      }
      const detailHtml = await client.getPointDetailHtml(selector, signal);
       return detailHtml;
    } catch (error) {
      if (!(error instanceof HyeboardError && error.code === "VNU_SESSION_EXPIRED")) throw error;

      // Retry once with a fresh client: re-validate session freshness,
      // re-warm transcript cookies, then re-fetch detail.
      const retryClient = new DaotaoClient(session);
      await retryClient.validateSession(signal);
      await retryClient.getTranscriptByStdIdHtml(envelope.selector.stdId, signal);
      const detailHtml = await retryClient.getPointDetailHtml(selector, signal);
       return detailHtml;
    }
  } finally {
    await vnuProbeBudgetCoordinator.releaseCrossDetailLease(await vnuProbeBudgetKey(session), consumed.leaseId).catch(() => undefined);
  }
}

// ─── Cross-detail batch grouping ───────────────────────────────
// When multiple permits target the same stdId, they share one DaotaoClient
// warmed once, avoiding concurrent getTranscriptByStdIdHtml calls that race
// the ASP server's per-request ASPSESSIONID rotation (causing VNU_SESSION_EXPIRED).
// Permits belonging to different stdIds still run in parallel via Promise.all.

type VnuCrossDetailBatchItem =
  | { permit: string; status: "ok"; html: string }
  | { permit: string; status: "error"; errorCode: string };

async function peekCrossDetailPermitStdId(permit: string): Promise<string> {
  const parsed = parseVnuCrossDetailPermitString(permit);
  const envelope = await decryptVnuCrossDetailPermitEnvelope(parsed.envelope, getSessionSecret());
  return envelope.selector.stdId;
}

async function fetchVnuCrossDetailBatch(
  session: EncryptedSessionPayload,
  requesterToken: string,
  permits: string[],
  signal: AbortSignal,
  limits: VnuCrossDetailLimits,
): Promise<VnuCrossDetailBatchItem[]> {
  // Group permits by stdId (peeked without consuming the DO permit)
  const groups = new Map<string, string[]>();
  for (const permit of permits) {
    let stdId: string;
    try {
      stdId = await peekCrossDetailPermitStdId(permit);
    } catch {
      // Invalid permit — will fail at consumption; isolate from valid groups
      stdId = `__invalid__${permit.slice(0, 8)}`;
    }
    const existing = groups.get(stdId);
    if (existing) existing.push(permit);
    else groups.set(stdId, [permit]);
  }

  // Each group: shared warm-up, sequential permit consumption
  const groupEntries = [...groups.entries()];
  const groupResults: VnuCrossDetailBatchItem[][] = [];
  let nextGroupIndex = 0;
  const processGroup = async (): Promise<void> => {
    while (true) {
      const groupIndex = nextGroupIndex++;
      if (groupIndex >= groupEntries.length) return;
      const [stdId, groupPermits] = groupEntries[groupIndex];
    if (stdId.startsWith("__invalid__")) {
      groupResults[groupIndex] = await Promise.all(groupPermits.map(async (permit) => {
        try {
          return { permit, status: "ok" as const, html: await fetchVnuCrossDetail(session, requesterToken, permit, signal, undefined, limits) };
        } catch (error) {
          return { permit, status: "error" as const, errorCode: error instanceof HyeboardError ? error.code : "VNU_REQUEST_FAILED" };
        }
      }));
      continue;
    }

    const client = new DaotaoClient(session);
    let warmErrorCode: string | undefined;
    try {
      await withVnuOraclePermit(session, signal, (permitSignal) => client.getTranscriptByStdIdHtml(stdId, permitSignal));
    } catch (error) {
      if (!(error instanceof HyeboardError) || !isCrossDetailItemError(error)) throw error;
      warmErrorCode = error.code;
    }

    const results: VnuCrossDetailBatchItem[] = [];
    for (const permit of groupPermits) {
      if (warmErrorCode !== undefined) {
        results.push({ permit, status: "error", errorCode: warmErrorCode });
        continue;
      }
      try {
        results.push({ permit, status: "ok", html: await fetchVnuCrossDetail(session, requesterToken, permit, signal, client, limits) });
      } catch (error) {
        if (!(error instanceof HyeboardError) || !isCrossDetailItemError(error)) throw error;
        results.push({ permit, status: "error", errorCode: error.code });
      }
    }
      groupResults[groupIndex] = results;
    }
  };
  await Promise.all(Array.from({ length: Math.min(limits.concurrency, groupEntries.length) }, () => processGroup()));

  // Preserve original permit order
  const itemMap = new Map(groupResults.flat().map((item) => [item.permit, item]));
  return permits.map((permit) => itemMap.get(permit)!);
}

function isCrossDetailItemError(error: HyeboardError): boolean {
  return error.code === "VNU_CROSS_LOOKUP_NOT_FOUND"
    || error.code === "VNU_CROSS_LOOKUP_NOT_CONVERGED"
    || error.code === "VNU_CROSS_DETAIL_PERMIT_INVALID"
    || error.code === "VNU_UPSTREAM_RESPONSE_INVALID"
    || error.code === "VNU_REQUEST_FAILED";
}

async function vnuImportCacheKey(username: string, password: string): Promise<string> {
  return `vnu/import/${await hmacHex(`${username}\n${password}`)}`;
}

type AuthenticatedSessionMetadata = {
  universityId: string;
  studentCode?: string;
  expiresAt: string;
  authenticated: true;
};

type CachedVnuImport = {
  seed: string;
  session: AuthenticatedSessionMetadata;
};

type RestoredCachedVnuImport = {
  payload: EncryptedSessionPayload;
  session: AuthenticatedSessionMetadata;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCachedVnuImport(value: unknown): CachedVnuImport | undefined {
  if (!isRecord(value) || typeof value.seed !== "string" || value.seed.length === 0 || !isRecord(value.session)) return undefined;

  const session = value.session;
  if (session.authenticated !== true || typeof session.universityId !== "string" || typeof session.expiresAt !== "string") return undefined;
  if (session.studentCode !== undefined && typeof session.studentCode !== "string") return undefined;

  return {
    seed: value.seed,
    session: {
      universityId: session.universityId,
      studentCode: session.studentCode,
      expiresAt: session.expiresAt,
      authenticated: true,
    },
  };
}

async function restoreCachedVnuImport(value: unknown, secret: string): Promise<RestoredCachedVnuImport | undefined> {
  const cached = parseCachedVnuImport(value);
  if (!cached) return undefined;

  try {
    const payload = await decryptSession(cached.seed, secret);
    const expiresAt = Date.parse(payload.expiresAt);
    if (payload.universityId !== "vnu" || payload.vnu?.kind !== "cookie" || typeof payload.vnu.value !== "string" || payload.vnu.value.length === 0) return undefined;
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return undefined;
    if (cached.session.universityId !== payload.universityId) return undefined;
    if (cached.session.studentCode !== payload.studentCode) return undefined;
    if (cached.session.expiresAt !== payload.expiresAt) return undefined;

    return { payload, session: cached.session };
  } catch {
    return undefined;
  }
}

async function issueVnuAuthResult(input: {
  username: string;
  password: string;
  payload: EncryptedSessionPayload;
  session: AuthenticatedSessionMetadata;
  secret: string;
  signal: AbortSignal;
}): Promise<AuthResult> {
  throwIfRequestCancelled(input.signal);
  const coordinator = vnuRefreshControlCoordinator;
  if (!coordinator) return { token: await encryptSession(sessionTokenPayload(input.payload), input.secret), session: input.session };

  const expectedStudentCode = input.payload.studentCode;
  if (!expectedStudentCode) throw incompleteVnuProfile();

  const grant = createVnuRefreshGrant({ username: input.username, password: input.password, expectedStudentCode });
  const descriptor = await createVnuRefreshAccessDescriptor({
    username: input.username,
    grantId: grant.grantId,
    accessExpiresAt: input.payload.expiresAt,
    grantExpiresAt: grant.expiresAt,
    secret: input.secret,
  });
  let activation: Awaited<ReturnType<VnuRefreshControlCoordinator["activatePair"]>>;
  throwIfRequestCancelled(input.signal);
  try {
    activation = await coordinator.activatePair(descriptor.principalKey, descriptorPair(descriptor));
  } catch {
    const unavailable = vnuRefreshUnavailable();
    getLogger().error({ operation: "manual-import-activation", code: unavailable.code, status: unavailable.status }, "VNU refresh pair activation failed");
    throw unavailable;
  }
  if (activation.kind === "rate-limited") {
    throw new HyeboardError(
      "VNU_MANUAL_ACTIVATION_RATE_LIMITED",
      "Too many VNU sign-ins. Wait before trying again.",
      429,
      { retryAfterSeconds: activation.retryAfterSeconds },
    );
  }
  const [token, refreshGrant] = await Promise.all([
    encryptSession(sessionTokenPayload({ ...input.payload, vnuRefresh: descriptor }), input.secret),
    encryptVnuRefreshGrant(grant, input.secret),
  ]);
  return { token, refreshGrant, session: input.session };
}

// ── Google-login rate limiting + token revocation ───────────────────────

const GOOGLE_LOGIN_RATE_LIMIT = 5;
const GOOGLE_LOGIN_RATE_WINDOW_SECONDS = 15 * 60;

async function googleLoginRateLimitKey(email: string): Promise<string> {
  return `uet/google-login-attempts/${await hmacHex(email.trim().toLowerCase())}`;
}

function sessionTokenPayload(payload: EncryptedSessionPayload, previous?: EncryptedSessionPayload): EncryptedSessionPayload {
  if (haConfig.mode !== "distributed") return payload;
  const sessionId = payload.sessionId ?? previous?.sessionId ?? (typeof crypto.randomUUID === "function" ? crypto.randomUUID() : requestId());
  return { ...payload, sessionId, sessionEpoch: haConfig.sessionEpoch };
}

async function checkAndIncrementGoogleLoginAttempts(email: string): Promise<void> {
  const key = await googleLoginRateLimitKey(email);
  if (haConfig.mode === "distributed") {
    if (!rateLimitCoordinator) throw distributedDependencyUnavailable("Redis rate limiter");
    let result: { allowed: boolean; retryAfterSeconds: number };
    try {
      result = await rateLimitCoordinator.consumeFixedWindow(key, 1, GOOGLE_LOGIN_RATE_WINDOW_SECONDS * 1000, GOOGLE_LOGIN_RATE_LIMIT);
    } catch {
      throw distributedDependencyUnavailable("Redis rate limiter");
    }
    if (!result.allowed) {
      throw new HyeboardError("GOOGLE_LOGIN_RATE_LIMITED", "Too many sign-in attempts for this email. Wait 15 minutes and try again, or use the manual token option below.", 429);
    }
    return;
  }

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
  if (sessionRevocationStore) {
    try {
      await sessionRevocationStore.revokeToken(token, expiresAt);
      return;
    } catch {
      if (haConfig.mode === "distributed") throw distributedDependencyUnavailable("PostgreSQL session revocation");
    }
  } else if (haConfig.mode === "distributed") {
    throw distributedDependencyUnavailable("PostgreSQL session revocation");
  }
  await cachePut(await revokedTokenKey(token), { revoked: true }, ttlSeconds);
}

async function isTokenRevoked(token: string): Promise<boolean> {
  if (sessionRevocationStore) {
    try {
      return await sessionRevocationStore.isTokenRevoked(token);
    } catch {
      if (haConfig.mode === "distributed") throw distributedDependencyUnavailable("PostgreSQL session revocation");
    }
  } else if (haConfig.mode === "distributed") {
    throw distributedDependencyUnavailable("PostgreSQL session revocation");
  }
  return Boolean(await cacheGet<{ revoked: true }>(await revokedTokenKey(token)));
}

async function revokeSession(session: EncryptedSessionPayload): Promise<void> {
  if (!session.sessionId) return;
  if (!sessionRevocationStore) {
    if (haConfig.mode === "distributed") throw distributedDependencyUnavailable("PostgreSQL session revocation");
    return;
  }
  try {
    await sessionRevocationStore.revokeSession(session.sessionId, session.expiresAt);
  } catch {
    if (haConfig.mode === "distributed") throw distributedDependencyUnavailable("PostgreSQL session revocation");
  }
}

async function isSessionRevoked(sessionId: string): Promise<boolean> {
  if (!sessionRevocationStore) {
    if (haConfig.mode === "distributed") throw distributedDependencyUnavailable("PostgreSQL session revocation");
    return false;
  }
  try {
    return await sessionRevocationStore.isSessionRevoked(sessionId);
  } catch {
    if (haConfig.mode === "distributed") throw distributedDependencyUnavailable("PostgreSQL session revocation");
    return false;
  }
}

async function vnuRawCacheKey(session: EncryptedSessionPayload, page: string, params: Record<string, string | undefined>): Promise<string> {
  return `vnu/raw/${await hmacHex(JSON.stringify({ cookie: session.vnu?.value ?? "", page, params }))}`;
}

function pointDetailSelector(gradesHtml: string, id: string, term: string): string {
  const selector = findPointDetailSelector(gradesHtml, id, term);
  if (!selector) {
    throw new HyeboardError("VNU_POINT_DETAIL_NOT_AVAILABLE", "Point detail is not available for this course.", 404);
  }
  return selector;
}

function detailPointClosingParenthesis(source: string, openingParenthesis: number): number | undefined {
  let quote: "'" | '"' | undefined;
  let depth = 1;

  for (let index = openingParenthesis + 1; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === "\\") {
        index += 1;
        continue;
      }
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (depth === 0) return index;
  }

  return undefined;
}

function thirdQuotedDetailPointArgument(source: string, openingParenthesis: number, closingParenthesis: number): { start: number; end: number } | undefined {
  let index = openingParenthesis + 1;

  for (let argument = 0; argument < 3; argument += 1) {
    while (/\s/.test(source[index] ?? "")) index += 1;
    const quote = source[index];
    if (quote !== "'" && quote !== '"') return undefined;

    const start = index + 1;
    index = start;
    while (index < closingParenthesis) {
      if (source[index] === "\\") {
        index += 2;
        continue;
      }
      if (source[index] === quote) break;
      index += 1;
    }
    if (index >= closingParenthesis) return undefined;
    if (argument === 2) return { start, end: index };

    index += 1;
    while (/\s/.test(source[index] ?? "")) index += 1;
    if (source[index] !== ",") return undefined;
    index += 1;
  }

  return undefined;
}

function sanitizeGradesHtmlForBrowser(html: string): string {
  const invocation = /\bdetailPoint\s*\(/gi;
  let sanitized = "";
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = invocation.exec(html))) {
    const openingParenthesis = invocation.lastIndex - 1;
    const closingParenthesis = detailPointClosingParenthesis(html, openingParenthesis);
    if (closingParenthesis === undefined) {
      const handlerEnd = html.indexOf(">", openingParenthesis);
      const replacementEnd = handlerEnd === -1 ? html.length : handlerEnd;
      sanitized += `${html.slice(cursor, match.index)}void 0`;
      cursor = replacementEnd;
      invocation.lastIndex = replacementEnd;
      continue;
    }

    const selector = thirdQuotedDetailPointArgument(html, openingParenthesis, closingParenthesis);
    if (!selector) {
      sanitized += `${html.slice(cursor, match.index)}void 0`;
      cursor = closingParenthesis + 1;
      continue;
    }

    sanitized += `${html.slice(cursor, selector.start)}${html.slice(selector.end, closingParenthesis + 1)}`;
    cursor = closingParenthesis + 1;
  }

  return `${sanitized}${html.slice(cursor)}`;
}

async function vnuRawHtml(session: EncryptedSessionPayload, page: string, params: { selUniv?: string; selStd?: string; vTermID?: string; id?: string; val?: string; Term?: string }, signal?: AbortSignal): Promise<string> {
  if (!session.vnu?.value) throw missingVnuCredential();
  // Client-supplied selStd/selUniv are never trusted for any key: per-student
  // branches below derive both ids from the session's own profile. Strip them
  // before cache keying too, so a smuggled value cannot even fragment this
  // session's cache entries.
  const { selStd: _ignoredSelStd, selUniv: _ignoredSelUniv, val: _ignoredVal, ...trustedParams } = params;
  const cacheKey = await vnuRawCacheKey(session, page, trustedParams);
  const cached = await cacheGet<{ html: string }>(cacheKey);
  if (cached) {
    if (isDaotaoSessionExpired("", cached.html)) {
      throw new HyeboardError("VNU_SESSION_EXPIRED", "The university portal session has expired. Sign in again.", 401);
    }
    return cached.html;
  }

  const client = new DaotaoClient(session);
  let html: string;
  if (page === "profile") html = await client.getProfileHtml(signal);
  else if (page === "grades") html = await client.getGradesHtml(signal);
  else if (page === "progress") html = await client.getStudyProgressHtml(signal);
  else if (page === "exam-base") html = await client.getExamBaseHtml(signal);
  else if (page === "syllabus") html = await client.getSyllabusHtml(signal);
  else if (page === "exams") {
    if (!trustedParams.vTermID) throw new HyeboardError("VNU_EXAM_QUERY_INCOMPLETE", "Exam lookup needs a term id (vTermID); the student and university ids are always derived from your own profile server-side.", 400);
    // Same hardening as point-detail: the selStd/selUniv sent upstream are
    // ALWAYS the session owner's own internal ids, resolved from their
    // profile here on the server. Live probing showed StdExamination.asp
    // silently ignores selStd anyway (self-echo — see har-notes.md), but
    // deriving the ids server-side keeps the proxy contract uniform with the
    // genuinely un-bound endpoints (listpoint_Brc1.asp, detailPoint.asp) and
    // stays correct if upstream behavior ever changes; cross-student access
    // lives only on the gated cross-lookup routes. The profile read reuses
    // this same cached path, keyed per session cookie.
    const ownProfile = parseProfileHtml(await vnuRawHtml(session, "profile", {}, signal));
    if (!VNU_PORTAL_STD_ID_PATTERN.test(ownProfile.internalStudentId ?? "") || !/^\d+$/.test(ownProfile.internalUnivId ?? "")) throw incompleteVnuProfile();
    html = await client.getExamsHtml({ selUniv: ownProfile.internalUnivId!, selStd: ownProfile.internalStudentId!, vTermID: trustedParams.vTermID }, signal);
  } else if (page === "point-detail") {
    if (!trustedParams.id || !trustedParams.Term) throw new HyeboardError("VNU_POINT_DETAIL_QUERY_INCOMPLETE", "Point detail needs a class id and a term ordinal.", 400);
    // detailPoint.asp accepts an unbound StdID. Authorize its selector solely
    // from the matching row in this session's cached own-grade document.
    const stdId = pointDetailSelector(await vnuRawHtml(session, "grades", {}, signal), trustedParams.id, trustedParams.Term);
    html = await client.getPointDetailHtml({ id: trustedParams.id, stdId, term: trustedParams.Term }, signal);
  } else {
    throw new HyeboardError("VNU_RAW_PAGE_UNKNOWN", `Unknown VNU raw page: ${page}`, 404);
  }

  if (signal) throwIfRequestCancelled(signal);
  await cachePut(cacheKey, { html }, page === "exams" || page === "point-detail" ? 60 : 300);
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

function serializeNativeUniversities(): University[] {
  return listUniversities().map((university) => {
    if (!probeBudgetCoordinatorInstalled && university.capabilities.crossLookup) {
      return { ...university, limits: undefined, capabilities: { ...university.capabilities, crossLookup: false } };
    }
    if (probeBudgetCoordinatorInstalled && university.id === "vnu" && university.capabilities.crossLookup) {
      const bulkMaxTargets = effectiveVnuRuntimeConfig.crossLookupBulkMaxTargets;
      return {
        ...university,
        limits: {
          crossLookup: {
            bulkMaxTargets,
            bulkDirectChunkMaxTargets: effectiveVnuRuntimeConfig.crossLookupDirectChunkMaxTargets,
            bulkModeMaxTargets: {
              "stdid-to-code": bulkMaxTargets,
              "stdid-to-transcript": bulkMaxTargets,
              "code-to-stdid": Math.min(bulkMaxTargets, Math.floor(300 / VNU_STUDENT_ID_RESOLVER_MAX_PROBES)),
            },
            ...(effectiveVnuRuntimeConfig.crossDetailEnabled
              ? { crossDetail: {
                maxTargets: effectiveVnuRuntimeConfig.crossDetailMaxTargets,
                maxRows: effectiveVnuRuntimeConfig.crossDetailMaxRows,
                concurrency: effectiveVnuRuntimeConfig.crossDetailConcurrency,
              } }
              : {}),
          },
        },
      };
    }
    return university;
  });
}

function effectiveHardLimits(): Partial<Record<OperationalLimitKey, number>> {
  const crossLookup = serializeNativeUniversities().find(({ id }) => id === "vnu")?.limits?.crossLookup;
  if (!crossLookup) return {};
  return {
    "crossLookup.bulkMaxTargets": crossLookup.bulkMaxTargets,
    ...(crossLookup.bulkDirectChunkMaxTargets === undefined ? {} : { "crossLookup.bulkDirectChunkMaxTargets": crossLookup.bulkDirectChunkMaxTargets }),
    ...(crossLookup.bulkModeMaxTargets?.["stdid-to-code"] === undefined ? {} : { "crossLookup.bulkModeMaxTargets.stdid-to-code": crossLookup.bulkModeMaxTargets["stdid-to-code"] }),
    ...(crossLookup.bulkModeMaxTargets?.["stdid-to-transcript"] === undefined ? {} : { "crossLookup.bulkModeMaxTargets.stdid-to-transcript": crossLookup.bulkModeMaxTargets["stdid-to-transcript"] }),
    ...(crossLookup.bulkModeMaxTargets?.["code-to-stdid"] === undefined ? {} : { "crossLookup.bulkModeMaxTargets.code-to-stdid": crossLookup.bulkModeMaxTargets["code-to-stdid"] }),
    ...(crossLookup.crossDetail === undefined ? {} : {
      "crossLookup.crossDetail.maxTargets": crossLookup.crossDetail.maxTargets,
      "crossLookup.crossDetail.maxRows": crossLookup.crossDetail.maxRows,
      "crossLookup.crossDetail.concurrency": crossLookup.crossDetail.concurrency,
    }),
  };
}

async function serializeUniversities(): Promise<University[]> {
  const policy = await requireFeaturePolicyRuntime().current();
  const hardLimits = effectiveHardLimits();
  return serializeNativeUniversities().map((university) => effectiveUniversity(university, policy, hardLimits));
}

async function resolveEffectiveUniversity(universityId: string): Promise<University> {
  const native = serializeNativeUniversities().find(({ id }) => id === universityId);
  if (!native) throw new HyeboardError("UNKNOWN_UNIVERSITY", `Unknown university: ${universityId}`, 404);
  return effectiveUniversity(native, await requireFeaturePolicyRuntime().current(), effectiveHardLimits());
}

async function requireFeature(universityId: string, capability: CapabilityKey): Promise<University> {
  const effective = await resolveEffectiveUniversity(universityId);
  if (!effective.capabilities[capability]) {
    throw new HyeboardError("FEATURE_DISABLED", "This feature is temporarily unavailable.", 503, { capability });
  }
  return effective;
}

function requireFeaturePolicyRuntime(): FeaturePolicyRuntime {
  if (!featurePolicyRuntime) throw new HyeboardError("FEATURE_POLICY_UNAVAILABLE", "Feature policy is unavailable.", 503);
  return featurePolicyRuntime;
}

const memoryAdminLoginWindows = new Map<string, { count: number; resetAt: number }>();
const memoryAdminLoginRateLimit: AdminLoginRateLimit = {
  // ponytail: process-local password limiter is valid only in documented single-process memory mode; use shared authority before replicas.
  async consume(bucketHash, limit, windowMs) {
    const now = Date.now();
    for (const [key, window] of memoryAdminLoginWindows) {
      if (window.resetAt <= now) memoryAdminLoginWindows.delete(key);
    }
    const stored = memoryAdminLoginWindows.get(bucketHash);
    const window = !stored || stored.resetAt <= now ? { count: 0, resetAt: now + windowMs } : stored;
    if (window.count >= limit) return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)) };
    memoryAdminLoginWindows.set(bucketHash, { ...window, count: window.count + 1 });
    return { allowed: true };
  },
};

function effectiveAdminLoginRateLimit(): AdminLoginRateLimit {
  if (adminLoginRateLimit) return adminLoginRateLimit;
  if (haConfig.mode === "distributed") {
    if (!rateLimitCoordinator) throw distributedDependencyUnavailable("Redis rate limiter");
    return {
      async consume(bucketHash, limit, windowMs) {
        try {
          return await rateLimitCoordinator!.consumeFixedWindow(`admin/login/${bucketHash}`, 1, windowMs, limit);
        } catch {
          throw distributedDependencyUnavailable("Redis rate limiter");
        }
      },
    };
  }
  if (haConfig.mode === "memory") return memoryAdminLoginRateLimit;
  throw distributedDependencyUnavailable("admin login limiter");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createApp(adapter: any, options: { lifecycle?: HaLifecycleController; clientIp?: (request: Request) => string | undefined } = {}) {
  const app = new Elysia({ adapter });
  const lifecycle = options.lifecycle ?? createHaLifecycle({ config: haConfig });

  const plugin = corsPlugin();
  if (plugin) app.use(plugin);

  const routed = app
    .onRequest(({ request, set }) => {
      // SAFETY: Request is extensible here; these process-local diagnostics never cross the API boundary.
      const req = request as unknown as { _hyebReqId?: string; _hyebStart?: number };
      req._hyebReqId = requestId();
      req._hyebStart = Date.now();
      const path = new URL(request.url).pathname;
      if (isVnuCrossDetailResponsePath(path) || path.startsWith("/api/uet/raw/") || path.startsWith("/api/vnu/class-lookup/")) set.headers["Cache-Control"] = "no-store, private";
      else if (path.startsWith("/api/admin/") || path === "/api/policy/events" || path.startsWith("/api/vnu/cross-lookup/") || isImportSessionPath(path) || path === "/api/vnu/auth/refresh" || path === "/api/vnu/auth/logout") set.headers["Cache-Control"] = "no-store";
      // Set HYEB_LOG_LEVEL=debug (Node/Bun .env, or a Cloudflare secret/var)
      // to see one line per incoming request here.
      getLogger().debug({ reqId: req._hyebReqId, method: request.method, path: requestLogPath(request.url) }, "request received");
    })
    .onAfterResponse(({ request, set }) => {
      // SAFETY: onRequest initializes these optional diagnostics on this Request instance.
      const req = request as unknown as { _hyebReqId?: string; _hyebStart?: number };
      getLogger().debug({ reqId: req._hyebReqId, status: set.status, durationMs: req._hyebStart ? Date.now() - req._hyebStart : undefined }, "request completed");
    })
    .onError(({ error, request }) => {
      // SAFETY: onRequest may attach this optional diagnostic to the Request instance.
      const req = request as unknown as { _hyebReqId?: string };
      return routeError(error, req._hyebReqId, request.url);
    });

  if (adminConfigEnabled) {
    const adminConfig = parseAdminConfig(runtimeConfig);
    // SAFETY: Elysia exposes the exact chainable get/post registrar surface consumed by the focused route module.
    registerAdminRoutes(routed as unknown as Parameters<typeof registerAdminRoutes>[0], {
      runtime: requireFeaturePolicyRuntime,
      config: () => adminConfig,
      rateLimit: { consume: (bucketHash, limit, windowMs) => effectiveAdminLoginRateLimit().consume(bucketHash, limit, windowMs) },
      clientIp: options.clientIp ?? (() => undefined),
      authenticateStudent: (request) => getSession(request.headers),
      nativeUniversities: serializeNativeUniversities,
      hardLimits: effectiveHardLimits,
    });
  }

  return routed
    // ── Public — no session required ──
    .get("/api/health", () => ok({ status: "ok", service: "hyeboard" }))
    .get("/api/live", async ({ set }) => {
      const diagnostics = await lifecycle.diagnostics();
      set.status = diagnostics.alive ? 200 : 503;
      return ok({ alive: diagnostics.alive, state: diagnostics.state, mode: diagnostics.mode, checkedAt: diagnostics.checkedAt });
    })
    .get("/api/ready", async ({ set }) => {
      await lifecycle.start();
      const snapshot = await lifecycle.snapshot();
      const diagnostics = safeHaDiagnostics(snapshot);
      set.status = diagnostics.state === "ready" ? 200 : 503;
      return ok(diagnostics);
    })
    .get("/api/universities", async () => ok(await serializeUniversities()))
    .post("/api/:universityId/auth/import-session", async ({ params, body, request, set }) => {
      set.headers["Cache-Control"] = "no-store";
      const adapterInstance = getAdapter(params.universityId);
      // Keep parent/guardian direct API logins on this SSE route so a
      // server-side OCR miss can relay the CAPTCHA image to the user. The
      // same rate limit remains shared with Google automation.
      if (params.universityId === "uet" && body.uetGoogleEmail) {
        if (!/^ph/i.test(body.uetGoogleEmail.trim())) ensureInlineAutomationAllowed();
        await checkAndIncrementGoogleLoginAttempts(body.uetGoogleEmail);
        const uetGoogleEmail = body.uetGoogleEmail;
        const uetGooglePassword = body.uetGooglePassword;
        // Google automation can take 90s+; parent direct login may pause for
        // a human CAPTCHA answer. Stream both as Server-Sent Events. Every
        // other branch below (vnu, manual-token/cookie paste, mock)
        // resolves almost instantly and keeps the plain JSON response.
        const encoder = new TextEncoder();
        let activeRelay: PreparedCaptchaRelay | undefined;
        let activeAutomationCancel: (() => Promise<void>) | undefined;
        let activeAutomationOwnershipToken: string | undefined;
        let cancelled = false;
        let closed = false;
        const cancelRelay = async () => {
          if (cancelled) return;
          cancelled = true;
          const relay = activeRelay;
          activeRelay = undefined;
          await relay?.cancel().catch(() => undefined);
          await activeAutomationCancel?.().catch(() => undefined);
        };
        const stream = new ReadableStream({
          async start(controller) {
            const send = (event: string, data: unknown, sequence?: number) => {
              if (cancelled || closed) return;
              try {
                controller.enqueue(encoder.encode(`${sequence === undefined ? "" : `id: ${sequence}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
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
              const distributedGoogle = haConfig.mode === "distributed" && !/^ph/i.test(uetGoogleEmail.trim());
              const cursorValue = new URL(request.url).searchParams.get("cursor") ?? request.headers.get("Last-Event-ID");
              const cursor = cursorValue === null || cursorValue === "" ? undefined : Number(cursorValue);
              if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < -1)) throw new HyeboardError("VALIDATION", "The automation replay cursor is invalid.", 400);
              const imported = distributedGoogle
                ? await requireDistributedAutomationBackend().importUetGoogle({
                    email: uetGoogleEmail,
                    password: uetGooglePassword ?? "",
                    idempotencyKey: request.headers.get("Idempotency-Key") ?? `login:${uetGoogleEmail.trim().toLowerCase()}:${uetGooglePassword ?? ""}`,
                    expectedStudentCode: uetGoogleEmail.trim().split("@")[0],
                  }, {
                    signal: request.signal,
                    cursor,
                    onJob: (ownershipToken) => {
                      activeAutomationOwnershipToken = ownershipToken;
                      activeAutomationCancel = () => requireDistributedAutomationBackend().cancelAutomation(ownershipToken);
                    },
                    onEvent: async (event) => {
                      if (event.type === "progress" && event.phase !== undefined && event.percent !== undefined) {
                        send("progress", { message: event.phase, phase: event.phase, percent: event.percent }, event.sequence);
                      } else if (event.type === "challenge-required" && event.challengeId && event.image) {
                        const backend = requireDistributedAutomationBackend();
                        if (!activeAutomationOwnershipToken) throw new HyeboardError("AUTOMATION_BACKEND_UNCONFIGURED", "Distributed browser automation ownership was not established.", 503);
                        send("captcha_required", { challengeId: backend.createChallengeToken(event, activeAutomationOwnershipToken), image: event.image }, event.sequence);
                      } else if (event.type === "succeeded") {
                        send("result", { sequence: event.sequence }, event.sequence);
                      }
                    },
                  })
                : await adapterInstance.importSession(body, {
                    signal: request.signal,
                    browserConnection: browserConnection(),
                    onProgress: (message) => send("progress", { message }),
                    onCaptchaNeeded: async (image) => {
                      if (haConfig.mode === "distributed" && !sharedCaptchaRelayCoordinatorInstalled) {
                        throw distributedDependencyUnavailable("Redis CAPTCHA relay");
                      }
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
              throwIfRequestCancelled(request.signal);
              const token = await encryptSession(sessionTokenPayload(imported.session), getSessionSecret());
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
            "Cache-Control": "no-store, no-transform",
            Connection: "keep-alive",
            // Disables response buffering on proxies that respect this
            // (e.g. nginx) so progress events actually stream incrementally
            // instead of arriving all at once when the connection closes.
            "X-Accel-Buffering": "no",
          },
        });
      }
      if (params.universityId === "vnu" && body.vnuUsername && body.vnuPassword) {
        const username = body.vnuUsername.trim().toLowerCase();
        const password = body.vnuPassword;
        const normalizedBody = { ...body, vnuUsername: username, vnuPassword: password };
        const cacheKey = await vnuImportCacheKey(username, password);
        const secret = getSessionSecret();
        const loginAndCache = async (): Promise<AuthResult> => {
          const imported = await adapterInstance.importSession(normalizedBody, { signal: request.signal });
          throwIfRequestCancelled(request.signal);
          const normalizedSession: EncryptedSessionPayload = {
            ...imported.session,
            studentCode: imported.studentCode ?? imported.session.studentCode,
          };
          if (!normalizedSession.studentCode) throw incompleteVnuProfile();
          const session = { universityId: normalizedSession.universityId, studentCode: normalizedSession.studentCode, expiresAt: normalizedSession.expiresAt, authenticated: true as const };
          throwIfRequestCancelled(request.signal);
          const authResult = await issueVnuAuthResult({ username, password, payload: normalizedSession, session, secret, signal: request.signal });
          const seed = await encryptSession(sessionTokenPayload(normalizedSession), secret);
          throwIfRequestCancelled(request.signal);
          await cachePut(cacheKey, { seed, session }, Math.floor((Date.parse(normalizedSession.expiresAt) - Date.now()) / 1000));
          return authResult;
        };

        const loginAfterCacheMiss = async (): Promise<AuthResult> => {
          if (haConfig.mode !== "distributed") return loginAndCache();
          if (!vnuImportSingleFlight) throw distributedDependencyUnavailable("Redis VNU import single-flight");

          // RedisSingleFlight also stores the result for its bounded TTL. Keep
          // upstream failures distinct so only coordinator/Redis failures map
          // to the distributed dependency error.
          const workFailure = Symbol("vnu-import-work-failure");
          let authResult: AuthResult;
          try {
            authResult = await vnuImportSingleFlight.run(cacheKey, async () => {
              try {
                return await loginAndCache();
              } catch (error) {
                throw { workFailure, error };
              }
            });
          } catch (error) {
            if (isRecord(error) && error.workFailure === workFailure) throw error.error;
            throw distributedDependencyUnavailable("Redis VNU import single-flight");
          }
          throwIfRequestCancelled(request.signal);
          return authResult;
        };

        const cached = await restoreCachedVnuImport(await cacheGet<unknown>(cacheKey), secret);
        if (!cached) return ok(await loginAfterCacheMiss());

        let liveStudentCode: string | undefined;
        try {
          liveStudentCode = parseProfileHtml(await new DaotaoClient(cached.payload).getProfileHtml(request.signal)).studentCode;
          throwIfRequestCancelled(request.signal);
        } catch (error) {
          if (error instanceof HyeboardError && error.code === "VNU_SESSION_EXPIRED") return ok(await loginAfterCacheMiss());
          throw error;
        }

        if (!liveStudentCode || liveStudentCode !== cached.payload.studentCode || liveStudentCode !== cached.session.studentCode) return ok(await loginAfterCacheMiss());

        return ok(await issueVnuAuthResult({ username, password, payload: cached.payload, session: cached.session, secret, signal: request.signal }));
      }
      const imported = await adapterInstance.importSession(body, { signal: request.signal });
      throwIfRequestCancelled(request.signal);
      const token = await encryptSession(sessionTokenPayload(imported.session), getSessionSecret());
      return ok({ token, session: { universityId: imported.universityId, studentCode: imported.studentCode, expiresAt: imported.expiresAt, authenticated: true } });
    }, { body: importSessionBody })
    // Answers a CAPTCHA challenge raised mid-login by the "captcha_required"
    // SSE event above. No session token exists
    // yet at this point in the flow (the whole point is to finish logging
    // in), so this is deliberately unauthenticated. Verify the signed relay
    // token before coordinator access so forged IDs cannot instantiate DOs.
    .post("/api/uet/auth/solve-captcha", async ({ body }) => {
      if (haConfig.mode === "distributed" && distributedAutomationBackend?.isAutomationChallengeToken(body.challengeId)) {
        await requireDistributedAutomationBackend().answerCaptcha(body.challengeId, body.answer);
        return ok({ accepted: true });
      }
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
    .post("/api/uet/auth/cancel-captcha", async ({ body }) => {
      if (haConfig.mode === "distributed" && distributedAutomationBackend?.isAutomationChallengeToken(body.challengeId)) {
        await requireDistributedAutomationBackend().cancelCaptcha(body.challengeId);
        return ok({ accepted: true });
      }
      throw captchaRelayNotFound();
    }, {
      body: t.Object({ challengeId: t.String({ minLength: 1, maxLength: 512 }) }),
    })
    .post("/api/uet/auth/cancel-automation", async ({ body }) => {
      await requireDistributedAutomationBackend().cancelAutomation(body.jobToken);
      return ok({ accepted: true });
    }, {
      body: t.Object({ jobToken: t.String({ minLength: 1, maxLength: 512 }) }),
    })
    .post("/api/vnu/auth/refresh", async ({ headers, request }) => {
      const token = parseBearerToken(new Headers(headers as Record<string, string>).get("Authorization"));
      if (!token) throw new HyeboardError("MISSING_SESSION", "Missing Authorization bearer token", 401);

      const secret = getSessionSecret();
      let session: EncryptedSessionPayload;
      try {
        session = await decryptSessionForVnuRefresh(token, secret);
      } catch (error) {
        try {
          await decryptAuthenticatedLegacyVnuSession(token, secret);
        } catch {
          throw error;
        }
        throw new HyeboardError("VNU_REFRESH_GRANT_INVALID", "The VNU reconnect grant is invalid or expired.", 401);
      }
      const body = await parseStrictVnuAuthBody(request, "refresh") as VnuRefreshBody;
      const grant = await decryptVnuRefreshGrant(body.refreshGrant, secret);
      const { descriptor, oldPair } = await linkedRefreshInputs(session, grant, secret);
      const coordinator = requireVnuRefreshControlCoordinator();

      if (session.universityId !== "vnu" || !session.studentCode || session.studentCode !== grant.expectedStudentCode) {
        try {
          await coordinator.revokeExactLinkedPair(descriptor.principalKey, oldPair);
        } catch {
          throw vnuRefreshUnavailable();
        }
        throw vnuRefreshIdentityMismatch();
      }

      let beginResult: BeginRefreshResult;
      try {
        beginResult = await coordinator.beginRefresh(descriptor.principalKey, oldPair);
      } catch {
        throw vnuRefreshUnavailable();
      }
      if (beginResult.kind !== "accepted") beginResultError(beginResult);

      let completionSettled = false;
      try {
        const imported = await getAdapter("vnu").importSession(
          { vnuUsername: grant.username, vnuPassword: grant.password, signal: request.signal },
          { signal: request.signal },
        );
        if (request.signal.aborted) throw vnuRefreshUnavailable();
        if (imported.universityId !== "vnu" || imported.studentCode !== grant.expectedStudentCode) throw vnuRefreshIdentityMismatch();
        const refreshedSession: EncryptedSessionPayload = {
          ...imported.session,
          studentCode: imported.studentCode,
        };
        ensureVnuIdentityMatch(refreshedSession, grant);

        const rotatedGrant = rotateVnuRefreshGrant(grant);
        const nextDescriptor = await createVnuRefreshAccessDescriptor({
          username: grant.username,
          grantId: rotatedGrant.grantId,
          accessExpiresAt: refreshedSession.expiresAt,
          grantExpiresAt: rotatedGrant.expiresAt,
          secret,
        });
        const nextPair = descriptorPair(nextDescriptor);
        const nextPayload = { ...refreshedSession, vnuRefresh: nextDescriptor };
        const [nextToken, nextGrant] = await Promise.all([
          encryptSession(sessionTokenPayload(nextPayload, session), secret),
          encryptVnuRefreshGrant(rotatedGrant, secret),
        ]);

        if (request.signal.aborted) throw vnuRefreshUnavailable();
        let completion: "completed" | "revoked";
        try {
          completion = await coordinator.completeRefresh(descriptor.principalKey, { old: oldPair, next: nextPair });
        } catch {
          throw vnuRefreshUnavailable();
        }
        completionSettled = true;
        if (completion === "revoked") throw new HyeboardError("VNU_REFRESH_GRANT_REVOKED", "The VNU reconnect grant has been revoked.", 401);

        return ok({
          token: nextToken,
          refreshGrant: nextGrant,
          session: {
            universityId: refreshedSession.universityId,
            studentCode: refreshedSession.studentCode,
            expiresAt: refreshedSession.expiresAt,
            authenticated: true,
          },
        });
      } catch (error) {
        if (!completionSettled) {
          try {
            await coordinator.abortRefresh(descriptor.principalKey, { pair: oldPair, terminal: isTerminalVnuRefreshFailure(error) });
          } catch {
            throw vnuRefreshUnavailable();
          }
        }
        throw publicVnuRefreshError(error);
      }
    })
    .post("/api/vnu/auth/logout", async ({ headers, request }) => {
      const token = parseBearerToken(new Headers(headers as Record<string, string>).get("Authorization"));
      if (!token) return ok({ authenticated: false });
      const secret = getSessionSecret();

      let session: EncryptedSessionPayload | undefined;
      let legacySession: EncryptedSessionPayload | undefined;
      try {
        session = await decryptSessionForVnuLogout(token, secret);
      } catch (error) {
        try {
          legacySession = await decryptAuthenticatedLegacyVnuSession(token, secret);
        } catch {
          throw error;
        }
      }
      const logoutBody = await parseStrictVnuAuthBody(request, "logout") as VnuLogoutBody;
      if (legacySession) {
        await revokeToken(token, legacySession.expiresAt);
        return ok({ authenticated: false });
      }

      const descriptor = session!.vnuRefresh!;
      const pair = descriptorPair(descriptor);
      if (logoutBody.refreshGrant !== undefined) {
        const grant = await decryptVnuRefreshGrantForLogout(logoutBody.refreshGrant, secret);
        await linkedRefreshInputs(session!, grant, secret);
        ensureVnuIdentityMatch(session!, grant);
      }

      let result: "revoked" | "mismatch" | "expired";
      try {
        const coordinator = requireVnuRefreshControlCoordinator();
        result = logoutBody.refreshGrant === undefined
          ? await coordinator.revokeLinkedPairByAccess(descriptor.principalKey, pair)
          : await coordinator.revokePrincipalByLinkedGrant(descriptor.principalKey, pair);
      } catch {
        throw vnuRefreshUnavailable();
      }
      if (result === "mismatch") throw new HyeboardError("VNU_REFRESH_GRANT_REVOKED", "The VNU reconnect grant has been revoked.", 401);
      const suppliedLinkedGrantIsLive = logoutBody.refreshGrant !== undefined && pair.grantExpiresAt > Date.now();
      const grantlessPairHasLiveArtifact = logoutBody.refreshGrant === undefined && (pair.accessExpiresAt > Date.now() || pair.grantExpiresAt > Date.now());
      if (result === "expired" && (suppliedLinkedGrantIsLive || grantlessPairHasLiveArtifact)) {
        throw new HyeboardError("VNU_REFRESH_GRANT_REVOKED", "The VNU reconnect grant has been revoked.", 401);
      }
      await revokeSession(session!);
      return ok({ authenticated: false });
    })
    .post("/api/:universityId/auth/logout", async ({ headers }) => {
      const h = headers instanceof Headers ? headers : new Headers(headers as Record<string, string>);
      const token = parseBearerToken(h.get("Authorization"));
      if (!token) return ok({ authenticated: false });

      let session: EncryptedSessionPayload;
      try {
        session = await decryptSession(token, getSessionSecret());
      } catch {
        // Already invalid/expired token — nothing to revoke.
        return ok({ authenticated: false });
      }

      await revokeSession(session);
      await revokeToken(token, session.expiresAt);
      return ok({ authenticated: false });
    })
    .get("/api/vnu/raw/:page", async ({ headers, params, query, request }) => {
      const session = await getSession(headers);
      if (session.universityId !== "vnu") throw new HyeboardError("SESSION_UNIVERSITY_MISMATCH", "Session university does not match route", 403);
      const capability = vnuRawCapabilities[params.page];
      if (!capability) throw new HyeboardError("VNU_RAW_PAGE_UNKNOWN", `Unknown VNU raw page: ${params.page}`, 404);
      await requireFeature("vnu", capability);
      const html = await vnuRawHtml(session, params.page, query, request.signal);
      return ok({ html: params.page === "grades" ? sanitizeGradesHtmlForBrowser(html) : html });
    }, { query: vnuRawQuery })
    .get("/api/vnu/class-lookup/catalog", async ({ headers, query, request }) => {
      const session = await getSession(headers);
      if (session.universityId !== "vnu") throw new HyeboardError("SESSION_UNIVERSITY_MISMATCH", "Session university does not match route", 403);
      await requireFeature("vnu", "classLookup");
      return ok({ html: await vnuRawHtml(session, "exams", query, request.signal) });
    }, { query: vnuRawQuery })
    .get("/api/vnu/class-lookup/point-detail", async ({ headers, query, request }) => {
      const session = await getSession(headers);
      if (session.universityId !== "vnu") throw new HyeboardError("SESSION_UNIVERSITY_MISMATCH", "Session university does not match route", 403);
      await requireFeature("vnu", "classLookup");
      return ok({ html: await vnuRawHtml(session, "point-detail", query, request.signal) });
    }, { query: vnuRawQuery })
    // Cross-student StdID -> student-code resolver. listpoint_Brc1.asp
    // HONORS selStd (live-verified — see har-notes.md): it renders the
    // requested student's identity header (name / 8-digit code / managing
    // class) for whatever selStd is passed. This deployment is authorized to
    // expose that, gated server-side behind an explicit opt-in flag and a
    // self-targeting rejection. Responses are NEVER cached: no shared-cache
    // path exists here, so one caller's cross-lookup result can never bleed
    // into another caller's cache entries. The fetched transcript HTML is
    // parsed here, server-side, and only the resolved code/name/class
    // ever cross the network — the target student's full grade table (which
    // the same HTML contains) is never sent to the browser. A header-less
    // response is a clean not-found, not an error.
    .get("/api/vnu/cross-lookup/student-code", async ({ headers, query, request }) => {
      const session = await getSession(headers);
      if (session.universityId !== "vnu") throw new HyeboardError("SESSION_UNIVERSITY_MISMATCH", "Session university does not match route", 403);
      await requireFeature("vnu", "crossLookup");
      if (query.allowCrossLookup !== "true") throw new HyeboardError("VNU_CROSS_LOOKUP_NOT_EXPLICITLY_ALLOWED", "Cross-student lookup requires the explicit allowCrossLookup=true opt-in.", 400);
      if (!query.stdId || !/^\d{1,11}$/.test(query.stdId)) throw new HyeboardError("VNU_CROSS_LOOKUP_QUERY_INCOMPLETE", "Cross-student student-code lookup needs a target student id.", 400);
      // Fails closed when the caller's own id is unavailable or malformed:
      // without a parsed own identity the self-targeting check below cannot
      // run, so the request is rejected rather than allowed through
      // unverified (see parseVnuOwnIdentity).
      const ownIdentity = parseVnuOwnIdentity(parseProfileHtml(await vnuRawHtml(session, "profile", {}, request.signal)), {
        requireStudentCode: false,
      });
      if (isOwnStdId(ownIdentity, query.stdId)) throw new HyeboardError("VNU_CROSS_LOOKUP_SELF_TARGET", "That is your own student id. Your own ID mapping is on the Lookup page; cross-lookup is only for other students.", 400);
      await reserveVnuOracleProbes(session, 1);
      const allowance = createVnuProbeAllowance(1);
      allowance.consume();
      const html = await withVnuOraclePermit(session, request.signal, (signal) => new DaotaoClient(session).getTranscriptByStdIdHtml(query.stdId!, signal));
      const { studentCode, studentName, className } = parseTranscriptHeader(html);
      if (!studentCode) throw new HyeboardError("VNU_CROSS_LOOKUP_NOT_FOUND", "The portal did not return a student for that identifier.", 404);
      return ok({ studentCode, studentName, className });
    }, { query: vnuCrossLookupQuery })
    // Cross-student student-code -> StdID resolver (the reverse direction of
    // the route above). No portal endpoint maps a public student code back to
    // an internal StdID, so this walks the live-verified Brc1 oracle. The
    // resolver projects from the caller anchor and searches a bounded ±16
    // candidate window using exact portal-code equality. Configured concurrency
    // controls candidate overlap; the whole worst-case reservation is consumed
    // conservatively before upstream work.
    .get("/api/vnu/cross-lookup/student-id", async ({ headers, query, request }) => {
      const session = await getSession(headers);
      if (session.universityId !== "vnu") throw new HyeboardError("SESSION_UNIVERSITY_MISMATCH", "Session university does not match route", 403);
      await requireFeature("vnu", "crossLookup");
      if (query.allowCrossLookup !== "true") throw new HyeboardError("VNU_CROSS_LOOKUP_NOT_EXPLICITLY_ALLOWED", "Cross-student lookup requires the explicit allowCrossLookup=true opt-in.", 400);
      if (!query.stdCode || !/^\d{8}$/.test(query.stdCode)) throw new HyeboardError("VNU_CROSS_LOOKUP_QUERY_INCOMPLETE", "Cross-student student-id lookup needs a target 8-digit student code.", 400);
      const ownIdentity = parseVnuOwnIdentity(parseProfileHtml(await vnuRawHtml(session, "profile", {}, request.signal)), {
        requireStudentCode: true,
      });
      if (isOwnStudentCode(ownIdentity, query.stdCode)) throw new HyeboardError("VNU_CROSS_LOOKUP_SELF_TARGET", "That is your own student code. Your own ID mapping is on the Lookup page; cross-lookup is only for other students.", 400);

      await reserveVnuOracleProbes(session, VNU_STUDENT_ID_RESOLVER_MAX_PROBES);
      const allowance = createVnuProbeAllowance(VNU_STUDENT_ID_RESOLVER_MAX_PROBES);
      const client = new DaotaoClient(session);
      return ok(await resolveVnuStudentId({
        ownStdId: ownIdentity.ownStdId,
        ownCode: ownIdentity.ownCode,
        targetCode: query.stdCode,
        concurrency: effectiveVnuRuntimeConfig.codeLookupConcurrency,
        signal: request.signal,
        fetchStudentCode: async (stdId, signal) => {
          allowance.consume();
          const html = await withVnuOraclePermit(session, signal, (permitSignal) => client.getTranscriptByStdIdHtml(String(stdId), permitSignal));
          return parseTranscriptHeader(html).studentCode;
        },
      }));
    }, { query: vnuCrossLookupQuery })
    .get("/api/vnu/cross-lookup/transcript", async ({ headers, query, set, request }) => {
       set.headers["Cache-Control"] = "no-store, private";
      const session = await getSession(headers);
      if (session.universityId !== "vnu") throw new HyeboardError("SESSION_UNIVERSITY_MISMATCH", "Session university does not match route", 403);
      const effective = await requireFeature("vnu", "crossLookup");
      if (query.allowCrossLookup !== "true") throw new HyeboardError("VNU_CROSS_LOOKUP_NOT_EXPLICITLY_ALLOWED", "Cross-student lookup requires the explicit allowCrossLookup=true opt-in.", 400);

      const hasStdId = query.stdId !== undefined;
      const hasStdCode = query.stdCode !== undefined;
      if (hasStdId === hasStdCode || (hasStdId && !/^\d{1,11}$/.test(query.stdId!)) || (hasStdCode && !/^\d{8}$/.test(query.stdCode!))) {
        throw new HyeboardError("VNU_CROSS_LOOKUP_QUERY_INCOMPLETE", "Cross-student transcript lookup needs exactly one valid target: stdId or 8-digit stdCode.", 400);
      }

      const ownIdentity = parseVnuOwnIdentity(parseProfileHtml(await vnuRawHtml(session, "profile", {}, request.signal)), {
        requireStudentCode: true,
      });
      if (hasStdId && isOwnStdId(ownIdentity, query.stdId!)) throw new HyeboardError("VNU_CROSS_LOOKUP_SELF_TARGET", "That is your own student id. Your own transcript is on the Grades page; cross-lookup is only for other students.", 400);
      if (hasStdCode && isOwnStudentCode(ownIdentity, query.stdCode!)) throw new HyeboardError("VNU_CROSS_LOOKUP_SELF_TARGET", "That is your own student code. Your own transcript is on the Grades page; cross-lookup is only for other students.", 400);

      const reservedUnits = hasStdCode ? VNU_STUDENT_ID_RESOLVER_MAX_PROBES + 1 : 1;
      await reserveVnuOracleProbes(session, reservedUnits);
      const allowance = createVnuProbeAllowance(reservedUnits);
      const client = new DaotaoClient(session);
      let targetStdId = query.stdId;
      if (query.stdCode) {
        const resolvedTarget = await resolveVnuStudentId({
          ownStdId: ownIdentity.ownStdId,
          ownCode: ownIdentity.ownCode,
          targetCode: query.stdCode,
          concurrency: effectiveVnuRuntimeConfig.codeLookupConcurrency,
          signal: request.signal,
          fetchStudentCode: async (stdId, signal) => {
            allowance.consume();
            return parseTranscriptHeader(await withVnuOraclePermit(session, signal, (permitSignal) => client.getTranscriptByStdIdHtml(String(stdId), permitSignal))).studentCode;
          },
        });
        targetStdId = resolvedTarget.stdId;
      }

       allowance.consume();
       const transcriptHtml = await withVnuOraclePermit(session, request.signal, (signal) => client.getTranscriptByStdIdHtml(targetStdId!, signal));
       const transcript = parseVnuCrossLookupTranscript(transcriptHtml);
       if (!transcript.header.studentCode) throw new HyeboardError("VNU_CROSS_LOOKUP_NOT_FOUND", "The portal did not return a student for that identifier.", 404);
       if (!effectiveVnuRuntimeConfig.crossDetailEnabled || !probeBudgetCoordinatorInstalled || !effective.limits?.crossLookup?.crossDetail) return ok(transcript);
       const limits = crossDetailLimits(effective);
       const requesterToken = parseBearerToken(new Headers(headers as Record<string, string>).get("Authorization"));
       if (!requesterToken) throw new HyeboardError("MISSING_SESSION", "Missing Authorization bearer token", 401);
       const minter = createVnuCrossDetailMinter({
         secret: getSessionSecret(),
         requesterToken,
         maxTargets: limits.maxTargets,
         maxRows: limits.maxRows,
         permitTtlSeconds: effectiveVnuRuntimeConfig.crossDetailPermitTtlSeconds,
       });
       const permitRows = await Promise.all(transcript.terms.flatMap((term) => term.rows.map(async (row, index) => ({
         termIndex: transcript.terms.indexOf(term),
         rowIndex: index,
         permit: row.classId && row.termOrdinal
           ? await minter.mint({ targetStdId: targetStdId!, transcriptHtml, row: { courseCode: row.courseCode, classId: row.classId, termOrdinal: row.termOrdinal } })
           : undefined,
       }))));
       if (minter.issued.length) await vnuProbeBudgetCoordinator.issueCrossDetailPermits(await vnuProbeBudgetKey(session), minter.issued, limits);
       return ok({ ...transcript, detailPermits: permitRows.filter((row): row is typeof row & { permit: string } => row.permit !== undefined).map(({ termIndex, rowIndex, permit }) => ({ termIndex, rowIndex, permit })) });
     }, { query: vnuCrossLookupQuery })
    .post("/api/vnu/cross-lookup/detail", async ({ headers, request, set }) => {
      set.headers["Cache-Control"] = "no-store, private";
      const session = await getSession(headers);
      if (session.universityId !== "vnu") throw new HyeboardError("SESSION_UNIVERSITY_MISMATCH", "Session university does not match route", 403);
      const requesterToken = parseBearerToken(new Headers(headers as Record<string, string>).get("Authorization"));
      if (!requesterToken) throw new HyeboardError("MISSING_SESSION", "Missing Authorization bearer token", 401);
      const limits = crossDetailLimits(await requireFeature("vnu", "crossLookup"));
      const { permit } = await readVnuCrossDetailBody(request, "single", limits.maxRows);
       return ok({ permit, html: await fetchVnuCrossDetail(session, requesterToken, permit, request.signal, undefined, limits) });
    }, { parse: "none" })
    .post("/api/vnu/cross-lookup/detail/bulk", async ({ headers, request, set }) => {
      set.headers["Cache-Control"] = "no-store, private";
      const session = await getSession(headers);
      if (session.universityId !== "vnu") throw new HyeboardError("SESSION_UNIVERSITY_MISMATCH", "Session university does not match route", 403);
      const requesterToken = parseBearerToken(new Headers(headers as Record<string, string>).get("Authorization"));
      if (!requesterToken) throw new HyeboardError("MISSING_SESSION", "Missing Authorization bearer token", 401);
      const limits = crossDetailLimits(await requireFeature("vnu", "crossLookup"));
      const { permits } = await readVnuCrossDetailBody(request, "bulk", limits.maxRows);
      const items = await fetchVnuCrossDetailBatch(session, requesterToken, permits, request.signal, limits);
      return ok({ items });
    }, { parse: "none" })
    .post("/api/vnu/cross-lookup/detail/export", async ({ headers, request, set }) => {
      set.headers["Cache-Control"] = "no-store, private";
      const session = await getSession(headers);
      if (session.universityId !== "vnu") throw new HyeboardError("SESSION_UNIVERSITY_MISMATCH", "Session university does not match route", 403);
      const requesterToken = parseBearerToken(new Headers(headers as Record<string, string>).get("Authorization"));
      if (!requesterToken) throw new HyeboardError("MISSING_SESSION", "Missing Authorization bearer token", 401);
      const limits = crossDetailLimits(await requireFeature("vnu", "crossLookup"));
      const { permits } = await readVnuCrossDetailBody(request, "export", limits.maxRows);
      const items = await fetchVnuCrossDetailBatch(session, requesterToken, permits, request.signal, limits);
      return ok({ items });
    }, { parse: "none" })
    .post("/api/vnu/cross-lookup/bulk", async ({ headers, request }) => {
      const session = await getSession(headers);
      if (session.universityId !== "vnu") throw new HyeboardError("SESSION_UNIVERSITY_MISMATCH", "Session university does not match route", 403);
      const effective = await requireFeature("vnu", "crossLookup");
      const body = await parseVnuBulkLookupRequest(request, effective.limits);
      const deadline = createBulkRequestDeadline(request.signal, effectiveVnuRuntimeConfig.crossLookupRequestTimeoutMs);

      try {

      const needsOwnCode = body.mode === "code-to-stdid";
      const ownIdentity = parseVnuOwnIdentity(parseProfileHtml(await vnuRawHtml(session, "profile", {}, deadline.signal)), {
        requireStudentCode: needsOwnCode,
      });

      const reservedUnits = vnuBulkReservationUnits(body);
      await reserveVnuOracleProbes(session, reservedUnits);
      const allowance = createVnuProbeAllowance(reservedUnits);
      const client = new DaotaoClient(session);
      const items: Array<{ target: string; status: "ok"; result: unknown } | { target: string; status: "error"; errorCode: string }> = [];

      if (body.mode === "code-to-stdid") {
        const orderedItems = new Array<typeof items[number]>(body.targets.length);
        const activeWorkerCount = Math.min(effectiveVnuRuntimeConfig.codeLookupBulkTargetConcurrency, body.targets.length);
        const candidateConcurrency = bulkResolverCandidateWidth(activeWorkerCount);
        let nextIndex = 0;
        const resolveTarget = async (index: number): Promise<void> => {
          throwIfRequestCancelled(deadline.signal);
          const rawTarget = body.targets[index];
          const target = typeof rawTarget === "string" ? rawTarget : "";
          if (typeof rawTarget !== "string" || !/^\d{8}$/.test(target)) {
            orderedItems[index] = { target, status: "error", errorCode: "VNU_CROSS_LOOKUP_INVALID_TARGET" };
            return;
          }
          if (isOwnStudentCode(ownIdentity, target)) {
            orderedItems[index] = { target, status: "error", errorCode: "VNU_CROSS_LOOKUP_SELF_TARGET" };
            return;
          }
          try {
            const resolution = await resolveVnuStudentId({
              ownStdId: ownIdentity.ownStdId,
              ownCode: ownIdentity.ownCode!,
              targetCode: target,
              concurrency: candidateConcurrency,
              signal: deadline.signal,
              fetchStudentCode: async (stdId, signal) => {
                allowance.consume();
                return parseTranscriptHeader(await withVnuOraclePermit(session, signal, (permitSignal) => client.getTranscriptByStdIdHtml(String(stdId), permitSignal))).studentCode;
              },
            });
            orderedItems[index] = { target, status: "ok", result: resolution };
          } catch (error) {
            if (isIsolatedBulkLookupError(error)) {
              orderedItems[index] = { target, status: "error", errorCode: error.code };
              return;
            }
            deadline.abort(error);
            throw error;
          }
        };
        const worker = async (): Promise<void> => {
          while (!deadline.signal.aborted) {
            const index = nextIndex;
            nextIndex += 1;
            if (index >= body.targets.length) return;
            await resolveTarget(index);
          }
          throwIfRequestCancelled(deadline.signal);
        };
        const workers = Array.from({ length: activeWorkerCount }, () => worker());
        const settled = await Promise.allSettled(workers);
        const fatal = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (fatal) throw fatal.reason;
        return ok({ items: orderedItems });
      }

      for (let index = 0; index < body.targets.length; index += 1) {
        throwIfRequestCancelled(deadline.signal);
        const rawTarget = body.targets[index];
        const target = typeof rawTarget === "string" ? rawTarget : "";
        if (typeof rawTarget !== "string" || !/^\d{1,11}$/.test(target)) {
          items.push({ target, status: "error", errorCode: "VNU_CROSS_LOOKUP_INVALID_TARGET" });
          continue;
        }

        if (isOwnStdId(ownIdentity, target)) {
          items.push({ target, status: "error", errorCode: "VNU_CROSS_LOOKUP_SELF_TARGET" });
          continue;
        }

        try {
          if (body.mode === "stdid-to-code") {
            allowance.consume();
            const header = parseTranscriptHeader(await withVnuOraclePermit(session, deadline.signal, (signal) => client.getTranscriptByStdIdHtml(target, signal)));
            if (!header.studentCode) throw new HyeboardError("VNU_CROSS_LOOKUP_NOT_FOUND", "Student not found", 404);
            items.push({ target, status: "ok", result: { studentCode: header.studentCode, studentName: header.studentName, className: header.className } });
            continue;
          }

          if (body.mode === "stdid-to-transcript") {
            allowance.consume();
            const transcript = parseVnuCrossLookupTranscript(await withVnuOraclePermit(session, deadline.signal, (signal) => client.getTranscriptByStdIdHtml(target, signal)));
            if (!transcript.header.studentCode) throw new HyeboardError("VNU_CROSS_LOOKUP_NOT_FOUND", "Student not found", 404);
            items.push({ target, status: "ok", result: transcript });
          }
        } catch (error) {
          if (!isIsolatedBulkLookupError(error)) throw error;
          items.push({
            target,
            status: "error",
            errorCode: error.code,
          });
        }
      }

      return ok({ items });
      } finally {
        deadline.cancel();
      }
    }, { parse: "none" })

    .group("/api/uet", (g) =>
      g
        .resolve(async ({ headers, request }) => {
          const { session, refreshedToken } = await resolveSession(headers, request.signal);
          if (session.universityId !== "uet") throw new HyeboardError("SESSION_UNIVERSITY_MISMATCH", "Session university does not match route", 403);
          return { session, refreshedToken };
        })
        .onAfterHandle(({ response, refreshedToken }) => {
          if (!refreshedToken || !response || typeof response !== "object") return response;
          const typed = response as { data?: unknown; error?: unknown; meta?: Record<string, unknown> };
          if (!("data" in typed)) return response;
          return { ...typed, meta: { ...(typed.meta ?? {}), refreshedToken } };
        })
        .get("/raw/:resource", async ({ session, params, query, set }) => {
          set.headers["Cache-Control"] = "no-store, private";
          const capability = uetRawCapabilities[params.resource];
          if (!capability) throw new HyeboardError("UET_RAW_RESOURCE_UNKNOWN", "Unknown UET raw resource", 404);
          await requireFeature("uet", capability);
          return ok(await uetRawRead(session, params.resource, query.termCode));
        }, { query: termCodeQuery }),
    )

    // ── Authenticated — session+adapter injected via resolve() ──
    .group("/api/:universityId", (g) =>
      g
        .resolve(async ({ headers, params, request }) => {
          const { session, refreshedToken } = await resolveSession(headers, request.signal);
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
        .get("/auth/session", async ({ session }) => {
          const effective = await resolveEffectiveUniversity(session.universityId);
          return ok({
            universityId: session.universityId,
            expiresAt: session.expiresAt,
            authenticated: true,
            ...(effective.capabilities.profile === true ? { studentCode: session.studentCode } : {}),
          });
        })
        .get("/me", async ({ adapter, session, request }) => { await requireFeature(session.universityId, "profile"); return ok(await adapter.getStudentProfile({ session, signal: request.signal })); })
        .get("/dashboard", async ({ adapter, session, query, request }) => {
          const effective = await resolveEffectiveUniversity(session.universityId);
          const dashboardRequest = { session, termCode: query.termCode, capabilities: effective.capabilities, signal: request.signal };
          const dashboard = await adapter.getDashboard(dashboardRequest);
          return ok(filterDashboardSummary(dashboard, effective.capabilities));
        }, { query: termCodeQuery })
        .get("/terms", async ({ adapter, session }) => { await requireFeature(session.universityId, "terms"); return ok(await adapter.getTerms({ session })); })
        .get("/timetable", async ({ adapter, session, query }) => { await requireFeature(session.universityId, "timetable"); return ok(await adapter.getTimetable({ session, termCode: query.termCode })); }, { query: termCodeQuery })
        .get("/courses", async ({ adapter, session }) => { await requireFeature(session.universityId, "courses"); return ok(await adapter.getCourses({ session })); })
        .get("/courses/:courseId", async ({ adapter, session, params }) => { await requireFeature(session.universityId, "courses"); return ok(await adapter.getCourseDetail({ session, courseId: params.courseId })); })
        .get("/assignments", async ({ adapter, session }) => { await requireFeature(session.universityId, "assignments"); return ok(await adapter.getAssignments({ session })); })
        .get("/grades", async ({ adapter, session }) => { await requireFeature(session.universityId, "grades"); return ok(await adapter.getGrades({ session })); })
        .get("/gpa", async ({ adapter, session }) => { await requireFeature(session.universityId, "grades"); return ok(await adapter.getGpaSummary({ session })); })
        .get("/exams", async ({ adapter, session, query }) => { await requireFeature(session.universityId, "exams"); return ok(await adapter.getExams({ session, termCode: query.termCode })); }, { query: termCodeQuery })
        .get("/attendance", async ({ adapter, session }) => { await requireFeature(session.universityId, "attendance"); return ok(await adapter.getAttendance({ session })); })
        .get("/notifications", async ({ adapter, session }) => { await requireFeature(session.universityId, "notifications"); return ok(await adapter.getNotifications({ session })); })
        .get("/news", async ({ adapter, session }) => { await requireFeature(session.universityId, "news"); return ok(await adapter.getNews({ session })); })
        .get("/documents", async ({ adapter, session }) => { await requireFeature(session.universityId, "documents"); return ok(await adapter.getDocuments({ session })); })
        .get("/tuition", async ({ adapter, session }) => { await requireFeature(session.universityId, "tuition"); return ok(await adapter.getTuition({ session })); })
        .get("/training-points", async ({ adapter, session }) => { await requireFeature(session.universityId, "trainingPoints"); return ok(await adapter.getTrainingPoints({ session })); })
        .get("/requests", async ({ adapter, session }) => { await requireFeature(session.universityId, "requests"); return ok(await adapter.getRequests({ session })); })
    )
    .compile();
}
