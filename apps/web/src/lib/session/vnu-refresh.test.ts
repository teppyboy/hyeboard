import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type StoredAccount } from "../api/api-types";
import {
  classifyVnuRecovery,
  clearVnuRefreshGrant,
  readVnuRefreshGrant,
  requestPolicyFor,
  runVnuRefresh,
  storeVnuRefreshGrant,
} from "./vnu-refresh";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

const ACCOUNT: StoredAccount = {
  id: "account-alpha",
  universityId: "vnu",
  token: "failed-token-alpha",
  studentCode: "SYNTHETIC-STUDENT-ALPHA",
  addedAt: "2036-01-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.stubGlobal("sessionStorage", new MemoryStorage());
  vi.stubGlobal("localStorage", new MemoryStorage());
});

afterEach(() => vi.unstubAllGlobals());

describe("VNU refresh storage and policy", () => {
  it("stores grants by opaque local account only in sessionStorage", () => {
    storeVnuRefreshGrant(ACCOUNT.id, "opaque-grant-alpha");
    storeVnuRefreshGrant("account-beta", "opaque-grant-beta");
    expect(readVnuRefreshGrant(ACCOUNT.id)).toBe("opaque-grant-alpha");
    expect(readVnuRefreshGrant("account-beta")).toBe("opaque-grant-beta");
    expect(localStorage.length).toBe(0);
    expect([...Array(sessionStorage.length)].map((_, index) => sessionStorage.key(index))).toEqual([
      "hyeboard.vnu.refreshGrant.account-alpha",
      "hyeboard.vnu.refreshGrant.account-beta",
    ]);
    clearVnuRefreshGrant(ACCOUNT.id);
    expect(readVnuRefreshGrant(ACCOUNT.id)).toBeUndefined();
    expect(readVnuRefreshGrant("account-beta")).toBe("opaque-grant-beta");
  });

  it.each([
    [new ApiError("expired", "VNU_SESSION_EXPIRED", 401), true],
    [new ApiError("missing", "VNU_LOGIN_REQUIRED", 401, { reason: "MISSING_VNU_CREDENTIAL" }), true],
    [new ApiError("broad", "VNU_LOGIN_REQUIRED", 401), false],
    [new ApiError("wrong", "VNU_LOGIN_REQUIRED", 401, {}), false],
    [new ApiError("profile", "VNU_PROFILE_INCOMPLETE", 500), false],
    [new Error("VNU_SESSION_EXPIRED"), false],
  ])("classifies exact recoverability", (error, expected) => {
    expect(classifyVnuRecovery(error)).toBe(expected);
  });

  it("rejects mixed, non-object, and prototype-derived recovery details", () => {
    const inherited = Object.create({ reason: "MISSING_VNU_CREDENTIAL" }) as unknown;
    const cases: unknown[] = [
      { reason: "MISSING_VNU_CREDENTIAL", privateKey: "SYNTHETIC-PRIVATE" },
      { reason: "MISSING_VNU_CREDENTIAL", retryAfterSeconds: 5 },
      inherited,
      null,
      ["MISSING_VNU_CREDENTIAL"],
      { reason: "SYNTHETIC-UNKNOWN" },
    ];
    for (const details of cases) {
      const error = new ApiError("missing", "VNU_LOGIN_REQUIRED", 401, details as never);
      expect(classifyVnuRecovery(error)).toBe(false);
    }
  });

  it.each([
    ["get", "/api/vnu/raw/profile", "safe-replay"],
    ["GET", "/api/vnu/raw/point-detail?id=SYNTHETIC", "safe-replay"],
    ["GET", "/api/vnu/dashboard?term=SYNTHETIC", "safe-replay"],
    ["GET", "/api/vnu/cross-lookup/student-code?allowCrossLookup=true", "refresh-no-replay"],
    ["POST", "/api/vnu/cross-lookup/bulk", "refresh-no-replay"],
    ["POST", "/api/vnu/raw/profile", "never"],
    ["HEAD", "/api/vnu/dashboard", "never"],
    ["POST", "/api/vnu/auth/refresh", "never"],
    ["GET", "/api/vnu/auth/solve-captcha", "never"],
    ["GET", "/api/vnu/unlisted", "never"],
    ["GET", "/api/uet/dashboard", "never"],
  ] as const)("maps %s %s to %s", (method, pathname, expected) => {
    expect(requestPolicyFor({ method, pathname })).toBe(expected);
  });
});

