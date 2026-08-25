import { configureLogger, createVnuRefreshGrant, decryptSession, decryptSessionForVnuLogout, decryptVnuRefreshGrant, encryptSession, encryptVnuRefreshGrant, HyeboardError, VNU_REFRESH_GRANT_MAX_LENGTH, type EncryptedSessionPayload } from "@hyeboard/core";
import { DaotaoClient, listUniversities, parseGradesHtml } from "@hyeboard/university-adapters";
import { StudentHubClient } from "@hyeboard/university-adapters/src/uet/studenthub-client";
import { authResultSchema } from "@hyeboard/schemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const adapterMocks = vi.hoisted(() => ({
  getAdapter: vi.fn(),
  importSession: vi.fn(),
}));

vi.mock("@hyeboard/university-adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hyeboard/university-adapters")>();
  return { ...actual, getAdapter: adapterMocks.getAdapter };
});

import { createApp, createCaptchaRelayToken, requestLogPath, resolveSession, setAppCache, setCaptchaRelayCoordinator, setDistributedAutomationBackend, setFeaturePolicyRuntime, setRateLimitCoordinator, setRuntimeConfig, setVnuImportSingleFlight, setVnuProbeBudgetCoordinator, setVnuRefreshControlCoordinator, type RuntimeConfig } from "./app";
import { LocalCaptchaRelayCoordinator, type CaptchaRelayCoordinator } from "./captcha-relay";
import { FeaturePolicyRuntime, InProcessFeaturePolicyEvents, MemoryFeaturePolicyStore } from "./feature-policy-store";
import { selfHostedRuntimeConfig } from "./start";
import type { VnuProbeBudgetCoordinator } from "./vnu-probe-budget";
import { createVnuCrossDetailMinter } from "./vnu-cross-detail";
import {
  applyAbortRefresh,
  applyActivatePair,
  applyBeginRefresh,
  applyCompleteRefresh,
  applyRevokeExactLinkedPair,
  applyRevokeLinkedPairByAccess,
  applyRevokePrincipalByLinkedGrant,
  checkAccessAuthoritatively,
  DurableObjectVnuRefreshControlCoordinator,
  VNU_MANUAL_ACTIVATION_LIMIT,
  VNU_MANUAL_ACTIVATION_WINDOW_MS,
  VNU_MANUAL_ACTIVATION_WINDOW_SECONDS,
  nextVnuRefreshAlarm,
  parseVnuRefreshControlState,
  type AccessCheckResult,
  type ActivatePairResult,
  type AccessDescriptorRef,
  type BeginRefreshResult,
  type LinkedPair,
  type VnuRefreshControlCoordinator,
  type VnuRefreshControlNamespace,
  type VnuRefreshControlState,
  type VnuRefreshControlStorage,
  type VnuRefreshControlStub,
} from "./vnu-refresh-control";

const SESSION_SECRET = "worker-test-secret-worker-test-secret";
const VNU_AUTH_BODY_MAX_BYTES = VNU_REFRESH_GRANT_MAX_LENGTH
  + new TextEncoder().encode('{"refreshGrant":""}').byteLength
  + 32;
const VNU_STUDENT_CODE = "SYNTHETIC-STUDENT-001";
const SYNTHETIC_VNU_CODE = 99_000_001;
const SYNTHETIC_VNU_STD_ID = 99_000_000_001;
let policyRuntime: FeaturePolicyRuntime;

beforeEach(() => {
  policyRuntime = new FeaturePolicyRuntime(new MemoryFeaturePolicyStore(), new InProcessFeaturePolicyEvents());
  setFeaturePolicyRuntime(policyRuntime);
});

afterEach(async () => {
  setFeaturePolicyRuntime(undefined);
  await policyRuntime.close();
});

const SENTINELS = [
  "PARENT_USERNAME_SENTINEL",
  "PARENT_PASSWORD_SENTINEL",
  "CAPTCHA_ANSWER_SENTINEL",
  "UPSTREAM_CAPTCHA_ID_SENTINEL",
  "CAPTCHA_IMAGE_SENTINEL",
  "ACCOUNT_FIELD_SENTINEL",
  "ACCESS_TOKEN_SENTINEL",
  "RAW_BODY_SENTINEL",
];

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function encryptRawLegacySessionFixture(payload: unknown): Promise<string> {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(SESSION_SECRET));
  const key = await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt"]);
  const iv = new Uint8Array(12).fill(0x62);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(encoder.encode(JSON.stringify(payload))),
  );
  return `${toBase64Url(iv)}.${toBase64Url(new Uint8Array(encrypted))}`;
}

function parentSession(): EncryptedSessionPayload {
  return {
    version: 1,
    universityId: "uet",
    studentCode: "ACCOUNT_FIELD_SENTINEL",
    uetParentCredential: { username: "PARENT_USERNAME_SENTINEL", password: "PARENT_PASSWORD_SENTINEL" },
    studenthub: { kind: "bearer", value: "ACCESS_TOKEN_SENTINEL", expiresAt: "2000-01-01T00:00:00.000Z" },
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

function rawUetSession(): EncryptedSessionPayload {
  return {
    version: 1,
    universityId: "uet",
    studentCode: "SYNTHETIC-UET",
    studenthub: { kind: "bearer", value: "SYNTHETIC_STUDENTHUB_TOKEN", expiresAt: "2099-01-01T00:00:00.000Z" },
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

function mockSession(): EncryptedSessionPayload {
  return { version: 1, universityId: "mock", studentCode: "SYNTHETIC-MOCK", expiresAt: "2099-01-01T00:00:00.000Z" };
}

async function disableCapability(capability: "profile" | "terms" | "courses" | "grades" | "classLookup" | "crossLookup"): Promise<void> {
  await policyRuntime.publish({
    baseRevision: 0,
    policy: { global: { capabilities: { [capability]: { enabled: false } }, limits: {} }, universities: {} },
    reason: `Disable ${capability} for policy enforcement test`,
    actor: { method: "password", subject: "test-admin" },
  });
}

type CoordinatorVnuImportResponse = {
  token: string;
  refreshGrant: string;
  session: {
    universityId: string;
    studentCode?: string;
    expiresAt: string;
    authenticated: true;
  };
};

type AccessOnlyVnuImportResponse = Omit<CoordinatorVnuImportResponse, "refreshGrant">;

type CoordinatorFailureMode = "outage" | "corrupted" | "storage" | "rpc";
type RefreshControlOperation = "begin" | "complete" | "abort" | "revoke-linked" | "revoke-exact";

class TestVnuImportRefreshControl implements VnuRefreshControlCoordinator {
  readonly activations: Array<{ principalKey: string; pair: LinkedPair }> = [];
  readonly checks: Array<{ principalKey: string; pair: AccessDescriptorRef }> = [];
  accessResult?: AccessCheckResult;
  readonly activePairs = new Map<string, LinkedPair>();
  readonly revokedPairs = new Map<string, LinkedPair[]>();
  readonly revocationAttempts: Array<{ principalKey: string; pair: AccessDescriptorRef }> = [];
  readonly beginAttempts: Array<{ principalKey: string; pair: LinkedPair }> = [];
  readonly completionAttempts: Array<{ principalKey: string; old: LinkedPair; next: LinkedPair }> = [];
  readonly abortAttempts: Array<{ principalKey: string; pair: LinkedPair; terminal: boolean }> = [];
  readonly exactRevocationAttempts: Array<{ principalKey: string; pair: LinkedPair }> = [];
  readonly leasedPrincipals = new Set<string>();
  beginResult?: BeginRefreshResult;
  revokeResult?: "revoked" | "mismatch" | "expired";
  failureMode?: CoordinatorFailureMode;
  failureOperation?: RefreshControlOperation;
  mutationCount = 0;
  cleanupWriteCount = 0;
  alarmUpdateCount = 0;
  staleCleanupPending = false;
  readonly activationWindows = new Map<string, { count: number; resetAt: number }>();

  private throwIfUnavailable(operation?: RefreshControlOperation): void {
    if (!this.failureMode || (this.failureOperation && this.failureOperation !== operation)) return;
    throw new Error(`SYNTHETIC_${this.failureMode.toUpperCase()}_SENTINEL`);
  }

  async activatePair(principalKey: string, pair: LinkedPair): Promise<ActivatePairResult> {
    this.throwIfUnavailable();
    const previous = this.activePairs.get(principalKey);
    const storedWindow = this.activationWindows.get(principalKey);
    const window = !storedWindow || Date.now() >= storedWindow.resetAt
      ? { count: 0, resetAt: Date.now() + VNU_MANUAL_ACTIVATION_WINDOW_MS }
      : storedWindow;
    if (previous && JSON.stringify(previous) === JSON.stringify(pair)) return { kind: "activated" };
    if (window.count >= VNU_MANUAL_ACTIVATION_LIMIT) {
      return {
        kind: "rate-limited",
        retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - Date.now()) / 1000)),
        limit: VNU_MANUAL_ACTIVATION_LIMIT,
        windowSeconds: VNU_MANUAL_ACTIVATION_WINDOW_SECONDS,
      };
    }
    if (previous && JSON.stringify(previous) !== JSON.stringify(pair)) {
      this.revokedPairs.set(principalKey, [...(this.revokedPairs.get(principalKey) ?? []), previous]);
    }
    this.activations.push({ principalKey, pair });
    this.activePairs.set(principalKey, pair);
    this.activationWindows.set(principalKey, { ...window, count: window.count + 1 });
    this.mutationCount += 1;
    return { kind: "activated" };
  }

  async checkAccess(principalKey: string, pair: AccessDescriptorRef): Promise<AccessCheckResult> {
    this.throwIfUnavailable();
    this.checks.push({ principalKey, pair });
    if (this.staleCleanupPending) {
      this.staleCleanupPending = false;
      this.cleanupWriteCount += 1;
      this.alarmUpdateCount += 1;
      this.mutationCount += 1;
    }
    if (this.accessResult) return this.accessResult;
    return JSON.stringify(this.activePairs.get(principalKey)) === JSON.stringify(pair) ? { kind: "active" } : { kind: "revoked" };
  }

  async beginRefresh(principalKey: string, pair: LinkedPair): Promise<BeginRefreshResult> {
    this.throwIfUnavailable("begin");
    this.beginAttempts.push({ principalKey, pair });
    if (this.beginResult) return this.beginResult;
    if (JSON.stringify(this.activePairs.get(principalKey)) !== JSON.stringify(pair)) return { kind: "revoked" };
    if (this.leasedPrincipals.has(principalKey)) return { kind: "in-progress", retryAfterSeconds: 120 };
    this.leasedPrincipals.add(principalKey);
    return { kind: "accepted", leaseExpiresAt: Date.now() + 120_000 };
  }
  async completeRefresh(principalKey: string, input: { old: LinkedPair; next: LinkedPair }): Promise<"completed" | "revoked"> {
    this.throwIfUnavailable("complete");
    this.completionAttempts.push({ principalKey, ...input });
    if (JSON.stringify(this.activePairs.get(principalKey)) !== JSON.stringify(input.old)) return "revoked";
    this.leasedPrincipals.delete(principalKey);
    this.activePairs.set(principalKey, input.next);
    this.revokedPairs.set(principalKey, [...(this.revokedPairs.get(principalKey) ?? []), input.old]);
    this.mutationCount += 1;
    return "completed";
  }
  async abortRefresh(principalKey: string, input: { pair: LinkedPair; terminal: boolean }): Promise<void> {
    this.throwIfUnavailable("abort");
    this.abortAttempts.push({ principalKey, ...input });
    this.leasedPrincipals.delete(principalKey);
    if (!input.terminal || JSON.stringify(this.activePairs.get(principalKey)) !== JSON.stringify(input.pair)) return;
    this.activePairs.delete(principalKey);
    this.revokedPairs.set(principalKey, [...(this.revokedPairs.get(principalKey) ?? []), input.pair]);
    this.mutationCount += 1;
  }
  async revokeLinkedPairByAccess(principalKey: string, pair: AccessDescriptorRef): Promise<"revoked" | "mismatch" | "expired"> {
    this.throwIfUnavailable("revoke-linked");
    this.revocationAttempts.push({ principalKey, pair });
    if (this.revokeResult) return this.revokeResult;
    if (pair.accessExpiresAt <= Date.now() && pair.grantExpiresAt <= Date.now()) return "expired";
    const active = this.activePairs.get(principalKey);
    if (JSON.stringify(active) === JSON.stringify(pair)) {
      this.leasedPrincipals.delete(principalKey);
      this.activePairs.delete(principalKey);
      this.revokedPairs.set(principalKey, [...(this.revokedPairs.get(principalKey) ?? []), pair]);
      this.mutationCount += 1;
      return "revoked";
    }
    if ((this.revokedPairs.get(principalKey) ?? []).some((revoked) => JSON.stringify(revoked) === JSON.stringify(pair))) return "revoked";
    return "mismatch";
  }
  async revokePrincipalByLinkedGrant(principalKey: string, pair: LinkedPair): Promise<"revoked" | "mismatch" | "expired"> {
    return this.revokeLinkedPairByAccess(principalKey, pair);
  }
  async revokeExactLinkedPair(principalKey: string, pair: LinkedPair): Promise<"revoked" | "mismatch" | "expired"> {
    this.throwIfUnavailable("revoke-exact");
    this.exactRevocationAttempts.push({ principalKey, pair });
    if (JSON.stringify(this.activePairs.get(principalKey)) !== JSON.stringify(pair)) return "mismatch";
    this.activePairs.delete(principalKey);
    this.revokedPairs.set(principalKey, [...(this.revokedPairs.get(principalKey) ?? []), pair]);
    this.mutationCount += 1;
    return "revoked";
  }
}

class InstrumentedVnuRefreshStorage implements VnuRefreshControlStorage {
  getCount = 0;
  transactionCount = 0;
  putCount = 0;
  deleteCount = 0;
  alarmUpdateCount = 0;
  getFailure?: Error;
  transactionFailure?: Error;

  constructor(public stored: unknown) {}

  resetCounts(): void {
    this.getCount = 0;
    this.transactionCount = 0;
    this.putCount = 0;
    this.deleteCount = 0;
    this.alarmUpdateCount = 0;
  }

  async get(): Promise<unknown> {
    this.getCount += 1;
    if (this.getFailure) throw this.getFailure;
    return this.stored;
  }

  async transaction<T>(body: (
    stored: unknown,
    put: (state: VnuRefreshControlState) => Promise<void>,
    deleteState: () => Promise<void>,
    setAlarm: (at: number | undefined) => Promise<void>,
  ) => Promise<T>): Promise<T> {
    this.transactionCount += 1;
    if (this.transactionFailure) throw this.transactionFailure;
    return body(
      this.stored,
      async (state) => { this.putCount += 1; this.stored = state; },
      async () => { this.deleteCount += 1; this.stored = undefined; },
      async () => { this.alarmUpdateCount += 1; },
    );
  }
}

type ProductionAuthorityHarness = {
  coordinator: DurableObjectVnuRefreshControlCoordinator;
  storage: InstrumentedVnuRefreshStorage;
  objectNames: string[];
  checkInputs: AccessDescriptorRef[];
};

function activeAuthorityState(pair: LinkedPair, staleAccessId?: string): VnuRefreshControlState {
  return {
    active: pair,
    revokedAccess: staleAccessId ? { [staleAccessId]: 1 } : {},
    revokedGrants: {},
    window: { count: 0, resetAt: Date.now() + 60_000 },
  };
}

function emptyAuthorityState(): VnuRefreshControlState {
  return { revokedAccess: {}, revokedGrants: {}, window: { count: 0, resetAt: Date.now() + 60_000 } };
}

function productionAuthorityHarness(stored: unknown, options: { rpcFailure?: Error; expectedPrincipal?: string } = {}): ProductionAuthorityHarness {
  const storage = new InstrumentedVnuRefreshStorage(stored);
  const unrelatedStorage = new InstrumentedVnuRefreshStorage(emptyAuthorityState());
  const objectNames: string[] = [];
  const checkInputs: AccessDescriptorRef[] = [];
  const unsupported = async (): Promise<never> => { throw new Error("not used"); };
  const stubFor = (stubStorage: InstrumentedVnuRefreshStorage): VnuRefreshControlStub => ({
    activatePair: unsupported,
    async checkAccess(access) {
      checkInputs.push(access);
      if (options.rpcFailure) throw options.rpcFailure;
      return checkAccessAuthoritatively(stubStorage, access, Date.now());
    },
    beginRefresh: unsupported,
    completeRefresh: unsupported,
    abortRefresh: unsupported,
    revokeLinkedPairByAccess: unsupported,
    revokePrincipalByLinkedGrant: unsupported,
    revokeExactLinkedPair: unsupported,
  });
  const expectedPrincipal = options.expectedPrincipal ?? "a".repeat(64);
  const namespace: VnuRefreshControlNamespace = {
    getByName(name) { objectNames.push(name); return stubFor(name === expectedPrincipal ? storage : unrelatedStorage); },
  };
  return { coordinator: new DurableObjectVnuRefreshControlCoordinator(namespace), storage, objectNames, checkInputs };
}

function productionRefreshAuthorityHarness(
  stored: VnuRefreshControlState,
  principalKey: string,
  revokeGate: { markEntered: () => void; release: Promise<void> },
  options: { throwAfterComplete?: boolean; completeGate?: { markEntered: () => void; release: Promise<void> } } = {},
) {
  const storage = new InstrumentedVnuRefreshStorage(stored);
  const calls = { begin: 0, complete: 0, abort: 0, revokeLinked: 0 };
  const mutate = async <T>(transition: (state: VnuRefreshControlState | undefined, now: number) => { state: VnuRefreshControlState; result: T; changed: boolean }): Promise<T> => {
    return storage.transaction(async (raw, put, _deleteState, setAlarm) => {
      const output = transition(parseVnuRefreshControlState(raw), Date.now());
      if (output.changed) {
        await put(output.state);
        await setAlarm(nextVnuRefreshAlarm(output.state));
      }
      return output.result;
    });
  };
  const stub: VnuRefreshControlStub = {
    activatePair: (pair) => mutate((state, now) => applyActivatePair(state, pair, now)),
    checkAccess: (pair) => checkAccessAuthoritatively(storage, pair, Date.now()),
    beginRefresh: async (pair) => { calls.begin += 1; return mutate((state, now) => applyBeginRefresh(state, pair, now)); },
    completeRefresh: async (input) => {
      calls.complete += 1;
      options.completeGate?.markEntered();
      await options.completeGate?.release;
      const result = await mutate((state, now) => applyCompleteRefresh(state, input, now));
      if (options.throwAfterComplete) throw new Error("SYNTHETIC_COMPLETION_DELIVERY_LOSS");
      return result;
    },
    abortRefresh: async (input) => { calls.abort += 1; return mutate((state, now) => applyAbortRefresh(state, input, now)); },
    revokeLinkedPairByAccess: async (pair) => {
      calls.revokeLinked += 1;
      revokeGate.markEntered();
      await revokeGate.release;
      return mutate((state, now) => applyRevokeLinkedPairByAccess(state, pair, now));
    },
    revokePrincipalByLinkedGrant: async (pair) => {
      calls.revokeLinked += 1;
      revokeGate.markEntered();
      await revokeGate.release;
      return mutate((state, now) => applyRevokePrincipalByLinkedGrant(state, pair, now));
    },
    revokeExactLinkedPair: (pair) => mutate((state, now) => applyRevokeExactLinkedPair(state, pair, now)),
  };
  const namespace: VnuRefreshControlNamespace = { getByName: (name) => {
    if (name !== principalKey) throw new Error("unexpected principal");
    return stub;
  } };
  return { coordinator: new DurableObjectVnuRefreshControlCoordinator(namespace), storage, calls };
}

class TestCache {
  readonly store = new Map<string, { response: Response; expiresAt: number }>();
  failMatch = false;
  failPut = false;

  constructor(private readonly currentTime: () => number) {}

  async match(request: Request): Promise<Response | undefined> {
    if (this.failMatch) throw new Error("synthetic cache read failure");
    const cached = this.store.get(request.url);
    if (!cached) return undefined;
    if (cached.expiresAt <= this.currentTime()) {
      this.store.delete(request.url);
      return undefined;
    }
    return cached.response.clone();
  }

  async put(request: Request, response: Response): Promise<void> {
    if (this.failPut) throw new Error("synthetic cache write failure");
    const cacheControl = response.headers.get("Cache-Control") ?? "";
    const maxAgeMatch = /max-age=(\d+)/.exec(cacheControl);
    const maxAgeSeconds = maxAgeMatch ? Number(maxAgeMatch[1]) : 0;
    this.store.set(request.url, {
      response: response.clone(),
      expiresAt: this.currentTime() + maxAgeSeconds * 1000,
    });
  }

  rawUrls(): string[] {
    return [...this.store.keys()].filter((key) => key.startsWith("https://hyeboard.internal/cache/vnu/raw/"));
  }

  revocationUrls(): string[] {
    return [...this.store.keys()].filter((key) => key.includes("/cache/revoked-token/"));
  }

  importUrl(): string {
    const url = [...this.store.keys()].find((key) => key.includes("/cache/vnu/import/"));
    if (!url) throw new Error("VNU import cache entry was not written");
    return url;
  }

  importUrls(): string[] {
    return [...this.store.keys()].filter((key) => key.includes("/cache/vnu/import/"));
  }

  async importEntry(): Promise<{
    seed: string;
    session: CoordinatorVnuImportResponse["session"];
  }> {
    return await this.store.get(this.importUrl())!.response.clone().json() as {
      seed: string;
      session: CoordinatorVnuImportResponse["session"];
    };
  }

  setImportEntry(value: unknown): void {
    this.store.set(this.importUrl(), {
      response: new Response(JSON.stringify(value), {
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" },
      }),
      expiresAt: this.currentTime() + 3_600_000,
    });
  }

  setOnlyRawEntry(value: unknown): void {
    const rawUrls = this.rawUrls();
    if (rawUrls.length !== 1) throw new Error(`Expected one VNU raw cache entry, found ${rawUrls.length}`);
    this.store.set(rawUrls[0], {
      response: new Response(JSON.stringify(value), {
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
      }),
      expiresAt: this.currentTime() + 300_000,
    });
  }
}

function vnuSession(expiresAt = "2099-01-01T00:00:00.000Z"): EncryptedSessionPayload {
  return {
    version: 1,
    universityId: "vnu",
    vnu: { kind: "cookie", value: "SYNTHETIC_VNU_COOKIE", expiresAt },
    expiresAt,
  };
}

function normalizedVnuSession(expiresAt = "2099-01-01T00:00:00.000Z"): EncryptedSessionPayload {
  return { ...vnuSession(expiresAt), studentCode: VNU_STUDENT_CODE };
}

function importedVnu(session = vnuSession()) {
  return {
    universityId: session.universityId,
    studentCode: VNU_STUDENT_CODE,
    expiresAt: session.expiresAt,
    session,
  };
}

function vnuProfileHtml(studentCode = VNU_STUDENT_CODE): string {
  return studentCode ? `<input name="StdCode" value="${studentCode}">` : "<html><body>Synthetic profile without identity</body></html>";
}

const XHTML_VNU_NOTIFICATION_EXPIRY_HTML = `
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>Thông báo</title></head>
  <body>
    <p><br>Bạn chưa đăng nhập hoặc phiên làm việc của bạn đã hết<br><br>Xin vui lòng bấm <a href="http://daotao.vnu.edu.vn/dkmh/login.asp">vào đây</a> để đăng nhập lại<br></p>
  </body>
</html>
`;

class TestVnuProbeBudget implements VnuProbeBudgetCoordinator {
  readonly identities: string[] = [];
  readonly amounts: number[] = [];
  readonly consumedAmounts: number[] = [];
  readonly reservedAmounts: number[] = [];
  readonly counts = new Map<string, number>();
  readonly activeLeases = new Map<string, { sessionIdentity: string; expiresAt: number }>();
  readonly releasedLeases: string[] = [];
  readonly crossDetailPermits = new Map<string, import("./vnu-probe-budget").VnuCrossDetailPermitRecord>();
  readonly consumedCrossDetailPermits = new Set<string>();
  readonly releasedCrossDetailLeases: string[] = [];
  private readonly pendingAcquires: Array<{
    sessionIdentity: string;
    resolve: (permit: { leaseId: string; expiresAt: number }) => void;
    reject: (reason: unknown) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];
  private nextLeaseNumber = 0;
  peakActiveLeases = 0;
  permitCap: number;
  onPermitQueued?: () => void;
  limit = Number.POSITIVE_INFINITY;
  unavailable = false;

  constructor(permitCap = 6) {
    this.permitCap = permitCap;
  }

  async acquireBrc1Permit(sessionIdentity: string, signal?: AbortSignal): Promise<{ leaseId: string; expiresAt: number }> {
    if (this.unavailable) throw new Error("synthetic budget outage");
    if (signal?.aborted) throw signal.reason ?? new DOMException("This operation was aborted", "AbortError");
    if (this.hasPermitCapacity(sessionIdentity)) return this.grantPermit(sessionIdentity);

    return new Promise((resolve, reject) => {
      const pending: (typeof this.pendingAcquires)[number] = { sessionIdentity, resolve, reject, signal };
      const onAbort = (): void => {
        const index = this.pendingAcquires.indexOf(pending);
        if (index >= 0) this.pendingAcquires.splice(index, 1);
        reject(signal!.reason ?? new DOMException("This operation was aborted", "AbortError"));
      };
      pending.onAbort = onAbort;
      this.pendingAcquires.push(pending);
      this.onPermitQueued?.();
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async releaseBrc1Permit(sessionIdentity: string, leaseId: string): Promise<void> {
    const lease = this.activeLeases.get(leaseId);
    if (!lease || lease.sessionIdentity !== sessionIdentity) return;
    this.activeLeases.delete(leaseId);
    this.releasedLeases.push(leaseId);
    this.drainSession(sessionIdentity);
  }

  async issueCrossDetailPermits(_sessionIdentity: string, permits: import("./vnu-probe-budget").VnuCrossDetailIssuedPermit[]): Promise<void> {
    for (const permit of permits) this.crossDetailPermits.set(permit.permitHash, permit.record);
  }

  async consumeCrossDetailPermit(_sessionIdentity: string, input: import("./vnu-probe-budget").VnuCrossDetailConsumeInput): Promise<{ leaseId: string; expiresAt: number; envelope: string }> {
    const record = this.crossDetailPermits.get(input.permitHash);
    const matches = record !== undefined
      && !this.consumedCrossDetailPermits.has(input.permitHash)
      && record.expiresAt > Date.now()
      && record.nonce === input.nonce
      && record.requesterHmac === input.requesterHmac
      && record.targetHmac === input.targetHmac
      && record.revisionHmac === input.revisionHmac
      && record.rowHmac === input.rowHmac
      && record.policyVersion === input.policyVersion;
    if (!matches) throw new HyeboardError("VNU_CROSS_DETAIL_PERMIT_INVALID", "The cross-detail permit is invalid or expired.", 403);
    this.consumedCrossDetailPermits.add(input.permitHash);
    return { leaseId: (this.consumedCrossDetailPermits.size).toString(16).padStart(32, "0"), expiresAt: Date.now() + 60_000, envelope: record.envelope };
  }

  async releaseCrossDetailLease(_sessionIdentity: string, leaseId: string): Promise<void> {
    this.releasedCrossDetailLeases.push(leaseId);
  }

  get activeLeaseCount(): number {
    return this.activeLeases.size;
  }

  get pendingPermitCount(): number {
    return this.pendingAcquires.length;
  }

  get count(): number {
    return [...this.counts.values()].reduce((total, count) => total + count, 0);
  }

  async consume(sessionIdentity: string, amount = 1): Promise<void> {
    this.consumedAmounts.push(amount);
    await this.record(sessionIdentity, amount);
  }

  async reserve(sessionIdentity: string, amount: number): Promise<void> {
    this.reservedAmounts.push(amount);
    await this.record(sessionIdentity, amount);
  }

  private async record(sessionIdentity: string, amount: number): Promise<void> {
    this.identities.push(sessionIdentity);
    this.amounts.push(amount);
    if (this.unavailable) throw new Error("synthetic budget outage");
    const count = this.counts.get(sessionIdentity) ?? 0;
    if (count + amount > this.limit) {
      throw new HyeboardError("VNU_RATE_LIMITED", "Synthetic budget exhausted", 429, {
        retryAfterSeconds: 600,
        limit: 300,
        windowSeconds: 600,
      });
    }
    this.counts.set(sessionIdentity, count + amount);
  }

  private hasPermitCapacity(sessionIdentity: string): boolean {
    return [...this.activeLeases.values()].filter((lease) => lease.sessionIdentity === sessionIdentity).length < this.permitCap;
  }

  private grantPermit(sessionIdentity: string): { leaseId: string; expiresAt: number } {
    const leaseId = (++this.nextLeaseNumber).toString(16).padStart(32, "0");
    const expiresAt = Date.now() + 65_000;
    this.activeLeases.set(leaseId, { sessionIdentity, expiresAt });
    this.peakActiveLeases = Math.max(this.peakActiveLeases, this.activeLeases.size);
    return { leaseId, expiresAt };
  }

  private drainSession(sessionIdentity: string): void {
    while (this.hasPermitCapacity(sessionIdentity)) {
      const index = this.pendingAcquires.findIndex((pending) => pending.sessionIdentity === sessionIdentity);
      if (index < 0) return;
      const pending = this.pendingAcquires.splice(index, 1)[0];
      pending.signal?.removeEventListener("abort", pending.onAbort!);
      if (pending.signal?.aborted) {
        pending.reject(pending.signal.reason ?? new DOMException("This operation was aborted", "AbortError"));
        continue;
      }
      pending.resolve(this.grantPermit(sessionIdentity));
    }
  }

}

async function requestVnuImport(app: ReturnType<typeof createApp>): Promise<Response> {
  return app.handle(new Request("http://localhost/api/vnu/auth/import-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vnuUsername: "SYNTHETIC_VNU_USER", vnuPassword: "SYNTHETIC_VNU_PASSWORD" }),
  }));
}

async function requestVnuRefresh(app: ReturnType<typeof createApp>, token: string, refreshGrant: string): Promise<Response> {
  return app.handle(new Request("http://localhost/api/vnu/auth/refresh", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ refreshGrant }),
  }));
}

async function requestVnuLogout(app: ReturnType<typeof createApp>, token: string, refreshGrant?: string): Promise<Response> {
  return app.handle(new Request("http://localhost/api/vnu/auth/logout", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(refreshGrant === undefined ? {} : { refreshGrant }),
  }));
}

async function requestVnuLogoutWithoutBody(app: ReturnType<typeof createApp>, token: string): Promise<Response> {
  return app.handle(new Request("http://localhost/api/vnu/auth/logout", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  }));
}

function enteredOperation<T>() {
  let markEntered!: () => void;
  let release!: (value: T) => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const result = new Promise<T>((resolve) => { release = resolve; });
  return { entered, markEntered, result, release };
}

function largestAcceptedWorkerPasswordLength(now: number): number {
  let low = 1;
  let high = VNU_REFRESH_GRANT_MAX_LENGTH;
  while (low < high) {
    const candidate = Math.ceil((low + high) / 2);
    try {
      createVnuRefreshGrant({
        username: "synthetic_vnu_user",
        password: "P".repeat(candidate),
        expectedStudentCode: VNU_STUDENT_CODE,
        now,
      });
      low = candidate;
    } catch {
      high = candidate - 1;
    }
  }
  return low;
}

function chunkedJsonRequest(path: string, token: string, chunks: string[], onPull: () => void = () => undefined): Request {
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      onPull();
      if (index >= chunks.length) return controller.close();
      controller.enqueue(encoder.encode(chunks[index++]));
    },
  }, { highWaterMark: 0 });
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("feature policy enforcement", () => {
  it("keeps session status usable while profile is disabled and omits the student identifier", async () => {
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET });
    await disableCapability("profile");
    adapterMocks.getAdapter.mockReturnValue({});
    const session = mockSession();
    const token = await encryptSession(session, SESSION_SECRET);

    const response = await createApp(undefined).handle(new Request("http://localhost/api/mock/auth/session", {
      headers: { Authorization: `Bearer ${token}` },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: {
        universityId: session.universityId,
        expiresAt: session.expiresAt,
        authenticated: true,
      },
      error: null,
    });
  });

  it("omits the student identifier when profile capability evidence is missing", async () => {
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET });
    adapterMocks.getAdapter.mockReturnValue({});
    const session = mockSession();
    const token = await encryptSession(session, SESSION_SECRET);
    const university = listUniversities().find(({ id }) => id === session.universityId)!;
    const profile = university.capabilities.profile;
    delete (university.capabilities as Partial<typeof university.capabilities>).profile;

    try {
      const response = await createApp(undefined).handle(new Request("http://localhost/api/mock/auth/session", {
        headers: { Authorization: `Bearer ${token}` },
      }));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        data: {
          universityId: session.universityId,
          expiresAt: session.expiresAt,
          authenticated: true,
        },
        error: null,
      });
    } finally {
      university.capabilities.profile = profile;
    }
  });

  it("preserves the student identifier when effective profile capability is enabled", async () => {
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET });
    adapterMocks.getAdapter.mockReturnValue({});
    const session = mockSession();
    const token = await encryptSession(session, SESSION_SECRET);

    const response = await createApp(undefined).handle(new Request("http://localhost/api/mock/auth/session", {
      headers: { Authorization: `Bearer ${token}` },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        universityId: session.universityId,
        studentCode: session.studentCode,
        expiresAt: session.expiresAt,
        authenticated: true,
      },
      error: null,
    });
  });

  it("keeps successful auth issuance identity metadata when profile is disabled", async () => {
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET });
    await disableCapability("profile");
    const session = mockSession();
    adapterMocks.getAdapter.mockReturnValue({ importSession: vi.fn().mockResolvedValue({
      universityId: session.universityId,
      studentCode: session.studentCode,
      expiresAt: session.expiresAt,
      session,
    }) });

    const response = await createApp(undefined).handle(new Request("http://localhost/api/mock/auth/import-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { session: { studentCode: session.studentCode } } });
  });

  it("keeps expired-session rejection unchanged when profile is disabled", async () => {
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET });
    await disableCapability("profile");
    adapterMocks.getAdapter.mockReturnValue({});
    const token = await encryptSession({ ...mockSession(), expiresAt: "2000-01-01T00:00:00.000Z" }, SESSION_SECRET);

    const response = await createApp(undefined).handle(new Request("http://localhost/api/mock/auth/session", {
      headers: { Authorization: `Bearer ${token}` },
    }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "SESSION_EXPIRED" } });
  });

  it.each([
    ["courses", "/api/mock/courses", "getCourses"],
    ["grades", "/api/mock/grades", "getGrades"],
  ] as const)("rejects disabled %s before adapter work", async (capability, path, method) => {
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET });
    await disableCapability(capability);
    const upstream = vi.fn();
    adapterMocks.getAdapter.mockReturnValue({ [method]: upstream });
    const token = await encryptSession(mockSession(), SESSION_SECRET);

    const response = await createApp(undefined).handle(new Request(`http://localhost${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "FEATURE_DISABLED", details: { capability } } });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("blocks lookup-only routes while keeping exams raw access independent", async () => {
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET });
    await disableCapability("classLookup");
    const token = await encryptSession(vnuSession(), SESSION_SECRET);
    const profileSpy = vi.spyOn(DaotaoClient.prototype, "getProfileHtml").mockResolvedValue(`<input name="hidStdID" value="${SYNTHETIC_VNU_STD_ID}"><input name="StdCode" value="${SYNTHETIC_VNU_CODE}"><select name="UnivID"><option value="1" selected>VNU</option></select>`);
    const examsSpy = vi.spyOn(DaotaoClient.prototype, "getExamsHtml").mockResolvedValue("<html>SYNTHETIC_EXAMS</html>");
    try {
      const lookup = await createApp(undefined).handle(new Request("http://localhost/api/vnu/class-lookup/catalog?vTermID=1", { headers: { Authorization: `Bearer ${token}` } }));
      expect(lookup.status).toBe(503);
      await expect(lookup.json()).resolves.toMatchObject({ error: { code: "FEATURE_DISABLED", details: { capability: "classLookup" } } });
      expect(profileSpy).not.toHaveBeenCalled();
      expect(examsSpy).not.toHaveBeenCalled();

      const exams = await createApp(undefined).handle(new Request("http://localhost/api/vnu/raw/exams?vTermID=1", { headers: { Authorization: `Bearer ${token}` } }));
      expect(exams.status).toBe(200);
      expect(examsSpy).toHaveBeenCalledTimes(1);
    } finally {
      profileSpy.mockRestore();
      examsSpy.mockRestore();
    }
  });

  it("blocks lookup-only point detail while grades raw and point detail remain grades-gated", async () => {
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET });
    await disableCapability("classLookup");
    const token = await encryptSession(vnuSession(), SESSION_SECRET);
    const selector = "00000000001";
    const gradesSpy = vi.spyOn(DaotaoClient.prototype, "getGradesHtml").mockResolvedValue(`<table>
      <tr><td>HỌC KỲ 1. MÃ HỌC KỲ 251</td></tr>
      <tr><td>1</td><td>INT1001</td><td>Synthetic Course</td><td>3</td><td>8</td><td>B</td><td>3</td><td><img onclick="detailPoint('123456','8','${selector}','42')"></td></tr>
    </table>`);
    const pointSpy = vi.spyOn(DaotaoClient.prototype, "getPointDetailHtml").mockResolvedValue("<table>SYNTHETIC_POINT_DETAIL</table>");
    try {
      const lookup = await createApp(undefined).handle(new Request("http://localhost/api/vnu/class-lookup/point-detail?id=123456&Term=42", { headers: { Authorization: `Bearer ${token}` } }));
      expect(lookup.status).toBe(503);
      expect(lookup.headers.get("Cache-Control")).toBe("no-store, private");
      await expect(lookup.json()).resolves.toMatchObject({ error: { code: "FEATURE_DISABLED", details: { capability: "classLookup" } } });
      expect(gradesSpy).not.toHaveBeenCalled();
      expect(pointSpy).not.toHaveBeenCalled();

      const grades = await createApp(undefined).handle(new Request("http://localhost/api/vnu/raw/grades", { headers: { Authorization: `Bearer ${token}` } }));
      expect(grades.status).toBe(200);

      const detail = await createApp(undefined).handle(new Request("http://localhost/api/vnu/raw/point-detail?id=123456&Term=42", { headers: { Authorization: `Bearer ${token}` } }));
      expect(detail.status).toBe(200);
      expect(gradesSpy).toHaveBeenCalledTimes(1);
      expect(pointSpy).toHaveBeenCalledWith({ id: "123456", stdId: selector, term: "42" }, expect.any(AbortSignal));
    } finally {
      gradesSpy.mockRestore();
      pointSpy.mockRestore();
    }
  });

  it("keeps raw grades and point detail unavailable when grades are disabled", async () => {
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET });
    await disableCapability("grades");
    const token = await encryptSession(vnuSession(), SESSION_SECRET);
    const gradesSpy = vi.spyOn(DaotaoClient.prototype, "getGradesHtml");
    const pointSpy = vi.spyOn(DaotaoClient.prototype, "getPointDetailHtml");
    try {
      for (const path of ["/api/vnu/raw/grades", "/api/vnu/raw/point-detail?id=123456&Term=42"]) {
        const response = await createApp(undefined).handle(new Request(`http://localhost${path}`, { headers: { Authorization: `Bearer ${token}` } }));
        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "FEATURE_DISABLED", details: { capability: "grades" } } });
      }
      expect(gradesSpy).not.toHaveBeenCalled();
      expect(pointSpy).not.toHaveBeenCalled();
    } finally {
      gradesSpy.mockRestore();
      pointSpy.mockRestore();
    }
  });

  it("rejects disabled crossLookup before specialized VNU upstream work", async () => {
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET });
    await disableCapability("crossLookup");
    const token = await encryptSession(vnuSession(), SESSION_SECRET);
    const profileSpy = vi.spyOn(DaotaoClient.prototype, "getProfileHtml");
    const transcriptSpy = vi.spyOn(DaotaoClient.prototype, "getTranscriptByStdIdHtml");
    try {
      const response = await createApp(undefined).handle(new Request("http://localhost/api/vnu/cross-lookup/student-code?stdId=1002&allowCrossLookup=true", { headers: { Authorization: `Bearer ${token}` } }));
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "FEATURE_DISABLED", details: { capability: "crossLookup" } } });
      expect(profileSpy).not.toHaveBeenCalled();
      expect(transcriptSpy).not.toHaveBeenCalled();
    } finally {
      profileSpy.mockRestore();
      transcriptSpy.mockRestore();
    }
  });

  it("removes dashboard profile at the API while preserving enabled current term independently", async () => {
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET });
    await disableCapability("profile");
    const getDashboard = vi.fn(async () => ({
      student: { id: "student-pii", fullName: "Student PII", universityId: "mock", studentCode: "STUDENT-PII" },
      currentTerm: { id: "term", code: "term", name: "Term" },
      todaySchedule: [],
      courses: [],
      assignments: [],
      grades: [],
      exams: [],
      notifications: [],
    }));
    adapterMocks.getAdapter.mockReturnValue({ getDashboard });
    const token = await encryptSession(mockSession(), SESSION_SECRET);

    const response = await createApp(undefined).handle(new Request("http://localhost/api/mock/dashboard", { headers: { Authorization: `Bearer ${token}` } }));
    const body = await response.json() as { data: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(body.data).not.toHaveProperty("student");
    expect(JSON.stringify(body.data)).not.toContain("Student PII");
    expect(JSON.stringify(body.data)).not.toContain("STUDENT-PII");
    expect(body.data.currentTerm).toEqual({ id: "term", code: "term", name: "Term" });
    expect(getDashboard).toHaveBeenCalledWith(expect.objectContaining({ capabilities: expect.objectContaining({ profile: false, terms: true }) }));
  });

  it("projects disabled dashboard capabilities before adapter work", async () => {
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET });
    await disableCapability("grades");
    const getDashboard = vi.fn(async ({ capabilities }: { capabilities: Record<string, boolean> }) => {
      expect(capabilities.grades).toBe(false);
      return { todaySchedule: [], courses: [], assignments: [], grades: [{ id: "leak", courseCode: "X", courseName: "Leak" }], exams: [], notifications: [] };
    });
    adapterMocks.getAdapter.mockReturnValue({ getDashboard });
    const token = await encryptSession(mockSession(), SESSION_SECRET);

    const response = await createApp(undefined).handle(new Request("http://localhost/api/mock/dashboard", { headers: { Authorization: `Bearer ${token}` } }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { grades: [] } });
    expect(getDashboard).toHaveBeenCalledTimes(1);
  });
});

describe("request-log privacy", () => {
  it("requestLogPath strips query identifiers and opt-in values", () => {
    expect(requestLogPath("https://hyeboard.test/api/vnu/cross-lookup/student-id?stdCode=99000002&allowCrossLookup=true"))
      .toBe("/api/vnu/cross-lookup/student-id");
  });
});

async function importVnu(app: ReturnType<typeof createApp>): Promise<CoordinatorVnuImportResponse> {
  const response = await requestVnuImport(app);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const body = await response.json() as { data: CoordinatorVnuImportResponse; error: null };
  expect(body.error).toBeNull();
  expect(Object.keys(body.data).sort()).toEqual(["refreshGrant", "session", "token"]);
  expect(Object.keys(body.data.session).sort()).toEqual(["authenticated", "expiresAt", "studentCode", "universityId"]);
  return body.data;
}

async function expectIssuedVnuAccess(token: string, expected: EncryptedSessionPayload): Promise<EncryptedSessionPayload> {
  const payload = await decryptSession(token, SESSION_SECRET);
  const { vnuRefresh, ...ordinary } = payload;
  expect(ordinary).toEqual(expected);
  expect(vnuRefresh).toMatchObject({
    version: 1,
    purpose: "vnu-refresh-access",
    accessExpiresAt: expected.expiresAt,
  });
  return payload;
}

async function getVnuSession(app: ReturnType<typeof createApp>, token: string): Promise<Response> {
  return app.handle(new Request("http://localhost/api/vnu/auth/session", {
    headers: { Authorization: `Bearer ${token}` },
  }));
}

async function getVnuRawPage(app: ReturnType<typeof createApp>, token: string, page = "grades"): Promise<Response> {
  return app.handle(new Request(`http://localhost/api/vnu/raw/${page}`, {
    headers: { Authorization: `Bearer ${token}` },
  }));
}

function descriptorVnuSession(overrides: Partial<NonNullable<EncryptedSessionPayload["vnuRefresh"]>> = {}): EncryptedSessionPayload {
  const expiresAt = "2099-01-01T00:00:00.000Z";
  return {
    ...normalizedVnuSession(expiresAt),
    vnuRefresh: {
      version: 1,
      purpose: "vnu-refresh-access",
      principalKey: "a".repeat(64),
      accessTokenId: "A".repeat(22),
      grantId: `${"B".repeat(21)}A`,
      accessExpiresAt: expiresAt,
      grantExpiresAt: "2099-01-01T08:00:00.000Z",
      ...overrides,
    },
  };
}

function descriptorPairFixture(session: EncryptedSessionPayload): LinkedPair {
  const descriptor = session.vnuRefresh!;
  return {
    accessTokenId: descriptor.accessTokenId,
    accessExpiresAt: Date.parse(descriptor.accessExpiresAt),
    grantId: descriptor.grantId,
    grantExpiresAt: Date.parse(descriptor.grantExpiresAt),
  };
}