describe("VNU refresh single-flight", () => {
  it("joins one account/token generation and commits/invalidate once", async () => {
    const auth = {
      token: "rotated-token-alpha",
      refreshGrant: "rotated-grant-alpha",
      session: { universityId: "vnu", studentCode: "SYNTHETIC-STUDENT-ALPHA", expiresAt: "2036-01-01T08:00:00.000Z", authenticated: true as const },
    };
    let resolveRefresh!: (value: typeof auth) => void;
    const fetchRefresh = vi.fn(() => new Promise<typeof auth>((resolve) => { resolveRefresh = resolve; }));
    const deps = {
      getAccount: () => ACCOUNT,
      getActiveAccountId: () => ACCOUNT.id,
      fetchRefresh,
      commit: vi.fn(() => true),
      terminal: vi.fn(),
      invalidate: vi.fn(),
      status: vi.fn(),
    };
    storeVnuRefreshGrant(ACCOUNT.id, "opaque-grant-alpha");
    const first = runVnuRefresh(ACCOUNT, undefined, deps);
    const second = runVnuRefresh(ACCOUNT, undefined, deps);
    resolveRefresh(auth);
    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: "committed", auth },
      { kind: "committed", auth },
    ]);
    expect(fetchRefresh).toHaveBeenCalledTimes(1);
    expect(deps.commit).toHaveBeenCalledTimes(1);
    expect(deps.invalidate).toHaveBeenCalledTimes(1);
  });

  it("keeps shared work for one waiter and aborts only after all waiters cancel", async () => {
    const refreshAbort = vi.fn();
    const fetchRefresh = vi.fn((_account: StoredAccount, _grant: string, signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => { refreshAbort(); reject(signal.reason); });
    }));
    const deps = { getAccount: () => ACCOUNT, getActiveAccountId: () => ACCOUNT.id, fetchRefresh, commit: vi.fn(), terminal: vi.fn(), invalidate: vi.fn(), status: vi.fn() };
    storeVnuRefreshGrant(ACCOUNT.id, "opaque-grant-alpha");
    const a = new AbortController();
    const b = new AbortController();
    const first = runVnuRefresh(ACCOUNT, a.signal, deps);
    const second = runVnuRefresh(ACCOUNT, b.signal, deps);
    a.abort(new DOMException("first cancelled", "AbortError"));
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(refreshAbort).not.toHaveBeenCalled();
    b.abort(new DOMException("second cancelled", "AbortError"));
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(refreshAbort).toHaveBeenCalledTimes(1);
    expect(deps.commit).not.toHaveBeenCalled();
  });

  it("makes an all-waiter-cancelled late success inert and allows a fresh flight", async () => {
    const lateAuth = {
      token: "obsolete-rotated-token",
      refreshGrant: "obsolete-rotated-grant",
      session: { universityId: "vnu", studentCode: ACCOUNT.studentCode, expiresAt: "2036-01-01T08:00:00.000Z", authenticated: true as const },
    };
    const freshAuth = {
      token: "fresh-rotated-token",
      refreshGrant: "fresh-rotated-grant",
      session: { universityId: "vnu", studentCode: ACCOUNT.studentCode, expiresAt: "2036-01-01T08:00:00.000Z", authenticated: true as const },
    };
    let releaseLate!: () => void;
    const lateReleased = new Promise<void>((resolve) => { releaseLate = resolve; });
    let markOldSettled!: () => void;
    const oldSettled = new Promise<void>((resolve) => { markOldSettled = resolve; });
    const refreshAbort = vi.fn();
    const fetchRefresh = vi.fn()
      .mockImplementationOnce(async (_account: StoredAccount, _grant: string, signal: AbortSignal) => {
        signal.addEventListener("abort", refreshAbort, { once: true });
        await lateReleased;
        return lateAuth;
      })
      .mockResolvedValueOnce(freshAuth);
    const deps = {
      getAccount: () => ACCOUNT,
      getActiveAccountId: () => ACCOUNT.id,
      fetchRefresh,
      commit: vi.fn(() => true),
      terminal: vi.fn(),
      invalidate: vi.fn(),
      status: vi.fn(),
      onFlightSettled: markOldSettled,
    };
    storeVnuRefreshGrant(ACCOUNT.id, "opaque-grant-alpha");
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = runVnuRefresh(ACCOUNT, firstController.signal, deps);
    const second = runVnuRefresh(ACCOUNT, secondController.signal, deps);

    firstController.abort(new DOMException("first cancelled", "AbortError"));
    secondController.abort(new DOMException("second cancelled", "AbortError"));
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(refreshAbort).toHaveBeenCalledTimes(1);
    deps.commit.mockClear();
    deps.terminal.mockClear();
    deps.invalidate.mockClear();
    deps.status.mockClear();

    releaseLate();
    await oldSettled;
    expect(deps.commit).not.toHaveBeenCalled();
    expect(deps.terminal).not.toHaveBeenCalled();
    expect(deps.invalidate).not.toHaveBeenCalled();
    expect(deps.status).not.toHaveBeenCalled();
    expect(readVnuRefreshGrant(ACCOUNT.id)).toBe("opaque-grant-alpha");

    const fresh = runVnuRefresh(ACCOUNT, undefined, { ...deps, onFlightSettled: undefined });
    await expect(fresh).resolves.toEqual({ kind: "committed", auth: freshAuth });
    expect(fetchRefresh).toHaveBeenCalledTimes(2);
    expect(deps.commit).toHaveBeenCalledTimes(1);
    expect(deps.invalidate).toHaveBeenCalledTimes(1);
  });

  it("retires an all-cancelled generation before a fresh caller arrives", async () => {
    const oldAuth = {
      token: "obsolete-rotated-token",
      refreshGrant: "obsolete-rotated-grant",
      session: { universityId: "vnu", studentCode: ACCOUNT.studentCode, expiresAt: "2036-01-01T08:00:00.000Z", authenticated: true as const },
    };
    const freshAuth = {
      token: "fresh-rotated-token",
      refreshGrant: "fresh-rotated-grant",
      session: { universityId: "vnu", studentCode: ACCOUNT.studentCode, expiresAt: "2036-01-01T08:00:00.000Z", authenticated: true as const },
    };
    let resolveOld!: (value: typeof oldAuth) => void;
    let resolveFresh!: (value: typeof freshAuth) => void;
    const fetchRefresh = vi.fn()
      .mockImplementationOnce(() => new Promise<typeof oldAuth>((resolve) => { resolveOld = resolve; }))
      .mockImplementationOnce(() => new Promise<typeof freshAuth>((resolve) => { resolveFresh = resolve; }))
      .mockImplementationOnce((_account: StoredAccount, _grant: string, signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }));
    const deps = {
      getAccount: () => ACCOUNT,
      getActiveAccountId: () => ACCOUNT.id,
      fetchRefresh,
      commit: vi.fn(() => true), terminal: vi.fn(), invalidate: vi.fn(), status: vi.fn(),
    };
    storeVnuRefreshGrant(ACCOUNT.id, "opaque-grant-alpha");
    const oldController = new AbortController();
    const addListener = vi.spyOn(oldController.signal, "addEventListener");
    const removeListener = vi.spyOn(oldController.signal, "removeEventListener");
    const oldWaiter = runVnuRefresh(ACCOUNT, oldController.signal, deps);
    oldController.abort(new DOMException("cancel old generation", "AbortError"));
    await expect(oldWaiter).rejects.toMatchObject({ name: "AbortError" });

    const freshWaiter = runVnuRefresh(ACCOUNT, undefined, deps);
    expect(fetchRefresh).toHaveBeenCalledTimes(2);
    resolveOld(oldAuth);
    await Promise.resolve();
    expect(deps.commit).not.toHaveBeenCalled();
    expect(deps.invalidate).not.toHaveBeenCalled();
    expect(readVnuRefreshGrant(ACCOUNT.id)).toBe("opaque-grant-alpha");
    expect(deps.status.mock.calls).toEqual([
      [ACCOUNT.id, "reconnecting"],
      [ACCOUNT.id, "idle"],
      [ACCOUNT.id, "reconnecting"],
    ]);

    resolveFresh(freshAuth);
    await expect(freshWaiter).resolves.toEqual({ kind: "committed", auth: freshAuth });
    expect(deps.commit).toHaveBeenCalledTimes(1);
    expect(deps.invalidate).toHaveBeenCalledTimes(1);
    expect(deps.status.mock.calls).toEqual([
      [ACCOUNT.id, "reconnecting"],
      [ACCOUNT.id, "idle"],
      [ACCOUNT.id, "reconnecting"],
      [ACCOUNT.id, "idle"],
    ]);
    expect(addListener).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledTimes(1);

    const cleanupController = new AbortController();
    const cleanupWaiter = runVnuRefresh(ACCOUNT, cleanupController.signal, deps);
    expect(fetchRefresh).toHaveBeenCalledTimes(3);
    cleanupController.abort(new DOMException("cleanup generation", "AbortError"));
    await expect(cleanupWaiter).rejects.toMatchObject({ name: "AbortError" });
  });

  it("lets one waiter cancel while another commits shared work", async () => {
    const auth = {
      token: "rotated-token-alpha",
      refreshGrant: "rotated-grant-alpha",
      session: { universityId: "vnu", studentCode: ACCOUNT.studentCode, expiresAt: "2036-01-01T08:00:00.000Z", authenticated: true as const },
    };
    let resolveRefresh!: (value: typeof auth) => void;
    const deps = {
      getAccount: () => ACCOUNT,
      getActiveAccountId: () => ACCOUNT.id,
      fetchRefresh: vi.fn(() => new Promise<typeof auth>((resolve) => { resolveRefresh = resolve; })),
      commit: vi.fn(() => true), terminal: vi.fn(), invalidate: vi.fn(), status: vi.fn(),
    };
    storeVnuRefreshGrant(ACCOUNT.id, "opaque-grant-alpha");
    const cancelled = new AbortController();
    const first = runVnuRefresh(ACCOUNT, cancelled.signal, deps);
    const second = runVnuRefresh(ACCOUNT, undefined, deps);
    cancelled.abort(new DOMException("synthetic cancel", "AbortError"));
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    resolveRefresh(auth);
    await expect(second).resolves.toEqual({ kind: "committed", auth });
    expect(deps.fetchRefresh).toHaveBeenCalledTimes(1);
    expect(deps.commit).toHaveBeenCalledTimes(1);
  });

  it("does not share flights across account IDs or failed tokens", async () => {
    const secondAccount = { ...ACCOUNT, id: "account-beta", token: "failed-token-beta" };
    const replacementToken = { ...ACCOUNT, token: "failed-token-replacement" };
    for (const account of [ACCOUNT, secondAccount, replacementToken]) storeVnuRefreshGrant(account.id, `grant-${account.token}`);
    const fetchRefresh = vi.fn((account: StoredAccount) => Promise.resolve({
      token: `rotated-${account.token}`,
      refreshGrant: `rotated-grant-${account.token}`,
      session: { universityId: "vnu", studentCode: account.studentCode, expiresAt: "2036-01-01T08:00:00.000Z", authenticated: true as const },
    }));
    const current = new Map([[ACCOUNT.id, ACCOUNT], [secondAccount.id, secondAccount]]);
    const deps = {
      getAccount: (id: string) => current.get(id),
      getActiveAccountId: () => ACCOUNT.id,
      fetchRefresh,
      commit: vi.fn(() => false), terminal: vi.fn(), invalidate: vi.fn(), status: vi.fn(),
    };

    await Promise.all([
      runVnuRefresh(ACCOUNT, undefined, deps),
      runVnuRefresh(secondAccount, undefined, { ...deps, getActiveAccountId: () => secondAccount.id }),
      runVnuRefresh(replacementToken, undefined, deps),
    ]);
    expect(fetchRefresh).toHaveBeenCalledTimes(3);
  });

  it.each(["switch", "replace", "remove", "manual-relogin"])("makes late %s resolution fully stale", async (race) => {
    const auth = {
      token: "rotated-token-alpha",
      refreshGrant: "rotated-grant-alpha",
      session: { universityId: "vnu", studentCode: ACCOUNT.studentCode, expiresAt: "2036-01-01T08:00:00.000Z", authenticated: true as const },
    };
    let current: StoredAccount | undefined = ACCOUNT;
    let activeId: string | null = ACCOUNT.id;
    let resolveRefresh!: (value: typeof auth) => void;
    const deps = {
      getAccount: () => current,
      getActiveAccountId: () => activeId,
      fetchRefresh: vi.fn(() => new Promise<typeof auth>((resolve) => { resolveRefresh = resolve; })),
      commit: vi.fn(() => true), terminal: vi.fn(), invalidate: vi.fn(), status: vi.fn(),
    };
    storeVnuRefreshGrant(ACCOUNT.id, "opaque-grant-alpha");
    const pending = runVnuRefresh(ACCOUNT, undefined, deps);
    if (race === "switch") activeId = "account-beta";
    if (race === "replace") current = { ...ACCOUNT, token: "replacement-token" };
    if (race === "remove") current = undefined;
    if (race === "manual-relogin") {
      current = { ...ACCOUNT, token: "manual-relogin-token" };
      storeVnuRefreshGrant(ACCOUNT.id, "manual-relogin-grant");
    }
    deps.commit.mockClear();
    deps.terminal.mockClear();
    deps.invalidate.mockClear();
    deps.status.mockClear();
    resolveRefresh(auth);

    await expect(pending).resolves.toEqual({ kind: "stale" });
    expect(deps.commit).not.toHaveBeenCalled();
    expect(deps.terminal).not.toHaveBeenCalled();
    expect(deps.invalidate).not.toHaveBeenCalled();
    expect(deps.status).not.toHaveBeenCalled();
    expect(readVnuRefreshGrant(ACCOUNT.id)).toBe(race === "manual-relogin" ? "manual-relogin-grant" : "opaque-grant-alpha");
  });

  it("treats stale late terminal failure as inert stale outcome", async () => {
    let current: StoredAccount | undefined = ACCOUNT;
    let rejectRefresh!: (error: unknown) => void;
    const deps = {
      getAccount: () => current,
      getActiveAccountId: () => ACCOUNT.id,
      fetchRefresh: vi.fn(() => new Promise<never>((_resolve, reject) => { rejectRefresh = reject; })),
      commit: vi.fn(), terminal: vi.fn(), invalidate: vi.fn(), status: vi.fn(),
    };
    storeVnuRefreshGrant(ACCOUNT.id, "opaque-grant-alpha");
    const pending = runVnuRefresh(ACCOUNT, undefined, deps);
    current = undefined;
    deps.terminal.mockClear();
    deps.status.mockClear();
    rejectRefresh(new ApiError("Synthetic revoked", "VNU_REFRESH_GRANT_REVOKED", 401));
    await expect(pending).resolves.toEqual({ kind: "stale" });
    expect(deps.terminal).not.toHaveBeenCalled();
    expect(deps.status).not.toHaveBeenCalled();
  });

  it.each([
    [new ApiError("Synthetic invalid", "VNU_REFRESH_GRANT_INVALID", 401), true, false],
    [new ApiError("Synthetic revoked", "VNU_REFRESH_GRANT_REVOKED", 401), true, false],
    [new ApiError("Synthetic credentials", "INVALID_VNU_CREDENTIAL", 401), true, false],
    [new ApiError("Synthetic identity", "VNU_REFRESH_IDENTITY_MISMATCH", 409), true, false],
    [new ApiError("Synthetic limited", "VNU_REFRESH_RATE_LIMITED", 429), false, true],
    [new ApiError("Synthetic unavailable", "VNU_REFRESH_UNAVAILABLE", 503), false, true],
  ])("handles terminal and retryable refresh errors exactly", async (error, terminal, retryable) => {
    const deps = {
      getAccount: () => ACCOUNT,
      getActiveAccountId: () => ACCOUNT.id,
      fetchRefresh: vi.fn().mockRejectedValue(error),
      commit: vi.fn(), terminal: vi.fn(), invalidate: vi.fn(), status: vi.fn(),
    };
    storeVnuRefreshGrant(ACCOUNT.id, "opaque-grant-alpha");
    await expect(runVnuRefresh(ACCOUNT, undefined, deps)).rejects.toBe(error);
    expect(deps.terminal).toHaveBeenCalledTimes(terminal ? 1 : 0);
    expect(deps.status).toHaveBeenCalledWith(ACCOUNT.id, "reconnecting");
    expect(deps.status).toHaveBeenCalledWith(ACCOUNT.id, retryable ? "retryable" : "reconnecting");
    expect(deps.invalidate).not.toHaveBeenCalled();
  });

  it("guards missing grant removal to the unchanged active origin", async () => {
    const terminal = vi.fn();
    const deps = {
      getAccount: () => ACCOUNT,
      getActiveAccountId: () => ACCOUNT.id,
      fetchRefresh: vi.fn(), commit: vi.fn(), terminal, invalidate: vi.fn(), status: vi.fn(),
    };
    await expect(runVnuRefresh(ACCOUNT, undefined, deps)).rejects.toMatchObject({ code: "VNU_REFRESH_GRANT_INVALID" });
    expect(terminal).toHaveBeenCalledWith(ACCOUNT);
    await expect(runVnuRefresh(ACCOUNT, undefined, { ...deps, getActiveAccountId: () => "account-beta" })).rejects.toMatchObject({ code: "VNU_REFRESH_GRANT_INVALID" });
    expect(terminal).toHaveBeenCalledTimes(1);
  });
});