describe("VNU access authority", () => {
  let authoritySession: EncryptedSessionPayload;
  let authority: ProductionAuthorityHarness;

  beforeEach(() => {
    vi.clearAllMocks();
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET });
    authoritySession = descriptorVnuSession();
    authority = productionAuthorityHarness(activeAuthorityState(descriptorPairFixture(authoritySession)));
    setVnuRefreshControlCoordinator(authority.coordinator);
  });

  afterEach(() => setVnuRefreshControlCoordinator(undefined));

  it("checks the exact descriptor authority before accepting an ordinary session", async () => {
    const session = descriptorVnuSession();
    const token = await encryptSession(session, SESSION_SECRET);

    await expect(resolveSession({ Authorization: `Bearer ${token}` })).resolves.toEqual({ session });
    expect(authority.objectNames).toEqual([session.vnuRefresh!.principalKey]);
    expect(authority.checkInputs).toEqual([descriptorPairFixture(session)]);
    expect(authority.storage.getCount).toBe(1);
  });

  it("performs exact read-only authority checks on three repeated active requests before upstream", async () => {
    const session = descriptorVnuSession();
    const pair = descriptorPairFixture(session);
    const getStudentProfile = vi.fn(async () => ({ id: "SYNTHETIC_PROFILE", fullName: "SYNTHETIC PROFILE", universityId: "vnu" }));
    adapterMocks.getAdapter.mockReturnValue({ getStudentProfile });
    const app = createApp(undefined);
    const token = await encryptSession(session, SESSION_SECRET);

    const responses = await Promise.all(Array.from({ length: 3 }, () => app.handle(new Request("http://localhost/api/vnu/me", {
      headers: { Authorization: `Bearer ${token}` },
    }))));

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(authority.objectNames).toEqual(Array.from({ length: 3 }, () => session.vnuRefresh!.principalKey));
    expect(authority.checkInputs).toEqual(Array.from({ length: 3 }, () => pair));
    expect(getStudentProfile).toHaveBeenCalledTimes(3);
    expect(authority.storage.getCount).toBe(3);
    expect(authority.storage.transactionCount).toBe(0);
    expect(authority.storage.putCount).toBe(0);
    expect(authority.storage.deleteCount).toBe(0);
    expect(authority.storage.alarmUpdateCount).toBe(0);
  });

  it("applies stale authority cleanup once and keeps later checks read-only", async () => {
    const session = descriptorVnuSession();
    const pair = descriptorPairFixture(session);
    authority = productionAuthorityHarness(activeAuthorityState(pair, `${"Z".repeat(21)}A`));
    setVnuRefreshControlCoordinator(authority.coordinator);
    const getStudentProfile = vi.fn(async () => ({ id: "SYNTHETIC_PROFILE", fullName: "SYNTHETIC PROFILE", universityId: "vnu" }));
    adapterMocks.getAdapter.mockReturnValue({ getStudentProfile });
    const app = createApp(undefined);
    const token = await encryptSession(session, SESSION_SECRET);

    const first = await app.handle(new Request("http://localhost/api/vnu/me", { headers: { Authorization: `Bearer ${token}` } }));
    expect(first.status).toBe(200);
    expect(authority.storage.getCount).toBe(1);
    expect(authority.storage.transactionCount).toBe(1);
    expect(authority.storage.putCount).toBe(1);
    expect(authority.storage.alarmUpdateCount).toBe(1);
    const second = await app.handle(new Request("http://localhost/api/vnu/me", { headers: { Authorization: `Bearer ${token}` } }));
    expect(second.status).toBe(200);
    expect(authority.storage.getCount).toBe(2);
    expect(authority.storage.transactionCount).toBe(1);
    expect(authority.storage.putCount).toBe(1);
    expect(authority.storage.alarmUpdateCount).toBe(1);
    expect(getStudentProfile).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["wrong namespace", { purpose: "other-purpose" }],
    ["malformed identifier", { accessTokenId: "NOT_CANONICAL" }],
    ["broken access-expiry link", { accessExpiresAt: "2099-01-01T00:00:01.000Z" }],
  ])("rejects a %s descriptor before coordinator access", async (_label, descriptorPatch) => {
    const malformed = descriptorVnuSession(descriptorPatch as never);
    const token = await encryptRawLegacySessionFixture(malformed);

    await expect(resolveSession({ Authorization: `Bearer ${token}` })).rejects.toMatchObject({ code: "INVALID_SESSION", status: 401 });
    expect(authority.checkInputs).toEqual([]);
  });

  it("rejects revoked descriptor authority without upstream access", async () => {
    authority = productionAuthorityHarness(emptyAuthorityState());
    setVnuRefreshControlCoordinator(authority.coordinator);
    const profileSpy = vi.spyOn(DaotaoClient.prototype, "getProfileHtml");
    const token = await encryptSession(descriptorVnuSession(), SESSION_SECRET);

    await expect(resolveSession({ Authorization: `Bearer ${token}` })).rejects.toMatchObject({ code: "SESSION_EXPIRED", status: 401 });
    expect(profileSpy).not.toHaveBeenCalled();
    profileSpy.mockRestore();
  });

  it.each([
    ["principal namespace", (_session: EncryptedSessionPayload) => descriptorVnuSession({ principalKey: "b".repeat(64) })],
    ["access ID", (_session: EncryptedSessionPayload) => descriptorVnuSession({ accessTokenId: `${"C".repeat(21)}A` })],
    ["grant ID/link", (_session: EncryptedSessionPayload) => descriptorVnuSession({ grantId: `${"D".repeat(21)}A` })],
    ["access expiry", (_session: EncryptedSessionPayload) => {
      const expiresAt = "2099-01-01T00:00:01.000Z";
      return { ...descriptorVnuSession({ accessExpiresAt: expiresAt }), expiresAt };
    }],
    ["grant expiry", (_session: EncryptedSessionPayload) => descriptorVnuSession({ grantExpiresAt: "2099-01-01T08:00:01.000Z" })],
  ])("rejects wrong %s authority without upstream or mutation", async (_label, alterSession) => {
    const activeSession = descriptorVnuSession();
    const getStudentProfile = vi.fn();
    adapterMocks.getAdapter.mockReturnValue({ getStudentProfile });
    const app = createApp(undefined);
    const token = await encryptSession(alterSession(activeSession), SESSION_SECRET);

    const response = await app.handle(new Request("http://localhost/api/vnu/me", {
      headers: { Authorization: `Bearer ${token}` },
    }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ data: null, error: { code: "SESSION_EXPIRED", message: "Session expired" } });
    expect(getStudentProfile).not.toHaveBeenCalled();
    expect(authority.storage.transactionCount).toBe(0);
    expect(authority.storage.putCount).toBe(0);
  });

  it.each(["corrupted", "get", "transaction", "rpc"] as const)("sanitizes production %s authority failure without upstream", async (failureMode) => {
    const sentinels = [
      `SYNTHETIC_${failureMode.toUpperCase()}_SENTINEL`,
      "UPSTREAM_PROSE_SENTINEL",
      "TOKEN_SENTINEL",
      "GRANT_SENTINEL",
      "PRINCIPAL_SENTINEL",
      "USERNAME_SENTINEL",
      "STUDENT_CODE_SENTINEL",
      "PROFILE_SENTINEL",
      "COOKIE_SENTINEL",
    ];
    const lines: string[] = [];
    configureLogger({ level: "error", mode: "node", destination: { write: (line) => lines.push(line) } });
    const pair = descriptorPairFixture(authoritySession);
    if (failureMode === "corrupted") authority = productionAuthorityHarness({ privateState: "SYNTHETIC_CORRUPTED_SENTINEL" });
    if (failureMode === "get") {
      authority = productionAuthorityHarness(activeAuthorityState(pair));
      authority.storage.getFailure = new Error("SYNTHETIC_GET_SENTINEL");
    }
    if (failureMode === "transaction") {
      authority = productionAuthorityHarness(activeAuthorityState(pair, `${"Z".repeat(21)}A`));
      authority.storage.transactionFailure = new Error("SYNTHETIC_TRANSACTION_SENTINEL");
    }
    if (failureMode === "rpc") {
      authority = productionAuthorityHarness(activeAuthorityState(pair), { rpcFailure: new Error("SYNTHETIC_RPC_SENTINEL") });
    }
    setVnuRefreshControlCoordinator(authority.coordinator);
    const getStudentProfile = vi.fn();
    adapterMocks.getAdapter.mockReturnValue({ getStudentProfile });
    const app = createApp(undefined);
    const token = await encryptSession(descriptorVnuSession(), SESSION_SECRET);

    const response = await app.handle(new Request("http://localhost/api/vnu/me", {
      headers: { Authorization: `Bearer ${token}` },
    }));
    const payloadText = await response.text();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const logText = lines.join("\n");

    expect(response.status).toBe(503);
    expect(JSON.parse(payloadText)).toEqual({
      data: null,
      error: {
        code: "VNU_REFRESH_UNAVAILABLE",
        message: "VNU reconnect is temporarily unavailable. Try again.",
        details: { retryAfterSeconds: 5 },
      },
    });
    expect(getStudentProfile).not.toHaveBeenCalled();
    expect(authority.storage.putCount).toBe(0);
    expect(authority.storage.deleteCount).toBe(0);
    expect(authority.storage.alarmUpdateCount).toBe(0);
    for (const sentinel of sentinels) {
      expect(payloadText).not.toContain(sentinel);
      expect(logText).not.toContain(sentinel);
    }
    expect(logText).not.toContain('"stack"');
    expect(logText).not.toContain('"reqId"');
    configureLogger({ level: "silent", mode: "node" });
  });

  it("never calls descriptor authority for a legacy VNU token", async () => {
    const session = normalizedVnuSession();
    const token = await encryptSession(session, SESSION_SECRET);

    await expect(resolveSession({ Authorization: `Bearer ${token}` })).resolves.toEqual({ session });
    expect(authority.checkInputs).toEqual([]);
  });

  it("keeps descriptorless VNU tokens on the existing raw cache path without refresh eligibility", async () => {
    const cache = new TestCache(() => Date.now());
    vi.stubGlobal("caches", { default: cache });
    const gradesSpy = vi.spyOn(DaotaoClient.prototype, "getGradesHtml").mockResolvedValue("<html>SYNTHETIC_LEGACY_GRADES</html>");
    const session = normalizedVnuSession();
    const token = await encryptSession(session, SESSION_SECRET);
    const app = createApp(undefined);

    const first = await getVnuRawPage(app, token);
    const second = await getVnuRawPage(app, token);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual({ data: { html: "<html>SYNTHETIC_LEGACY_GRADES</html>" }, error: null });
    expect(gradesSpy).toHaveBeenCalledTimes(1);
    expect(authority.checkInputs).toEqual([]);
    expect(authority.storage.getCount).toBe(0);
    expect(session.vnuRefresh).toBeUndefined();
    gradesSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("does not cache VNU raw HTML resolved after request cancellation", async () => {
    const cache = new TestCache(() => Date.now());
    const putSpy = vi.spyOn(cache, "put");
    vi.stubGlobal("caches", { default: cache });
    const firstFetch = enteredOperation<string>();
    const gradesSpy = vi.spyOn(DaotaoClient.prototype, "getGradesHtml")
      .mockImplementationOnce(async (signal?: AbortSignal) => {
        expect(signal).toBe(firstRequest.signal);
        firstFetch.markEntered();
        return firstFetch.result;
      })
      .mockResolvedValueOnce("<html>SYNTHETIC_RETRY_GRADES</html>");
    const token = await encryptSession(normalizedVnuSession(), SESSION_SECRET);
    const app = createApp(undefined);
    const controller = new AbortController();
    const firstRequest = new Request("http://localhost/api/vnu/raw/grades", {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}` },
    });

    const firstResponsePromise = app.handle(firstRequest);
    await firstFetch.entered;
    controller.abort(new DOMException("SYNTHETIC_RAW_ABORT", "AbortError"));
    firstFetch.release("<html>SYNTHETIC_CANCELLED_GRADES</html>");
    const firstResponse = await firstResponsePromise;

    expect(firstResponse.status).toBe(500);
    expect(cache.rawUrls()).toEqual([]);
    expect(putSpy).not.toHaveBeenCalled();

    const secondResponse = await getVnuRawPage(app, token);
    expect(secondResponse.status).toBe(200);
    await expect(secondResponse.json()).resolves.toEqual({ data: { html: "<html>SYNTHETIC_RETRY_GRADES</html>" }, error: null });
    expect(gradesSpy).toHaveBeenCalledTimes(2);
    expect(cache.rawUrls()).toHaveLength(1);

    gradesSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("fails descriptor-bearing self-hosted sessions closed", async () => {
    setVnuRefreshControlCoordinator(undefined);
    const token = await encryptSession(descriptorVnuSession(), SESSION_SECRET);

    await expect(resolveSession({ Authorization: `Bearer ${token}` })).rejects.toMatchObject({ code: "VNU_REFRESH_UNAVAILABLE", status: 503 });
  });
});

describe("JSON error detail boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET });
  });

  async function rejectedImport(details: unknown): Promise<Record<string, unknown>> {
    adapterMocks.importSession.mockRejectedValue(new HyeboardError("SYNTHETIC_REJECTION", "Safe synthetic rejection", 429, details));
    adapterMocks.getAdapter.mockReturnValue({ importSession: adapterMocks.importSession });
    const response = await createApp(undefined).handle(new Request("http://localhost/api/mock/auth/import-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }));
    expect(response.status).toBe(429);
    const payload = await response.json() as Record<string, unknown>;
    await new Promise((resolve) => setTimeout(resolve, 0));
    return payload;
  }

  it("includes only a fully valid allow-listed detail object", async () => {
    await expect(rejectedImport({ retryAfterSeconds: 5, limit: 5, windowSeconds: 900 })).resolves.toMatchObject({
      error: { details: { retryAfterSeconds: 5, limit: 5, windowSeconds: 900 } },
    });
  });

  it.each([
    { retryAfterSeconds: 5, privateCredential: "PRIVATE_SENTINEL" },
    { reason: "OTHER_REASON" },
    "NONOBJECT_SENTINEL",
  ])("omits mixed, unknown, and nonobject details atomically", async (details) => {
    const payload = await rejectedImport(details);
    expect(payload).toMatchObject({ error: { code: "SYNTHETIC_REJECTION" } });
    expect((payload.error as Record<string, unknown>).details).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain("PRIVATE_SENTINEL");
  });

  it("omits circular details instead of failing serialization", async () => {
    const details: Record<string, unknown> = { retryAfterSeconds: 5 };
    details.circular = details;

    const payload = await rejectedImport(details);
    expect((payload.error as Record<string, unknown>).details).toBeUndefined();
  });

  it("sanitizes unexpected import-session SSE failures", async () => {
    const sentinel = "PRIVATE_UPSTREAM_COOKIE_TOKEN_STUDENT_SENTINEL";
    adapterMocks.importSession.mockRejectedValue(new Error(sentinel));
    adapterMocks.getAdapter.mockReturnValue({ importSession: adapterMocks.importSession });

    const response = await createApp(undefined).handle(new Request("http://localhost/api/uet/auth/import-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uetGoogleEmail: "student@example.test", uetGooglePassword: "PRIVATE_PASSWORD" }),
    }));
    const text = await response.text();

    expect(text).toContain("event: error");
    expect(text).toContain('"code":"GOOGLE_SIGNIN_FAILURE"');
    expect(text).toContain('"message":"Google sign-in did not complete. Try again."');
    expect(text).not.toContain(sentinel);
  });

  it("rejects empty access-token and refresh-grant wire values", () => {
    const session = { universityId: "vnu", studentCode: VNU_STUDENT_CODE, expiresAt: "2099-01-01T00:00:00.000Z", authenticated: true };

    expect(authResultSchema.safeParse({ token: "", session }).success).toBe(false);
    expect(authResultSchema.safeParse({ token: "SYNTHETIC_TOKEN", refreshGrant: "", session }).success).toBe(false);
    expect(authResultSchema.safeParse({ token: "SYNTHETIC_TOKEN", refreshGrant: "SYNTHETIC_GRANT", session }).success).toBe(true);
  });
});

describe("VNU recoverability classification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET });
  });

  afterEach(() => configureLogger({ level: "silent", mode: "node" }));

  it("marks only a missing VNU credential with the recoverable reason", async () => {
    const token = await encryptSession({ ...normalizedVnuSession(), vnu: undefined }, SESSION_SECRET);
    const response = await getVnuRawPage(createApp(undefined), token);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      data: null,
      error: {
        code: "VNU_LOGIN_REQUIRED",
        message: "VNU data needs an active university portal credential.",
        details: { reason: "MISSING_VNU_CREDENTIAL" },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it.each([
    ["Hyeboard", new HyeboardError("SYNTHETIC_VNU_FAILURE", "UPSTREAM_PROSE_SENTINEL TOKEN_SENTINEL GRANT_SENTINEL", 502)],
    ["unexpected", new Error("UPSTREAM_PROSE_SENTINEL TOKEN_SENTINEL GRANT_SENTINEL PRINCIPAL_SENTINEL USERNAME_SENTINEL STUDENT_CODE_SENTINEL PROFILE_SENTINEL COOKIE_SENTINEL")],
  ])("uses constant private-free VNU logging for %s route failures", async (_label, routeFailure) => {
    const lines: string[] = [];
    configureLogger({ level: "error", mode: "node", destination: { write: (line) => lines.push(line) } });
    adapterMocks.getAdapter.mockReturnValue({ getStudentProfile: vi.fn(async () => { throw routeFailure; }) });
    const app = createApp(undefined);
    const token = await encryptSession(normalizedVnuSession(), SESSION_SECRET);

    const response = await app.handle(new Request("http://localhost/api/vnu/me", {
      headers: { Authorization: `Bearer ${token}` },
    }));
    await response.text();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const output = lines.join("\n");
    expect(output).toContain('"operation":"route"');
    expect(output).toContain('"msg":"VNU request failed"');
    expect(output).not.toContain('"reqId"');
    expect(output).not.toContain('"stack"');
    for (const sentinel of ["UPSTREAM_PROSE_SENTINEL", "TOKEN_SENTINEL", "GRANT_SENTINEL", "PRINCIPAL_SENTINEL", "USERNAME_SENTINEL", "STUDENT_CODE_SENTINEL", "PROFILE_SENTINEL", "COOKIE_SENTINEL"]) {
      expect(output).not.toContain(sentinel);
    }
    for (const line of lines) {
      const { level: _level, time: _time, pid: _pid, hostname: _hostname, ...stable } = JSON.parse(line) as Record<string, unknown>;
      expect(stable).toEqual(expect.objectContaining({ operation: "route", msg: "VNU request failed" }));
      expect(Object.keys(stable).sort()).toEqual(["code", "msg", "operation", "status"]);
    }
  });

  it("replaces an untrusted status-bearing error code at the VNU boundary", async () => {
    const privateCode = "PRIVATE_CODE_SENTINEL";
    const privateMessage = "PRIVATE_MESSAGE_SENTINEL";
    const routeFailure = Object.assign(new Error(privateMessage), { status: 422, code: privateCode, details: { privateId: "PRIVATE_ID_SENTINEL" } });
    const lines: string[] = [];
    configureLogger({ level: "warn", mode: "node", destination: { write: (line) => lines.push(line) } });
    adapterMocks.getAdapter.mockReturnValue({ getStudentProfile: vi.fn(async () => { throw routeFailure; }) });
    const app = createApp(undefined);
    const token = await encryptSession(normalizedVnuSession(), SESSION_SECRET);

    const response = await app.handle(new Request("http://localhost/api/vnu/me", { headers: { Authorization: `Bearer ${token}` } }));
    const responseText = await response.text();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const logText = lines.join("\n");

    expect(response.status).toBe(500);
    expect(JSON.parse(responseText)).toEqual({
      data: null,
      error: { code: "INTERNAL_ERROR", message: "Unexpected API error" },
    });
    for (const privateValue of [privateCode, privateMessage, "PRIVATE_ID_SENTINEL"]) {
      expect(responseText).not.toContain(privateValue);
      expect(logText).not.toContain(privateValue);
    }
    expect(JSON.parse(lines[0]!)).toMatchObject({ operation: "route", code: "INTERNAL_ERROR", status: 500, msg: "VNU request failed" });
  });
});

describe("import-session cache protection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET });
    adapterMocks.getAdapter.mockReturnValue({ importSession: adapterMocks.importSession });
  });

  it("marks fast JSON responses no-store", async () => {
    adapterMocks.importSession.mockResolvedValue({
      universityId: "mock",
      studentCode: "SYNTHETIC-MOCK",
      expiresAt: "2099-01-01T00:00:00.000Z",
      session: mockSession(),
    });

    const response = await createApp(undefined).handle(new Request("http://localhost/api/mock/auth/import-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("marks UET SSE responses no-store while preserving stream transforms", async () => {
    adapterMocks.importSession.mockResolvedValue({
      universityId: "uet",
      studentCode: "SYNTHETIC-UET",
      expiresAt: "2099-01-01T00:00:00.000Z",
      session: rawUetSession(),
    });

    const response = await createApp(undefined).handle(new Request("http://localhost/api/uet/auth/import-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uetGoogleEmail: "PH00000001", uetGooglePassword: "fake-password" }),
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store, no-transform");
    await response.body?.cancel();
  });

  it("does not mint a token when a non-VNU JSON import resolves after cancellation", async () => {
    const gate = enteredOperation<{
      universityId: string;
      studentCode: string;
      expiresAt: string;
      session: EncryptedSessionPayload;
    }>();
    adapterMocks.importSession.mockImplementationOnce(async () => {
      gate.markEntered();
      return gate.result;
    });
    const controller = new AbortController();
    const request = new Request("http://localhost/api/mock/auth/import-session", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    const responsePromise = createApp(undefined).handle(request);
    await gate.entered;
    controller.abort(new DOMException("SYNTHETIC_MOCK_IMPORT_ABORT", "AbortError"));
    gate.release({
      universityId: "mock",
      studentCode: "SYNTHETIC-MOCK",
      expiresAt: "2099-01-01T00:00:00.000Z",
      session: mockSession(),
    });

    const response = await responsePromise;
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ data: null, error: { code: "INTERNAL_ERROR", message: "Unexpected API error" } });
  });

  it("marks failed JSON responses no-store", async () => {
    adapterMocks.importSession.mockRejectedValue(new HyeboardError("SYNTHETIC_REJECTION", "Safe synthetic rejection", 429));

    const response = await createApp(undefined).handle(new Request("http://localhost/api/mock/auth/import-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }));

    expect(response.status).toBe(429);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("lazy parent session refresh", () => {
  let logOutput: string[];

  beforeEach(async () => {
    vi.clearAllMocks();
    adapterMocks.getAdapter.mockReturnValue({ importSession: adapterMocks.importSession });
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET });
    configureLogger({ level: "silent", mode: "node" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    logOutput = [];
    configureLogger({
      level: "debug",
      mode: "node",
      destination: { write: (line: string) => logOutput.push(line) },
    });
  });

  afterEach(() => configureLogger({ level: "silent", mode: "node" }));

  it("refreshes without browser context or a human CAPTCHA callback", async () => {
    const refreshedSession = {
      ...parentSession(),
      studenthub: { kind: "bearer" as const, value: "NEW_ACCESS_TOKEN_SENTINEL", expiresAt: "2098-01-01T00:00:00.000Z" },
    };
    adapterMocks.importSession.mockResolvedValue({
      universityId: "uet",
      studentCode: refreshedSession.studentCode,
      expiresAt: refreshedSession.expiresAt,
      session: refreshedSession,
    });
    const token = await encryptSession(parentSession(), SESSION_SECRET);

    const resolved = await resolveSession({ Authorization: `Bearer ${token}` });

    expect(adapterMocks.importSession.mock.calls[0]).toEqual([{
      uetGoogleEmail: "PARENT_USERNAME_SENTINEL",
      uetGooglePassword: "PARENT_PASSWORD_SENTINEL",
    }]);
    expect(resolved.refreshedToken).toBeTypeOf("string");
    await expect(decryptSession(resolved.refreshedToken!, SESSION_SECRET)).resolves.toEqual(refreshedSession);
    expect(logOutput.join("\n")).toBe("");
  });

  it("does not mint a refreshed UET token when the adapter resolves after cancellation", async () => {
    const refreshedSession = {
      ...parentSession(),
      studenthub: { kind: "bearer" as const, value: "NEW_ACCESS_TOKEN_SENTINEL", expiresAt: "2098-01-01T00:00:00.000Z" },
    };
    const gate = enteredOperation<{
      universityId: string;
      studentCode: string;
      expiresAt: string;
      session: EncryptedSessionPayload;
    }>();
    adapterMocks.importSession.mockImplementationOnce(async () => {
      gate.markEntered();
      return gate.result;
    });
    const token = await encryptSession(parentSession(), SESSION_SECRET);
    const controller = new AbortController();

    const resolving = resolveSession({ Authorization: `Bearer ${token}` }, controller.signal);
    await gate.entered;
    controller.abort(new DOMException("SYNTHETIC_UET_REFRESH_ABORT", "AbortError"));
    gate.release({
      universityId: "uet",
      studentCode: refreshedSession.studentCode!,
      expiresAt: refreshedSession.expiresAt,
      session: refreshedSession,
    });

    await expect(resolving).rejects.toMatchObject({ code: "GOOGLE_REFRESH_FAILED", status: 401 });
  });

  it.each([
    ["STUDENTHUB_CAPTCHA_REQUIRED", 422],
    ["STUDENTHUB_CAPTCHA_REJECTED", 422],
    ["STUDENTHUB_CAPTCHA_TIMEOUT", 408],
  ])("propagates %s unchanged without session-death semantics", async (code, status) => {
    const token = await encryptSession(parentSession(), SESSION_SECRET);
    const error = new HyeboardError(code, `Refresh failed ${SENTINELS.join(" ")}`, status);
    adapterMocks.importSession.mockRejectedValue(error);

    let caught: unknown;
    try {
      await resolveSession({ Authorization: `Bearer ${token}` });
    } catch (value) {
      caught = value;
    }

    expect(caught).toBe(error);
    expect(caught).toMatchObject({ code, status });
    expect(adapterMocks.importSession.mock.calls[0]).toHaveLength(1);
    await expect(decryptSession(token, SESSION_SECRET)).resolves.toEqual(parentSession());
    for (const sentinel of SENTINELS) expect(logOutput.join("\n")).not.toContain(sentinel);
  });
});

describe("UET CAPTCHA SSE cancellation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET });
  });

  it("cancels and removes an active relay when the response reader is cancelled", async () => {
    const relayId = "HYEB_RELAY_ID_SENTINEL";
    const upstreamCaptchaId = "UPSTREAM_CAPTCHA_ID_SENTINEL";
    const coordinator = new LocalCaptchaRelayCoordinator(() => relayId, 60_000);
    setCaptchaRelayCoordinator(coordinator);
    let finishImport!: () => void;
    const importFinished = new Promise<void>((resolve) => { finishImport = resolve; });
    adapterMocks.importSession.mockImplementation(async (_body, context) => {
      try {
        void upstreamCaptchaId;
        await context.onCaptchaNeeded("data:image/png;base64,SU1BR0VfU0VOVElORUw=");
        throw new Error("unexpected answer");
      } finally {
        finishImport();
      }
    });
    adapterMocks.getAdapter.mockReturnValue({ importSession: adapterMocks.importSession });
    const app = createApp(undefined);
    const response = await app.handle(new Request("http://localhost/api/uet/auth/import-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uetGoogleEmail: "PH00000001", uetGooglePassword: "fake-password" }),
    }));
    const reader = response.body!.getReader();

    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    const payload = JSON.parse(/^data: (.+)$/m.exec(text)?.[1] ?? "null") as Record<string, unknown>;
    expect(/^event: captcha_required$/m.test(text)).toBe(true);
    expect(payload.challengeId).toMatch(new RegExp(`^${relayId}\\.[0-9a-f]{64}$`));
    expect(payload.image).toBe("data:image/png;base64,SU1BR0VfU0VOVElORUw=");
    expect(Object.keys(payload).sort()).toEqual(["challengeId", "image"]);
    expect(text).not.toContain(upstreamCaptchaId);

    await reader.cancel();
    await importFinished;
    await expect(coordinator.answer(relayId, "LATE_ANSWER_SENTINEL")).rejects.toMatchObject({
      code: "STUDENTHUB_CAPTCHA_CHALLENGE_NOT_FOUND",
      status: 404,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("awaits asynchronous coordinator answers before accepting the solve request", async () => {
    let releaseAnswer!: () => void;
    const answerGate = new Promise<void>((resolve) => { releaseAnswer = resolve; });
    const answer = vi.fn(async () => { await answerGate; });
    const coordinator: CaptchaRelayCoordinator = {
      prepare: async () => { throw new Error("not used"); },
      answer,
    };
    setCaptchaRelayCoordinator(coordinator);
    const app = createApp(undefined);
    const relayToken = await createCaptchaRelayToken("HYEB_RELAY_ID_SENTINEL");
    let settled = false;
    const responsePromise = app.handle(new Request("http://localhost/api/uet/auth/solve-captcha", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challengeId: relayToken, answer: "ANSWER_SENTINEL" }),
    })).then((response) => {
      settled = true;
      return response;
    });

    await vi.waitFor(() => expect(answer).toHaveBeenCalledWith("HYEB_RELAY_ID_SENTINEL", "ANSWER_SENTINEL"));
    expect(settled).toBe(false);
    releaseAnswer();

    const response = await responsePromise;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { accepted: true }, error: null });
  });

  it("rejects malformed and forged relay tokens before coordinator access", async () => {
    const answer = vi.fn();
    setCaptchaRelayCoordinator({
      prepare: async () => { throw new Error("not used"); },
      answer,
    });
    const app = createApp(undefined);
    const validToken = await createCaptchaRelayToken("HYEB_RELAY_ID_SENTINEL");
    const forgedToken = `${validToken.slice(0, -1)}${validToken.endsWith("0") ? "1" : "0"}`;
    const bodies = [];

    for (const challengeId of ["malformed-token", forgedToken]) {
      const response = await app.handle(new Request("http://localhost/api/uet/auth/solve-captcha", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId, answer: "ANSWER_SENTINEL" }),
      }));
      expect(response.status).toBe(404);
      bodies.push(await response.json());
    }

    expect(bodies[0]).toEqual(bodies[1]);
    expect(answer).not.toHaveBeenCalled();
  });

  it.each([
    [{ challengeId: "x".repeat(161), answer: "A" }],
    [{ challengeId: "token", answer: "" }],
    [{ challengeId: "token", answer: "A".repeat(65) }],
  ])("rejects solve request bounds before coordinator access", async (body) => {
    const answer = vi.fn();
    setCaptchaRelayCoordinator({
      prepare: async () => { throw new Error("not used"); },
      answer,
    });
    const app = createApp(undefined);

    const response = await app.handle(new Request("http://localhost/api/uet/auth/solve-captcha", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));

    expect(response.status).toBe(422);
    expect(answer).not.toHaveBeenCalled();
  });
});

describe("distributed Google login rate limiting", () => {
  const cache = {
    match: vi.fn(async () => undefined),
    put: vi.fn(async () => undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET, HYEB_HA_MODE: "distributed" });
    setAppCache(cache);
    adapterMocks.getAdapter.mockReturnValue({});
    setDistributedAutomationBackend({
      isAvailable: () => true,
      isAutomationChallengeToken: () => false,
      createChallengeToken: () => "unused",
      answerCaptcha: async () => undefined,
      cancelCaptcha: async () => undefined,
      cancelAutomation: async () => undefined,
      importUetGoogle: async () => ({
        universityId: "uet",
        studentCode: "STUDENT_SENTINEL",
        expiresAt: "2099-01-01T00:00:00.000Z",
        session: {
          version: 1,
          universityId: "uet",
          studentCode: "STUDENT_SENTINEL",
          expiresAt: "2099-01-01T00:00:00.000Z",
          uetGoogleCredential: { email: "student@example.test", password: "PRIVATE_PASSWORD" },
        },
      }),
    });
  });

  afterEach(() => {
    setDistributedAutomationBackend(undefined);
    setRateLimitCoordinator(undefined);
    setAppCache(undefined);
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET });
  });

  function request(): Promise<Response> {
    return createApp(undefined).handle(new Request("http://localhost/api/uet/auth/import-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uetGoogleEmail: "student@example.test", uetGooglePassword: "PRIVATE_PASSWORD" }),
    }));
  }

  it("uses the injected atomic coordinator without reading or writing the JSON cache", async () => {
    const consumeFixedWindow = vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 }));
    setRateLimitCoordinator({ consumeFixedWindow });

    const response = await request();
    expect(response.status).toBe(200);
    await response.text();
    expect(consumeFixedWindow).toHaveBeenCalledWith(expect.stringMatching(/^uet\/google-login-attempts\/[0-9a-f]{64}$/), 1, 15 * 60 * 1000, 5);
    expect(cache.match).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("preserves the public rate-limit error code", async () => {
    setRateLimitCoordinator({ consumeFixedWindow: async () => ({ allowed: false, retryAfterSeconds: 42 }) });

    const response = await request();
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      data: null,
      error: {
        code: "GOOGLE_LOGIN_RATE_LIMITED",
        message: "Too many sign-in attempts for this email. Wait 15 minutes and try again, or use the manual token option below.",
      },
    });
  });

  it("maps a Redis coordinator failure to a sanitized 503", async () => {
    setRateLimitCoordinator({ consumeFixedWindow: async () => { throw new Error("PRIVATE_REDIS_FAILURE"); } });

    const response = await request();
    const text = await response.text();
    expect(response.status).toBe(503);
    expect(text).not.toContain("PRIVATE_REDIS_FAILURE");
    expect(JSON.parse(text)).toEqual({
      data: null,
      error: {
        code: "HA_DEPENDENCY_UNAVAILABLE",
        message: "The distributed Redis rate limiter dependency is unavailable.",
      },
    });
  });
});

describe("VNU import session cache", () => {
  let cache: TestCache;
  let app: ReturnType<typeof createApp>;
  let syntheticTime: number;
  let dateNowSpy: ReturnType<typeof vi.spyOn>;
  let profileSpy: ReturnType<typeof vi.spyOn>;
  let gradesSpy: ReturnType<typeof vi.spyOn> | undefined;
  let refreshControl: TestVnuImportRefreshControl;

  beforeEach(() => {
    vi.clearAllMocks();
    adapterMocks.getAdapter.mockReset();
    adapterMocks.importSession.mockReset();
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET });
    syntheticTime = 1_800_000_000_000;
    dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => syntheticTime);
    cache = new TestCache(() => syntheticTime);
    vi.stubGlobal("caches", { default: cache });
    adapterMocks.getAdapter.mockReturnValue({ importSession: adapterMocks.importSession });
    adapterMocks.importSession.mockResolvedValue(importedVnu());
    refreshControl = new TestVnuImportRefreshControl();
    setVnuRefreshControlCoordinator(refreshControl);
    profileSpy = vi.spyOn(DaotaoClient.prototype, "getProfileHtml").mockResolvedValue(vnuProfileHtml());
    gradesSpy = undefined;
    app = createApp(undefined);
  });

  afterEach(() => {
    gradesSpy?.mockRestore();
    profileSpy.mockRestore();
    dateNowSpy.mockRestore();
    vi.unstubAllGlobals();
    setVnuImportSingleFlight(undefined);
    setAppCache(undefined);
    setVnuRefreshControlCoordinator(undefined);
    configureLogger({ level: "silent", mode: "node" });
  });

  it("does not issue credentials or cache a VNU import resolved after request cancellation", async () => {
    const importGate = enteredOperation<ReturnType<typeof importedVnu>>();
    const putSpy = vi.spyOn(cache, "put");
    adapterMocks.importSession
      .mockImplementationOnce(async () => {
        importGate.markEntered();
        return importGate.result;
      })
      .mockResolvedValueOnce(importedVnu());
    const controller = new AbortController();
    const firstRequest = new Request("http://localhost/api/vnu/auth/import-session", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vnuUsername: "SYNTHETIC_VNU_USER", vnuPassword: "SYNTHETIC_VNU_PASSWORD" }),
    });

    const firstResponsePromise = app.handle(firstRequest);
    await importGate.entered;
    controller.abort(new DOMException("SYNTHETIC_IMPORT_ABORT", "AbortError"));
    importGate.release(importedVnu());
    const firstResponse = await firstResponsePromise;

    expect(firstResponse.status).toBe(500);
    await expect(firstResponse.json()).resolves.toEqual({ data: null, error: { code: "INTERNAL_ERROR", message: "Unexpected API error" } });
    expect(refreshControl.activations).toEqual([]);
    expect(cache.importUrls()).toEqual([]);
    expect(putSpy).not.toHaveBeenCalled();

    const retry = await requestVnuImport(app);
    expect(retry.status).toBe(200);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(2);
    expect(refreshControl.activations).toHaveLength(1);
    expect(cache.importUrls()).toHaveLength(1);
  });

  it("normalizes the username and activates a linked access/grant pair before returning artifacts", async () => {
    const response = await app.handle(new Request("http://localhost/api/vnu/auth/import-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vnuUsername: "  SYNTHETIC-VNU-USER  ", vnuPassword: "SYNTHETIC-PASSWORD-BYTES" }),
    }));
    const body = await response.json() as { data: CoordinatorVnuImportResponse; error: null };

    expect(response.status).toBe(200);
    expect(adapterMocks.importSession).toHaveBeenCalledWith(
      {
        vnuUsername: "synthetic-vnu-user",
        vnuPassword: "SYNTHETIC-PASSWORD-BYTES",
      },
      { signal: expect.any(AbortSignal) },
    );
    const access = await decryptSession(body.data.token, SESSION_SECRET);
    const grant = await decryptVnuRefreshGrant(body.data.refreshGrant!, SESSION_SECRET, syntheticTime);
    expect(grant).toMatchObject({
      username: "synthetic-vnu-user",
      password: "SYNTHETIC-PASSWORD-BYTES",
      expectedStudentCode: VNU_STUDENT_CODE,
    });
    expect(Date.parse(grant.expiresAt) - Date.parse(grant.issuedAt)).toBe(8 * 60 * 60 * 1000);
    expect(access.vnuRefresh).toMatchObject({ grantId: grant.grantId, grantExpiresAt: grant.expiresAt });
    expect(refreshControl.activations).toEqual([{
      principalKey: access.vnuRefresh!.principalKey,
      pair: {
        accessTokenId: access.vnuRefresh!.accessTokenId,
        accessExpiresAt: Date.parse(access.vnuRefresh!.accessExpiresAt),
        grantId: grant.grantId,
        grantExpiresAt: Date.parse(grant.expiresAt),
      },
    }]);
  });

  it("deduplicates concurrent distributed imports through the injected single-flight", async () => {
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET, HYEB_HA_MODE: "distributed" });
    setAppCache(cache);
    let releaseImport!: () => void;
    const importGate = new Promise<void>((resolve) => { releaseImport = resolve; });
    adapterMocks.importSession.mockImplementation(async () => {
      await importGate;
      return importedVnu();
    });
    let shared: Promise<unknown> | undefined;
    let runCalls = 0;
    const run = async <T>(_key: string, work: () => Promise<T>): Promise<T> => {
      runCalls += 1;
      shared ??= work();
      return await shared as T;
    };
    setVnuImportSingleFlight({ run });

    const requestImport = () => app.handle(new Request("http://localhost/api/vnu/auth/import-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vnuUsername: "SYNTHETIC-VNU-USER", vnuPassword: "SYNTHETIC-PASSWORD-BYTES" }),
    }));
    const first = requestImport();
    await vi.waitFor(() => expect(adapterMocks.importSession).toHaveBeenCalledOnce());
    const second = requestImport();
    releaseImport();
    const responses = await Promise.all([first, second]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(runCalls).toBe(2);
    expect(adapterMocks.importSession).toHaveBeenCalledOnce();
    expect(await responses[0]!.clone().json()).toEqual(await responses[1]!.clone().json());
  });

  it("does not return a shared distributed import result to an aborted follower", async () => {
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET, HYEB_HA_MODE: "distributed" });
    setAppCache(cache);
    const importGate = enteredOperation<ReturnType<typeof importedVnu>>();
    adapterMocks.importSession.mockImplementation(async () => {
      importGate.markEntered();
      return importGate.result;
    });
    let shared: Promise<unknown> | undefined;
    let runCalls = 0;
    setVnuImportSingleFlight({
      run: async <T>(_key: string, work: () => Promise<T>): Promise<T> => {
        runCalls += 1;
        shared ??= work();
        return await shared as T;
      },
    });
    const requestImport = (signal?: AbortSignal) => app.handle(new Request("http://localhost/api/vnu/auth/import-session", {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vnuUsername: "SYNTHETIC-VNU-USER", vnuPassword: "SYNTHETIC-PASSWORD-BYTES" }),
    }));

    const leader = requestImport();
    await importGate.entered;
    const followerController = new AbortController();
    const follower = requestImport(followerController.signal);
    await vi.waitFor(() => expect(runCalls).toBe(2));
    followerController.abort(new DOMException("SYNTHETIC_FOLLOWER_ABORT", "AbortError"));
    importGate.release(importedVnu());

    const leaderResponse = await leader;
    const followerResponse = await follower;
    const followerText = await followerResponse.text();
    expect(leaderResponse.status).toBe(200);
    expect(followerResponse.status).toBe(500);
    expect(JSON.parse(followerText)).toEqual({ data: null, error: { code: "INTERNAL_ERROR", message: "Unexpected API error" } });
    expect(followerText).not.toMatch(/token|grant|session|SYNTHETIC-PASSWORD-BYTES/i);
    expect(adapterMocks.importSession).toHaveBeenCalledOnce();
    expect(refreshControl.activations).toHaveLength(1);
    expect(refreshControl.mutationCount).toBe(1);
    expect(cache.importUrls()).toHaveLength(1);

    const liveResponse = await requestImport();
    expect(liveResponse.status).toBe(200);
    expect(adapterMocks.importSession).toHaveBeenCalledOnce();
    expect(refreshControl.activations).toHaveLength(2);
    expect(refreshControl.mutationCount).toBe(2);
    expect(cache.importUrls()).toHaveLength(1);
  });

  it("returns sanitized 429 without artifacts on the sixth manual activation and succeeds after reset", async () => {
    const privatePassword = "PRIVATE_MANUAL_ACTIVATION_PASSWORD";
    const requestImport = (password = privatePassword) => app.handle(new Request("http://localhost/api/vnu/auth/import-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vnuUsername: "SYNTHETIC-VNU-USER", vnuPassword: password }),
    }));

    for (let activation = 0; activation < VNU_MANUAL_ACTIVATION_LIMIT; activation += 1) {
      expect((await requestImport()).status).toBe(200);
    }
    expect(cache.importUrls()).toHaveLength(1);
    const importUrlsBeforeRejected = cache.importUrls();
    const mutationCount = refreshControl.mutationCount;
    const principalKey = refreshControl.activations[0]!.principalKey;
    const activePairBefore = structuredClone(refreshControl.activePairs.get(principalKey));
    const revokedPairsBefore = structuredClone(refreshControl.revokedPairs.get(principalKey));
    const activationWindowBefore = structuredClone(refreshControl.activationWindows.get(principalKey));
    const logLines: string[] = [];
    configureLogger({ level: "warn", mode: "node", destination: { write: (line) => logLines.push(line) } });
    const rejected = await requestImport("PRIVATE_FRESH_RATE_LIMITED_PASSWORD");
    const rejectedText = await rejected.text();
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("Cache-Control")).toBe("no-store");
    expect(JSON.parse(rejectedText)).toEqual({
      data: null,
      error: {
        code: "VNU_MANUAL_ACTIVATION_RATE_LIMITED",
        message: "Too many VNU sign-ins. Wait before trying again.",
        details: { retryAfterSeconds: VNU_MANUAL_ACTIVATION_WINDOW_MS / 1000 },
      },
    });
    expect(rejectedText).not.toMatch(/token|grant|PRIVATE_(?:MANUAL_ACTIVATION|FRESH_RATE_LIMITED)_PASSWORD/i);
    expect(refreshControl.mutationCount).toBe(mutationCount);
    expect(refreshControl.activations).toHaveLength(VNU_MANUAL_ACTIVATION_LIMIT);
    expect(refreshControl.activePairs.get(principalKey)).toEqual(activePairBefore);
    expect(refreshControl.revokedPairs.get(principalKey)).toEqual(revokedPairsBefore);
    expect(refreshControl.activationWindows.get(principalKey)).toEqual(activationWindowBefore);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(2);
    expect(cache.importUrls()).toHaveLength(1);
    expect(logLines.join("\n")).toContain("VNU_MANUAL_ACTIVATION_RATE_LIMITED");
    expect(logLines.join("\n")).not.toMatch(/PRIVATE_(?:MANUAL_ACTIVATION|FRESH_RATE_LIMITED)_PASSWORD|SYNTHETIC-VNU-USER/i);

    syntheticTime += VNU_MANUAL_ACTIVATION_WINDOW_MS;
    const reset = await requestImport("PRIVATE_FRESH_RATE_LIMITED_PASSWORD");
    expect(reset.status).toBe(200);
    expect(refreshControl.activations).toHaveLength(VNU_MANUAL_ACTIVATION_LIMIT + 1);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(3);
    expect(cache.importUrls()).toHaveLength(2);
    const acceptedCacheUrl = cache.importUrls().find((url) => !importUrlsBeforeRejected.includes(url));
    expect(acceptedCacheUrl).toBeDefined();
    const acceptedCacheEntry = await cache.store.get(acceptedCacheUrl!)!.response.clone().json() as { seed: string; session: CoordinatorVnuImportResponse["session"] };
    await expect(decryptSession(acceptedCacheEntry.seed, SESSION_SECRET)).resolves.toEqual(normalizedVnuSession());
    expect(acceptedCacheEntry.session).toMatchObject({ universityId: "vnu", studentCode: VNU_STUDENT_CODE, authenticated: true });
  });

  it.each([
    ["refresh", "/api/vnu/auth/refresh", {}],
    ["refresh extras", "/api/vnu/auth/refresh", { refreshGrant: "x", extra: true }],
    ["logout extras", "/api/vnu/auth/logout", { extra: true }],
  ])("rejects malformed strict %s bodies with no-store", async (_label, path, body) => {
    const imported = await importVnu(app);
    const response = await app.handle(new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${imported.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(refreshControl.beginAttempts).toEqual([]);
    expect(refreshControl.revocationAttempts).toEqual([]);
  });

  it("requires a JSON object logout body while accepting an explicit empty object", async () => {
    const imported = await importVnu(app);
    const missing = await requestVnuLogoutWithoutBody(app, imported.token);
    expect(missing.status).toBe(400);
    expect(missing.headers.get("Cache-Control")).toBe("no-store");
    expect(refreshControl.revocationAttempts).toEqual([]);

    const explicitEmpty = await requestVnuLogout(app, imported.token);
    expect(explicitEmpty.status).toBe(200);
    expect(explicitEmpty.headers.get("Cache-Control")).toBe("no-store");
    expect(refreshControl.revocationAttempts).toHaveLength(1);
    expect(cache.revocationUrls()).toEqual([]);
  });

  it.each(["refresh", "logout"] as const)("bounds chunked %s bodies by actual bytes before grant authority or upstream", async (operation) => {
    const imported = await importVnu(app);
    const path = `/api/vnu/auth/${operation}`;
    const oversized = JSON.stringify({ refreshGrant: "X".repeat(VNU_AUTH_BODY_MAX_BYTES) });
    const response = await app.handle(chunkedJsonRequest(path, imported.token, [oversized.slice(0, 4_000), oversized.slice(4_000)]));
    const responseText = await response.text();
    expect(response.status).toBe(413);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(JSON.parse(responseText)).toEqual({ data: null, error: { code: "PAYLOAD_TOO_LARGE", message: "The request body is too large." } });
    expect(responseText).not.toContain("X".repeat(32));
    expect(refreshControl.beginAttempts).toEqual([]);
    expect(refreshControl.revocationAttempts).toEqual([]);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
    expect(cache.revocationUrls()).toEqual([]);
  });

  it.each(["refresh", "logout"] as const)("rejects unauthenticated %s before consuming its body stream", async (operation) => {
    let pulls = 0;
    const response = await app.handle(chunkedJsonRequest(`/api/vnu/auth/${operation}`, "tampered", [JSON.stringify({ refreshGrant: "PRIVATE_GRANT_SENTINEL" })], () => { pulls += 1; }));
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(pulls).toBe(0);
    expect(refreshControl.beginAttempts).toEqual([]);
    expect(refreshControl.revocationAttempts).toEqual([]);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(0);
  });

  it("accepts a valid refresh body at the exact streaming byte ceiling", async () => {
    const imported = await importVnu(app);
    const json = JSON.stringify({ refreshGrant: imported.refreshGrant });
    const body = json + " ".repeat(VNU_AUTH_BODY_MAX_BYTES - new TextEncoder().encode(json).byteLength);
    const response = await app.handle(chunkedJsonRequest("/api/vnu/auth/refresh", imported.token, [body.slice(0, 4_096), body.slice(4_096)]));
    expect(new TextEncoder().encode(body)).toHaveLength(VNU_AUTH_BODY_MAX_BYTES);
    expect(response.status).toBe(200);
    expect(refreshControl.beginAttempts).toHaveLength(1);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(2);
  });

  it("accepts the largest producer-issued grant through the shared field and body ceilings", async () => {
    const password = "P".repeat(largestAcceptedWorkerPasswordLength(syntheticTime));
    const importedResponse = await app.handle(new Request("http://localhost/api/vnu/auth/import-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vnuUsername: "SYNTHETIC_VNU_USER", vnuPassword: password }),
    }));
    const importedBody = await importedResponse.json() as { data: CoordinatorVnuImportResponse; error: null };
    expect(importedResponse.status).toBe(200);
    expect(importedBody.data.refreshGrant.length).toBeLessThanOrEqual(VNU_REFRESH_GRANT_MAX_LENGTH);
    const json = JSON.stringify({ refreshGrant: importedBody.data.refreshGrant });
    const padded = json + " ".repeat(VNU_AUTH_BODY_MAX_BYTES - new TextEncoder().encode(json).byteLength);
    const refreshed = await app.handle(chunkedJsonRequest("/api/vnu/auth/refresh", importedBody.data.token, [padded]));
    expect(refreshed.status).toBe(200);
  });

  it("fails oversized producer credentials before authority activation or artifact return", async () => {
    const privatePassword = `PRIVATE_OVERSIZE_PASSWORD_${"X".repeat(7_000)}`;
    const response = await app.handle(new Request("http://localhost/api/vnu/auth/import-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vnuUsername: "SYNTHETIC_VNU_USER", vnuPassword: privatePassword }),
    }));
    const text = await response.text();
    expect(response.status).toBe(400);
    expect(JSON.parse(text)).toEqual({ data: null, error: { code: "VNU_REFRESH_GRANT_TOO_LARGE", message: "The VNU reconnect credentials are too large to store safely." } });
    expect(text).not.toContain("PRIVATE_OVERSIZE_PASSWORD");
    expect(refreshControl.activations).toEqual([]);
    expect(refreshControl.mutationCount).toBe(0);
    expect(text).not.toContain("token");
    expect(text).not.toContain("refreshGrant");
  });

  it("rejects a refresh grant field one character above the canonical maximum before authority", async () => {
    const imported = await importVnu(app);
    const response = await requestVnuRefresh(app, imported.token, "X".repeat(VNU_REFRESH_GRANT_MAX_LENGTH + 1));
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(refreshControl.beginAttempts).toEqual([]);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
  });

  it("maps authenticated descriptorless legacy refresh to grant-invalid without authority or login", async () => {
    const token = await encryptSession(normalizedVnuSession(), SESSION_SECRET);
    const loginCount = adapterMocks.importSession.mock.calls.length;
    const response = await requestVnuRefresh(app, token, "not-a-grant");
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_REFRESH_GRANT_INVALID" } });
    expect(refreshControl.beginAttempts).toEqual([]);
    expect(refreshControl.exactRevocationAttempts).toEqual([]);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(loginCount);
  });

  it("logs out an authenticated expired descriptorless legacy token idempotently", async () => {
    const expired = normalizedVnuSession(new Date(syntheticTime - 1).toISOString());
    const token = await encryptSession(expired, SESSION_SECRET);
    const first = await requestVnuLogout(app, token);
    const second = await requestVnuLogout(app, token);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    expect(second.headers.get("Cache-Control")).toBe("no-store");
    expect(refreshControl.revocationAttempts).toEqual([]);
    expect(cache.revocationUrls()).toHaveLength(0);
  });

  it("rejects invalid outward access artifacts before grant, authority, or upstream stages", async () => {
    const imported = await importVnu(app);
    const payload = await decryptSession(imported.token, SESSION_SECRET);
    const wrongPurpose = await encryptRawLegacySessionFixture({
      ...payload,
      vnuRefresh: { ...payload.vnuRefresh!, purpose: "other-purpose" },
    });
    const tampered = `${imported.token.slice(0, -1)}${imported.token.endsWith("A") ? "B" : "A"}`;
    const loginCount = adapterMocks.importSession.mock.calls.length;
    for (const token of ["malformed", tampered, imported.refreshGrant, wrongPurpose]) {
      const response = await requestVnuRefresh(app, token, imported.refreshGrant);
      expect(response.status).toBe(401);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      await expect(response.json()).resolves.toMatchObject({ error: { code: "INVALID_SESSION" } });
    }
    expect(refreshControl.beginAttempts).toEqual([]);
    expect(refreshControl.exactRevocationAttempts).toEqual([]);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(loginCount);
  });

  it("never sends a malformed descriptor-bearing logout token through legacy fallback", async () => {
    const imported = await importVnu(app);
    const payload = await decryptSession(imported.token, SESSION_SECRET);
    const malformedDescriptor = await encryptRawLegacySessionFixture({
      ...payload,
      vnuRefresh: { ...payload.vnuRefresh!, grantId: "NOT_CANONICAL" },
    });
    const response = await requestVnuLogout(app, malformedDescriptor);
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "INVALID_SESSION" } });
    expect(refreshControl.revocationAttempts).toEqual([]);
    expect(cache.revocationUrls()).toEqual([]);
  });

  it("refresh rotates both artifacts once and preserves the original grant lifetime", async () => {
    const imported = await importVnu(app);
    const before = await decryptVnuRefreshGrant(imported.refreshGrant, SESSION_SECRET, syntheticTime);
    const rotatedSession = { ...vnuSession(), vnu: { kind: "cookie" as const, value: "SYNTHETIC_ROTATED_COOKIE", expiresAt: vnuSession().expiresAt } };
    adapterMocks.importSession.mockResolvedValueOnce(importedVnu(rotatedSession));

    const response = await requestVnuRefresh(app, imported.token, imported.refreshGrant);
    const body = await response.json() as { data: CoordinatorVnuImportResponse; error: null };
    const after = await decryptVnuRefreshGrant(body.data.refreshGrant, SESSION_SECRET, syntheticTime);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body.data.token).not.toBe(imported.token);
    expect(body.data.refreshGrant).not.toBe(imported.refreshGrant);
    expect(after).toMatchObject({ issuedAt: before.issuedAt, expiresAt: before.expiresAt, username: before.username, password: before.password });
    expect(after.grantId).not.toBe(before.grantId);
    expect(refreshControl.beginAttempts).toHaveLength(1);
    expect(refreshControl.completionAttempts).toHaveLength(1);
    expect(refreshControl.abortAttempts).toEqual([]);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(2);
  });

  it("accepts expired outward access only on refresh while ordinary access remains expired", async () => {
    const expiresAt = new Date(syntheticTime - 1).toISOString();
    adapterMocks.importSession.mockResolvedValueOnce(importedVnu(vnuSession(expiresAt)));
    const imported = await importVnu(app);
    expect((await getVnuRawPage(app, imported.token)).status).toBe(401);
    adapterMocks.importSession.mockResolvedValueOnce(importedVnu());
    expect((await requestVnuRefresh(app, imported.token, imported.refreshGrant)).status).toBe(200);
  });

  it("treats expired upstream cookie metadata independently from outward access expiry", async () => {
    const session = normalizedVnuSession();
    session.vnu = { ...session.vnu!, expiresAt: new Date(syntheticTime - 1).toISOString() };
    adapterMocks.importSession.mockResolvedValueOnce(importedVnu(session));
    const imported = await importVnu(app);
    adapterMocks.importSession.mockResolvedValueOnce(importedVnu());
    const response = await requestVnuRefresh(app, imported.token, imported.refreshGrant);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(2);
    expect(cache.revocationUrls()).toEqual([]);
  });

  it("rejects malformed, expired, and wrong-purpose grants before authority or upstream login", async () => {
    const imported = await importVnu(app);
    const loginCount = adapterMocks.importSession.mock.calls.length;
    const expired = createVnuRefreshGrant({ username: "SYNTHETIC_VNU_USER", password: "SYNTHETIC_PASSWORD", expectedStudentCode: VNU_STUDENT_CODE, now: syntheticTime - 8 * 60 * 60 * 1000 - 1 });
    const expiredToken = await encryptVnuRefreshGrant(expired, SESSION_SECRET);
    for (const grant of ["not-a-grant", expiredToken, imported.token]) {
      const response = await requestVnuRefresh(app, imported.token, grant);
      expect(response.status).toBe(401);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_REFRESH_GRANT_INVALID" } });
    }
    expect(refreshControl.beginAttempts).toEqual([]);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(loginCount);
  });

  it("rejects principal and grant linkage mismatches without authority mutation or upstream login", async () => {
    const imported = await importVnu(app);
    const grant = await decryptVnuRefreshGrant(imported.refreshGrant, SESSION_SECRET, syntheticTime);
    const wrongPrincipal = await encryptVnuRefreshGrant({ ...grant, username: "other_synthetic_user" }, SESSION_SECRET);
    const otherGrant = createVnuRefreshGrant({ username: grant.username, password: grant.password, expectedStudentCode: grant.expectedStudentCode, now: syntheticTime });
    const wrongLink = await encryptVnuRefreshGrant({ ...grant, grantId: otherGrant.grantId }, SESSION_SECRET);
    const loginCount = adapterMocks.importSession.mock.calls.length;
    for (const mismatched of [wrongPrincipal, wrongLink]) {
      const response = await requestVnuRefresh(app, imported.token, mismatched);
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_REFRESH_IDENTITY_MISMATCH" } });
    }
    expect(refreshControl.beginAttempts).toEqual([]);
    expect(refreshControl.exactRevocationAttempts).toEqual([]);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(loginCount);
  });

  it("revokes only the linked pair when signed access identity mismatches the grant before lease", async () => {
    const imported = await importVnu(app);
    const payload = await decryptSession(imported.token, SESSION_SECRET);
    const mismatchedToken = await encryptSession({ ...payload, studentCode: "OTHER_SYNTHETIC_STUDENT" }, SESSION_SECRET);
    const response = await requestVnuRefresh(app, mismatchedToken, imported.refreshGrant);
    expect(response.status).toBe(409);
    expect(refreshControl.exactRevocationAttempts).toEqual([{ principalKey: payload.vnuRefresh!.principalKey, pair: descriptorPairFixture(payload) }]);
    expect(refreshControl.beginAttempts).toEqual([]);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ kind: "revoked" } as BeginRefreshResult, 401, "VNU_REFRESH_GRANT_REVOKED", undefined],
    [{ kind: "in-progress", retryAfterSeconds: 7 } as BeginRefreshResult, 503, "VNU_REFRESH_UNAVAILABLE", { retryAfterSeconds: 7 }],
    [{ kind: "rate-limited", retryAfterSeconds: 8, limit: 5, windowSeconds: 900 } as BeginRefreshResult, 429, "VNU_REFRESH_RATE_LIMITED", { retryAfterSeconds: 8, limit: 5, windowSeconds: 900 }],
  ])("maps begin result $result.kind without upstream login", async (result, status, code, details) => {
    const imported = await importVnu(app);
    refreshControl.beginResult = result;
    const response = await requestVnuRefresh(app, imported.token, imported.refreshGrant);
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ error: { code, ...(details ? { details } : {}) } });
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["INVALID_VNU_CREDENTIAL", 401, true],
    ["VNU_REFRESH_IDENTITY_MISMATCH", 409, true],
    ["VNU_RATE_LIMITED", 429, false],
    ["VNU_UPSTREAM_UNAVAILABLE", 502, false],
    ["VNU_REQUEST_FAILED", 502, false],
  ])("aborts leased refresh with terminal=%s for %s", async (code, status, terminal) => {
    const imported = await importVnu(app);
    adapterMocks.importSession.mockRejectedValueOnce(new HyeboardError(code, "PRIVATE_UPSTREAM_PROSE_SENTINEL", status));
    const response = await requestVnuRefresh(app, imported.token, imported.refreshGrant);
    const responseText = await response.clone().text();
    expect(response.status).toBe(status);
    expect(responseText).not.toContain("PRIVATE_UPSTREAM_PROSE_SENTINEL");
    expect(refreshControl.abortAttempts).toHaveLength(1);
    expect(refreshControl.abortAttempts[0].terminal).toBe(terminal);
  });

  it.each([
    ["network", () => new Error("PRIVATE_NETWORK_PROSE_SENTINEL")],
    ["adapter cancellation", () => new DOMException("PRIVATE_ABORT_PROSE_SENTINEL", "AbortError")],
  ])("retryably aborts and sanitizes a raw %s refresh transport failure before same-artifact retry", async (_label, makeFailure) => {
    const imported = await importVnu(app);
    const payload = await decryptSession(imported.token, SESSION_SECRET);
    const principalKey = payload.vnuRefresh!.principalKey;
    const oldPair = descriptorPairFixture(payload);
    const lines: string[] = [];
    configureLogger({ level: "warn", mode: "node", destination: { write: (line) => lines.push(line) } });
    adapterMocks.importSession.mockRejectedValueOnce(makeFailure());

    const failed = await requestVnuRefresh(app, imported.token, imported.refreshGrant);
    const failedText = await failed.text();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(failed.status).toBe(502);
    expect(failed.headers.get("Cache-Control")).toBe("no-store");
    expect(JSON.parse(failedText)).toEqual({ data: null, error: { code: "VNU_REQUEST_FAILED", message: "The VNU reconnect request failed. Try again." } });
    for (const privateValue of ["PRIVATE_NETWORK_PROSE_SENTINEL", "PRIVATE_ABORT_PROSE_SENTINEL"]) {
      expect(failedText).not.toContain(privateValue);
      expect(lines.join("\n")).not.toContain(privateValue);
    }
    expect(lines).toHaveLength(1);
    const { level: _level, time: _time, pid: _pid, hostname: _hostname, ...stableLog } = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(stableLog).toEqual({ operation: "route", code: "VNU_REQUEST_FAILED", status: 502, msg: "VNU request failed" });
    expect(refreshControl.abortAttempts).toEqual([{ principalKey, pair: oldPair, terminal: false }]);
    expect(refreshControl.activePairs.get(principalKey)).toEqual(oldPair);
    expect(refreshControl.leasedPrincipals.has(principalKey)).toBe(false);
    expect(refreshControl.completionAttempts).toEqual([]);
    expect(cache.revocationUrls()).toEqual([]);

    adapterMocks.importSession.mockResolvedValueOnce(importedVnu());
    const retry = await requestVnuRefresh(app, imported.token, imported.refreshGrant);
    expect(retry.status).toBe(200);
    expect(retry.headers.get("Cache-Control")).toBe("no-store");
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(3);
    expect(refreshControl.beginAttempts).toHaveLength(2);
    expect(refreshControl.abortAttempts).toHaveLength(1);
    expect(refreshControl.completionAttempts).toHaveLength(1);
  });

  it("terminally aborts the exact leased pair when live login returns another student", async () => {
    const imported = await importVnu(app);
    adapterMocks.importSession.mockResolvedValueOnce({
      ...importedVnu(),
      studentCode: "OTHER_SYNTHETIC_STUDENT",
    });
    const response = await requestVnuRefresh(app, imported.token, imported.refreshGrant);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_REFRESH_IDENTITY_MISMATCH" } });
    expect(refreshControl.abortAttempts).toHaveLength(1);
    expect(refreshControl.abortAttempts[0]).toMatchObject({ pair: refreshControl.beginAttempts[0].pair, terminal: true });
  });

  it("allows only one upstream login for concurrent refresh requests", async () => {
    const imported = await importVnu(app);
    const gate = enteredOperation<ReturnType<typeof importedVnu>>();
    adapterMocks.importSession.mockImplementationOnce(async () => {
      gate.markEntered();
      return gate.result;
    });
    const first = requestVnuRefresh(app, imported.token, imported.refreshGrant);
    await gate.entered;
    const second = await requestVnuRefresh(app, imported.token, imported.refreshGrant);
    expect(second.status).toBe(503);
    await expect(second.json()).resolves.toMatchObject({ error: { code: "VNU_REFRESH_UNAVAILABLE", details: { retryAfterSeconds: 120 } } });
    gate.release(importedVnu());
    expect((await first).status).toBe(200);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(2);
  });

  it("logout first defeats a late refresh completion", async () => {
    const imported = await importVnu(app);
    const gate = enteredOperation<ReturnType<typeof importedVnu>>();
    adapterMocks.importSession.mockImplementationOnce(async () => {
      gate.markEntered();
      return gate.result;
    });
    const refreshing = requestVnuRefresh(app, imported.token, imported.refreshGrant);
    await gate.entered;
    const logout = await requestVnuLogout(app, imported.token, imported.refreshGrant);
    gate.release(importedVnu());
    const late = await refreshing;
    expect(logout.status).toBe(200);
    expect(logout.headers.get("Cache-Control")).toBe("no-store");
    expect(late.status).toBe(401);
    expect(late.headers.get("Cache-Control")).toBe("no-store");
    expect(refreshControl.completionAttempts).toHaveLength(1);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(2);
  });

  it("revokes a completed refresh when entered old-descriptor logout carries its linked grant", async () => {
    const imported = await importVnu(app);
    const oldPayload = await decryptSession(imported.token, SESSION_SECRET);
    const principalKey = oldPayload.vnuRefresh!.principalKey;
    const oldPair = descriptorPairFixture(oldPayload);
    const gate = enteredOperation<void>();
    const authority = productionRefreshAuthorityHarness(activeAuthorityState(oldPair), principalKey, { markEntered: gate.markEntered, release: gate.result });
    setVnuRefreshControlCoordinator(authority.coordinator);
    const oldLogoutPromise = requestVnuLogout(app, imported.token, imported.refreshGrant);
    await gate.entered;

    adapterMocks.importSession.mockResolvedValueOnce(importedVnu());
    const refreshed = await requestVnuRefresh(app, imported.token, imported.refreshGrant);
    const refreshedBody = await refreshed.json() as { data: CoordinatorVnuImportResponse; error: null };
    const nextPayload = await decryptSession(refreshedBody.data.token, SESSION_SECRET);
    const nextPair = descriptorPairFixture(nextPayload);
    expect(refreshed.status).toBe(200);
    expect(refreshed.headers.get("Cache-Control")).toBe("no-store");
    expect((authority.storage.stored as VnuRefreshControlState).active).toEqual(nextPair);
    expect(authority.calls).toEqual({ begin: 1, complete: 1, abort: 0, revokeLinked: 1 });
    authority.storage.resetCounts();

    gate.release();
    const oldLogout = await oldLogoutPromise;
    expect(oldLogout.status).toBe(200);
    expect(oldLogout.headers.get("Cache-Control")).toBe("no-store");
    expect(authority.storage.transactionCount).toBe(1);
    expect(authority.storage.putCount).toBe(1);
    expect(authority.storage.deleteCount).toBe(0);
    expect(authority.storage.alarmUpdateCount).toBe(1);
    expect((authority.storage.stored as VnuRefreshControlState).active).toBeUndefined();
    expect(cache.revocationUrls()).toEqual([]);
    expect(authority.calls).toEqual({ begin: 1, complete: 1, abort: 0, revokeLinked: 1 });
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(2);

    gradesSpy = vi.spyOn(DaotaoClient.prototype, "getGradesHtml").mockResolvedValue("<html>UPSTREAM_SHOULD_NOT_RUN</html>");
    expect((await getVnuRawPage(app, refreshedBody.data.token)).status).toBe(401);
    expect(gradesSpy).not.toHaveBeenCalled();

    authority.storage.resetCounts();
    const newLogout = await requestVnuLogout(app, refreshedBody.data.token, refreshedBody.data.refreshGrant);
    expect(newLogout.status).toBe(200);
    expect(newLogout.headers.get("Cache-Control")).toBe("no-store");
    expect((authority.storage.stored as VnuRefreshControlState).active).toBeUndefined();
    expect(authority.storage.transactionCount).toBe(1);
    expect(authority.storage.putCount).toBe(0);
    expect(authority.storage.alarmUpdateCount).toBe(0);
    expect(authority.calls).toEqual({ begin: 1, complete: 1, abort: 0, revokeLinked: 2 });
    expect(cache.revocationUrls()).toEqual([]);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(2);
  });

  it("keeps a manual relogin authoritative when delayed old linked logout resumes", async () => {
    const oldLogin = await importVnu(app);
    const oldPayload = await decryptSession(oldLogin.token, SESSION_SECRET);
    const principalKey = oldPayload.vnuRefresh!.principalKey;
    const gate = enteredOperation<void>();
    const authority = productionRefreshAuthorityHarness(activeAuthorityState(descriptorPairFixture(oldPayload)), principalKey, {
      markEntered: gate.markEntered,
      release: gate.result,
    });
    setVnuRefreshControlCoordinator(authority.coordinator);
    const delayedLogout = requestVnuLogout(app, oldLogin.token, oldLogin.refreshGrant);
    await gate.entered;

    const newLogin = await importVnu(app);
    const newPayload = await decryptSession(newLogin.token, SESSION_SECRET);
    const newPair = descriptorPairFixture(newPayload);
    expect((authority.storage.stored as VnuRefreshControlState).active).toEqual(newPair);
    authority.storage.resetCounts();

    gate.release();
    const oldLogout = await delayedLogout;
    expect(oldLogout.status).toBe(401);
    expect(oldLogout.headers.get("Cache-Control")).toBe("no-store");
    await expect(oldLogout.json()).resolves.toMatchObject({ error: { code: "VNU_REFRESH_GRANT_REVOKED" } });
    expect(authority.storage.putCount).toBe(0);
    expect(authority.storage.alarmUpdateCount).toBe(0);
    expect((authority.storage.stored as VnuRefreshControlState).active).toEqual(newPair);

    expect((await getVnuSession(app, newLogin.token)).status).toBe(200);
    await expect(authority.coordinator.checkAccess(principalKey, newPair)).resolves.toEqual({ kind: "active" });
  });

  it("keeps committed rotation authoritative when completion delivery fails", async () => {
    const imported = await importVnu(app);
    const oldPayload = await decryptSession(imported.token, SESSION_SECRET);
    const principalKey = oldPayload.vnuRefresh!.principalKey;
    const unusedRevokeGate = enteredOperation<void>();
    unusedRevokeGate.release();
    const authority = productionRefreshAuthorityHarness(
      activeAuthorityState(descriptorPairFixture(oldPayload)),
      principalKey,
      { markEntered: unusedRevokeGate.markEntered, release: unusedRevokeGate.result },
      { throwAfterComplete: true },
    );
    setVnuRefreshControlCoordinator(authority.coordinator);
    adapterMocks.importSession.mockResolvedValueOnce(importedVnu());
    const lost = await requestVnuRefresh(app, imported.token, imported.refreshGrant);
    const lostText = await lost.text();
    const state = authority.storage.stored as VnuRefreshControlState;
    expect(lost.status).toBe(503);
    expect(lost.headers.get("Cache-Control")).toBe("no-store");
    expect(JSON.parse(lostText)).toMatchObject({ error: { code: "VNU_REFRESH_UNAVAILABLE" } });
    expect(lostText).not.toContain("SYNTHETIC_COMPLETION_DELIVERY_LOSS");
    expect(state.active).toBeDefined();
    expect(state.revokedAccess[oldPayload.vnuRefresh!.accessTokenId]).toBe(Date.parse(oldPayload.vnuRefresh!.accessExpiresAt));
    expect(state.revokedGrants[oldPayload.vnuRefresh!.grantId]).toEqual({
      accessTokenId: oldPayload.vnuRefresh!.accessTokenId,
      accessExpiresAt: Date.parse(oldPayload.vnuRefresh!.accessExpiresAt),
      grantExpiresAt: Date.parse(oldPayload.vnuRefresh!.grantExpiresAt),
      refreshSuccessor: state.active,
    });
    expect(authority.calls).toEqual({ begin: 1, complete: 1, abort: 1, revokeLinked: 0 });
    await expect(authority.coordinator.checkAccess(principalKey, state.active!)).resolves.toEqual({ kind: "active" });

    const logout = await requestVnuLogout(app, imported.token, imported.refreshGrant);
    expect(logout.status).toBe(200);
    expect((authority.storage.stored as VnuRefreshControlState).active).toBeUndefined();
    expect(await authority.coordinator.checkAccess(principalKey, state.active!)).toEqual({ kind: "revoked" });
    expect((await requestVnuLogout(app, imported.token, imported.refreshGrant)).status).toBe(200);
    expect(cache.revocationUrls()).toEqual([]);
  });

  it("settles an in-flight committed completion before late request cancellation", async () => {
    const imported = await importVnu(app);
    const oldPayload = await decryptSession(imported.token, SESSION_SECRET);
    const principalKey = oldPayload.vnuRefresh!.principalKey;
    const unusedRevokeGate = enteredOperation<void>();
    unusedRevokeGate.release();
    const completionGate = enteredOperation<void>();
    const authority = productionRefreshAuthorityHarness(
      activeAuthorityState(descriptorPairFixture(oldPayload)),
      principalKey,
      { markEntered: unusedRevokeGate.markEntered, release: unusedRevokeGate.result },
      { completeGate: { markEntered: completionGate.markEntered, release: completionGate.result } },
    );
    setVnuRefreshControlCoordinator(authority.coordinator);
    const controller = new AbortController();
    let refreshRequest!: Request;
    adapterMocks.importSession.mockImplementationOnce(async (input) => {
      expect(input.signal).toBe(refreshRequest.signal);
      return importedVnu();
    });
    refreshRequest = new Request("http://localhost/api/vnu/auth/refresh", {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${imported.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ refreshGrant: imported.refreshGrant }),
    });
    const refreshing = app.handle(refreshRequest);
    await completionGate.entered;
    controller.abort(new DOMException("SYNTHETIC_LATE_ABORT", "AbortError"));
    completionGate.release();
    const response = await refreshing;
    const body = await response.json() as { data: CoordinatorVnuImportResponse; error: null };
    expect(response.status).toBe(200);
    expect(authority.calls).toEqual({ begin: 1, complete: 1, abort: 0, revokeLinked: 0 });
    expect((authority.storage.stored as VnuRefreshControlState).active).toEqual(descriptorPairFixture(await decryptSession(body.data.token, SESSION_SECRET)));
    expect((await getVnuSession(app, body.data.token)).status).toBe(200);
    expect(cache.revocationUrls()).toEqual([]);
  });

  it("does not abort after complete authoritatively rejects a logged-out pair", async () => {
    const imported = await importVnu(app);
    const gate = enteredOperation<ReturnType<typeof importedVnu>>();
    adapterMocks.importSession.mockImplementationOnce(async () => {
      gate.markEntered();
      return gate.result;
    });
    const refreshing = requestVnuRefresh(app, imported.token, imported.refreshGrant);
    await gate.entered;
    expect((await requestVnuLogout(app, imported.token)).status).toBe(200);
    refreshControl.failureMode = "outage";
    refreshControl.failureOperation = "abort";
    gate.release(importedVnu());
    const response = await refreshing;
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_REFRESH_GRANT_REVOKED" } });
    expect(refreshControl.completionAttempts).toHaveLength(1);
    expect(refreshControl.abortAttempts).toEqual([]);
    expect(cache.revocationUrls()).toEqual([]);
  });

  it("cancellation before completion aborts retryably and leaves the grant usable", async () => {
    const imported = await importVnu(app);
    const oldPayload = await decryptSession(imported.token, SESSION_SECRET);
    const gate = enteredOperation<ReturnType<typeof importedVnu>>();
    let refreshRequest!: Request;
    adapterMocks.importSession.mockImplementationOnce(async (input) => {
      expect(input.signal).toBe(refreshRequest.signal);
      gate.markEntered();
      return gate.result;
    });
    const abort = new AbortController();
    refreshRequest = new Request("http://localhost/api/vnu/auth/refresh", {
      method: "POST",
      signal: abort.signal,
      headers: { Authorization: `Bearer ${imported.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ refreshGrant: imported.refreshGrant }),
    });
    const refreshing = app.handle(refreshRequest);
    await gate.entered;
    abort.abort();
    gate.release(importedVnu());
    const cancelled = await refreshing;
    expect(cancelled.status).toBe(503);
    await expect(cancelled.json()).resolves.toMatchObject({ data: null, error: { code: "VNU_REFRESH_UNAVAILABLE" } });
    expect(refreshControl.abortAttempts.at(-1)?.terminal).toBe(false);
    expect(refreshControl.completionAttempts).toEqual([]);
    expect(refreshControl.activePairs.get(oldPayload.vnuRefresh!.principalKey)).toEqual(descriptorPairFixture(oldPayload));
    adapterMocks.importSession.mockResolvedValueOnce(importedVnu());
    expect((await requestVnuRefresh(app, imported.token, imported.refreshGrant)).status).toBe(200);
  });

  it("fails closed with sanitized no-store responses when refresh or logout authority is unavailable", async () => {
    const imported = await importVnu(app);
    refreshControl.failureMode = "outage";
    for (const response of [
      await requestVnuRefresh(app, imported.token, imported.refreshGrant),
      await requestVnuLogout(app, imported.token),
    ]) {
      const text = await response.text();
      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(JSON.parse(text)).toMatchObject({ error: { code: "VNU_REFRESH_UNAVAILABLE" } });
      expect(text).not.toContain("SYNTHETIC_OUTAGE_SENTINEL");
    }
  });

  it.each(["begin", "complete"] as const)("fails closed for a separate %s coordinator outage", async (operation) => {
    const imported = await importVnu(app);
    const begin = vi.spyOn(refreshControl, "beginRefresh");
    const complete = vi.spyOn(refreshControl, "completeRefresh");
    const abort = vi.spyOn(refreshControl, "abortRefresh");
    refreshControl.failureMode = "outage";
    refreshControl.failureOperation = operation;
    const response = await requestVnuRefresh(app, imported.token, imported.refreshGrant);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_REFRESH_UNAVAILABLE" } });
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(operation === "begin" ? 1 : 2);
    expect(refreshControl.beginAttempts).toHaveLength(operation === "begin" ? 0 : 1);
    expect(refreshControl.completionAttempts).toHaveLength(0);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(operation === "complete" ? 1 : 0);
    expect(abort).toHaveBeenCalledTimes(operation === "complete" ? 1 : 0);
    expect(cache.revocationUrls()).toEqual([]);
  });

  it("fails closed when exact pre-lease revocation is unavailable", async () => {
    const imported = await importVnu(app);
    const payload = await decryptSession(imported.token, SESSION_SECRET);
    const mismatched = await encryptSession({ ...payload, studentCode: "OTHER_SYNTHETIC_STUDENT" }, SESSION_SECRET);
    refreshControl.failureMode = "outage";
    refreshControl.failureOperation = "revoke-exact";
    const revokeExact = vi.spyOn(refreshControl, "revokeExactLinkedPair");
    const response = await requestVnuRefresh(app, mismatched, imported.refreshGrant);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(refreshControl.exactRevocationAttempts).toHaveLength(0);
    expect(revokeExact).toHaveBeenCalledTimes(1);
    expect(refreshControl.beginAttempts).toEqual([]);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
    expect(cache.revocationUrls()).toEqual([]);
  });

  it("fails closed when retryable abort is unavailable", async () => {
    const imported = await importVnu(app);
    refreshControl.failureMode = "outage";
    refreshControl.failureOperation = "abort";
    const abort = vi.spyOn(refreshControl, "abortRefresh");
    adapterMocks.importSession.mockRejectedValueOnce(new HyeboardError("VNU_UPSTREAM_UNAVAILABLE", "PRIVATE_ABORT_PROSE", 502));
    const response = await requestVnuRefresh(app, imported.token, imported.refreshGrant);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_REFRESH_UNAVAILABLE" } });
    expect(refreshControl.beginAttempts).toHaveLength(1);
    expect(refreshControl.abortAttempts).toHaveLength(0);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(cache.revocationUrls()).toEqual([]);
  });

  it("fails closed when linked logout revocation is unavailable", async () => {
    const imported = await importVnu(app);
    refreshControl.failureMode = "outage";
    refreshControl.failureOperation = "revoke-linked";
    const revoke = vi.spyOn(refreshControl, "revokeLinkedPairByAccess");
    const response = await requestVnuLogout(app, imported.token);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(refreshControl.revocationAttempts).toHaveLength(0);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(cache.revocationUrls()).toEqual([]);
  });

  it("fails closed for descriptor-bearing refresh and logout when self-hosted authority is absent", async () => {
    const imported = await importVnu(app);
    setVnuRefreshControlCoordinator(undefined);
    const loginCount = adapterMocks.importSession.mock.calls.length;
    for (const response of [
      await requestVnuRefresh(app, imported.token, imported.refreshGrant),
      await requestVnuLogout(app, imported.token),
    ]) {
      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_REFRESH_UNAVAILABLE" } });
    }
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(loginCount);
    expect(cache.revocationUrls()).toEqual([]);
  });

  it("allowlists route errors and logs only stable fields for unknown upstream failures", async () => {
    const imported = await importVnu(app);
    const lines: string[] = [];
    configureLogger({ level: "warn", mode: "node", destination: { write: (line) => lines.push(line) } });
    adapterMocks.importSession.mockRejectedValueOnce(new HyeboardError(
      "PRIVATE_UPSTREAM_CODE_SENTINEL",
      "PRIVATE_UPSTREAM_MESSAGE_SENTINEL",
      418,
      { reason: "PRIVATE_DETAIL_SENTINEL", privateId: "PRIVATE_ID_SENTINEL" },
    ));
    const response = await requestVnuRefresh(app, imported.token, imported.refreshGrant);
    const text = await response.text();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(response.status).toBe(502);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(JSON.parse(text)).toEqual({ data: null, error: { code: "VNU_REQUEST_FAILED", message: "The VNU reconnect request failed. Try again." } });
    for (const privateValue of ["PRIVATE_UPSTREAM_CODE_SENTINEL", "PRIVATE_UPSTREAM_MESSAGE_SENTINEL", "PRIVATE_DETAIL_SENTINEL", "PRIVATE_ID_SENTINEL"]) {
      expect(text).not.toContain(privateValue);
      expect(lines.join("\n")).not.toContain(privateValue);
    }
    for (const line of lines) {
      const { level: _level, time: _time, pid: _pid, hostname: _hostname, ...stable } = JSON.parse(line) as Record<string, unknown>;
      expect(Object.keys(stable).sort()).toEqual(["code", "msg", "operation", "status"]);
    }
  });

  it("validates optional logout grants before the sole authoritative mutation", async () => {
    const imported = await importVnu(app);
    const grant = await decryptVnuRefreshGrant(imported.refreshGrant, SESSION_SECRET, syntheticTime);
    const wrongPrincipal = await encryptVnuRefreshGrant({ ...grant, username: "other_synthetic_user" }, SESSION_SECRET);
    const wrongStudent = await encryptVnuRefreshGrant({ ...grant, expectedStudentCode: "OTHER_SYNTHETIC_STUDENT" }, SESSION_SECRET);
    const otherGrant = createVnuRefreshGrant({ username: grant.username, password: grant.password, expectedStudentCode: grant.expectedStudentCode, now: syntheticTime });
    const wrongId = await encryptVnuRefreshGrant({ ...grant, grantId: otherGrant.grantId }, SESSION_SECRET);
    const shiftedIssuedAt = new Date(Date.parse(grant.issuedAt) + 1_000).toISOString();
    const shiftedExpiresAt = new Date(Date.parse(grant.expiresAt) + 1_000).toISOString();
    const wrongExpiry = await encryptVnuRefreshGrant({ ...grant, issuedAt: shiftedIssuedAt, expiresAt: shiftedExpiresAt }, SESSION_SECRET);
    const malformed = await requestVnuLogout(app, imported.token, "not-a-grant");
    expect(malformed.status).toBe(401);
    for (const wrong of [wrongPrincipal, wrongStudent, wrongId, wrongExpiry]) {
      const mismatch = await requestVnuLogout(app, imported.token, wrong);
      expect(mismatch.status).toBe(409);
      expect(mismatch.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(refreshControl.revocationAttempts).toEqual([]);
    expect(refreshControl.exactRevocationAttempts).toEqual([]);
    expect(refreshControl.beginAttempts).toEqual([]);
    expect(refreshControl.abortAttempts).toEqual([]);
    expect(refreshControl.completionAttempts).toEqual([]);
    expect(cache.revocationUrls()).toEqual([]);

    const success = await requestVnuLogout(app, imported.token, imported.refreshGrant);
    expect(success.status).toBe(200);
    expect(success.headers.get("Cache-Control")).toBe("no-store");
    expect(refreshControl.revocationAttempts).toHaveLength(1);
    expect(refreshControl.exactRevocationAttempts).toEqual([]);
    expect(cache.revocationUrls()).toEqual([]);
  });

  it.each([
    ["expired", 409, "VNU_REFRESH_IDENTITY_MISMATCH", async (imported: CoordinatorVnuImportResponse) => {
      const grant = await decryptVnuRefreshGrant(imported.refreshGrant, SESSION_SECRET, syntheticTime);
      const expired = createVnuRefreshGrant({
        username: grant.username,
        password: grant.password,
        expectedStudentCode: grant.expectedStudentCode,
        now: syntheticTime - 8 * 60 * 60 * 1000 - 1,
      });
      return encryptVnuRefreshGrant(expired, SESSION_SECRET);
    }],
    ["wrong-purpose", 401, "VNU_REFRESH_GRANT_INVALID", async (imported: CoordinatorVnuImportResponse) => imported.token],
  ] as const)("rejects a production-backed %s optional logout grant before every authority operation and write", async (_label, expectedStatus, expectedCode, makeInvalidGrant) => {
    const imported = await importVnu(app);
    const payload = await decryptSession(imported.token, SESSION_SECRET);
    const principalKey = payload.vnuRefresh!.principalKey;
    const authority = productionAuthorityHarness(activeAuthorityState(descriptorPairFixture(payload)), { expectedPrincipal: principalKey });
    setVnuRefreshControlCoordinator(authority.coordinator);
    const coordinatorSpies = [
      vi.spyOn(authority.coordinator, "activatePair"),
      vi.spyOn(authority.coordinator, "checkAccess"),
      vi.spyOn(authority.coordinator, "beginRefresh"),
      vi.spyOn(authority.coordinator, "completeRefresh"),
      vi.spyOn(authority.coordinator, "abortRefresh"),
      vi.spyOn(authority.coordinator, "revokeLinkedPairByAccess"),
      vi.spyOn(authority.coordinator, "revokePrincipalByLinkedGrant"),
      vi.spyOn(authority.coordinator, "revokeExactLinkedPair"),
    ];

    const response = await requestVnuLogout(app, imported.token, await makeInvalidGrant(imported));
    expect(response.status).toBe(expectedStatus);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ error: { code: expectedCode } });
    for (const spy of coordinatorSpies) expect(spy).not.toHaveBeenCalled();
    expect(authority.objectNames).toEqual([]);
    expect(authority.storage.getCount).toBe(0);
    expect(authority.storage.transactionCount).toBe(0);
    expect(authority.storage.putCount).toBe(0);
    expect(authority.storage.deleteCount).toBe(0);
    expect(authority.storage.alarmUpdateCount).toBe(0);
    expect(cache.revocationUrls()).toEqual([]);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
  });

  it("logs out from an expired authenticated descriptor without a tab grant", async () => {
    const expiresAt = new Date(syntheticTime - 1).toISOString();
    adapterMocks.importSession.mockResolvedValueOnce(importedVnu(vnuSession(expiresAt)));
    const imported = await importVnu(app);
    const payload = await decryptSessionForVnuLogout(imported.token, SESSION_SECRET);
    const response = await requestVnuLogout(app, imported.token);
    expect(response.status).toBe(200);
    expect(refreshControl.revocationAttempts).toEqual([{ principalKey: payload.vnuRefresh!.principalKey, pair: descriptorPairFixture(payload) }]);
    expect(cache.revocationUrls()).toEqual([]);
  });

  it("accepts a fully expired descriptor after lazy authority cleanup without mutation", async () => {
    const shortSession = vnuSession(new Date(syntheticTime + 1_000).toISOString());
    adapterMocks.importSession.mockResolvedValueOnce(importedVnu(shortSession));
    const imported = await importVnu(app);
    const payload = await decryptSessionForVnuLogout(imported.token, SESSION_SECRET);
    const principalKey = payload.vnuRefresh!.principalKey;
    refreshControl.activePairs.delete(principalKey);
    const mutationCount = refreshControl.mutationCount;
    syntheticTime = Date.parse(payload.vnuRefresh!.grantExpiresAt) + 1;
    const response = await requestVnuLogout(app, imported.token);
    expect(response.status).toBe(200);
    expect(refreshControl.revocationAttempts).toHaveLength(1);
    expect(refreshControl.mutationCount).toBe(mutationCount);
  });

  it("accepts a correctly linked expired logout grant without authority mutation", async () => {
    const imported = await importVnu(app);
    const payload = await decryptSessionForVnuLogout(imported.token, SESSION_SECRET);
    const pair = descriptorPairFixture(payload);
    const principalKey = payload.vnuRefresh!.principalKey;
    const gate = enteredOperation<void>();
    gate.release();
    const authority = productionRefreshAuthorityHarness(activeAuthorityState(pair), principalKey, { markEntered: gate.markEntered, release: gate.result });
    setVnuRefreshControlCoordinator(authority.coordinator);
    syntheticTime = pair.grantExpiresAt;

    const response = await requestVnuLogout(app, imported.token, imported.refreshGrant);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(authority.storage.transactionCount).toBe(1);
    expect(authority.storage.putCount).toBe(0);
    expect(authority.storage.deleteCount).toBe(0);
    expect(authority.storage.alarmUpdateCount).toBe(0);
  });

  it("accepts an expired old linked grant after completed rotation without mutating next", async () => {
    const imported = await importVnu(app);
    const oldPayload = await decryptSessionForVnuLogout(imported.token, SESSION_SECRET);
    const oldPair = descriptorPairFixture(oldPayload);
    const principalKey = oldPayload.vnuRefresh!.principalKey;
    const gate = enteredOperation<void>();
    gate.release();
    const authority = productionRefreshAuthorityHarness(activeAuthorityState(oldPair), principalKey, { markEntered: gate.markEntered, release: gate.result });
    setVnuRefreshControlCoordinator(authority.coordinator);
    adapterMocks.importSession.mockResolvedValueOnce(importedVnu());
    const refreshed = await requestVnuRefresh(app, imported.token, imported.refreshGrant);
    expect(refreshed.status).toBe(200);
    const nextPair = (authority.storage.stored as VnuRefreshControlState).active!;
    syntheticTime = oldPair.grantExpiresAt;
    authority.storage.resetCounts();

    expect((await requestVnuLogout(app, imported.token, imported.refreshGrant)).status).toBe(200);
    expect((authority.storage.stored as VnuRefreshControlState).active).toEqual(nextPair);
    expect(authority.storage.putCount).toBe(0);
    expect(await authority.coordinator.checkAccess(principalKey, nextPair)).toEqual({ kind: "revoked" });
  });

  it("rejects a tampered expired logout grant before authority mutation", async () => {
    const imported = await importVnu(app);
    const payload = await decryptSessionForVnuLogout(imported.token, SESSION_SECRET);
    const pair = descriptorPairFixture(payload);
    const authority = productionAuthorityHarness(activeAuthorityState(pair), { expectedPrincipal: payload.vnuRefresh!.principalKey });
    setVnuRefreshControlCoordinator(authority.coordinator);
    syntheticTime = pair.grantExpiresAt;
    const tampered = `${imported.refreshGrant.slice(0, -1)}${imported.refreshGrant.endsWith("A") ? "B" : "A"}`;

    const response = await requestVnuLogout(app, imported.token, tampered);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_REFRESH_GRANT_INVALID" } });
    expect(authority.storage.transactionCount).toBe(0);
    expect(authority.storage.putCount).toBe(0);
    expect(authority.objectNames).toEqual([]);
  });

  it.each(["expired", "mismatch"] as const)("rejects live-half authority %s instead of claiming idempotent logout", async (authorityResult) => {
    const expiresAt = new Date(syntheticTime - 1).toISOString();
    adapterMocks.importSession.mockResolvedValueOnce(importedVnu(vnuSession(expiresAt)));
    const imported = await importVnu(app);
    refreshControl.revokeResult = authorityResult;
    const response = await requestVnuLogout(app, imported.token);
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_REFRESH_GRANT_REVOKED" } });
    expect(refreshControl.revocationAttempts).toHaveLength(1);
    expect(cache.revocationUrls()).toEqual([]);
  });

  it("uses submitted request-local credentials after a live verified cache hit", async () => {
    const first = await importVnu(app);
    const second = await importVnu(app);
    const secondGrant = await decryptVnuRefreshGrant(second.refreshGrant, SESSION_SECRET, syntheticTime);
    const firstAccess = await decryptSession(first.token, SESSION_SECRET);
    const secondAccess = await decryptSession(second.token, SESSION_SECRET);

    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
    expect(profileSpy).toHaveBeenCalledTimes(1);
    expect(secondGrant).toMatchObject({
      username: "synthetic_vnu_user",
      password: "SYNTHETIC_VNU_PASSWORD",
      expectedStudentCode: VNU_STUDENT_CODE,
    });
    expect(refreshControl.activations).toHaveLength(2);
    expect(refreshControl.activePairs.get(secondAccess.vnuRefresh!.principalKey)).toEqual(descriptorPairFixture(secondAccess));
    expect(refreshControl.revokedPairs.get(firstAccess.vnuRefresh!.principalKey)).toContainEqual(descriptorPairFixture(firstAccess));

    gradesSpy = vi.spyOn(DaotaoClient.prototype, "getGradesHtml").mockResolvedValue("<html>SYNTHETIC_ACTIVE_GRADES</html>");
    const oldResponse = await getVnuRawPage(app, first.token);
    const newResponse = await getVnuRawPage(app, second.token);
    expect(oldResponse.status).toBe(401);
    expect(newResponse.status).toBe(200);
    expect(gradesSpy).toHaveBeenCalledTimes(1);
  });

  it("returns no access or grant artifact when pair activation fails", async () => {
    const active = await importVnu(app);
    const activePayload = await decryptSession(active.token, SESSION_SECRET);
    const activePair = descriptorPairFixture(activePayload);
    const revokedBefore = structuredClone(refreshControl.revokedPairs.get(activePayload.vnuRefresh!.principalKey) ?? []);
    const mutationCountBefore = refreshControl.mutationCount;
    const importCacheCountBefore = cache.importUrls().length;
    refreshControl.failureMode = "outage";

    const response = await app.handle(new Request("http://localhost/api/vnu/auth/import-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vnuUsername: "SYNTHETIC_VNU_USER", vnuPassword: "PRIVATE_FRESH_OUTAGE_PASSWORD" }),
    }));
    const text = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(text)).toEqual({
      data: null,
      error: {
        code: "VNU_REFRESH_UNAVAILABLE",
        message: "VNU reconnect is temporarily unavailable. Try again.",
        details: { retryAfterSeconds: 5 },
      },
    });
    expect(refreshControl.activePairs.get(activePayload.vnuRefresh!.principalKey)).toEqual(activePair);
    expect(refreshControl.revokedPairs.get(activePayload.vnuRefresh!.principalKey) ?? []).toEqual(revokedBefore);
    expect(refreshControl.mutationCount).toBe(mutationCountBefore);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(2);
    expect(cache.importUrls()).toHaveLength(importCacheCountBefore);
    for (const privateValue of ["token", "refreshGrant", "session", "SYNTHETIC_VNU_COOKIE", "SYNTHETIC_VNU_USER", "SYNTHETIC_VNU_PASSWORD", "PRIVATE_FRESH_OUTAGE_PASSWORD"]) {
      expect(text).not.toContain(privateValue);
    }
  });

  it("authoritatively revokes the current descriptor pair before successful logout", async () => {
    const imported = await importVnu(app);
    const access = await decryptSession(imported.token, SESSION_SECRET);
    const principalKey = access.vnuRefresh!.principalKey;
    const pair = descriptorPairFixture(access);

    const logout = await app.handle(new Request("http://localhost/api/vnu/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${imported.token}`, "Content-Type": "application/json" },
      body: "{}",
    }));

    expect(logout.status).toBe(200);
    await expect(logout.json()).resolves.toEqual({ data: { authenticated: false }, error: null });
    expect(refreshControl.activePairs.has(principalKey)).toBe(false);
    expect(refreshControl.revokedPairs.get(principalKey)).toContainEqual(pair);
    expect(cache.revocationUrls()).toHaveLength(0);

    const repeatedLogout = await app.handle(new Request("http://localhost/api/vnu/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${imported.token}`, "Content-Type": "application/json" },
      body: "{}",
    }));
    expect(repeatedLogout.status).toBe(200);
    expect(refreshControl.revokedPairs.get(principalKey)).toEqual([pair]);

    gradesSpy = vi.spyOn(DaotaoClient.prototype, "getGradesHtml").mockResolvedValue("<html>UPSTREAM_SHOULD_NOT_RUN</html>");
    const rejected = await getVnuRawPage(app, imported.token);
    expect(rejected.status).toBe(401);
    await expect(rejected.json()).resolves.toEqual({ data: null, error: { code: "SESSION_EXPIRED", message: "Session expired" } });
    expect(gradesSpy).not.toHaveBeenCalled();
  });

  it("fails logout atomically when authoritative pair revocation is unavailable", async () => {
    const imported = await importVnu(app);
    const access = await decryptSession(imported.token, SESSION_SECRET);
    const principalKey = access.vnuRefresh!.principalKey;
    const pair = descriptorPairFixture(access);
    const mutationCountBefore = refreshControl.mutationCount;
    refreshControl.failureMode = "outage";

    const logout = await app.handle(new Request("http://localhost/api/vnu/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${imported.token}`, "Content-Type": "application/json" },
      body: "{}",
    }));

    expect(logout.status).toBe(503);
    await expect(logout.json()).resolves.toEqual({
      data: null,
      error: {
        code: "VNU_REFRESH_UNAVAILABLE",
        message: "VNU reconnect is temporarily unavailable. Try again.",
        details: { retryAfterSeconds: 5 },
      },
    });
    expect(refreshControl.activePairs.get(principalKey)).toEqual(pair);
    expect(refreshControl.revokedPairs.get(principalKey) ?? []).not.toContainEqual(pair);
    expect(refreshControl.mutationCount).toBe(mutationCountBefore);
    expect(cache.revocationUrls()).toEqual([]);
  });

  it("fails a descriptor-pair mismatch before writing legacy token revocation", async () => {
    const imported = await importVnu(app);
    const access = await decryptSession(imported.token, SESSION_SECRET);
    const principalKey = access.vnuRefresh!.principalKey;
    const pair = descriptorPairFixture(access);
    refreshControl.activePairs.set(principalKey, { ...pair, grantId: `${"Z".repeat(21)}A` });

    const logout = await app.handle(new Request("http://localhost/api/vnu/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${imported.token}`, "Content-Type": "application/json" },
      body: "{}",
    }));

    expect(logout.status).toBe(401);
    await expect(logout.json()).resolves.toEqual({ data: null, error: { code: "VNU_REFRESH_GRANT_REVOKED", message: "The VNU reconnect grant has been revoked." } });
    expect(cache.revocationUrls()).toEqual([]);

    refreshControl.activePairs.set(principalKey, pair);
    gradesSpy = vi.spyOn(DaotaoClient.prototype, "getGradesHtml").mockResolvedValue("<html>SYNTHETIC_ACTIVE_AFTER_MISMATCH</html>");
    const stillActive = await getVnuRawPage(app, imported.token);
    expect(stillActive.status).toBe(200);
    expect(gradesSpy).toHaveBeenCalledTimes(1);
  });

  it("preserves legacy descriptorless VNU logout revocation without coordinator access", async () => {
    const legacySession = normalizedVnuSession();
    const legacyToken = await encryptSession(legacySession, SESSION_SECRET);

    const logout = await app.handle(new Request("http://localhost/api/vnu/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${legacyToken}`, "Content-Type": "application/json" },
      body: "{}",
    }));

    expect(logout.status).toBe(200);
    await expect(logout.json()).resolves.toEqual({ data: { authenticated: false }, error: null });
    expect(cache.revocationUrls()).toHaveLength(1);
    expect(refreshControl.revocationAttempts).toEqual([]);
    expect(refreshControl.checks).toEqual([]);

    gradesSpy = vi.spyOn(DaotaoClient.prototype, "getGradesHtml").mockResolvedValue("<html>LEGACY_UPSTREAM_SHOULD_NOT_RUN</html>");
    const rejected = await getVnuRawPage(app, legacyToken);
    expect(rejected.status).toBe(401);
    await expect(rejected.json()).resolves.toEqual({ data: null, error: { code: "SESSION_EXPIRED", message: "Session expired" } });
    expect(gradesSpy).not.toHaveBeenCalled();
    expect(refreshControl.revocationAttempts).toEqual([]);
    expect(refreshControl.checks).toEqual([]);
  });

  it("preserves an access-only response when no coordinator is installed", async () => {
    setVnuRefreshControlCoordinator(undefined);

    const response = await requestVnuImport(app);
    const body = await response.json() as { data: AccessOnlyVnuImportResponse; error: null };

    expect(response.status).toBe(200);
    expect(Object.keys(body.data).sort()).toEqual(["session", "token"]);
    await expect(decryptSession(body.data.token, SESSION_SECRET)).resolves.toEqual(normalizedVnuSession());
  });

  it.each([
    ["missing internal student ID", `<select name="UnivID"><option value="77" selected>SYNTHETIC FACULTY</option></select>`],
    ["malformed internal university ID", `<input name="hidStdID" value="99000000001"><select name="UnivID"><option value="MALFORMED" selected>SYNTHETIC FACULTY</option></select>`],
  ])("returns profile incomplete for %s without exam upstream access", async (_label, profileHtml) => {
    const imported = await importVnu(app);
    profileSpy.mockResolvedValueOnce(profileHtml);
    const examSpy = vi.spyOn(DaotaoClient.prototype, "getExamsHtml");

    const response = await app.handle(new Request("http://localhost/api/vnu/raw/exams?vTermID=SYNTHETIC_TERM", {
      headers: { Authorization: `Bearer ${imported.token}` },
    }));
    const responseText = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(responseText)).toEqual({
      data: null,
      error: { code: "VNU_PROFILE_INCOMPLETE", message: "The university portal profile is incomplete." },
    });
    for (const privateValue of ["99000000001", "MALFORMED", "SYNTHETIC FACULTY", "77"]) expect(responseText).not.toContain(privateValue);
    expect(examSpy).not.toHaveBeenCalled();
    examSpy.mockRestore();
  });

  it("uses the transcript detail selector instead of the unequal profile identifier", async () => {
    const imported = await importVnu(app);
    profileSpy.mockResolvedValueOnce(`<input name="hidStdID" value="99999999999">`);
    gradesSpy = vi.spyOn(DaotaoClient.prototype, "getGradesHtml").mockResolvedValue(`<table>
      <tr><td>HỌC KỲ 1. MÃ HỌC KỲ 251</td></tr>
      <tr><td>1</td><td>INT1001</td><td>Synthetic Course</td><td>3</td><td>8</td><td>B</td><td>3</td><td><img onclick="detailPoint('123456','8','00000000001','42')"></td></tr>
    </table>`);
    const pointSpy = vi.spyOn(DaotaoClient.prototype, "getPointDetailHtml").mockResolvedValue("<table></table>");

    const response = await app.handle(new Request("http://localhost/api/vnu/raw/point-detail?id=123456&Term=42", {
      headers: { Authorization: `Bearer ${imported.token}` },
    }));

    expect(response.status).toBe(200);
    expect(profileSpy).not.toHaveBeenCalled();
    expect(pointSpy).toHaveBeenCalledWith({ id: "123456", stdId: "00000000001", term: "42" }, expect.any(AbortSignal));
    pointSpy.mockRestore();
  });

  it("derives own exam identity server-side and ignores browser overrides", async () => {
    const imported = await importVnu(app);
    profileSpy.mockResolvedValueOnce(`<input name="hidStdID" value="99000000001"><select name="UnivID"><option value="77" selected>SYNTHETIC FACULTY</option></select>`);
    const examSpy = vi.spyOn(DaotaoClient.prototype, "getExamsHtml").mockResolvedValue("<table></table>");

    const response = await app.handle(new Request("http://localhost/api/vnu/raw/exams?vTermID=42&selStd=ATTACKER&selUniv=666", {
      headers: { Authorization: `Bearer ${imported.token}` },
    }));

    expect(response.status).toBe(200);
    expect(examSpy).toHaveBeenCalledWith({ selUniv: "77", selStd: "99000000001", vTermID: "42" }, expect.any(AbortSignal));
    examSpy.mockRestore();
  });

  it("ignores browser point-detail selector overrides", async () => {
    const imported = await importVnu(app);
    gradesSpy = vi.spyOn(DaotaoClient.prototype, "getGradesHtml").mockResolvedValue(`<table>
      <tr><td>HỌC KỲ 1. MÃ HỌC KỲ 251</td></tr>
      <tr><td>1</td><td>INT1001</td><td>Synthetic Course</td><td>3</td><td>8</td><td>B</td><td>3</td><td><img onclick="detailPoint('123456','8','00000000001','42')"></td></tr>
    </table>`);
    const pointSpy = vi.spyOn(DaotaoClient.prototype, "getPointDetailHtml").mockResolvedValue("<table></table>");

    const response = await app.handle(new Request("http://localhost/api/vnu/raw/point-detail?id=123456&Term=42&selStd=ATTACKER&val=9.9", {
      headers: { Authorization: `Bearer ${imported.token}` },
    }));

    expect(response.status).toBe(200);
    expect(pointSpy).toHaveBeenCalledWith({ id: "123456", stdId: "00000000001", term: "42" }, expect.any(AbortSignal));
    pointSpy.mockRestore();
  });

  it("sanitizes the browser grades response while retaining the cached selector for point detail", async () => {
    const imported = await importVnu(app);
    const selector = "00000000001";
    gradesSpy = vi.spyOn(DaotaoClient.prototype, "getGradesHtml").mockResolvedValue(`<table>
      <tr><td>HỌC KỲ 1. MÃ HỌC KỲ 251</td></tr>
      <tr><td>1</td><td>INT1001</td><td>Synthetic Course</td><td>3</td><td>8</td><td>B</td><td>3</td><td><img onclick="detailPoint('123456','8','${selector}','42')"></td></tr>
    </table>`);
    const pointSpy = vi.spyOn(DaotaoClient.prototype, "getPointDetailHtml").mockResolvedValue("<table></table>");

    const gradesResponse = await getVnuRawPage(app, imported.token);
    const gradesBody = await gradesResponse.json() as { data: { html: string } };
    const detailResponse = await app.handle(new Request("http://localhost/api/vnu/raw/point-detail?id=123456&Term=42", {
      headers: { Authorization: `Bearer ${imported.token}` },
    }));

    expect(gradesResponse.status).toBe(200);
    expect(gradesBody.data.html).toContain("detailPoint('123456','8','','42')");
    expect(gradesBody.data.html).not.toContain(selector);
    expect(detailResponse.status).toBe(200);
    expect(gradesSpy).toHaveBeenCalledTimes(1);
    expect(pointSpy).toHaveBeenCalledWith({ id: "123456", stdId: selector, term: "42" }, expect.any(AbortSignal));
    pointSpy.mockRestore();
  });

  it.each([
    ["canonical", `detailPoint('123456','8','00000000001','42')`, `detailPoint('123456','8','','42')`, true],
    ["extra argument", `detailPoint('123456','8','00000000001','42','extra')`, `detailPoint('123456','8','','42','extra')`, false],
    ["malformed tail", `detailPoint('123456','8','00000000001','42', malformed)`, `detailPoint('123456','8','','42', malformed)`, false],
    ["unquoted selector position", `detailPoint('123456','8', malformed, '00000000001','42')`, "void 0", false],
  ])("redacts the selector from a %s grades handler", async (_case, handler, expectedBrowserHandler, isCanonical) => {
    const imported = await importVnu(app);
    const selector = "00000000001";
    gradesSpy = vi.spyOn(DaotaoClient.prototype, "getGradesHtml").mockResolvedValue(`<table>
      <tr><td>HỌC KỲ 1. MÃ HỌC KỲ 251</td></tr>
      <tr><td>1</td><td>INT1001</td><td>Synthetic Course</td><td>3</td><td>8</td><td>B</td><td>3</td><td><img onclick="${handler}"></td></tr>
    </table>`);

    const response = await getVnuRawPage(app, imported.token);
    const body = await response.json() as { data: { html: string } };

    expect(response.status).toBe(200);
    expect(body.data.html).not.toContain(selector);
    expect(body.data.html).toContain(expectedBrowserHandler);
    if (isCanonical) expect(parseGradesHtml(body.data.html).rows[0]).toMatchObject({ classId: "123456", termOrdinal: "42" });
  });

  it.each([
    ["missing", `<table></table>`],
    ["malformed", `<table><tr><td>HỌC KỲ 1. MÃ HỌC KỲ 251</td></tr><tr><td>1</td><td>INT1001</td><td>Synthetic Course</td><td>3</td><td>8</td><td>B</td><td>3</td><td><img onclick="detailPoint('123456','8','not-numeric','42')"></td></tr></table>`],
    ["ambiguous", `<table><tr><td>HỌC KỲ 1. MÃ HỌC KỲ 251</td></tr><tr><td>1</td><td>INT1001</td><td>Synthetic Course</td><td>3</td><td>8</td><td>B</td><td>3</td><td><img onclick="detailPoint('123456','8','00000000001','42')"></td></tr><tr><td>2</td><td>INT1002</td><td>Synthetic Course</td><td>3</td><td>8</td><td>B</td><td>3</td><td><img onclick="detailPoint('123456','8','00000000002','42')"></td></tr></table>`],
  ])("rejects %s point-detail selector without upstream access", async (_case, gradesHtml) => {
    const imported = await importVnu(app);
    gradesSpy = vi.spyOn(DaotaoClient.prototype, "getGradesHtml").mockResolvedValue(gradesHtml);
    const pointSpy = vi.spyOn(DaotaoClient.prototype, "getPointDetailHtml");

    const response = await app.handle(new Request("http://localhost/api/vnu/raw/point-detail?id=123456&Term=42", {
      headers: { Authorization: `Bearer ${imported.token}` },
    }));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      data: null,
      error: { code: "VNU_POINT_DETAIL_NOT_AVAILABLE", message: "Point detail is not available for this course." },
    });
    expect(pointSpy).not.toHaveBeenCalled();
    pointSpy.mockRestore();
  });

  it("reuses cached own grades across point-detail lookups", async () => {
    const imported = await importVnu(app);
    gradesSpy = vi.spyOn(DaotaoClient.prototype, "getGradesHtml").mockResolvedValue(`<table>
      <tr><td>HỌC KỲ 1. MÃ HỌC KỲ 251</td></tr>
      <tr><td>1</td><td>INT1001</td><td>Synthetic Course</td><td>3</td><td>8</td><td>B</td><td>3</td><td><img onclick="detailPoint('123456','8','00000000001','42')"></td></tr>
      <tr><td>2</td><td>INT1002</td><td>Synthetic Course</td><td>3</td><td>8</td><td>B</td><td>3</td><td><img onclick="detailPoint('654321','8','00000000001','42')"></td></tr>
    </table>`);
    const pointSpy = vi.spyOn(DaotaoClient.prototype, "getPointDetailHtml").mockResolvedValue("<table></table>");

    const first = await app.handle(new Request("http://localhost/api/vnu/raw/point-detail?id=123456&Term=42", { headers: { Authorization: `Bearer ${imported.token}` } }));
    const second = await app.handle(new Request("http://localhost/api/vnu/raw/point-detail?id=654321&Term=42", { headers: { Authorization: `Bearer ${imported.token}` } }));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(gradesSpy).toHaveBeenCalledTimes(1);
    expect(pointSpy).toHaveBeenCalledTimes(2);
    pointSpy.mockRestore();
  });

  it("returns the exact profile-incomplete envelope when verified import identity is missing", async () => {
    adapterMocks.importSession.mockResolvedValue({
      universityId: "vnu",
      studentCode: undefined,
      expiresAt: vnuSession().expiresAt,
      session: vnuSession(),
    });

    const response = await requestVnuImport(app);
    const responseText = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(responseText)).toEqual({
      data: null,
      error: { code: "VNU_PROFILE_INCOMPLETE", message: "The university portal profile is incomplete." },
    });
    for (const privateValue of [VNU_STUDENT_CODE, "SYNTHETIC_VNU_USER", "SYNTHETIC_VNU_PASSWORD", "SYNTHETIC_VNU_COOKIE"]) {
      expect(responseText).not.toContain(privateValue);
    }
  });

  it("expires cached responses at their deterministic max-age boundary", async () => {
    const request = new Request("https://hyeboard.internal/cache/synthetic-expiry");
    await cache.put(request, new Response("cached", {
      headers: { "Cache-Control": "public, max-age=1" },
    }));

    await expect(cache.match(request).then((response) => response?.text())).resolves.toBe("cached");
    syntheticTime += 1_000;
    await expect(cache.match(request)).resolves.toBeUndefined();
  });

  it("derives a positive import-cache TTL and expires it at the exact boundary", async () => {
    const expiresAt = new Date(syntheticTime + 2_500).toISOString();
    const session = vnuSession(expiresAt);
    adapterMocks.importSession.mockResolvedValue(importedVnu(session));

    const first = await importVnu(app);
    const cacheUrl = cache.importUrl();
    expect(cache.store.get(cacheUrl)?.response.headers.get("Cache-Control")).toBe("public, max-age=2");
    await expectIssuedVnuAccess(first.token, normalizedVnuSession(expiresAt));

    syntheticTime += 1_999;
    await importVnu(app);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);

    syntheticTime += 1;
    const boundaryLogin = await importVnu(app);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(2);
    expect(boundaryLogin.session.expiresAt).toBe(expiresAt);
  });

  it("skips the import cache when the derived TTL is non-positive", async () => {
    const expiresAt = new Date(syntheticTime + 999).toISOString();
    const session = vnuSession(expiresAt);
    adapterMocks.importSession.mockResolvedValue(importedVnu(session));

    const outward = await importVnu(app);

    expect(cache.store.size).toBe(0);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
    await expectIssuedVnuAccess(outward.token, normalizedVnuSession(expiresAt));
  });

  it("normalizes verified VNU identity before caching and reuses it on the next import", async () => {
    const imported = importedVnu();
    expect(imported.session.studentCode).toBeUndefined();
    adapterMocks.importSession.mockResolvedValue(imported);

    const first = await importVnu(app);
    const cached = await cache.importEntry();
    const firstSession = await decryptSession(first.token, SESSION_SECRET);

    expect(imported.session.studentCode).toBeUndefined();
    expect(firstSession.studentCode).toBe(VNU_STUDENT_CODE);
    expect(cached.session.studentCode).toBe(firstSession.studentCode);
    await expect(decryptSession(cached.seed, SESSION_SECRET)).resolves.toEqual(normalizedVnuSession());

    const second = await importVnu(app);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
    expect(second.session).toEqual(cached.session);
    const secondSession = await expectIssuedVnuAccess(second.token, normalizedVnuSession());
    expect(secondSession.vnuRefresh).not.toEqual(firstSession.vnuRefresh);
  });

  it("caches an opaque seed and returns a distinct valid token on a cache miss", async () => {
    const outward = await importVnu(app);
    const cached = await cache.importEntry();

    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
    expect(cached.seed).toBeTypeOf("string");
    expect(cached.seed).not.toBe(outward.token);
    expect(cached.session).toEqual(outward.session);
    await expect(decryptSession(cached.seed, SESSION_SECRET)).resolves.toEqual(normalizedVnuSession());
    await expectIssuedVnuAccess(outward.token, normalizedVnuSession());
    expect(Object.keys(cached).sort()).toEqual(["seed", "session"]);
  });

  it("validates a cache hit live and returns a fresh equivalent token without mutating the cache", async () => {
    const probeBudget = new TestVnuProbeBudget();
    setVnuProbeBudgetCoordinator(probeBudget);
    const first = await importVnu(app);
    const cached = await cache.importEntry();
    const cacheUrl = cache.importUrl();
    const storedBefore = cache.store.get(cacheUrl)!;
    const bytesBefore = await storedBefore.response.clone().text();
    const second = await importVnu(app);

    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
    expect(profileSpy).toHaveBeenCalledTimes(1);
    expect(second.token).not.toBe(first.token);
    expect(second.token).not.toBe(cached.seed);
    expect(second.session).toEqual(first.session);
    expect(second.session).toEqual(cached.session);
    const firstPayload = await decryptSession(first.token, SESSION_SECRET);
    const secondPayload = await decryptSession(second.token, SESSION_SECRET);
    expect(secondPayload).toMatchObject(normalizedVnuSession());
    expect(secondPayload.vnuRefresh).not.toEqual(firstPayload.vnuRefresh);
    expect(secondPayload.expiresAt).toBe("2099-01-01T00:00:00.000Z");
    expect(await cache.store.get(cacheUrl)!.response.clone().text()).toBe(bytesBefore);
    expect(cache.store.get(cacheUrl)!.expiresAt).toBe(storedBefore.expiresAt);
    expect(probeBudget.count).toBe(0);
  });

  it("repairs a definitively expired cached upstream session and reuses the replacement", async () => {
    const repairedSession: EncryptedSessionPayload = {
      ...vnuSession(),
      vnu: { kind: "cookie", value: "REPAIRED_SYNTHETIC_VNU_COOKIE", expiresAt: "2099-01-01T00:00:00.000Z" },
    };
    const first = await importVnu(app);
    const oldCached = await cache.importEntry();
    profileSpy
      .mockRejectedValueOnce(new HyeboardError("VNU_SESSION_EXPIRED", "Synthetic upstream session expired", 401))
      .mockResolvedValueOnce(vnuProfileHtml());
    adapterMocks.importSession.mockImplementationOnce(async () => {
      expect(await cache.importEntry()).toEqual(oldCached);
      return importedVnu(repairedSession);
    });

    const repaired = await importVnu(app);
    const replacement = await cache.importEntry();
    const cachedRelogin = await importVnu(app);

    expect(adapterMocks.importSession).toHaveBeenCalledTimes(2);
    expect(profileSpy).toHaveBeenCalledTimes(2);
    expect(replacement.seed).not.toBe(oldCached.seed);
    expect(repaired.token).not.toBe(replacement.seed);
    expect(cachedRelogin.token).not.toBe(replacement.seed);
    expect(cachedRelogin.token).not.toBe(repaired.token);
    await expectIssuedVnuAccess(first.token, normalizedVnuSession());
    const normalizedRepaired = { ...repairedSession, studentCode: VNU_STUDENT_CODE };
    await expectIssuedVnuAccess(repaired.token, normalizedRepaired);
    await expect(decryptSession(replacement.seed, SESSION_SECRET)).resolves.toEqual(normalizedRepaired);
    await expectIssuedVnuAccess(cachedRelogin.token, normalizedRepaired);
  });

  it("repairs a cache hit when the real profile client receives a standalone HTTP 200 expiry notice", async () => {
    const expiryNoticeSentinel = "CACHE_HIT_PROFILE_EXPIRY_SENTINEL";
    const expiryNotice = "Phiên làm việc đã kết thúc. Vui lòng đăng nhập lại hệ thống.";
    const expiryNoticeHtml = `<html><body><table data-synthetic-marker="${expiryNoticeSentinel}"><tr><td>${expiryNotice}</td></tr></table></body></html>`;
    const repairedSession: EncryptedSessionPayload = {
      ...vnuSession(),
      vnu: { kind: "cookie", value: "REPAIRED_HTTP_BOUNDARY_COOKIE", expiresAt: "2099-01-01T00:00:00.000Z" },
    };
    await importVnu(app);
    const oldCached = await cache.importEntry();
    profileSpy.mockRestore();
    const upstreamFetch = vi.fn(async () => new Response(expiryNoticeHtml, {
      status: 200,
      headers: { "Content-Type": "text/html" },
    }));
    vi.stubGlobal("fetch", upstreamFetch);
    adapterMocks.importSession.mockResolvedValueOnce(importedVnu(repairedSession));

    const response = await requestVnuImport(app);
    const responseText = await response.text();
    const payload = JSON.parse(responseText) as { data: CoordinatorVnuImportResponse; error: null };
    const replacement = await cache.importEntry();

    expect(response.status).toBe(200);
    expect(payload.error).toBeNull();
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    expect(upstreamFetch).toHaveBeenCalledWith(
      "https://daotao.vnu.edu.vn/StdInfo/TabStdSelf.asp",
      expect.objectContaining({ headers: expect.objectContaining({ Cookie: "SYNTHETIC_VNU_COOKIE" }) }),
    );
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(2);
    expect(replacement.seed).not.toBe(oldCached.seed);
    const normalizedRepaired = { ...repairedSession, studentCode: VNU_STUDENT_CODE };
    await expectIssuedVnuAccess(payload.data.token, normalizedRepaired);
    await expect(decryptSession(replacement.seed, SESSION_SECRET)).resolves.toEqual(normalizedRepaired);
    expect(replacement.session).toEqual(payload.data.session);
    expect(responseText).not.toContain(expiryNoticeSentinel);
    expect(responseText).not.toContain(expiryNotice);
  });

  it("returns VNU_SESSION_EXPIRED instead of caching or exposing a raw grades paragraph HTTP expiry response", async () => {
    const expiryNotice = "Phiên làm việc đã kết thúc. Vui lòng đăng nhập lại hệ thống.";
    const expiryNoticeHtml = `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Phiên làm việc đã kết thúc.<br />Vui lòng đăng nhập lại hệ thống.<br /><a href="http://daotao.vnu.edu.vn/dkmh/login.asp">Sign in</a><br /></p></body></html>`;
    const upstreamFetch = vi.fn(async () => new Response(expiryNoticeHtml, { status: 200, headers: { "Content-Type": "text/html" } }));
    const outward = await importVnu(app);
    gradesSpy = vi.spyOn(DaotaoClient.prototype, "getGradesHtml");
    vi.stubGlobal("fetch", upstreamFetch);

    const response = await getVnuRawPage(app, outward.token);
    const responseText = await response.text();

    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(JSON.parse(responseText)).toMatchObject({
      data: null,
      error: { code: "VNU_SESSION_EXPIRED" },
    });
    expect(responseText).not.toContain(expiryNotice);
    expect(cache.rawUrls()).toEqual([]);
    expect(gradesSpy).toHaveBeenCalledTimes(1);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["profile", "/StdInfo/TabStdSelf.asp"],
    ["grades", "/ListPoint/listpoint_Brc1.asp"],
    ["progress", "/StdInfo/TabStdStudy.asp"],
  ])("returns VNU_SESSION_EXPIRED for the exact XHTML notification variant on raw %s", async (page, upstreamPath) => {
    const imported = await importVnu(app);
    profileSpy.mockRestore();
    const upstreamFetch = vi.fn(async () => new Response(XHTML_VNU_NOTIFICATION_EXPIRY_HTML, {
      status: 200,
      headers: { "Content-Type": "text/html" },
    }));
    vi.stubGlobal("fetch", upstreamFetch);

    const response = await getVnuRawPage(app, imported.token, page);
    const responseText = await response.text();

    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(JSON.parse(responseText)).toMatchObject({
      data: null,
      error: { code: "VNU_SESSION_EXPIRED" },
    });
    expect(responseText).not.toContain(XHTML_VNU_NOTIFICATION_EXPIRY_HTML);
    expect(cache.rawUrls()).toEqual([]);
    expect(upstreamFetch).toHaveBeenCalledWith(`https://daotao.vnu.edu.vn${upstreamPath}`, expect.anything());
  });

  it.each([
    ["HTTPS default port", "https://daotao.vnu.edu.vn:443/dkmh/login.asp"],
    ["HTTP default port", "http://daotao.vnu.edu.vn:80/dkmh/login.asp"],
    ["HTTPS non-default port", "https://daotao.vnu.edu.vn:8443/dkmh/login.asp"],
    ["HTTP non-default port", "http://daotao.vnu.edu.vn:8080/dkmh/login.asp"],
  ])("returns raw grades HTML instead of an expiry error for a strict paragraph notice with an explicit %s", async (_port, href) => {
    const html = `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Phiên làm việc đã kết thúc.<br />Vui lòng đăng nhập lại hệ thống.<br /><a href="${href}">Sign in</a><br /></p></body></html>`;
    const upstreamFetch = vi.fn(async () => new Response(html, { status: 200, headers: { "Content-Type": "text/html" } }));
    const imported = await importVnu(app);
    profileSpy.mockRestore();
    vi.stubGlobal("fetch", upstreamFetch);

    const response = await getVnuRawPage(app, imported.token);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { html }, error: null });
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["profile", "/StdInfo/TabStdSelf.asp"],
    ["grades", "/ListPoint/listpoint_Brc1.asp"],
    ["progress", "/StdInfo/TabStdStudy.asp"],
  ])("normalizes a strict legacy HTTP 200 expiry page for raw %s without caching it", async (page, upstreamPath) => {
    const legacyExpiryHtml = `<html><body><table><tr><td>Phi&#xEA;n l&#224;m vi&#7879;c &#273;&#227; k&#7871;t th&#250;c. Vui&nbsp;l&#242;ng &#273;&#259;ng nh&#7853;p l&#7841;i h&#7879; th&#7889;ng.</td></tr></table></body></html>`;
    const imported = await importVnu(app);
    profileSpy.mockRestore();
    const upstreamFetch = vi.fn(async () => new Response(legacyExpiryHtml, { status: 200, headers: { "Content-Type": "text/html" } }));
    vi.stubGlobal("fetch", upstreamFetch);

    const response = await getVnuRawPage(app, imported.token, page);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      data: null,
      error: { code: "VNU_SESSION_EXPIRED", message: "The university portal session has expired. Sign in again." },
    });
    expect(upstreamFetch).toHaveBeenCalledWith(`https://daotao.vnu.edu.vn${upstreamPath}`, expect.anything());
    expect(cache.rawUrls()).toEqual([]);
  });

  it("rejects a legacy expiry page from the raw cache without an upstream call or notice leak", async () => {
    const expiryNoticeSentinel = "LEGACY_CACHED_EXPIRY_NOTICE_SENTINEL";
    const expiryNotice = "Phiên làm việc đã kết thúc. Vui lòng đăng nhập lại hệ thống.";
    const token = await encryptSession(vnuSession(), SESSION_SECRET);
    gradesSpy = vi.spyOn(DaotaoClient.prototype, "getGradesHtml").mockResolvedValue("<html><body>NORMAL_CACHED_GRADES</body></html>");

    const seedResponse = await getVnuRawPage(app, token);
    const normalCacheHit = await getVnuRawPage(app, token);
    expect(seedResponse.status).toBe(200);
    expect(normalCacheHit.status).toBe(200);
    await expect(normalCacheHit.json()).resolves.toEqual({ data: { html: "<html><body>NORMAL_CACHED_GRADES</body></html>" }, error: null });
    expect(gradesSpy).toHaveBeenCalledTimes(1);

    cache.setOnlyRawEntry({
      html: `<html><body><table data-synthetic-marker="${expiryNoticeSentinel}"><tr><td>${expiryNotice}</td></tr></table></body></html>`,
    });
    gradesSpy.mockClear();

    const response = await getVnuRawPage(app, token);
    const responseText = await response.text();

    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(JSON.parse(responseText)).toMatchObject({ data: null, error: { code: "VNU_SESSION_EXPIRED" } });
    expect(responseText).not.toContain(expiryNoticeSentinel);
    expect(responseText).not.toContain(expiryNotice);
    expect(gradesSpy).not.toHaveBeenCalled();
  });

  it("rejects the replaced access pair before raw-cache or upstream access", async () => {
    const repairedSession: EncryptedSessionPayload = {
      ...vnuSession(),
      vnu: { kind: "cookie", value: "REPAIRED_SYNTHETIC_VNU_COOKIE", expiresAt: "2099-01-01T00:00:00.000Z" },
    };
    const oldOutward = await importVnu(app);
    profileSpy.mockRejectedValueOnce(
      new HyeboardError("VNU_SESSION_EXPIRED", "The university portal session has expired. Sign in again.", 401),
    );
    adapterMocks.importSession.mockResolvedValueOnce(importedVnu(repairedSession));
    gradesSpy = vi.spyOn(DaotaoClient.prototype, "getGradesHtml").mockResolvedValue("<html>SYNTHETIC_GRADES</html>");

    const repairedOutward = await importVnu(app);
    const oldPayload = await decryptSession(oldOutward.token, SESSION_SECRET);
    const repairedPayload = await decryptSession(repairedOutward.token, SESSION_SECRET);
    const oldResponse = await getVnuRawPage(app, oldOutward.token);
    const repairedResponse = await getVnuRawPage(app, repairedOutward.token);
    const rawUrls = cache.rawUrls();

    expect(oldPayload.vnu?.value).toBe("SYNTHETIC_VNU_COOKIE");
    expect(repairedPayload.vnu?.value).toBe("REPAIRED_SYNTHETIC_VNU_COOKIE");
    expect(oldPayload.vnu?.value).not.toBe(repairedPayload.vnu?.value);
    expect(oldResponse.status).toBe(401);
    expect(repairedResponse.status).toBe(200);
    expect(rawUrls).toHaveLength(1);
    expect(gradesSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing", ""],
    ["mismatched", "OTHER-SYNTHETIC-STUDENT"],
  ])("repairs a cache hit with %s live profile identity", async (_label, liveStudentCode) => {
    const repairedSession: EncryptedSessionPayload = {
      ...vnuSession(),
      vnu: { kind: "cookie", value: `REPAIRED_${liveStudentCode || "MISSING"}_COOKIE`, expiresAt: "2099-01-01T00:00:00.000Z" },
    };
    await importVnu(app);
    const oldCached = await cache.importEntry();
    profileSpy.mockResolvedValueOnce(vnuProfileHtml(liveStudentCode));
    adapterMocks.importSession.mockResolvedValueOnce(importedVnu(repairedSession));

    const recovered = await importVnu(app);
    const replacement = await cache.importEntry();

    expect(profileSpy).toHaveBeenCalledTimes(1);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(2);
    expect(replacement.seed).not.toBe(oldCached.seed);
    const normalizedRepaired = { ...repairedSession, studentCode: VNU_STUDENT_CODE };
    await expectIssuedVnuAccess(recovered.token, normalizedRepaired);
    await expect(decryptSession(replacement.seed, SESSION_SECRET)).resolves.toEqual(normalizedRepaired);
  });

  it.each([
    ["rate limit", "VNU_RATE_LIMITED", 429],
    ["upstream unavailable", "VNU_UPSTREAM_UNAVAILABLE", 502],
  ])("propagates transient profile validation %s without login or cache mutation", async (_label, code, status) => {
    await importVnu(app);
    const cacheUrl = cache.importUrl();
    const storedBefore = cache.store.get(cacheUrl)!;
    const bytesBefore = await storedBefore.response.clone().text();
    profileSpy.mockRejectedValueOnce(new HyeboardError(code, "Synthetic transient validation failure", status));

    const response = await requestVnuImport(app);

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ data: null, error: { code } });
    expect(profileSpy).toHaveBeenCalledTimes(1);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
    expect(await cache.store.get(cacheUrl)!.response.clone().text()).toBe(bytesBefore);
    expect(cache.store.get(cacheUrl)!.expiresAt).toBe(storedBefore.expiresAt);
  });

  it("preserves the old cache when recovery login fails", async () => {
    await importVnu(app);
    const cacheUrl = cache.importUrl();
    const storedBefore = cache.store.get(cacheUrl)!;
    const bytesBefore = await storedBefore.response.clone().text();
    profileSpy.mockRejectedValueOnce(new HyeboardError("VNU_SESSION_EXPIRED", "Synthetic upstream session expired", 401));
    adapterMocks.importSession.mockRejectedValueOnce(new HyeboardError("INVALID_VNU_CREDENTIAL", "Synthetic credentials rejected", 401));

    const response = await requestVnuImport(app);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ data: null, error: { code: "INVALID_VNU_CREDENTIAL" } });
    expect(profileSpy).toHaveBeenCalledTimes(1);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(2);
    expect(await cache.store.get(cacheUrl)!.response.clone().text()).toBe(bytesBefore);
    expect(cache.store.get(cacheUrl)!.expiresAt).toBe(storedBefore.expiresAt);
  });

  it("keeps a cached relogin usable after the old outward token is revoked", async () => {
    const oldLogin = await importVnu(app);
    const independentLogin = await importVnu(app);

    const logout = await app.handle(new Request("http://localhost/api/vnu/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${oldLogin.token}`, "Content-Type": "application/json" },
      body: "{}",
    }));
    expect(logout.status).toBe(200);

    const oldSession = await getVnuSession(app, oldLogin.token);
    expect(oldSession.status).toBe(401);
    await expect(oldSession.json()).resolves.toMatchObject({
      data: null,
      error: { code: "SESSION_EXPIRED" },
    });

    const independentSession = await getVnuSession(app, independentLogin.token);
    expect(independentSession.status).toBe(200);

    const relogin = await importVnu(app);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
    expect(relogin.token).not.toBe(oldLogin.token);
    expect(relogin.token).not.toBe(independentLogin.token);
    const freshSession = await getVnuSession(app, relogin.token);
    expect(freshSession.status).toBe(200);
    await expect(freshSession.json()).resolves.toEqual({
      data: {
        universityId: "vnu",
        studentCode: "SYNTHETIC-STUDENT-001",
        expiresAt: "2099-01-01T00:00:00.000Z",
        authenticated: true,
      },
      error: null,
    });
  });

  it.each([
    ["malformed seed", async () => "not-an-encrypted-session"],
    ["wrong token version", async () => encryptRawLegacySessionFixture({ ...normalizedVnuSession(), version: 2 })],
    ["failed authentication tag", async () => encryptSession(normalizedVnuSession(), "different-synthetic-secret-32-bytes")],
    ["expired seed", async () => encryptSession(normalizedVnuSession("2000-01-01T00:00:00.000Z"), SESSION_SECRET)],
    ["non-VNU seed", async () => encryptSession({ ...normalizedVnuSession(), universityId: "uet", vnu: undefined }, SESSION_SECRET)],
    ["non-cookie VNU credential", async () => encryptSession({ ...normalizedVnuSession(), vnu: { ...normalizedVnuSession().vnu!, kind: "bearer" } }, SESSION_SECRET)],
  ])("treats a %s as a cache miss", async (_label, makeSeed) => {
    await importVnu(app);
    const previous = await cache.importEntry();
    cache.setImportEntry({ ...previous, seed: await makeSeed() });
    vi.clearAllMocks();
    adapterMocks.getAdapter.mockReturnValue({ importSession: adapterMocks.importSession });
    adapterMocks.importSession.mockResolvedValue(importedVnu());

    const recovered = await importVnu(app);

    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
    await expectIssuedVnuAccess(recovered.token, normalizedVnuSession());
    const replacement = await cache.importEntry();
    expect(Object.keys(replacement).sort()).toEqual(["seed", "session"]);
    expect(replacement.session).toEqual(recovered.session);
    await expect(decryptSession(replacement.seed, SESSION_SECRET)).resolves.toEqual(normalizedVnuSession());

    const cachedRelogin = await importVnu(app);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
    expect(cachedRelogin.token).not.toBe(recovered.token);
    expect(cachedRelogin.token).not.toBe(replacement.seed);
    expect(cachedRelogin.session).toEqual(recovered.session);
    await expectIssuedVnuAccess(cachedRelogin.token, normalizedVnuSession());
  });

  it.each([
    ["university", { universityId: "uet" }],
    ["student code", { studentCode: "OTHER-SYNTHETIC-STUDENT" }],
    ["expiry", { expiresAt: "2098-01-01T00:00:00.000Z" }],
  ])("treats inconsistent %s metadata as a cache miss", async (_label, metadataPatch) => {
    await importVnu(app);
    const previous = await cache.importEntry();
    cache.setImportEntry({ ...previous, session: { ...previous.session, ...metadataPatch } });
    vi.clearAllMocks();
    adapterMocks.getAdapter.mockReturnValue({ importSession: adapterMocks.importSession });
    adapterMocks.importSession.mockResolvedValue(importedVnu());

    const recovered = await importVnu(app);

    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
    const replacement = await cache.importEntry();
    expect(Object.keys(replacement).sort()).toEqual(["seed", "session"]);
    expect(replacement.session).toEqual(recovered.session);
    await expect(decryptSession(replacement.seed, SESSION_SECRET)).resolves.toEqual(normalizedVnuSession());

    const cachedRelogin = await importVnu(app);
    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
    expect(cachedRelogin.token).not.toBe(recovered.token);
    expect(cachedRelogin.token).not.toBe(replacement.seed);
    expect(cachedRelogin.session).toEqual(recovered.session);
    await expectIssuedVnuAccess(cachedRelogin.token, normalizedVnuSession());
  });

  it("falls back to upstream login when the cache read fails", async () => {
    cache.failMatch = true;

    const outward = await importVnu(app);

    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
    await expectIssuedVnuAccess(outward.token, normalizedVnuSession());
  });

  it("returns the normal response when the cache write fails", async () => {
    cache.failPut = true;

    const outward = await importVnu(app);

    expect(adapterMocks.importSession).toHaveBeenCalledTimes(1);
    await expectIssuedVnuAccess(outward.token, normalizedVnuSession());
    expect(cache.store.size).toBe(0);
  });
});

describe("VNU cross-transcript route", () => {
  let cache: TestCache;
  let app: ReturnType<typeof createApp>;
  let profileSpy: ReturnType<typeof vi.spyOn>;
  let transcriptSpy: ReturnType<typeof vi.spyOn>;
  let probeBudget: TestVnuProbeBudget;

  const profileHtml = `<input name="hidStdID" value="1000"><input name="StdCode" value="20000000">`;
  const targetTranscriptHtml = `<table>
    <tr><td>Sinh viên: SYNTHETIC TARGET</td><td>Mã số: 20000001</td><td>Lớp quản lý: QH-SYNTHETIC</td></tr>
    <tr><td>HỌC KỲ 1 - 2025-2026. MÃ HỌC KỲ 251</td></tr>
    <tr><td>1</td><td>INT1001</td><td>Reliable Systems</td><td>3</td><td>8</td><td>B+</td><td>3.5</td><td></td></tr>
  </table><div>Tổng tín chỉ: 3</div>`;

  async function authorizedRequest(query: string, route = "transcript", sessionCookie = "SYNTHETIC_TRANSCRIPT_COOKIE", signal?: AbortSignal): Promise<Response> {
    const session = { ...vnuSession(), vnu: { ...vnuSession().vnu!, value: sessionCookie } };
    const token = await encryptSession(session, SESSION_SECRET);
    return app.handle(new Request(`http://localhost/api/vnu/cross-lookup/${route}?${query}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    }));
  }

  async function bulkRequest(body: unknown, session: EncryptedSessionPayload = { ...vnuSession(), vnu: { ...vnuSession().vnu!, value: "SYNTHETIC_TRANSCRIPT_COOKIE" } }, signal?: AbortSignal): Promise<Response> {
    return bulkRawRequest(JSON.stringify(body), session, signal);
  }

  async function bulkRawRequest(body: string, session?: EncryptedSessionPayload, signal?: AbortSignal): Promise<Response> {
    const token = session ? await encryptSession(session, SESSION_SECRET) : undefined;
    return app.handle(new Request("http://localhost/api/vnu/cross-lookup/bulk", {
      method: "POST",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
      body,
      signal,
    }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET });
    cache = new TestCache(() => Date.now());
    vi.stubGlobal("caches", { default: cache });
    probeBudget = new TestVnuProbeBudget();
    setVnuProbeBudgetCoordinator(probeBudget);
    profileSpy = vi.spyOn(DaotaoClient.prototype, "getProfileHtml").mockResolvedValue(profileHtml);
    transcriptSpy = vi.spyOn(DaotaoClient.prototype, "getTranscriptByStdIdHtml").mockResolvedValue(targetTranscriptHtml);
    app = createApp(undefined);
  });

  afterEach(() => {
    profileSpy.mockRestore();
    transcriptSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("enforces an admin bulk limit below the immutable runtime ceiling", async () => {
    await policyRuntime.publish({
      baseRevision: 0,
      policy: { global: { capabilities: {}, limits: { "crossLookup.bulkDirectChunkMaxTargets": 2 } }, universities: {} },
      reason: "Synthetic effective bulk limit",
      actor: { method: "password", subject: "test-admin" },
    });

    const response = await bulkRequest({ mode: "stdid-to-code", targets: ["1001", "1002", "1003"], allowCrossLookup: true });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_CROSS_LOOKUP_CHUNK_TOO_LARGE" } });
    expect(profileSpy).not.toHaveBeenCalled();
    expect(transcriptSpy).not.toHaveBeenCalled();
  });

  it("never lets an admin bulk limit exceed the immutable runtime ceiling", async () => {
    await policyRuntime.publish({
      baseRevision: 0,
      policy: { global: { capabilities: {}, limits: { "crossLookup.bulkDirectChunkMaxTargets": 100 } }, universities: {} },
      reason: "Synthetic oversized admin limit",
      actor: { method: "password", subject: "test-admin" },
    });

    const response = await bulkRequest({ mode: "stdid-to-code", targets: Array.from({ length: 33 }, (_, index) => String(index + 1)), allowCrossLookup: true });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_CROSS_LOOKUP_CHUNK_TOO_LARGE" } });
    expect(profileSpy).not.toHaveBeenCalled();
    expect(transcriptSpy).not.toHaveBeenCalled();
  });

  it("rejects invalid target combinations before reading the own profile", async () => {
    const response = await authorizedRequest("stdId=1001&stdCode=20000001&allowCrossLookup=true");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_CROSS_LOOKUP_QUERY_INCOMPLETE" } });
    expect(profileSpy).not.toHaveBeenCalled();
    expect(transcriptSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["neither target", "allowCrossLookup=true"],
    ["malformed StdID", "stdId=abc&allowCrossLookup=true"],
    ["empty StdID", "stdId=&allowCrossLookup=true"],
    ["malformed student code", "stdCode=1234567&allowCrossLookup=true"],
  ])("rejects %s before reading the own profile or transcript oracle", async (_label, query) => {
    const response = await authorizedRequest(query);

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store, private");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_CROSS_LOOKUP_QUERY_INCOMPLETE" } });
    expect(profileSpy).not.toHaveBeenCalled();
    expect(transcriptSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", "stdId=1001"],
    ["incorrect", "stdId=1001&allowCrossLookup=1"],
  ])("rejects %s explicit opt-in before reading the own profile or transcript oracle", async (_label, query) => {
    const response = await authorizedRequest(query);

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store, private");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_CROSS_LOOKUP_NOT_EXPLICITLY_ALLOWED" } });
    expect(profileSpy).not.toHaveBeenCalled();
    expect(transcriptSpy).not.toHaveBeenCalled();
  });

  it("rejects a non-VNU session before profile or transcript access", async () => {
    const token = await encryptSession(parentSession(), SESSION_SECRET);
    const response = await app.handle(new Request("http://localhost/api/vnu/cross-lookup/transcript?stdId=1001&allowCrossLookup=true", {
      headers: { Authorization: `Bearer ${token}` },
    }));

    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("no-store, private");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "SESSION_UNIVERSITY_MISMATCH" } });
    expect(profileSpy).not.toHaveBeenCalled();
    expect(transcriptSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["normalized zero-padded own StdID", "stdId=00000001000&allowCrossLookup=true"],
    ["own student code", "stdCode=20000000&allowCrossLookup=true"],
  ])("rejects %s before transcript oracle access", async (_label, query) => {
    const response = await authorizedRequest(query);

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store, private");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_CROSS_LOOKUP_SELF_TARGET" } });
    expect(profileSpy).toHaveBeenCalledTimes(1);
    expect(transcriptSpy).not.toHaveBeenCalled();
  });

  it("rejects a normalized zero-padded own StdID on the student-code route before oracle access", async () => {
    const response = await authorizedRequest("stdId=00000001000&allowCrossLookup=true", "student-code");

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_CROSS_LOOKUP_SELF_TARGET" } });
    expect(probeBudget.count).toBe(0);
    expect(transcriptSpy).not.toHaveBeenCalled();
  });

  // Regression: Number("not-a-number") is NaN and NaN never equals the
  // target, so a truthy-but-malformed own-profile id silently bypassed the
  // old self-target guard — the route then spent budget and fetched Brc1
  // with an unverified caller identity. Identity parsing now fails closed.
  it.each([
    ["student-code", "stdId=1002&allowCrossLookup=true"],
    ["student-id", "stdCode=20000001&allowCrossLookup=true"],
    ["transcript", "stdId=1002&allowCrossLookup=true"],
  ])("fails closed on a malformed own-profile identity for %s without budget or Brc1 access", async (route, query) => {
    profileSpy.mockResolvedValue(`<input name="hidStdID" value="not-a-number"><input name="StdCode" value="20000000">`);

    const response = await authorizedRequest(query, route);
    const responseText = await response.text();

    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe(route === "transcript" ? "no-store, private" : "no-store");
    expect(JSON.parse(responseText)).toEqual({ data: null, error: { code: "VNU_PROFILE_INCOMPLETE", message: "The university portal profile is incomplete." } });
    for (const privateValue of ["not-a-number", "20000000"]) expect(responseText).not.toContain(privateValue);
    expect(probeBudget.count).toBe(0);
    expect(transcriptSpy).not.toHaveBeenCalled();
  });

  it("fails closed on a malformed own-profile identity for bulk without budget or Brc1 access", async () => {
    profileSpy.mockResolvedValue(`<input name="hidStdID" value="not-a-number"><input name="StdCode" value="20000000">`);

    const response = await bulkRequest({ mode: "stdid-to-code", targets: ["1002"], allowCrossLookup: true });
    const responseText = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(responseText)).toEqual({ data: null, error: { code: "VNU_PROFILE_INCOMPLETE", message: "The university portal profile is incomplete." } });
    for (const privateValue of ["not-a-number", "20000000"]) expect(responseText).not.toContain(privateValue);
    expect(probeBudget.count).toBe(0);
    expect(transcriptSpy).not.toHaveBeenCalled();
  });

  it("returns profile incomplete when a required own student code is missing", async () => {
    profileSpy.mockResolvedValue(`<input name="hidStdID" value="1000">`);

    const response = await authorizedRequest("stdCode=20000001&allowCrossLookup=true", "student-id");
    const responseText = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(responseText)).toEqual({ data: null, error: { code: "VNU_PROFILE_INCOMPLETE", message: "The university portal profile is incomplete." } });
    for (const privateValue of ["1000", "20000001"]) expect(responseText).not.toContain(privateValue);
    expect(probeBudget.count).toBe(0);
    expect(transcriptSpy).not.toHaveBeenCalled();
  });

  it("returns the exact profile-incomplete envelope when bulk mode requires a missing own student code", async () => {
    profileSpy.mockResolvedValue(`<input name="hidStdID" value="1000">`);

    const response = await bulkRequest({ mode: "code-to-stdid", targets: ["20000001"], allowCrossLookup: true });
    const responseText = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(responseText)).toEqual({ data: null, error: { code: "VNU_PROFILE_INCOMPLETE", message: "The university portal profile is incomplete." } });
    for (const privateValue of ["1000", "20000001"]) expect(responseText).not.toContain(privateValue);
    expect(probeBudget.count).toBe(0);
    expect(transcriptSpy).not.toHaveBeenCalled();
  });

  it("returns parsed JSON only and spends one probe for direct StdID mode", async () => {
    const response = await authorizedRequest("stdId=1001&allowCrossLookup=true");
    const body = await response.json() as { data: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store, private");
    expect(body.data).toMatchObject({
      header: { studentCode: "20000001", studentName: "SYNTHETIC TARGET" },
      terms: [{ maHK: "251", rows: [{ courseCode: "INT1001", grade10: 8 }] }],
      totals: { totalCredits: 3 },
    });
    expect(JSON.stringify(body)).not.toContain("<table>");
    expect(transcriptSpy).toHaveBeenCalledTimes(1);
    expect(probeBudget.count).toBe(1);
    expect(probeBudget.reservedAmounts).toEqual([1]);
    expect(probeBudget.consumedAmounts).toEqual([]);
    expect(probeBudget.activeLeaseCount).toBe(0);
    expect(probeBudget.releasedLeases).toHaveLength(1);
  });

  it("removes upstream notice prose from transcript responses", async () => {
    const upstreamNoticeSentinel = "UPSTREAM_NOTICE_SENTINEL_DO_NOT_EXPOSE";
    transcriptSpy.mockResolvedValue(`${targetTranscriptHtml}<script>alert('${upstreamNoticeSentinel}')</script>`);

    const response = await authorizedRequest("stdId=1001&allowCrossLookup=true");
    const payload = await response.text();

    expect(response.status).toBe(200);
    expect(payload).not.toContain(upstreamNoticeSentinel);
    expect(payload).not.toContain("notice");
  });

  it("cross-transcript by code reserves 34 and performs a separate final fetch", async () => {
    const response = await authorizedRequest("stdCode=20000001&allowCrossLookup=true");
    const body = await response.json() as { data: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store, private");
    expect(body.data).toMatchObject({ header: { studentCode: "20000001" }, terms: [{ maHK: "251" }] });
    expect(JSON.stringify(body)).not.toContain("<table>");
    expect(transcriptSpy).toHaveBeenCalledTimes(2);
    expect(transcriptSpy.mock.calls.map((call: unknown[]) => call[0])).toEqual(["1001", "00000001001"]);
    expect(probeBudget.reservedAmounts).toEqual([34]);
    expect(probeBudget.consumedAmounts).toEqual([]);
  });

  it("rejects a 34-unit transcript reservation before resolver or final fetch", async () => {
    probeBudget.limit = 33;

    const response = await authorizedRequest("stdCode=20000001&allowCrossLookup=true");

    expect(response.status).toBe(429);
    expect(response.headers.get("Cache-Control")).toBe("no-store, private");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_RATE_LIMITED" } });
    expect(transcriptSpy).not.toHaveBeenCalled();
    expect(probeBudget.reservedAmounts).toEqual([34]);
  });

  it("keeps separate budget identifiers and counters for separate VNU sessions", async () => {
    probeBudget.limit = 1;

    const first = await authorizedRequest("stdId=1001&allowCrossLookup=true", "transcript", "SYNTHETIC_SESSION_A");
    const exhaustedFirst = await authorizedRequest("stdId=1002&allowCrossLookup=true", "transcript", "SYNTHETIC_SESSION_A");
    const second = await authorizedRequest("stdId=1002&allowCrossLookup=true", "transcript", "SYNTHETIC_SESSION_B");

    expect(first.status).toBe(200);
    expect(exhaustedFirst.status).toBe(429);
    expect(second.status).toBe(200);
    expect(new Set(probeBudget.identities).size).toBe(2);
    expect([...probeBudget.counts.values()].sort()).toEqual([1, 1]);
    expect(transcriptSpy).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["headerless transcript", `<table><tr><td>1</td><td>INT1001</td><td>Foreign grade</td><td>3</td><td>8</td><td>B+</td><td>3.5</td><td></td></tr></table>`],
    ["invalid portal response", "<html><body>not a transcript</body></html>"],
  ])("returns no foreign result for an %s", async (_label, html) => {
    transcriptSpy.mockResolvedValue(html);

    const response = await authorizedRequest("stdId=1001&allowCrossLookup=true");
    const body = await response.json() as { data: unknown; error: { code: string } };

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store, private");
    expect(body).toMatchObject({ data: null, error: { code: "VNU_CROSS_LOOKUP_NOT_FOUND" } });
    expect(JSON.stringify(body)).not.toContain("Foreign grade");
  });

  it("shares one HMAC budget across student-code and student-id routes for the same session", async () => {
    const byId = await authorizedRequest("stdId=1002&allowCrossLookup=true", "student-code");
    const byCode = await authorizedRequest("stdCode=20000001&allowCrossLookup=true", "student-id");

    expect(byId.status).toBe(200);
    expect(byCode.status).toBe(200);
    expect(byId.headers.get("Cache-Control")).toBe("no-store");
    expect(byCode.headers.get("Cache-Control")).toBe("no-store");
    expect(probeBudget.count).toBe(34);
    expect(probeBudget.reservedAmounts).toEqual([1, 33]);
    expect(probeBudget.consumedAmounts).toEqual([]);
    expect(new Set(probeBudget.identities).size).toBe(1);
    expect(probeBudget.identities[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(probeBudget.identities.join(" ")).not.toContain("SYNTHETIC_TRANSCRIPT_COOKIE");
    expect(probeBudget.identities.join(" ")).not.toMatch(/20000001|1002/);
  });

  it.each([
    ["student-code", "stdId=bad&allowCrossLookup=true"],
    ["student-id", "stdCode=bad&allowCrossLookup=true"],
  ])("sets no-store on %s resolver errors", async (route, query) => {
    const response = await authorizedRequest(query, route);

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("maps a headerless portal notice to not-found without exposing its prose", async () => {
    const upstreamNoticeSentinel = "UPSTREAM_NOTICE_SENTINEL_DO_NOT_EXPOSE";
    transcriptSpy.mockResolvedValue(`<script>alert('${upstreamNoticeSentinel}')</script>`);

    const response = await authorizedRequest("stdId=1001&allowCrossLookup=true", "student-code");
    const payload = await response.text();

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(payload).toContain("VNU_CROSS_LOOKUP_NOT_FOUND");
    expect(payload).not.toContain(upstreamNoticeSentinel);
  });

  it("rejects confirmed exhaustion before the upstream Brc1 fetch without session-death semantics", async () => {
    probeBudget.limit = 0;

    const response = await authorizedRequest("stdId=1002&allowCrossLookup=true", "student-code");
    const body = await response.json() as { error: { code: string; details: Record<string, unknown> } };

    expect(response.status).toBe(429);
    expect(body.error).toMatchObject({ code: "VNU_RATE_LIMITED", details: { retryAfterSeconds: 600 } });
    expect(transcriptSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain("SYNTHETIC_TRANSCRIPT_COOKIE");
    expect(JSON.stringify(body)).not.toMatch(/20000001|1002/);
  });

  it("student-id reserves exact 33 before Brc1 and limit 32 starts no upstream work", async () => {
    probeBudget.limit = 32;

    const response = await authorizedRequest("stdCode=20000001&allowCrossLookup=true", "student-id");

    expect(response.status).toBe(429);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(probeBudget.reservedAmounts).toEqual([33]);
    expect(probeBudget.consumedAmounts).toEqual([]);
    expect(transcriptSpy).not.toHaveBeenCalled();
  });

  it("direct abortable Request passes exact cancellation reason and settles started work", async () => {
    const controller = new AbortController();
    const reason = new DOMException("synthetic direct cancellation", "AbortError");
    const observedReasons: unknown[] = [];
    let settled = false;
    transcriptSpy.mockImplementation(async (_stdId: string, signal?: AbortSignal) => {
      try {
        return await new Promise<string>((_resolve, reject) => signal?.addEventListener("abort", () => {
          observedReasons.push(signal.reason);
          reject(signal.reason);
        }, { once: true }));
      } finally {
        settled = true;
      }
    });

    const responsePromise = authorizedRequest("stdId=1001&allowCrossLookup=true", "student-code", undefined, controller.signal);
    await vi.waitFor(() => expect(transcriptSpy).toHaveBeenCalledOnce());
    controller.abort(reason);
    const response = await responsePromise;

    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(observedReasons).toEqual([reason]);
    expect(settled).toBe(true);
    expect(probeBudget.activeLeaseCount).toBe(0);
  });

  it("resolver route cancelled at configured concurrency 4 aborts and settles every started candidate", async () => {
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET, VNU_CODE_LOOKUP_CONCURRENCY: "4" });
    const controller = new AbortController();
    const reason = { cancelled: "resolver request" };
    const candidateSignals: AbortSignal[] = [];
    let settledCandidates = 0;
    transcriptSpy.mockImplementation(async (_stdId: string, signal?: AbortSignal) => {
      if (transcriptSpy.mock.calls.length === 1) return "<html>headerless</html>";
      candidateSignals.push(signal!);
      try {
        return await new Promise<string>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
      } finally {
        settledCandidates += 1;
      }
    });

    const responsePromise = authorizedRequest("stdCode=20000001&allowCrossLookup=true", "student-id", undefined, controller.signal);
    await vi.waitFor(() => expect(candidateSignals).toHaveLength(4));
    controller.abort(reason);
    const response = await responsePromise;

    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(candidateSignals.every((signal) => signal.aborted && signal.reason === reason)).toBe(true);
    expect(settledCandidates).toBe(4);
  });

  it("fatal concurrent candidate aborts siblings and propagates exact 429 with no-store", async () => {
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET, VNU_CODE_LOOKUP_CONCURRENCY: "4" });
    const fatal = new HyeboardError("VNU_RATE_LIMITED", "synthetic candidate limit", 429);
    const siblingSignals: AbortSignal[] = [];
    let settledSiblings = 0;
    transcriptSpy.mockImplementation(async (_stdId: string, signal?: AbortSignal) => {
      if (transcriptSpy.mock.calls.length === 1) return "<html>headerless</html>";
      if (transcriptSpy.mock.calls.length === 2) throw fatal;
      siblingSignals.push(signal!);
      try {
        return await new Promise<string>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
      } finally {
        settledSiblings += 1;
      }
    });

    const response = await authorizedRequest("stdCode=20000001&allowCrossLookup=true", "student-id");

    expect(response.status).toBe(429);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_RATE_LIMITED" } });
    expect(siblingSignals.length).toBeLessThanOrEqual(3);
    expect(siblingSignals.every((signal) => signal.aborted && signal.reason === fatal)).toBe(true);
    expect(settledSiblings).toBe(siblingSignals.length);
    expect(probeBudget.activeLeaseCount).toBe(0);
  });

  it("candidate session expiry aborts siblings and propagates 401 instead of not-converged", async () => {
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET, VNU_CODE_LOOKUP_CONCURRENCY: "4" });
    const fatal = new HyeboardError("VNU_SESSION_EXPIRED", "synthetic candidate expiry", 401);
    const siblingSignals: AbortSignal[] = [];
    transcriptSpy.mockImplementation(async (_stdId: string, signal?: AbortSignal) => {
      if (transcriptSpy.mock.calls.length === 1) return "<html>headerless</html>";
      if (transcriptSpy.mock.calls.length === 2) throw fatal;
      siblingSignals.push(signal!);
      return new Promise<string>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    });

    const response = await authorizedRequest("stdCode=20000001&allowCrossLookup=true", "student-id");

    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_SESSION_EXPIRED" } });
    expect(siblingSignals.length).toBeLessThanOrEqual(3);
    expect(siblingSignals.every((signal) => signal.aborted && signal.reason === fatal)).toBe(true);
  });

  it("reports budget unavailability as 503 without session-death semantics", async () => {
    probeBudget.unavailable = true;

    const response = await authorizedRequest("stdId=1002&allowCrossLookup=true", "student-code");
    const body = await response.json() as { error: { code: string; details: Record<string, unknown> } };

    expect(response.status).toBe(503);
    expect(body.error).toMatchObject({ code: "VNU_PROBE_BUDGET_UNAVAILABLE", details: { retryAfterSeconds: 5 } });
    expect(transcriptSpy).not.toHaveBeenCalled();
  });

  it("does not lease cross-student permits for the session owner's grades", async () => {
    const gradesSpy = vi.spyOn(DaotaoClient.prototype, "getGradesHtml").mockResolvedValue(targetTranscriptHtml);
    const token = await encryptSession(vnuSession(), SESSION_SECRET);

    const response = await app.handle(new Request("http://localhost/api/vnu/raw/grades", {
      headers: { Authorization: `Bearer ${token}` },
    }));

    expect(response.status).toBe(200);
    expect(gradesSpy).toHaveBeenCalledOnce();
    expect(probeBudget.activeLeaseCount).toBe(0);
    expect(probeBudget.releasedLeases).toEqual([]);
    gradesSpy.mockRestore();
  });

  it("splits three bulk resolver workers into two candidate permits each", async () => {
    setRuntimeConfig({
      HYEB_SESSION_SECRET: SESSION_SECRET,
      VNU_CODE_LOOKUP_BULK_TARGET_CONCURRENCY: "3",
      VNU_CODE_LOOKUP_CONCURRENCY: "6",
    });
    const controller = new AbortController();
    transcriptSpy.mockImplementation(async (stdId: string, signal?: AbortSignal) => {
      if (["1050", "1100", "1150"].includes(stdId)) return "<html>headerless</html>";
      return new Promise<string>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });

    const request = bulkRequest({
      mode: "code-to-stdid",
      targets: ["20000050", "20000100", "20000150"],
      allowCrossLookup: true,
    }, undefined, controller.signal);
    await vi.waitFor(() => expect(transcriptSpy).toHaveBeenCalledTimes(9));

    expect(probeBudget.activeLeaseCount).toBe(6);
    expect(probeBudget.pendingPermitCount).toBe(0);
    controller.abort(new DOMException("bulk resolver cancelled", "AbortError"));
    await request;
    expect(probeBudget.activeLeaseCount).toBe(0);
  });

  it("caps concurrent same-session code bulk Brc1 work at exactly six and releases every aborted lease", async () => {
    setRuntimeConfig({
      HYEB_SESSION_SECRET: SESSION_SECRET,
      VNU_CODE_LOOKUP_BULK_TARGET_CONCURRENCY: "3",
      VNU_CODE_LOOKUP_CONCURRENCY: "6",
    });
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    let resolveSixActive!: () => void;
    const sixActive = new Promise<void>((resolve) => { resolveSixActive = resolve; });
    transcriptSpy.mockImplementation(async (_stdId: string, signal?: AbortSignal) => {
      if (transcriptSpy.mock.calls.length === 6) resolveSixActive();
      return new Promise<string>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    });

    const first = bulkRequest({ mode: "code-to-stdid", targets: ["20000001", "20000002", "20000003"], allowCrossLookup: true }, undefined, firstAbort.signal);
    const second = bulkRequest({ mode: "code-to-stdid", targets: ["20000004", "20000005", "20000006"], allowCrossLookup: true }, undefined, secondAbort.signal);
    await sixActive;

    expect(transcriptSpy).toHaveBeenCalledTimes(6);
    expect(probeBudget.activeLeaseCount).toBe(6);
    expect(probeBudget.peakActiveLeases).toBe(6);
    firstAbort.abort(new DOMException("first bulk cancelled", "AbortError"));
    secondAbort.abort(new DOMException("second bulk cancelled", "AbortError"));
    await Promise.all([first, second]);

    expect(probeBudget.activeLeaseCount).toBe(0);
    expect(probeBudget.pendingPermitCount).toBe(0);
    expect(probeBudget.releasedLeases).toHaveLength(6);
  });

  it("shares exactly six same-session Brc1 permits between direct and bulk code lookups", async () => {
    setRuntimeConfig({
      HYEB_SESSION_SECRET: SESSION_SECRET,
      VNU_CODE_LOOKUP_BULK_TARGET_CONCURRENCY: "3",
      VNU_CODE_LOOKUP_CONCURRENCY: "6",
    });
    const directAbort = new AbortController();
    const bulkAbort = new AbortController();
    let resolveSixActive!: () => void;
    const sixActive = new Promise<void>((resolve) => { resolveSixActive = resolve; });
    transcriptSpy.mockImplementation(async (_stdId: string, signal?: AbortSignal) => {
      const call = transcriptSpy.mock.calls.length;
      if (call === 1) return "<html>headerless</html>";
      if (call === 7) resolveSixActive();
      return new Promise<string>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    });

    const direct = authorizedRequest("stdCode=20000001&allowCrossLookup=true", "student-id", undefined, directAbort.signal);
    await sixActive;
    const bulk = bulkRequest({ mode: "code-to-stdid", targets: ["20000002", "20000003", "20000004"], allowCrossLookup: true }, undefined, bulkAbort.signal);
    await Promise.resolve();

    expect(transcriptSpy).toHaveBeenCalledTimes(7);
    expect(probeBudget.activeLeaseCount).toBe(6);
    expect(probeBudget.peakActiveLeases).toBe(6);
    directAbort.abort(new DOMException("direct cancelled", "AbortError"));
    bulkAbort.abort(new DOMException("bulk cancelled", "AbortError"));
    await Promise.all([direct, bulk]);

    expect(probeBudget.activeLeaseCount).toBe(0);
    expect(probeBudget.pendingPermitCount).toBe(0);
  });

  it("removes an aborted cap-one queued direct lookup before it reaches Brc1", async () => {
    probeBudget = new TestVnuProbeBudget(1);
    setVnuProbeBudgetCoordinator(probeBudget);
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    let resolveFirstFetch!: () => void;
    const firstFetchStarted = new Promise<void>((resolve) => { resolveFirstFetch = resolve; });
    let resolveQueued!: () => void;
    const secondQueued = new Promise<void>((resolve) => { resolveQueued = resolve; });
    probeBudget.onPermitQueued = resolveQueued;
    transcriptSpy.mockImplementation(async (_stdId: string, signal?: AbortSignal) => {
      resolveFirstFetch();
      return new Promise<string>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    });

    const first = authorizedRequest("stdId=1001&allowCrossLookup=true", "student-code", undefined, firstAbort.signal);
    await firstFetchStarted;
    const second = authorizedRequest("stdId=1002&allowCrossLookup=true", "student-code", undefined, secondAbort.signal);
    await secondQueued;
    secondAbort.abort(new DOMException("queued direct cancelled", "AbortError"));
    await second;

    expect(transcriptSpy).toHaveBeenCalledTimes(1);
    expect(probeBudget.pendingPermitCount).toBe(0);
    firstAbort.abort(new DOMException("first direct cancelled", "AbortError"));
    await first;
    expect(probeBudget.activeLeaseCount).toBe(0);
  });

  it("releases all permits after a resolver winner cancels sibling probes", async () => {
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET, VNU_CODE_LOOKUP_CONCURRENCY: "4" });
    transcriptSpy.mockImplementation(async (stdId: string, signal?: AbortSignal) => {
      const call = transcriptSpy.mock.calls.length;
      if (call === 1) return "<html>headerless</html>";
      if (stdId === "1000") {
        await Promise.resolve();
        return targetTranscriptHtml;
      }
      return new Promise<string>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    });

    const response = await authorizedRequest("stdCode=20000001&allowCrossLookup=true", "student-id");

    expect(response.status).toBe(200);
    expect(probeBudget.activeLeaseCount).toBe(0);
    expect(probeBudget.releasedLeases).toHaveLength(transcriptSpy.mock.calls.length);
  });

  it("passes the direct-route default 60-second TimeoutError to Brc1 and releases its permit", async () => {
    vi.useFakeTimers();
    const observedSignals: AbortSignal[] = [];
    let resolveFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => { resolveFetchStarted = resolve; });
    transcriptSpy.mockImplementation(async (_stdId: string, signal?: AbortSignal) => {
      observedSignals.push(signal!);
      resolveFetchStarted();
      return new Promise<string>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    });
    const responsePromise = authorizedRequest("stdId=1001&allowCrossLookup=true", "student-code");
    await fetchStarted;
    await vi.advanceTimersByTimeAsync(60_000);
    const response = await responsePromise;

    expect(response.status).toBe(500);
    expect(observedSignals[0].aborted).toBe(true);
    expect(observedSignals[0].reason).toBeInstanceOf(DOMException);
    expect((observedSignals[0].reason as DOMException).name).toBe("TimeoutError");
    expect(probeBudget.activeLeaseCount).toBe(0);
    vi.useRealTimers();
  });

  describe("bulk lookup", () => {
    it("runs authentication, university, explicit opt-in, body, then own-profile guards", async () => {
      const missingSession = await bulkRawRequest("{");
      expect(missingSession.status).toBe(401);
      await expect(missingSession.json()).resolves.toMatchObject({ error: { code: "MISSING_SESSION" } });

      const wrongUniversity = await bulkRawRequest("{", parentSession());
      expect(wrongUniversity.status).toBe(403);
      await expect(wrongUniversity.json()).resolves.toMatchObject({ error: { code: "SESSION_UNIVERSITY_MISMATCH" } });

      const missingOptIn = await bulkRequest({ mode: "stdid-to-code", targets: ["1001"], allowCrossLookup: false });
      expect(missingOptIn.status).toBe(400);
      await expect(missingOptIn.json()).resolves.toMatchObject({ error: { code: "VNU_CROSS_LOOKUP_NOT_EXPLICITLY_ALLOWED" } });

      const malformed = await bulkRequest({ mode: "unknown", targets: ["1001"], allowCrossLookup: true });
      expect(malformed.status).toBe(400);
      expect(profileSpy).not.toHaveBeenCalled();

      profileSpy.mockResolvedValueOnce("<html>no profile identity</html>");
      const noProfile = await bulkRequest({ mode: "stdid-to-code", targets: ["1001"], allowCrossLookup: true });
      expect(noProfile.status).toBe(500);
      expect(transcriptSpy).not.toHaveBeenCalled();
      expect(probeBudget.count).toBe(0);
    });

    it.each([
      ["string", "true", 400],
      ["number", 1, 400],
      ["boolean", true, 200],
    ] as const)("accepts only boolean true for allowCrossLookup (%s)", async (_label, allowCrossLookup, status) => {
      const response = await bulkRequest({ mode: "stdid-to-code", targets: ["1001"], allowCrossLookup });

      expect(response.status).toBe(status);
      if (status === 400) await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_CROSS_LOOKUP_NOT_EXPLICITLY_ALLOWED" } });
    });

    it.each([
      ["stdid-to-code", 33],
      ["stdid-to-transcript", 33],
      ["code-to-stdid", 10],
    ] as const)("rejects an oversized %s chunk at the chunk boundary", async (mode, size) => {
      const target = mode === "code-to-stdid" ? "20000001" : "1001";
      const response = await bulkRequest({ mode, targets: Array.from({ length: size }, () => target), allowCrossLookup: true });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_CROSS_LOOKUP_CHUNK_TOO_LARGE" } });
      expect(profileSpy).not.toHaveBeenCalled();
      expect(transcriptSpy).not.toHaveBeenCalled();
    });

    it.each([
      ["stdid-to-code", []],
      ["stdid-to-transcript", []],
      ["code-to-stdid", []],
    ] as const)("rejects empty targets for %s", async (mode, targets) => {
      const response = await bulkRequest({ mode, targets, allowCrossLookup: true });
      expect(response.status).toBe(400);
    });

    it("isolates malformed, self, not-found, and successful direct-code targets in input order", async () => {
      transcriptSpy.mockImplementation(async (stdId: string) => stdId === "1002"
        ? `<table><tr><td>Sinh viên: LATER TARGET</td><td>Mã số: 20000002</td><td>Lớp quản lý: QH-LATER</td></tr></table>`
        : "<html>headerless</html>");

      const response = await bulkRequest({ mode: "stdid-to-code", targets: ["bad", "1000", "1001", "1002"], allowCrossLookup: true });
      const payload = await response.json() as { data: { items: Array<Record<string, unknown>> } };

      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(payload.data.items).toEqual([
        { target: "bad", status: "error", errorCode: "VNU_CROSS_LOOKUP_INVALID_TARGET" },
        { target: "1000", status: "error", errorCode: "VNU_CROSS_LOOKUP_SELF_TARGET" },
        { target: "1001", status: "error", errorCode: "VNU_CROSS_LOOKUP_NOT_FOUND" },
        { target: "1002", status: "ok", result: { studentCode: "20000002", studentName: "LATER TARGET", className: "QH-LATER" } },
      ]);
      expect(transcriptSpy.mock.calls.map((call: unknown[]) => call[0] as string)).toEqual(["1001", "1002"]);
      expect(probeBudget.amounts).toEqual([4]);
      expect(JSON.stringify(payload)).not.toContain("<html>");
    });

    it("propagates terminal transcript expiry for the whole chunk and stops later targets", async () => {
      transcriptSpy
        .mockRejectedValueOnce(new HyeboardError("VNU_SESSION_EXPIRED", "Synthetic upstream session expired", 401))
        .mockResolvedValueOnce(targetTranscriptHtml);

      const response = await bulkRequest({ mode: "stdid-to-transcript", targets: ["1001", "1002"], allowCrossLookup: true });

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({
        data: null,
        error: { code: "VNU_SESSION_EXPIRED" },
      });
      expect(transcriptSpy).toHaveBeenCalledTimes(1);
      expect(transcriptSpy).toHaveBeenCalledWith("1001", expect.any(AbortSignal));
    });

    it("reserves the resolver hard maximum once per code target without per-fetch double charging", async () => {
      transcriptSpy.mockImplementation(async (stdId: string) => {
        const code = 20_000_000 + Number(stdId) - 1_000;
        return `<table><tr><td>Sinh viên: TARGET</td><td>Mã số: ${code}</td><td>Lớp quản lý: QH-TARGET</td></tr></table>`;
      });

      const response = await bulkRequest({ mode: "code-to-stdid", targets: ["20000001", "20000002"], allowCrossLookup: true });
      const payload = await response.json() as { data: { items: Array<Record<string, unknown>> } };

      expect(response.status).toBe(200);
      expect(payload.data.items).toMatchObject([
        { target: "20000001", status: "ok", result: { stdId: "00000001001", probes: 1 } },
        { target: "20000002", status: "ok", result: { stdId: "00000001002", probes: 1 } },
      ]);
      expect(probeBudget.reservedAmounts).toEqual([66]);
      expect(probeBudget.consumedAmounts).toEqual([]);
      expect(transcriptSpy).toHaveBeenCalledTimes(2);
    });

    it("rejects the whole chunk reservation before any Brc1 request", async () => {
      probeBudget.limit = 4;
      const response = await bulkRequest({ mode: "stdid-to-transcript", targets: ["1001", "1002", "1003", "1004", "1005"], allowCrossLookup: true });

      expect(response.status).toBe(429);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_RATE_LIMITED" } });
      expect(transcriptSpy).not.toHaveBeenCalled();
    });

    it("32 direct targets are accepted and reserve 32 atomically", async () => {
      const response = await bulkRequest({ mode: "stdid-to-code", targets: Array.from({ length: 32 }, (_, index) => String(1001 + index)), allowCrossLookup: true });

      expect(response.status).toBe(200);
      expect(probeBudget.reservedAmounts).toEqual([32]);
      expect(probeBudget.consumedAmounts).toEqual([]);
    });

    it("accepts nine code targets and rejects ten before reading the profile", async () => {
      const nine = Array.from({ length: 9 }, (_, index) => String(20_000_001 + index));
      const accepted = await bulkRequest({ mode: "code-to-stdid", targets: nine, allowCrossLookup: true });
      expect(accepted.status).toBe(200);

      profileSpy.mockClear();
      transcriptSpy.mockClear();
      const rejected = await bulkRequest({ mode: "code-to-stdid", targets: [...nine, "20000010"], allowCrossLookup: true });
      expect(rejected.status).toBe(400);
      await expect(rejected.json()).resolves.toMatchObject({ error: { code: "VNU_CROSS_LOOKUP_CHUNK_TOO_LARGE" } });
      expect(profileSpy).not.toHaveBeenCalled();
      expect(transcriptSpy).not.toHaveBeenCalled();
    });

    it("ordinary bulk systemic failure aborts chunk and starts no later item", async () => {
      const fatal = new HyeboardError("VNU_UPSTREAM_UNAVAILABLE", "synthetic outage", 503);
      transcriptSpy.mockImplementation(async (stdId: string) => {
        if (stdId === "1002") throw fatal;
        return targetTranscriptHtml;
      });

      const response = await bulkRequest({ mode: "stdid-to-code", targets: ["1001", "1002", "1003"], allowCrossLookup: true });

      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(transcriptSpy.mock.calls.map((call: unknown[]) => call[0])).toEqual(["1001", "1002"]);
    });

    it("bulk code targets overlap while their aggregate candidate probes stay capped", async () => {
      probeBudget = new TestVnuProbeBudget(2);
      setVnuProbeBudgetCoordinator(probeBudget);
      setRuntimeConfig({
        HYEB_SESSION_SECRET: SESSION_SECRET,
        VNU_CODE_LOOKUP_BULK_TARGET_CONCURRENCY: "2",
        VNU_CODE_LOOKUP_CONCURRENCY: "2",
      });
      profileSpy.mockResolvedValue(`<input name="hidStdID" value="${SYNTHETIC_VNU_STD_ID}"><input name="StdCode" value="${SYNTHETIC_VNU_CODE}">`);
      const targetCodes = [SYNTHETIC_VNU_CODE + 100, SYNTHETIC_VNU_CODE + 200];
      const projectedIds = targetCodes.map((code) => SYNTHETIC_VNU_STD_ID + code - SYNTHETIC_VNU_CODE);
      const pendingWork = new Map<number, { resolve: (html: string) => void; reject: (reason: unknown) => void }>();
      const enteredIds = new Set<number>();
      const startedWork = new Map(projectedIds.flatMap((stdId) => [
        [stdId - 1, enteredOperation<void>()],
        [stdId + 1, enteredOperation<void>()],
      ]));
      const waitForWork = (stdId: number): Promise<void> => {
        const work = startedWork.get(stdId);
        if (!work) throw new Error(`No controlled Brc1 start exists for ${stdId}`);
        return work.entered;
      };
      const completeWork = (stdId: number, html: string): void => {
        const work = pendingWork.get(stdId);
        if (!work) throw new Error(`No controlled Brc1 work exists for ${stdId}`);
        pendingWork.delete(stdId);
        work.resolve(html);
      };
      transcriptSpy.mockImplementation(async (stdIdText: string, signal?: AbortSignal) => {
        const stdId = Number(stdIdText);
        if (projectedIds.includes(stdId) || !startedWork.has(stdId)) return "<html>headerless</html>";
        return new Promise<string>((resolve, reject) => {
          pendingWork.set(stdId, { resolve, reject });
          enteredIds.add(stdId);
          startedWork.get(stdId)?.markEntered();
          signal?.addEventListener("abort", () => {
            pendingWork.delete(stdId);
            reject(signal.reason);
          }, { once: true });
        });
      });

      const responsePromise = bulkRequest({ mode: "code-to-stdid", targets: targetCodes.map(String), allowCrossLookup: true });
      await vi.waitFor(() => expect([...enteredIds].filter((stdId) => startedWork.has(stdId)).length).toBe(2));
      expect(probeBudget.activeLeaseCount).toBe(2);

      // Either target can win the shared permit race. Release any +1 probes
      // that acquired a permit so both exact-priority -1 probes can enter.
      projectedIds.forEach((projectedId, index) => {
        if (pendingWork.has(projectedId + 1)) completeWork(projectedId + 1, "<html>headerless</html>");
        if (pendingWork.has(projectedId - 1)) completeWork(projectedId - 1, `<table><tr><td>Mã số: ${targetCodes[index]}</td></tr></table>`);
      });
      await Promise.all(projectedIds.map((projectedId) => waitForWork(projectedId - 1)));
      expect(probeBudget.activeLeaseCount).toBeLessThanOrEqual(2);
      projectedIds.forEach((projectedId, index) => {
        if (pendingWork.has(projectedId - 1)) completeWork(projectedId - 1, `<table><tr><td>Mã số: ${targetCodes[index]}</td></tr></table>`);
      });

      const response = await responsePromise;
      const payload = await response.json() as { data: { items: Array<{ target: string; status: string }> } };

      expect(response.status).toBe(200);
      expect(payload.data.items.map(({ target, status }) => ({ target, status }))).toEqual(targetCodes.map((target) => ({ target: String(target), status: "ok" })));
      expect(probeBudget.reservedAmounts).toEqual([66]);
      expect(probeBudget.peakActiveLeases).toBeLessThanOrEqual(2);
      expect(probeBudget.activeLeaseCount).toBe(0);
    });

    it("per-item nonconverged remains isolated and ordered", async () => {
      profileSpy.mockResolvedValue(`<input name="hidStdID" value="${SYNTHETIC_VNU_STD_ID}"><input name="StdCode" value="${SYNTHETIC_VNU_CODE}">`);
      const missingCode = SYNTHETIC_VNU_CODE + 100;
      const foundCode = SYNTHETIC_VNU_CODE + 200;
      const foundStdId = SYNTHETIC_VNU_STD_ID + 200;
      transcriptSpy.mockImplementation(async (stdIdText: string) => Number(stdIdText) === foundStdId
        ? `<table><tr><td>Mã số: ${foundCode}</td></tr></table>`
        : "<html>headerless</html>");

      const response = await bulkRequest({ mode: "code-to-stdid", targets: [String(missingCode), String(foundCode)], allowCrossLookup: true });
      const payload = await response.json() as { data: { items: Array<Record<string, unknown>> } };

      expect(response.status).toBe(200);
      expect(payload.data.items).toMatchObject([
        { target: String(missingCode), status: "error", errorCode: "VNU_CROSS_LOOKUP_NOT_CONVERGED" },
        { target: String(foundCode), status: "ok", result: { stdId: String(foundStdId) } },
      ]);
    });

    it("aborted bulk request starts no later item", async () => {
      const controller = new AbortController();
      const reason = { cancelled: "bulk" };
      transcriptSpy.mockImplementation(async (_stdId: string, signal?: AbortSignal) => new Promise<string>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }));
      const token = await encryptSession(vnuSession(), SESSION_SECRET);
      const responsePromise = app.handle(new Request("http://localhost/api/vnu/cross-lookup/bulk", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "stdid-to-code", targets: ["1001", "1002", "1003"], allowCrossLookup: true }),
        signal: controller.signal,
      }));
      await vi.waitFor(() => expect(transcriptSpy).toHaveBeenCalledOnce());
      controller.abort(reason);

      const response = await responsePromise;
      expect(response.status).toBe(500);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(transcriptSpy).toHaveBeenCalledOnce();
    });

    it("fails with 503 before Brc1 when the reservation service is unavailable", async () => {
      probeBudget.unavailable = true;
      const response = await bulkRequest({ mode: "stdid-to-code", targets: ["1001"], allowCrossLookup: true });

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_PROBE_BUDGET_UNAVAILABLE" } });
      expect(transcriptSpy).not.toHaveBeenCalled();
    });

    it("returns full parsed transcript models and no raw HTML", async () => {
      const response = await bulkRequest({ mode: "stdid-to-transcript", targets: ["1001"], allowCrossLookup: true });
      const payload = await response.json() as { data: { items: Array<Record<string, unknown>> } };

      expect(response.status).toBe(200);
      expect(payload.data.items).toMatchObject([{ target: "1001", status: "ok", result: { header: { studentCode: "20000001" }, terms: [{ maHK: "251" }], totals: { totalCredits: 3 } } }]);
      expect(JSON.stringify(payload)).not.toContain("<table>");
      expect(probeBudget.amounts).toEqual([1]);
    });

    it("removes upstream notice prose from bulk transcript results", async () => {
      const upstreamNoticeSentinel = "UPSTREAM_NOTICE_SENTINEL_DO_NOT_EXPOSE";
      transcriptSpy.mockResolvedValue(`${targetTranscriptHtml}<font color="red">${upstreamNoticeSentinel}</font>`);

      const response = await bulkRequest({ mode: "stdid-to-transcript", targets: ["1001"], allowCrossLookup: true });
      const payload = await response.text();

      expect(response.status).toBe(200);
      expect(payload).not.toContain(upstreamNoticeSentinel);
      expect(payload).not.toContain("notice");
    });

    it("keeps reservations isolated between sessions", async () => {
      probeBudget.limit = 1;
      const first = await bulkRequest({ mode: "stdid-to-code", targets: ["1001"], allowCrossLookup: true }, { ...vnuSession(), vnu: { ...vnuSession().vnu!, value: "BULK_SESSION_A" } });
      const exhausted = await bulkRequest({ mode: "stdid-to-code", targets: ["1002"], allowCrossLookup: true }, { ...vnuSession(), vnu: { ...vnuSession().vnu!, value: "BULK_SESSION_A" } });
      const second = await bulkRequest({ mode: "stdid-to-code", targets: ["1002"], allowCrossLookup: true }, { ...vnuSession(), vnu: { ...vnuSession().vnu!, value: "BULK_SESSION_B" } });

      expect([first.status, exhausted.status, second.status]).toEqual([200, 429, 200]);
      expect(new Set(probeBudget.identities).size).toBe(2);
    });
  });

  it("normalizes self-hosted VNU file values and gives environment values precedence", () => {
    const fileConfig: RuntimeConfig = {
      VNU_CODE_LOOKUP_CONCURRENCY: "16",
      VNU_CROSS_LOOKUP_BULK_MAX_TARGETS: "75",
    };

    expect(selfHostedRuntimeConfig({
      HYEB_SESSION_SECRET: SESSION_SECRET,
      VNU_CODE_LOOKUP_CONCURRENCY: "32",
    }, fileConfig)).toMatchObject({
      VNU_CODE_LOOKUP_CONCURRENCY: "32",
      VNU_CROSS_LOOKUP_BULK_MAX_TARGETS: "75",
    });
  });

});

describe("UET raw read routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET });
  });

  afterEach(() => vi.restoreAllMocks());

  it("rejects unauthenticated and unknown raw resources", async () => {
    const app = createApp(undefined);
    const token = await encryptSession(rawUetSession(), SESSION_SECRET);

    const unauthenticated = await app.handle(new Request("http://localhost/api/uet/raw/profile"));
    const unknown = await app.handle(new Request("http://localhost/api/uet/raw/not-a-resource", {
      headers: { Authorization: `Bearer ${token}` },
    }));

    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("Cache-Control")).toBe("no-store, private");
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("Cache-Control")).toBe("no-store, private");
    await expect(unknown.json()).resolves.toMatchObject({ error: { code: "UET_RAW_RESOURCE_UNKNOWN" } });
  });

  it("returns only an allowlisted unwrapped StudentHub payload", async () => {
    const timetable = [{ courseCode: "SYN101", termCode: "251", sessionStart: 1 }];
    const getTimetable = vi.spyOn(StudentHubClient.prototype, "getTimetable").mockResolvedValue(timetable);
    const app = createApp(undefined);
    const token = await encryptSession(rawUetSession(), SESSION_SECRET);

    const response = await app.handle(new Request("http://localhost/api/uet/raw/timetable?termCode=251", {
      headers: { Authorization: `Bearer ${token}` },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store, private");
    await expect(response.json()).resolves.toEqual({ data: timetable, error: null });
    expect(getTimetable).toHaveBeenCalledWith("251");
  });
});

describe("VNU cross-detail HTTP routes", () => {
  let app: ReturnType<typeof createApp>;
  let probeBudget: TestVnuProbeBudget;
  let detailSpy: ReturnType<typeof vi.spyOn>;
  let profileSpy: ReturnType<typeof vi.spyOn>;
  let transcriptSpy: ReturnType<typeof vi.spyOn>;
  let validateSpy: ReturnType<typeof vi.spyOn>;

  async function bearerToken(cookie: string): Promise<string> {
    return encryptSession({ ...vnuSession(), vnu: { ...vnuSession().vnu!, value: cookie } }, SESSION_SECRET);
  }

  async function issuePermit(token: string, targetStdId = "99000000001"): Promise<string> {
    const minter = createVnuCrossDetailMinter({
      secret: SESSION_SECRET,
      requesterToken: token,
      maxTargets: 1,
      maxRows: 2,
      permitTtlSeconds: 60,
    });
    const permit = await minter.mint({
      targetStdId,
      transcriptHtml: "<table>synthetic transcript</table>",
      row: { courseCode: "SYN9901", classId: "990099", termOrdinal: "2" },
    });
    if (!permit) throw new Error("Synthetic cross-detail permit was not minted");
    await probeBudget.issueCrossDetailPermits("synthetic-session", minter.issued);
    return permit;
  }

  async function requestRoute(path: string, token: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    return app.handle(new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    setRuntimeConfig({
      HYEB_SESSION_SECRET: SESSION_SECRET,
      VNU_CROSS_DETAIL_MAX_TARGETS: "1",
      VNU_CROSS_DETAIL_MAX_ROWS: "2",
      VNU_CROSS_DETAIL_CONCURRENCY: "1",
      VNU_CROSS_DETAIL_BUDGET: "2",
      VNU_CROSS_DETAIL_WINDOW_SECONDS: "60",
      VNU_CROSS_DETAIL_PERMIT_TTL_SECONDS: "60",
      VNU_CROSS_DETAIL_EXPORT_MODE: "selected",
    });
    probeBudget = new TestVnuProbeBudget();
    setVnuProbeBudgetCoordinator(probeBudget);
    profileSpy = vi.spyOn(DaotaoClient.prototype, "getProfileHtml").mockResolvedValue('<input name="hidStdID" value="1000"><input name="StdCode" value="20000000">');
    transcriptSpy = vi.spyOn(DaotaoClient.prototype, "getTranscriptByStdIdHtml").mockResolvedValue("<table><tr><td>Sinh viên: SYNTHETIC</td><td>Mã số: 20000001</td></tr></table>");
    detailSpy = vi.spyOn(DaotaoClient.prototype, "getPointDetailHtml").mockResolvedValue("<p>Điểm chi tiết môn học - Học kỳ 2. Mã học kỳ 252</p><table><tr><td>STT</td><td>Bản chất kỳ thi</td><td>TS</td><td>Lần thi</td><td>Điểm</td><td>Ghi chú</td></tr><tr><td>1</td><td>Synthetic component</td><td>0.5</td><td>1</td><td>9</td><td></td></tr></table>");
    validateSpy = vi.spyOn(DaotaoClient.prototype, "validateSession").mockResolvedValue("");
    app = createApp(undefined);
  });

  afterEach(() => {
    detailSpy.mockRestore();
    profileSpy.mockRestore();
    transcriptSpy.mockRestore();
    validateSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("keeps transcript permit issuance and its errors private", async () => {
    const token = await bearerToken("SYNTHETIC_ISSUANCE_COOKIE");
    const success = await app.handle(new Request("http://localhost/api/vnu/cross-lookup/transcript?stdId=1001&allowCrossLookup=true", { headers: { Authorization: `Bearer ${token}` } }));
    const failure = await app.handle(new Request("http://localhost/api/vnu/cross-lookup/transcript?allowCrossLookup=true", { headers: { Authorization: `Bearer ${token}` } }));

    expect(success.status).toBe(200);
    expect(success.headers.get("Cache-Control")).toBe("no-store, private");
    expect(failure.headers.get("Cache-Control")).toBe("no-store, private");
  });


  it("rejects a wrong-bearer permit with the generic invalid response", async () => {
    const permitOwner = await bearerToken("SYNTHETIC_OWNER_COOKIE");
    const otherBearer = await bearerToken("SYNTHETIC_OTHER_COOKIE");
    const permit = await issuePermit(permitOwner);

    const response = await requestRoute("/api/vnu/cross-lookup/detail", otherBearer, { allowCrossLookup: true, permit });

    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("no-store, private");
    await expect(response.json()).resolves.toEqual({ data: null, error: { code: "VNU_CROSS_DETAIL_PERMIT_INVALID", message: "The cross-detail permit is invalid or expired." } });
  });

  it("rejects selector smuggling and selected-export omissions through HTTP handlers", async () => {
    const token = await bearerToken("SYNTHETIC_BODY_COOKIE");
    const permit = await issuePermit(token);
    const smuggled = await requestRoute("/api/vnu/cross-lookup/detail", token, { allowCrossLookup: true, permit, stdId: "99000000002" });
    const unselectedExport = await requestRoute("/api/vnu/cross-lookup/detail/export", token, { allowCrossLookup: true });

    expect(smuggled.status).toBe(400);
    expect(smuggled.headers.get("Cache-Control")).toBe("no-store, private");
    await expect(smuggled.json()).resolves.toMatchObject({ error: { code: "VNU_CROSS_DETAIL_BODY_INVALID" } });
    expect(unselectedExport.status).toBe(400);
    expect(unselectedExport.headers.get("Cache-Control")).toBe("no-store, private");
    await expect(unselectedExport.json()).resolves.toMatchObject({ error: { code: "VNU_CROSS_DETAIL_EXPORT_NOT_SELECTED" } });
  });

  it("handles success, replay, and selected export with private no-store responses", async () => {
    const token = await bearerToken("SYNTHETIC_SUCCESS_COOKIE");
    const permit = await issuePermit(token);
    const detail = await requestRoute("/api/vnu/cross-lookup/detail", token, { allowCrossLookup: true, permit });
    const replay = await requestRoute("/api/vnu/cross-lookup/detail", token, { allowCrossLookup: true, permit });
    const exportPermit = await issuePermit(token);
    const selectedExport = await requestRoute("/api/vnu/cross-lookup/detail/export", token, { allowCrossLookup: true, permits: [exportPermit] });

    expect(detail.status).toBe(200);
    expect(detail.headers.get("Cache-Control")).toBe("no-store, private");
    expect(replay.status).toBe(403);
    expect(replay.headers.get("Cache-Control")).toBe("no-store, private");
    await expect(replay.json()).resolves.toMatchObject({ error: { code: "VNU_CROSS_DETAIL_PERMIT_INVALID" } });
    expect(selectedExport.status).toBe(200);
    expect(selectedExport.headers.get("Cache-Control")).toBe("no-store, private");
  });

  it("rejects expired permits through the HTTP route", async () => {
    const token = await bearerToken("SYNTHETIC_EXPIRED_COOKIE");
    const minter = createVnuCrossDetailMinter({ secret: SESSION_SECRET, requesterToken: token, maxTargets: 1, maxRows: 1, permitTtlSeconds: -1 });
    const permit = await minter.mint({ targetStdId: "99000000001", transcriptHtml: "synthetic", row: { courseCode: "SYN9901", classId: "990099", termOrdinal: "2" } });
    await probeBudget.issueCrossDetailPermits("synthetic-session", minter.issued);
    const response = await requestRoute("/api/vnu/cross-lookup/detail", token, { allowCrossLookup: true, permit });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_CROSS_DETAIL_PERMIT_INVALID" } });
  });


  it("pads the upstream detail student ID and rejects a generic portal page", async () => {
    const token = await bearerToken("SYNTHETIC_SHAPE_COOKIE");
    const permit = await issuePermit(token, "12345");
    detailSpy.mockRestore();
    const wrongPageHtml = `<html><head><title>Xem thông tin sinh vien</title></head><body><table><tr><td>Synthetic portal shell</td></tr></table></body></html>`;
    const upstreamResponse = new Response(wrongPageHtml);
    Object.defineProperty(upstreamResponse, "url", { value: "https://daotao.vnu.edu.vn/ListPoint/detailPoint.asp" });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(upstreamResponse);
    vi.stubGlobal("fetch", fetchMock);

    const response = await requestRoute("/api/vnu/cross-lookup/detail", token, { allowCrossLookup: true, permit });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://daotao.vnu.edu.vn/ListPoint/detailPoint.asp?id=990099&val=&StdID=00000012345&Term=2",
      expect.objectContaining({ redirect: "follow" }),
    );
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      data: null,
      error: {
        code: "VNU_UPSTREAM_RESPONSE_INVALID",
        message: "daotao.vnu.edu.vn returned an unexpected point-detail page.",
      },
    });
    expect(probeBudget.releasedCrossDetailLeases).toHaveLength(1);
  });

  it("releases consumed detail leases after upstream rejection and request abort", async () => {
    const token = await bearerToken("SYNTHETIC_RELEASE_COOKIE");
    detailSpy.mockRejectedValueOnce(new Error("Synthetic upstream failure"));
    const rejected = await requestRoute("/api/vnu/cross-lookup/detail", token, { allowCrossLookup: true, permit: await issuePermit(token) });
    expect(rejected.status).toBe(500);
    expect(probeBudget.releasedCrossDetailLeases).toHaveLength(1);

    const controller = new AbortController();
    detailSpy.mockImplementationOnce(async (_selector: unknown, signal?: AbortSignal) => new Promise<string>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true })));
    const abortedRequest = requestRoute("/api/vnu/cross-lookup/detail", token, { allowCrossLookup: true, permit: await issuePermit(token) }, controller.signal);
    await vi.waitFor(() => expect(detailSpy).toHaveBeenCalledTimes(2));
    controller.abort(new DOMException("Synthetic abort", "AbortError"));
    await abortedRequest;
    expect(probeBudget.releasedCrossDetailLeases).toHaveLength(2);
  });
});

describe("VNU cross-detail bulk grouping", () => {
  let app: ReturnType<typeof createApp>;
  let probeBudget: TestVnuProbeBudget;
  let detailSpy: ReturnType<typeof vi.spyOn>;
  let profileSpy: ReturnType<typeof vi.spyOn>;
  let transcriptSpy: ReturnType<typeof vi.spyOn>;
  let validateSpy: ReturnType<typeof vi.spyOn>;

  async function bearerToken(cookie: string): Promise<string> {
    return encryptSession({ ...vnuSession(), vnu: { ...vnuSession().vnu!, value: cookie } }, SESSION_SECRET);
  }

  async function requestRoute(path: string, token: string, body: unknown): Promise<Response> {
    return app.handle(new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    setRuntimeConfig({
      HYEB_SESSION_SECRET: SESSION_SECRET,
      VNU_CROSS_DETAIL_MAX_TARGETS: "4",
      VNU_CROSS_DETAIL_MAX_ROWS: "6",
      VNU_CROSS_DETAIL_CONCURRENCY: "1",
      VNU_CROSS_DETAIL_BUDGET: "10",
      VNU_CROSS_DETAIL_WINDOW_SECONDS: "60",
      VNU_CROSS_DETAIL_PERMIT_TTL_SECONDS: "60",
      VNU_CROSS_DETAIL_EXPORT_MODE: "selected",
    });
    probeBudget = new TestVnuProbeBudget();
    setVnuProbeBudgetCoordinator(probeBudget);
    profileSpy = vi.spyOn(DaotaoClient.prototype, "getProfileHtml").mockResolvedValue('<input name="hidStdID" value="1000"><input name="StdCode" value="20000000">');
    transcriptSpy = vi.spyOn(DaotaoClient.prototype, "getTranscriptByStdIdHtml").mockResolvedValue("<table><tr><td>Sinh viên: SYNTHETIC</td><td>Mã số: 20000001</td></tr></table>");
    detailSpy = vi.spyOn(DaotaoClient.prototype, "getPointDetailHtml").mockResolvedValue("<p>Điểm chi tiết môn học - Học kỳ 2. Mã học kỳ 252</p><table><tr><td>STT</td><td>Bản chất kỳ thi</td><td>TS</td><td>Lần thi</td><td>Điểm</td><td>Ghi chú</td></tr><tr><td>1</td><td>Synthetic component</td><td>0.5</td><td>1</td><td>9</td><td></td></tr></table>");
    validateSpy = vi.spyOn(DaotaoClient.prototype, "validateSession").mockResolvedValue("");
    app = createApp(undefined);
  });

  afterEach(() => {
    detailSpy.mockRestore();
    profileSpy.mockRestore();
    transcriptSpy.mockRestore();
    validateSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  async function issuePermits(token: string, options: {
    count: number;
    targetStdId?: string;
    startClassId?: number;
  }): Promise<string[]> {
    const targetStdId = options.targetStdId ?? "99000000001";
    const minter = createVnuCrossDetailMinter({
      secret: SESSION_SECRET,
      requesterToken: token,
      maxTargets: 4,
      maxRows: options.count,
      permitTtlSeconds: 60,
    });
    const permits: string[] = [];
    const start = options.startClassId ?? 990099;
    for (let index = 0; index < options.count; index += 1) {
      const permit = await minter.mint({
        targetStdId,
        transcriptHtml: "<table>synthetic transcript</table>",
        row: { courseCode: `SYN${9901 + index}`, classId: String(start + index), termOrdinal: "2" },
      });
      if (!permit) throw new Error("Synthetic cross-detail permit was not minted");
      permits.push(permit);
    }
    await probeBudget.issueCrossDetailPermits("synthetic-session", minter.issued);
    return permits;
  }

  it("groups same-stdId bulk permits under a single warm-up and processes sequentially", async () => {
    const token = await bearerToken("SYNTHETIC_GROUP_COOKIE");
    const permits = await issuePermits(token, { count: 3 });

    const response = await requestRoute("/api/vnu/cross-lookup/detail/bulk", token, {
      allowCrossLookup: true,
      permits,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store, private");
    const body = await response.json() as { data: { items: Array<{ permit: string; status: string; html?: string; errorCode?: string }> }; error: null };
    expect(body.data.items).toHaveLength(3);
    for (const item of body.data.items) {
      expect(item.status).toBe("ok");
      expect(item.html).toContain("Synthetic component");
    }

    // Warm-up happened exactly once (single stdId group)
    expect(transcriptSpy).toHaveBeenCalledTimes(1);
    expect(transcriptSpy).toHaveBeenCalledWith("99000000001", expect.anything());

    // Detail fetched for each permit
    expect(detailSpy).toHaveBeenCalledTimes(3);

    // All leases released
    expect(probeBudget.releasedCrossDetailLeases).toHaveLength(3);
  });

  it("warms up once per distinct stdId and processes each group independently", async () => {
    const token = await bearerToken("SYNTHETIC_MULTI_GROUP_COOKIE");
    const permitsA = await issuePermits(token, { count: 2, targetStdId: "99000000001", startClassId: 990100 });
    const permitsB = await issuePermits(token, { count: 2, targetStdId: "99000000002", startClassId: 990200 });
    const permits = [...permitsA, ...permitsB];

    const response = await requestRoute("/api/vnu/cross-lookup/detail/bulk", token, {
      allowCrossLookup: true,
      permits,
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { data: { items: Array<{ permit: string; status: string }> }; error: null };
    expect(body.data.items).toHaveLength(4);
    expect(body.data.items.every((item) => item.status === "ok")).toBe(true);

    // Two warm-ups: one per stdId group
    expect(transcriptSpy).toHaveBeenCalledTimes(2);
    expect(detailSpy).toHaveBeenCalledTimes(4);
    expect(probeBudget.releasedCrossDetailLeases).toHaveLength(4);
  });

  it("propagates isolated warm-up failure to all permits in the same group", async () => {
    const token = await bearerToken("SYNTHETIC_WARM_FAIL_COOKIE");

    // Group A: will succeed
    const permitsA = await issuePermits(token, { count: 1, targetStdId: "99000000001", startClassId: 990300 });

    // Group B: warm-up will fail
    const permitsB = await issuePermits(token, { count: 2, targetStdId: "99000000002", startClassId: 990400 });
    transcriptSpy.mockRestore();
    transcriptSpy = vi.spyOn(DaotaoClient.prototype, "getTranscriptByStdIdHtml").mockImplementation(async (stdId: string) => {
      if (stdId === "99000000002") throw new HyeboardError("VNU_SESSION_EXPIRED", "Synthetic session expiry", 401);
      return "<table><tr><td>Sinh viên: SYNTHETIC</td><td>Mã số: 20000001</td></tr></table>";
    });

    const permits = [...permitsA, ...permitsB];
    const response = await requestRoute("/api/vnu/cross-lookup/detail/bulk", token, {
      allowCrossLookup: true,
      permits,
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VNU_SESSION_EXPIRED" } });
  });

  it("preserves original permit order in the response", async () => {
    const token = await bearerToken("SYNTHETIC_ORDER_COOKIE");
    const permits = await issuePermits(token, { count: 3 });

    const response = await requestRoute("/api/vnu/cross-lookup/detail/bulk", token, {
      allowCrossLookup: true,
      permits,
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { data: { items: Array<{ permit: string }> }; error: null };
    expect(body.data.items.map((item) => item.permit)).toEqual(permits);
  });

  it("handles invalid permits alongside valid ones in the same batch", async () => {
    const token = await bearerToken("SYNTHETIC_MIXED_COOKIE");
    const valid = await issuePermits(token, { count: 2 });
    const invalid = "ffffffffffffffffffffffffffffffff.XYZ.invalid";

    const response = await requestRoute("/api/vnu/cross-lookup/detail/bulk", token, {
      allowCrossLookup: true,
      permits: [valid[0], invalid, valid[1]],
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { data: { items: Array<{ permit: string; status: string; errorCode?: string }> }; error: null };
    expect(body.data.items).toHaveLength(3);
    expect(body.data.items.map((item) => item.permit)).toEqual([valid[0], invalid, valid[1]]);

    const invalidItem = body.data.items.find((item) => item.permit === invalid);
    expect(invalidItem!.status).toBe("error");
    expect(invalidItem!.errorCode).toBe("VNU_CROSS_DETAIL_PERMIT_INVALID");

    const validItems = body.data.items.filter((item) => item !== invalidItem);
    expect(validItems.every((item) => item.status === "ok")).toBe(true);
    expect(probeBudget.releasedCrossDetailLeases).toHaveLength(2);
  });

  it("processes both bulk and export routes through the batch grouper", async () => {
    const token = await bearerToken("SYNTHETIC_EXPORT_COOKIE");
    const permits = await issuePermits(token, { count: 2 });

    const bulk = await requestRoute("/api/vnu/cross-lookup/detail/bulk", token, {
      allowCrossLookup: true,
      permits,
    });
    expect(bulk.status).toBe(200);
    expect(((await bulk.json()) as { data: { items: unknown[] } }).data.items).toHaveLength(2);

    // Export has its own permit set (single-use, bulk consumed the old ones)
    const exportPermits = await issuePermits(token, { count: 2 });
    const selectedExport = await requestRoute("/api/vnu/cross-lookup/detail/export", token, {
      allowCrossLookup: true,
      permits: exportPermits,
    });
    expect(selectedExport.status).toBe(200);
    expect(((await selectedExport.json()) as { data: { items: unknown[] } }).data.items).toHaveLength(2);

    // Two groups (one per request), one warm-up each
    expect(transcriptSpy).toHaveBeenCalledTimes(2);
    expect(detailSpy).toHaveBeenCalledTimes(4);
    expect(probeBudget.releasedCrossDetailLeases).toHaveLength(4);
  });
});
