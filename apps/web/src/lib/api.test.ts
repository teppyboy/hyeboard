import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, cancelVnuRefreshForAccount, commitVnuRefresh, getActiveAccount, isSessionDeathCode, listAccounts, SESSION_TOKEN_ROTATED_EVENT, shouldInvalidateVnuRefreshQuery, shouldRetryQuery, switchAccount, VNU_REFRESH_COMMITTED_EVENT, VNU_REFRESH_STATUS_EVENT, type StoredAccount } from "./api";
import { ApiError as SharedApiError, markVnuRefreshAttempted, wasVnuRefreshAttempted } from "./api-types";
import { readVnuRefreshGrant, storeVnuRefreshGrant, VNU_REQUEST_NOT_REPLAYED } from "./vnu-refresh";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const ACCOUNT: StoredAccount = {
  id: "vnu-account",
  universityId: "vnu",
  token: "stored-session-token",
  studentCode: "SYNTHETIC-STUDENT",
  addedAt: "2026-07-27T00:00:00.000Z",
};

const SECOND_ACCOUNT: StoredAccount = {
  id: "vnu-account-99",
  universityId: "vnu",
  token: "stored-session-token-99",
  studentCode: "SYNTHETIC-STUDENT-99",
  addedAt: "2099-12-31T00:00:00.000Z",
};

const UET_ACCOUNT: StoredAccount = {
  ...ACCOUNT,
  id: "uet-account",
  universityId: "uet",
  token: "stored-uet-session-token",
};

function seedAccount(): void {
  localStorage.setItem("hyeboard.accounts", JSON.stringify([ACCOUNT]));
  localStorage.setItem("hyeboard.activeAccountId", ACCOUNT.id);
}

function rejectNextRequest(code: string, status: number): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
    data: null,
    error: { code, message: `Synthetic ${code}` },
  }), {
    status,
    headers: { "Content-Type": "application/json" },
  })));
}

function jsonOk(data: unknown): Response {
  return new Response(JSON.stringify({ data, error: null }), { headers: { "Content-Type": "application/json" } });
}

function jsonError(code: string, status: number): Response {
  return new Response(JSON.stringify({ data: null, error: { code, message: `Synthetic ${code}` } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const DETAIL_HTML = `<p>Điểm chi tiết môn học - Học kỳ 2. Mã học kỳ 252</p><table><tr><td>STT</td><td>Bản chất kỳ thi</td><td>TS</td><td>Lần thi</td><td>Điểm</td><td>Ghi chú</td></tr><tr><td>1</td><td>Synthetic component</td><td>0.5</td><td>1</td><td>9</td><td></td></tr></table>`;

describe("frontend cross-detail parsing", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("sessionStorage", new MemoryStorage());
    vi.stubGlobal("window", { dispatchEvent: vi.fn() });
    vi.stubGlobal("CustomEvent", class { constructor(readonly type: string) {} });
    seedAccount();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("parses worker HTML into the existing component model", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonOk({ permit: "permit-a", html: DETAIL_HTML })));
    await expect(api.vnuCrossDetail("permit-a")).resolves.toEqual([{ index: 1, nature: "Synthetic component", weight: 0.5, attempt: 1, score: 9, }]);
  });

  it("fails malformed worker HTML safely", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonOk({ permit: "permit-a", html: "<main>not detail</main>" })));
    await expect(api.vnuCrossDetail("permit-a")).rejects.toMatchObject({ code: "VNU_CROSS_DETAIL_RESPONSE_INVALID" });
  });

  it("rejects malformed bulk responses and permit mismatches", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonOk({ items: [{ permit: "other", status: "ok", html: DETAIL_HTML }] })));
    await expect(api.vnuCrossDetailBulk(["permit-a"])).rejects.toMatchObject({ code: "VNU_CROSS_DETAIL_RESPONSE_INVALID" });
  });
});

async function requestCrossLookup(): Promise<void> {
  await api.vnuCrossStudentId({ stdCode: "SYNTHETIC-STUDENT" });
}

describe("UET raw client mapping", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("sessionStorage", new MemoryStorage());
    vi.stubGlobal("window", { dispatchEvent: vi.fn() });
    vi.stubGlobal("CustomEvent", class { constructor(readonly type: string) {} });
    localStorage.setItem("hyeboard.accounts", JSON.stringify([UET_ACCOUNT]));
    localStorage.setItem("hyeboard.activeAccountId", UET_ACCOUNT.id);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("maps a raw StudentHub grade response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonOk([{ pointCode: "SYN-GRADE", courseCode: "SYN101", name: "Synthetic course", point4: "3.5", point10: "8.5" }])));

    await expect(api.grades("uet")).resolves.toEqual([{
      id: "SYN-GRADE", courseCode: "SYN101", courseName: "Synthetic course", credits: undefined, termCode: undefined, point4: 3.5, point10: 8.5,
    }]);
    expect(fetch).toHaveBeenCalledWith("/api/uet/raw/grades", expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer stored-uet-session-token" }) }));
  });
});

describe("VNU dashboard API mapping", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("sessionStorage", new MemoryStorage());
    vi.stubGlobal("window", { dispatchEvent: vi.fn() });
    vi.stubGlobal("CustomEvent", class { constructor(readonly type: string) {} });
    seedAccount();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("routes the VNU dashboard through the API endpoint without raw page requests", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonOk({
      student: undefined,
      currentTerm: undefined,
      todaySchedule: [],
      courses: [],
      assignments: [],
      grades: [],
      exams: [],
      notifications: [],
    })));

    await expect(api.dashboard("vnu", "251")).resolves.toMatchObject({ todaySchedule: [], grades: [] });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/vnu/dashboard?termCode=251", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer stored-session-token" }),
    }));
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining("/api/vnu/raw/"), expect.anything());
  });
});

describe("frontend session-death policy", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("sessionStorage", new MemoryStorage());
    vi.stubGlobal("window", { dispatchEvent: vi.fn() });
    vi.stubGlobal("CustomEvent", class<T = unknown> {
      readonly detail: T | null;
      constructor(readonly type: string, init?: CustomEventInit<T>) {
        this.detail = init?.detail ?? null;
      }
    });
    seedAccount();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(["VNU_RATE_LIMITED", "VNU_PROBE_BUDGET_UNAVAILABLE"])("preserves stored session and account state for %s", async (code) => {
    storeVnuRefreshGrant(ACCOUNT.id, "synthetic-refresh-grant");
    rejectNextRequest(code, code === "VNU_RATE_LIMITED" ? 429 : 503);

    await expect(requestCrossLookup()).rejects.toMatchObject({ code });

    expect(isSessionDeathCode(code)).toBe(false);
    expect(listAccounts()).toEqual([ACCOUNT]);
    expect(getActiveAccount()).toEqual(ACCOUNT);
    expect(localStorage.getItem("hyeboard.activeAccountId")).toBe(ACCOUNT.id);
    expect(readVnuRefreshGrant(ACCOUNT.id)).toBe("synthetic-refresh-grant");
  });

  it("keeps a code-less 401 inline without removing the account", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: null,
      error: { message: "Synthetic code-less failure" },
    }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    })));

    await expect(requestCrossLookup()).rejects.toMatchObject({ code: undefined, status: 401 });
    expect(listAccounts()).toEqual([ACCOUNT]);
    expect(getActiveAccount()).toEqual(ACCOUNT);
  });

  it("keeps stored state for FEATURE_DISABLED", async () => {
    rejectNextRequest("FEATURE_DISABLED", 503);

    await expect(api.courses(ACCOUNT.universityId)).rejects.toMatchObject({ code: "FEATURE_DISABLED", status: 503 });
    expect(listAccounts()).toContainEqual(expect.objectContaining({ id: ACCOUNT.id }));
    expect(isSessionDeathCode("FEATURE_DISABLED")).toBe(false);
  });

  it.each(["MISSING_SESSION", "SESSION_EXPIRED", "INVALID_SESSION"])("clears stored state for genuine session-death code %s", async (code) => {
    storeVnuRefreshGrant(ACCOUNT.id, "synthetic-refresh-grant");
    rejectNextRequest(code, 401);

    await expect(requestCrossLookup()).rejects.toMatchObject({ code });

    expect(isSessionDeathCode(code)).toBe(true);
    expect(listAccounts()).toEqual([]);
    expect(getActiveAccount()).toBeUndefined();
    expect(localStorage.getItem("hyeboard.activeAccountId")).toBeNull();
    expect(readVnuRefreshGrant(ACCOUNT.id)).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("preserves a newer same-account VNU token and grant after a late terminal response", async () => {
    storeVnuRefreshGrant(ACCOUNT.id, "synthetic-old-refresh-grant");
    let releaseResponse!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { releaseResponse = resolve; })));
    const pending = requestCrossLookup();
    const replacement = { ...ACCOUNT, token: "synthetic-replacement-token" };
    localStorage.setItem("hyeboard.accounts", JSON.stringify([replacement]));
    storeVnuRefreshGrant(ACCOUNT.id, "synthetic-replacement-refresh-grant");
    releaseResponse(jsonError("INVALID_SESSION", 401));

    await expect(pending).rejects.toMatchObject({ code: "INVALID_SESSION" });
    expect(listAccounts()).toEqual([replacement]);
    expect(readVnuRefreshGrant(ACCOUNT.id)).toBe("synthetic-replacement-refresh-grant");
  });

  it("clears only the unchanged inactive VNU origin and its grant", async () => {
    localStorage.setItem("hyeboard.accounts", JSON.stringify([ACCOUNT, SECOND_ACCOUNT]));
    storeVnuRefreshGrant(ACCOUNT.id, "synthetic-origin-refresh-grant");
    storeVnuRefreshGrant(SECOND_ACCOUNT.id, "synthetic-other-refresh-grant");
    let releaseResponse!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { releaseResponse = resolve; })));
    const pending = requestCrossLookup();
    switchAccount(SECOND_ACCOUNT.id);
    releaseResponse(jsonError("SESSION_EXPIRED", 401));

    await expect(pending).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    expect(listAccounts()).toEqual([SECOND_ACCOUNT]);
    expect(getActiveAccount()).toEqual(SECOND_ACCOUNT);
    expect(readVnuRefreshGrant(ACCOUNT.id)).toBeUndefined();
    expect(readVnuRefreshGrant(SECOND_ACCOUNT.id)).toBe("synthetic-other-refresh-grant");
  });

  it("removes the originating account when bulk lookup returns top-level VNU_SESSION_EXPIRED", async () => {
    rejectNextRequest("VNU_SESSION_EXPIRED", 401);

    await expect(api.vnuCrossLookupBulk("stdid-to-transcript", ["1001", "1002"])).rejects.toMatchObject({
      code: "VNU_SESSION_EXPIRED",
    });

    expect(isSessionDeathCode("VNU_SESSION_EXPIRED")).toBe(false);
    expect(listAccounts()).toEqual([]);
    expect(getActiveAccount()).toBeUndefined();
    expect(localStorage.getItem("hyeboard.activeAccountId")).toBeNull();
  });

  it("strips upstream notice prose from every cross-lookup response shape", async () => {
    const upstreamNoticeSentinel = "UPSTREAM_NOTICE_SENTINEL_DO_NOT_EXPOSE";
    const transcript = {
      header: { studentCode: "20000001" },
      terms: [{ maHK: "251", rows: [] }],
      totals: {},
      notice: upstreamNoticeSentinel,
    };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { studentCode: "20000001", notice: upstreamNoticeSentinel }, error: null })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: transcript, error: null })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { items: [{ target: "1001", status: "ok", result: transcript }] }, error: null }))));

    const studentCode = await api.vnuCrossStudentCode({ stdId: "1001" });
    const crossTranscript = await api.vnuCrossTranscript({ mode: "stdId", stdId: "1001" });
    const bulk = await api.vnuCrossLookupBulk("stdid-to-transcript", ["1001"]);

    expect(JSON.stringify({ studentCode, crossTranscript, bulk })).not.toContain(upstreamNoticeSentinel);
    expect(studentCode).toEqual({ studentCode: "20000001", studentName: undefined, className: undefined });
    expect(crossTranscript).not.toHaveProperty("notice");
    expect(bulk[0]?.status === "ok" ? bulk[0].result : undefined).not.toHaveProperty("notice");
  });

  it("removes only the inactive originating UET account when its request dies late", async () => {
    localStorage.setItem("hyeboard.accounts", JSON.stringify([UET_ACCOUNT, SECOND_ACCOUNT]));
    localStorage.setItem("hyeboard.activeAccountId", UET_ACCOUNT.id);
    let releaseResponse!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { releaseResponse = resolve; })));

    const pending = requestCrossLookup();
    switchAccount(SECOND_ACCOUNT.id);
    releaseResponse(new Response(JSON.stringify({ data: null, error: { code: "INVALID_SESSION", message: "Synthetic expired request" } }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    }));

    await expect(pending).rejects.toMatchObject({ code: "INVALID_SESSION" });
    expect(getActiveAccount()).toEqual(SECOND_ACCOUNT);
    expect(listAccounts()).toEqual([SECOND_ACCOUNT]);
  });

  it("writes a late refresh to the unchanged originating account after an account switch", async () => {
    localStorage.setItem("hyeboard.accounts", JSON.stringify([ACCOUNT, SECOND_ACCOUNT]));
    let releaseResponse!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { releaseResponse = resolve; })));

    const pending = requestCrossLookup();
    switchAccount(SECOND_ACCOUNT.id);
    releaseResponse(new Response(JSON.stringify({
      data: { stdCode: "SYNTHETIC-STUDENT", stdId: "99000000101", probes: 1 },
      error: null,
      meta: { refreshedToken: "late-refreshed-session-token" },
    }), { headers: { "Content-Type": "application/json" } }));

    await expect(pending).resolves.toBeUndefined();
    expect(getActiveAccount()).toEqual(SECOND_ACCOUNT);
    expect(listAccounts()).toEqual([{ ...ACCOUNT, token: "late-refreshed-session-token" }, SECOND_ACCOUNT]);
  });

  it("does not overwrite a same-account relogin with a late refresh", async () => {
    let releaseResponse!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { releaseResponse = resolve; })));

    const pending = requestCrossLookup();
    const reloggedAccount = { ...ACCOUNT, token: "relogged-session-token" };
    localStorage.setItem("hyeboard.accounts", JSON.stringify([reloggedAccount]));
    releaseResponse(new Response(JSON.stringify({
      data: { stdCode: "SYNTHETIC-STUDENT", stdId: "99000000101", probes: 1 },
      error: null,
      meta: { refreshedToken: "stale-refreshed-session-token" },
    }), { headers: { "Content-Type": "application/json" } }));

    await expect(pending).resolves.toBeUndefined();
    expect(getActiveAccount()).toEqual(reloggedAccount);
  });

  it("does not remove a same-account relogin when the old request expires late", async () => {
    let releaseResponse!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { releaseResponse = resolve; })));

    const pending = requestCrossLookup();
    const reloggedAccount = { ...ACCOUNT, token: "relogged-session-token" };
    localStorage.setItem("hyeboard.accounts", JSON.stringify([reloggedAccount]));
    releaseResponse(new Response(JSON.stringify({
      data: null,
      error: { code: "VNU_SESSION_EXPIRED", message: "Synthetic old session expiry" },
    }), { status: 401, headers: { "Content-Type": "application/json" } }));

    await expect(pending).rejects.toMatchObject({ code: "VNU_SESSION_EXPIRED" });
    expect(listAccounts()).toEqual([reloggedAccount]);
    expect(getActiveAccount()).toEqual(reloggedAccount);
  });

  it("still applies a refresh to the unchanged initiating account", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { stdCode: "SYNTHETIC-STUDENT", stdId: "99000000101", probes: 1 },
      error: null,
      meta: { refreshedToken: "same-account-refreshed-token" },
    }), { headers: { "Content-Type": "application/json" } })));

    await requestCrossLookup();

    expect(getActiveAccount()).toEqual({ ...ACCOUNT, token: "same-account-refreshed-token" });
    expect(vi.mocked(window.dispatchEvent).mock.calls.map(([event]) => ({
      type: event.type,
      detail: (event as CustomEvent<unknown>).detail,
    }))).toContainEqual({ type: SESSION_TOKEN_ROTATED_EVENT, detail: { accountId: ACCOUNT.id } });
  });

  it("re-exports one ApiError identity and keeps refresh marker private", () => {
    expect(ApiError).toBe(SharedApiError);
    const error = new ApiError("Synthetic failure", "VNU_REFRESH_UNAVAILABLE", 503, { retryAfterSeconds: 7 });
    expect(error).toBeInstanceOf(SharedApiError);
    expect(markVnuRefreshAttempted(error)).toBe(error);
    expect(wasVnuRefreshAttempted(error)).toBe(true);
    expect(error.details).toEqual({ retryAfterSeconds: 7 });
    expect(Object.keys(error)).not.toContain("vnuRefreshAttempted");
    expect(JSON.stringify(error)).not.toContain("vnuRefreshAttempted");
  });

  it("propagates sanitized worker details into ApiError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: null,
      error: { code: "VNU_RATE_LIMITED", message: "Synthetic limited", details: { retryAfterSeconds: 9, limit: 5, windowSeconds: 900, privateToken: "must-not-propagate" } },
    }), { status: 429, headers: { "Content-Type": "application/json" } })));

    const error = await requestCrossLookup().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ details: { retryAfterSeconds: 9, limit: 5, windowSeconds: 900 } });
    expect((error as ApiError).details).toEqual({ retryAfterSeconds: 9, limit: 5, windowSeconds: 900 });
    expect(JSON.stringify(error)).not.toContain("privateToken");
  });

  it("does not recover VNU login-required responses with mixed details", async () => {
    storeVnuRefreshGrant(ACCOUNT.id, "synthetic-refresh-grant");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: null,
      error: {
        code: "VNU_LOGIN_REQUIRED",
        message: "Synthetic missing credential",
        details: { reason: "MISSING_VNU_CREDENTIAL", retryAfterSeconds: 5, privateKey: "SYNTHETIC-PRIVATE" },
      },
    }), { status: 401, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await requestCrossLookup().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "VNU_LOGIN_REQUIRED", details: undefined });
    expect(JSON.stringify(error)).not.toContain("SYNTHETIC-PRIVATE");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readVnuRefreshGrant(ACCOUNT.id)).toBe("synthetic-refresh-grant");
  });

  it("preserves only allowed details from a plain-JSON UET stream-start error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: null,
      error: {
        code: "UET_UPSTREAM_UNAVAILABLE",
        message: "Synthetic pre-stream failure",
        details: {
          retryAfterSeconds: 11,
          limit: 5,
          windowSeconds: 900,
          privateToken: "must-not-propagate",
          internalReason: "must-not-propagate",
        },
      },
    }), { status: 503, headers: { "Content-Type": "application/json" } })));

    const error = await api.importUetGoogleSession({
      uetGoogleEmail: "synthetic-user@example.invalid",
      uetGooglePassword: "synthetic-password",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      code: "UET_UPSTREAM_UNAVAILABLE",
      status: 503,
      details: { retryAfterSeconds: 11, limit: 5, windowSeconds: 900 },
    });
    expect((error as ApiError).details).toEqual({ retryAfterSeconds: 11, limit: 5, windowSeconds: 900 });
    expect(JSON.stringify(error)).not.toContain("privateToken");
    expect(JSON.stringify(error)).not.toContain("internalReason");
  });

  it("refreshes one safe GET then replays once with rotated token and preserved options", async () => {
    storeVnuRefreshGrant(ACCOUNT.id, "opaque-grant-alpha");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: null, error: { code: "VNU_SESSION_EXPIRED", message: "Synthetic expiry" } }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: {
        token: "rotated-token-alpha",
        refreshGrant: "rotated-grant-alpha",
        session: { universityId: "vnu", studentCode: ACCOUNT.studentCode, expiresAt: "2036-01-01T08:00:00.000Z", authenticated: true },
      }, error: null })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [], error: null })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.timetable("vnu", "SYNTHETIC-TERM")).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/api/vnu/timetable?termCode=SYNTHETIC-TERM");
    expect(fetchMock.mock.calls[1]?.[0]).toContain("/api/vnu/auth/refresh");
    expect(fetchMock.mock.calls[2]?.[0]).toBe(fetchMock.mock.calls[0]?.[0]);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${ACCOUNT.token}` });
    expect((fetchMock.mock.calls[2]?.[1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer rotated-token-alpha" });
    expect(getActiveAccount()?.token).toBe("rotated-token-alpha");
    expect(readVnuRefreshGrant(ACCOUNT.id)).toBe("rotated-grant-alpha");
    const committedEvents = vi.mocked(window.dispatchEvent).mock.calls
      .map(([event]) => event as unknown as { type: string; detail: unknown })
      .filter((event) => event.type === VNU_REFRESH_COMMITTED_EVENT);
    expect(committedEvents).toEqual([{ type: VNU_REFRESH_COMMITTED_EVENT, detail: { accountId: ACCOUNT.id, preserveFeatureState: true } }]);
  });

  it.each([
    ["profile", () => api.vnuOwnProfile(), `<input name="StdCode" value="SYNTHETIC-STUDENT">`, { studentCode: "SYNTHETIC-STUDENT" }],
    ["grades", () => api.grades("vnu"), "<table></table>", []],
    ["progress", () => api.trainingPoints("vnu"), "<table></table>", []],
  ])("refreshes and replays the VNU raw %s GET once after normalized expiry", async (page, request, replayHtml, expected) => {
    storeVnuRefreshGrant(ACCOUNT.id, "opaque-grant-alpha");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonError("VNU_SESSION_EXPIRED", 401))
      .mockResolvedValueOnce(jsonOk({
        token: "rotated-token-alpha",
        refreshGrant: "rotated-grant-alpha",
        session: { universityId: "vnu", studentCode: ACCOUNT.studentCode, expiresAt: "2036-01-01T08:00:00.000Z", authenticated: true },
      }))
      .mockResolvedValueOnce(jsonOk({ html: replayHtml }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(request()).resolves.toEqual(expected);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toContain(`/api/vnu/raw/${page}`);
    expect(fetchMock.mock.calls[1]?.[0]).toContain("/api/vnu/auth/refresh");
    expect(fetchMock.mock.calls[2]?.[0]).toBe(fetchMock.mock.calls[0]?.[0]);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${ACCOUNT.token}` });
    expect((fetchMock.mock.calls[2]?.[1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer rotated-token-alpha" });
  });

  it("replays a safe GET at most once when the rotated token also expires", async () => {
    storeVnuRefreshGrant(ACCOUNT.id, "opaque-grant-alpha");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: null, error: { code: "VNU_SESSION_EXPIRED", message: "Synthetic initial expiry" } }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: {
        token: "rotated-token-alpha",
        refreshGrant: "rotated-grant-alpha",
        session: { universityId: "vnu", studentCode: ACCOUNT.studentCode, expiresAt: "2036-01-01T08:00:00.000Z", authenticated: true },
      }, error: null })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: null, error: { code: "VNU_SESSION_EXPIRED", message: "Synthetic replay expiry" } }), { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await api.timetable("vnu").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "VNU_SESSION_EXPIRED" });
    expect(wasVnuRefreshAttempted(error)).toBe(true);
    expect(shouldRetryQuery(0, error)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/api/vnu/auth/refresh"))).toHaveLength(1);
  });

  it.each([
    ["charged GET", () => api.vnuCrossStudentId({ stdCode: "SYNTHETIC-STUDENT" })],
    ["bulk POST", () => api.vnuCrossLookupBulk("code-to-stdid", ["SYNTHETIC-STUDENT"])],
  ])("refreshes %s but never replays it", async (_label, invoke) => {
    storeVnuRefreshGrant(ACCOUNT.id, "opaque-grant-alpha");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: null, error: { code: "VNU_SESSION_EXPIRED", message: "Synthetic expiry" } }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: {
        token: "rotated-token-alpha",
        refreshGrant: "rotated-grant-alpha",
        session: { universityId: "vnu", studentCode: ACCOUNT.studentCode, expiresAt: "2036-01-01T08:00:00.000Z", authenticated: true },
      }, error: null })));
    vi.stubGlobal("fetch", fetchMock);

    const rejection = invoke();
    await expect(rejection).rejects.toMatchObject({ code: VNU_REQUEST_NOT_REPLAYED });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/vnu/auth/refresh"))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => !String(url).includes("/api/vnu/auth/refresh"))).toHaveLength(1);
  });

  it("does not refresh or replay an aborted lookup", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = api.vnuCrossTranscript({ mode: "stdId", stdId: "1001" }, controller.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort(new DOMException("lookup cancelled", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not replay a safe lookup aborted after refresh succeeds", async () => {
    storeVnuRefreshGrant(ACCOUNT.id, "opaque-grant-alpha");
    const controller = new AbortController();
    let releaseRefresh!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonError("VNU_SESSION_EXPIRED", 401))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { releaseRefresh = resolve; }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = api.vnuClassCatalog({ vTermID: "1" }, controller.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    controller.abort(new DOMException("lookup cancelled", "AbortError"));
    releaseRefresh(jsonOk({
      token: "late-token",
      refreshGrant: "late-grant",
      session: { universityId: "vnu", studentCode: ACCOUNT.studentCode, expiresAt: "2036-01-01T08:00:00.000Z", authenticated: true },
    }));

    await expect(pending).rejects.toMatchObject({ code: "VNU_REFRESH_CANCELLED" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("joins two safe GET waiters to one held refresh and replays each exactly once", async () => {
    storeVnuRefreshGrant(ACCOUNT.id, "opaque-grant-alpha");
    const rotatedAuth = {
      token: "rotated-token-alpha",
      refreshGrant: "rotated-grant-alpha",
      session: { universityId: "vnu", studentCode: ACCOUNT.studentCode, expiresAt: "2036-01-01T08:00:00.000Z", authenticated: true as const },
    };
    let releaseRefresh!: (response: Response) => void;
    const refreshResponse = new Promise<Response>((resolve) => { releaseRefresh = resolve; });
    const calls: Array<{ path: string; method: string; token: string | null }> = [];
    let safeGets = 0;

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "https://hyeboard.invalid").pathname;
      const method = init?.method ?? "GET";
      const token = new Headers(init?.headers).get("Authorization");
      calls.push({ path, method, token });
      if (path === "/api/vnu/auth/refresh") {
        return refreshResponse;
      }
      if (path === "/api/vnu/class-lookup/catalog") {
        safeGets += 1;
        if (safeGets <= 2) return jsonError("VNU_SESSION_EXPIRED", 401);
        return jsonOk({ html: "<main></main>" });
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    }));

    const firstController = new AbortController();
    const secondController = new AbortController();
    let markSecondWaiterRegistered!: () => void;
    const secondWaiterRegistered = new Promise<void>((resolve) => { markSecondWaiterRegistered = resolve; });
    const originalAddEventListener = secondController.signal.addEventListener.bind(secondController.signal);
    vi.spyOn(secondController.signal, "addEventListener").mockImplementation((type, listener, options) => {
      originalAddEventListener(type, listener, options);
      if (type === "abort") markSecondWaiterRegistered();
    });

    const first = api.vnuClassCatalog({ vTermID: "1" }, firstController.signal);
    const second = api.vnuClassCatalog({ vTermID: "1" }, secondController.signal);
    await secondWaiterRegistered;
    expect(calls.filter((call) => call.path === "/api/vnu/auth/refresh")).toHaveLength(1);
    releaseRefresh(jsonOk(rotatedAuth));

    await expect(Promise.all([first, second])).resolves.toEqual([[], []]);
    expect(calls.filter((call) => call.path === "/api/vnu/auth/refresh")).toHaveLength(1);
    expect(calls.filter((call) => call.path === "/api/vnu/class-lookup/catalog")).toEqual([
      { path: "/api/vnu/class-lookup/catalog", method: "GET", token: `Bearer ${ACCOUNT.token}` },
      { path: "/api/vnu/class-lookup/catalog", method: "GET", token: `Bearer ${ACCOUNT.token}` },
      { path: "/api/vnu/class-lookup/catalog", method: "GET", token: `Bearer ${rotatedAuth.token}` },
      { path: "/api/vnu/class-lookup/catalog", method: "GET", token: `Bearer ${rotatedAuth.token}` },
    ]);
    expect(listAccounts()).toContainEqual(expect.objectContaining({ id: ACCOUNT.id, token: rotatedAuth.token }));
    expect(readVnuRefreshGrant(ACCOUNT.id)).toBe(rotatedAuth.refreshGrant);
  });

  it("aborts one refresh after every safe GET waiter cancels and ignores its late success", async () => {
    storeVnuRefreshGrant(ACCOUNT.id, "opaque-grant-alpha");
    let releaseLateRefresh!: () => void;
    const lateRefreshMayReturn = new Promise<void>((resolve) => { releaseLateRefresh = resolve; });
    let markLateRefreshReturned!: () => void;
    const lateRefreshReturned = new Promise<void>((resolve) => { markLateRefreshReturned = resolve; });
    let refreshAbortCount = 0;
    let safeGetCount = 0;
    let refreshCallCount = 0;
    const requestAuthorizations: Array<{ path: string; authorization: string | null }> = [];
    let markSecondWaiterRegistered!: () => void;
    const secondWaiterRegistered = new Promise<void>((resolve) => { markSecondWaiterRegistered = resolve; });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const originalAddEventListener = secondController.signal.addEventListener.bind(secondController.signal);
    vi.spyOn(secondController.signal, "addEventListener").mockImplementation((type, listener, options) => {
      originalAddEventListener(type, listener, options);
      if (type === "abort") markSecondWaiterRegistered();
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "https://hyeboard.invalid").pathname;
      requestAuthorizations.push({ path, authorization: new Headers(init?.headers).get("Authorization") });
      if (path === "/api/vnu/class-lookup/catalog") {
        safeGetCount += 1;
        if (safeGetCount <= 3) return jsonError("VNU_SESSION_EXPIRED", 401);
        return jsonOk({ html: "<main></main>" });
      }
      if (path === "/api/vnu/auth/refresh") {
        refreshCallCount += 1;
        if (refreshCallCount === 2) {
          return jsonOk({
            token: "fresh-rotated-token",
            refreshGrant: "fresh-rotated-grant",
            session: { universityId: "vnu", studentCode: ACCOUNT.studentCode, expiresAt: "2036-01-01T08:00:00.000Z", authenticated: true },
          });
        }
        init?.signal?.addEventListener("abort", () => { refreshAbortCount += 1; }, { once: true });
        await lateRefreshMayReturn;
        markLateRefreshReturned();
        return jsonOk({
          token: "obsolete-rotated-token",
          refreshGrant: "obsolete-rotated-grant",
          session: { universityId: "vnu", studentCode: ACCOUNT.studentCode, expiresAt: "2036-01-01T08:00:00.000Z", authenticated: true },
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = api.vnuClassCatalog({ vTermID: "1" }, firstController.signal);
    const second = api.vnuClassCatalog({ vTermID: "1" }, secondController.signal);
    await secondWaiterRegistered;
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/vnu/auth/refresh"))).toHaveLength(1);

    firstController.abort(new DOMException("first safe GET cancelled", "AbortError"));
    await expect(first).rejects.toMatchObject({ code: "VNU_REFRESH_CANCELLED" });
    expect(refreshAbortCount).toBe(0);
    secondController.abort(new DOMException("second safe GET cancelled", "AbortError"));
    await expect(second).rejects.toMatchObject({ code: "VNU_REFRESH_CANCELLED" });
    expect(refreshAbortCount).toBe(1);

    const dispatchEvent = vi.mocked(window.dispatchEvent);
    dispatchEvent.mockClear();
    releaseLateRefresh();
    await lateRefreshReturned;
    await expect(api.vnuClassCatalog({ vTermID: "2" })).resolves.toEqual([]);

    expect(safeGetCount).toBe(4);
    expect(refreshCallCount).toBe(2);
    expect(requestAuthorizations.filter(({ path }) => path === "/api/vnu/class-lookup/catalog")).toEqual([
      { path: "/api/vnu/class-lookup/catalog", authorization: `Bearer ${ACCOUNT.token}` },
      { path: "/api/vnu/class-lookup/catalog", authorization: `Bearer ${ACCOUNT.token}` },
      { path: "/api/vnu/class-lookup/catalog", authorization: `Bearer ${ACCOUNT.token}` },
      { path: "/api/vnu/class-lookup/catalog", authorization: "Bearer fresh-rotated-token" },
    ]);
    expect(listAccounts()).toContainEqual(expect.objectContaining({ id: ACCOUNT.id, token: "fresh-rotated-token" }));
    expect(readVnuRefreshGrant(ACCOUNT.id)).toBe("fresh-rotated-grant");
    expect(dispatchEvent.mock.calls.map(([event]) => ({
      type: (event as unknown as { type: string }).type,
      detail: (event as unknown as { detail: unknown }).detail,
    }))).toEqual([
      { type: VNU_REFRESH_STATUS_EVENT, detail: { accountId: ACCOUNT.id, state: "reconnecting" } },
      { type: SESSION_TOKEN_ROTATED_EVENT, detail: { accountId: ACCOUNT.id } },
      { type: VNU_REFRESH_COMMITTED_EVENT, detail: { accountId: ACCOUNT.id, preserveFeatureState: true } },
      { type: VNU_REFRESH_STATUS_EVENT, detail: { accountId: ACCOUNT.id, state: "idle" } },
    ]);
  });

  it("never refreshes auth or unlisted non-GET requests", async () => {
    storeVnuRefreshGrant(ACCOUNT.id, "opaque-grant-alpha");
    rejectNextRequest("VNU_SESSION_EXPIRED", 401);

    await expect(api.importSession("vnu", { vnuUsername: "synthetic-user", vnuPassword: "synthetic-password" })).rejects.toMatchObject({ code: "VNU_SESSION_EXPIRED" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(readVnuRefreshGrant(ACCOUNT.id)).toBe("opaque-grant-alpha");
  });

  it.each(["switch", "replace", "remove", "manual-relogin"])("does not replay or signal success after a %s race", async (race) => {
    storeVnuRefreshGrant(ACCOUNT.id, "opaque-grant-alpha");
    let releaseRefresh!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: null, error: { code: "VNU_SESSION_EXPIRED", message: "Synthetic expiry" } }), { status: 401 }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { releaseRefresh = resolve; }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = api.vnuCrossStudentId({ stdCode: "SYNTHETIC-STUDENT" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    if (race === "switch") {
      localStorage.setItem("hyeboard.accounts", JSON.stringify([ACCOUNT, SECOND_ACCOUNT]));
      localStorage.setItem("hyeboard.activeAccountId", SECOND_ACCOUNT.id);
    }
    if (race === "replace") {
      localStorage.setItem("hyeboard.accounts", JSON.stringify([{ ...ACCOUNT, token: "replacement-token" }]));
    }
    if (race === "remove") {
      localStorage.setItem("hyeboard.accounts", "[]");
      localStorage.removeItem("hyeboard.activeAccountId");
      sessionStorage.removeItem(`hyeboard.vnu.refreshGrant.${ACCOUNT.id}`);
    }
    if (race === "manual-relogin") {
      localStorage.setItem("hyeboard.accounts", JSON.stringify([{ ...ACCOUNT, token: "manual-relogin-token" }]));
      storeVnuRefreshGrant(ACCOUNT.id, "manual-relogin-grant");
    }
    const grantBeforeRelease = readVnuRefreshGrant(ACCOUNT.id);
    const accountsBeforeRelease = localStorage.getItem("hyeboard.accounts");
    const dispatchEvent = vi.mocked(window.dispatchEvent);
    dispatchEvent.mockClear();

    releaseRefresh(new Response(JSON.stringify({ data: {
      token: "late-rotated-token",
      refreshGrant: "late-rotated-grant",
      session: { universityId: "vnu", studentCode: ACCOUNT.studentCode, expiresAt: "2036-01-01T08:00:00.000Z", authenticated: true },
    }, error: null })));

    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "VNU_SESSION_EXPIRED" });
    expect(error).not.toMatchObject({ code: VNU_REQUEST_NOT_REPLAYED });
    expect(wasVnuRefreshAttempted(error)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem("hyeboard.accounts")).toBe(accountsBeforeRelease);
    expect(readVnuRefreshGrant(ACCOUNT.id)).toBe(grantBeforeRelease);
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it.each([
    [429, "VNU_REFRESH_RATE_LIMITED"],
    [503, "VNU_REFRESH_UNAVAILABLE"],
    [502, "VNU_UPSTREAM_UNAVAILABLE"],
  ])("marks refresh HTTP %s so Query does not retry", async (status, code) => {
    storeVnuRefreshGrant(ACCOUNT.id, "opaque-grant-alpha");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: null, error: { code: "VNU_SESSION_EXPIRED", message: "Synthetic expiry" } }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: null, error: { code, message: "Synthetic refresh failure" } }), { status }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await api.timetable("vnu").catch((caught: unknown) => caught);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(error).toMatchObject({ code });
    expect(wasVnuRefreshAttempted(error)).toBe(true);
    expect(shouldRetryQuery(0, error)).toBe(false);
    expect(listAccounts()).toEqual([ACCOUNT]);
    expect(readVnuRefreshGrant(ACCOUNT.id)).toBe("opaque-grant-alpha");
  });

  it("normalizes and marks refresh network failure without Query retry", async () => {
    storeVnuRefreshGrant(ACCOUNT.id, "opaque-grant-alpha");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: null, error: { code: "VNU_SESSION_EXPIRED", message: "Synthetic expiry" } }), { status: 401 }))
      .mockRejectedValueOnce(new TypeError("synthetic offline"));
    vi.stubGlobal("fetch", fetchMock);

    const error = await api.timetable("vnu").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "VNU_REFRESH_NETWORK_ERROR", status: 503 });
    expect(wasVnuRefreshAttempted(error)).toBe(true);
    expect(shouldRetryQuery(0, error)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("allows one Query retry only for unrelated unmarked transient failures", () => {
    const transient = new ApiError("Synthetic transient", "UNRELATED_TRANSIENT", 503);
    expect(shouldRetryQuery(0, transient)).toBe(true);
    expect(shouldRetryQuery(1, transient)).toBe(false);
    expect(shouldRetryQuery(0, new ApiError("dead", "INVALID_SESSION", 401))).toBe(false);
    expect(shouldRetryQuery(0, new ApiError("manual", VNU_REQUEST_NOT_REPLAYED))).toBe(false);
  });

  it("suppresses Query retry for both exact unmarked recovery triggers", () => {
    expect(shouldRetryQuery(0, new ApiError("expired", "VNU_SESSION_EXPIRED", 401))).toBe(false);
    expect(shouldRetryQuery(0, new ApiError("missing", "VNU_LOGIN_REQUIRED", 401, { reason: "MISSING_VNU_CREDENTIAL" }))).toBe(false);
    expect(shouldRetryQuery(0, new ApiError("broad", "VNU_LOGIN_REQUIRED", 401))).toBe(true);
    expect(shouldRetryQuery(0, new ApiError("profile", "VNU_PROFILE_INCOMPLETE", 500))).toBe(true);
  });

  it("does not retry or remove a switched origin when no refresh grant exists", async () => {
    localStorage.setItem("hyeboard.accounts", JSON.stringify([ACCOUNT, SECOND_ACCOUNT]));
    localStorage.setItem("hyeboard.activeAccountId", ACCOUNT.id);
    let releaseResponse!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { releaseResponse = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = api.timetable("vnu");
    switchAccount(SECOND_ACCOUNT.id);
    releaseResponse(new Response(JSON.stringify({ data: null, error: { code: "VNU_SESSION_EXPIRED", message: "Synthetic expiry" } }), { status: 401 }));

    const error = await pending.catch((caught: unknown) => caught);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ code: "VNU_SESSION_EXPIRED" });
    expect(shouldRetryQuery(0, error)).toBe(false);
    expect(listAccounts()).toEqual([ACCOUNT, SECOND_ACCOUNT]);
    expect(getActiveAccount()).toEqual(SECOND_ACCOUNT);
  });

  it("invalidates only active queries belonging to the recovered VNU account", () => {
    const query = (queryKey: readonly unknown[], active = true) => ({ queryKey, isActive: () => active });
    expect(shouldInvalidateVnuRefreshQuery(query(["dashboard", "vnu", undefined, 4]), ACCOUNT.id, ACCOUNT.id)).toBe(true);
    expect(shouldInvalidateVnuRefreshQuery(query(["grades", "vnu", "SYNTHETIC-TERM", 4]), ACCOUNT.id, ACCOUNT.id)).toBe(true);
    expect(shouldInvalidateVnuRefreshQuery(query(["dashboard", "uet", undefined, 4]), ACCOUNT.id, ACCOUNT.id)).toBe(false);
    expect(shouldInvalidateVnuRefreshQuery(query(["universities"]), ACCOUNT.id, ACCOUNT.id)).toBe(false);
    expect(shouldInvalidateVnuRefreshQuery(query(["vnu-cross-student-id", "vnu"]), ACCOUNT.id, ACCOUNT.id)).toBe(false);
    expect(shouldInvalidateVnuRefreshQuery(query(["unrelated", "vnu"]), ACCOUNT.id, ACCOUNT.id)).toBe(false);
    expect(shouldInvalidateVnuRefreshQuery(query(["unrelated", "vnu"], false), ACCOUNT.id, ACCOUNT.id)).toBe(false);
    expect(shouldInvalidateVnuRefreshQuery(query(["dashboard", "vnu"]), ACCOUNT.id, SECOND_ACCOUNT.id)).toBe(false);
  });

  it("rolls a rotated grant back when account persistence fails", () => {
    storeVnuRefreshGrant(ACCOUNT.id, "opaque-grant-alpha");
    const originalSetItem = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
      if (key === "hyeboard.accounts") throw new Error("Synthetic storage failure");
      originalSetItem(key, value);
    });

    expect(() => commitVnuRefresh(ACCOUNT, {
      token: "rotated-token-alpha",
      refreshGrant: "rotated-grant-alpha",
      session: { universityId: "vnu", studentCode: ACCOUNT.studentCode, expiresAt: "2036-01-01T08:00:00.000Z", authenticated: true },
    })).toThrow("Synthetic storage failure");
    expect(readVnuRefreshGrant(ACCOUNT.id)).toBe("opaque-grant-alpha");
  });

  it("returns the imported account and commits its grant before the sole switch event", async () => {
    const dispatchEvent = vi.mocked(window.dispatchEvent);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        token: "opaque-access-alpha",
        refreshGrant: "opaque-grant-alpha",
        session: { universityId: "vnu", studentCode: "SYNTHETIC-STUDENT-ALPHA", expiresAt: "2036-01-01T08:00:00.000Z", authenticated: true },
      },
      error: null,
    }))));

    const result = await api.importSession("vnu", { vnuUsername: "SYNTHETIC-VNU-USER", vnuPassword: "SYNTHETIC-VNU-PASSWORD" });

    expect(result.auth.token).toBe("opaque-access-alpha");
    expect(result.account.studentCode).toBe("SYNTHETIC-STUDENT-ALPHA");
    expect(readVnuRefreshGrant(result.account.id)).toBe("opaque-grant-alpha");
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect(listAccounts()).toContainEqual(result.account);
  });

  it("commits access-only VNU auth and clears a stale account grant", async () => {
    storeVnuRefreshGrant(ACCOUNT.id, "stale-grant");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        token: "access-only-token",
        session: { universityId: "vnu", studentCode: ACCOUNT.studentCode, expiresAt: "2036-01-01T08:00:00.000Z", authenticated: true },
      },
      error: null,
    }))));

    const result = await api.importSession("vnu", { vnuUsername: "SYNTHETIC-VNU-USER", vnuPassword: "SYNTHETIC-VNU-PASSWORD" });

    expect(result.account.id).toBe(ACCOUNT.id);
    expect(result.auth.refreshGrant).toBeUndefined();
    expect(readVnuRefreshGrant(ACCOUNT.id)).toBeUndefined();
    expect(window.dispatchEvent).toHaveBeenCalledTimes(1);
  });

  it("rolls account, active account, and grant back when imported account persistence fails", async () => {
    storeVnuRefreshGrant(ACCOUNT.id, "original-grant");
    const originalSetItem = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
      if (key === "hyeboard.accounts" && value.includes("replacement-access-token")) throw new Error("Synthetic import storage failure");
      originalSetItem(key, value);
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        token: "replacement-access-token",
        refreshGrant: "replacement-grant",
        session: { universityId: "vnu", studentCode: ACCOUNT.studentCode, expiresAt: "2036-01-01T08:00:00.000Z", authenticated: true },
      },
      error: null,
    }))));

    await expect(api.importSession("vnu", { vnuUsername: "SYNTHETIC-VNU-USER", vnuPassword: "SYNTHETIC-VNU-PASSWORD" })).rejects.toThrow("Synthetic import storage failure");
    expect(listAccounts()).toEqual([ACCOUNT]);
    expect(getActiveAccount()).toEqual(ACCOUNT);
    expect(readVnuRefreshGrant(ACCOUNT.id)).toBe("original-grant");
    expect(window.dispatchEvent).not.toHaveBeenCalled();
  });

  it("retains exact account and grant when VNU revocation fails", async () => {
    storeVnuRefreshGrant(ACCOUNT.id, "opaque-grant-alpha");
    rejectNextRequest("VNU_REFRESH_UNAVAILABLE", 503);

    await expect(api.revokeAndRemoveAccount(ACCOUNT.id)).rejects.toMatchObject({ code: "VNU_REFRESH_UNAVAILABLE" });

    expect(listAccounts()).toEqual([ACCOUNT]);
    expect(readVnuRefreshGrant(ACCOUNT.id)).toBe("opaque-grant-alpha");
  });

  it("uses the requested inactive VNU account token and grant", async () => {
    localStorage.setItem("hyeboard.accounts", JSON.stringify([ACCOUNT, SECOND_ACCOUNT]));
    localStorage.setItem("hyeboard.activeAccountId", SECOND_ACCOUNT.id);
    storeVnuRefreshGrant(ACCOUNT.id, "opaque-grant-alpha");
    storeVnuRefreshGrant(SECOND_ACCOUNT.id, "opaque-grant-beta");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { authenticated: false }, error: null })));
    vi.stubGlobal("fetch", fetchMock);

    await api.revokeAndRemoveAccount(ACCOUNT.id);

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/vnu/auth/logout"), expect.objectContaining({
      headers: expect.objectContaining({ Authorization: `Bearer ${ACCOUNT.token}` }),
      body: JSON.stringify({ refreshGrant: "opaque-grant-alpha" }),
    }));
    expect(listAccounts()).toEqual([SECOND_ACCOUNT]);
    expect(readVnuRefreshGrant(ACCOUNT.id)).toBeUndefined();
    expect(readVnuRefreshGrant(SECOND_ACCOUNT.id)).toBe("opaque-grant-beta");
  });

  it("keeps non-VNU exact-account logout best-effort and preserves the active account", async () => {
    localStorage.setItem("hyeboard.accounts", JSON.stringify([UET_ACCOUNT, SECOND_ACCOUNT]));
    localStorage.setItem("hyeboard.activeAccountId", SECOND_ACCOUNT.id);
    storeVnuRefreshGrant(SECOND_ACCOUNT.id, "opaque-grant-beta");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: null, error: { code: "UET_UPSTREAM_UNAVAILABLE", message: "Synthetic unavailable" } }), { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await api.revokeAndRemoveAccount(UET_ACCOUNT.id);

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/uet/auth/logout"), expect.objectContaining({
      headers: expect.objectContaining({ Authorization: `Bearer ${UET_ACCOUNT.token}` }),
      method: "POST",
    }));
    expect(listAccounts()).toEqual([SECOND_ACCOUNT]);
    expect(getActiveAccount()).toEqual(SECOND_ACCOUNT);
    expect(readVnuRefreshGrant(SECOND_ACCOUNT.id)).toBe("opaque-grant-beta");
  });

  it.each(["active", "inactive"])("removes a %s grantless VNU account through its descriptor", async (kind) => {
    localStorage.setItem("hyeboard.accounts", JSON.stringify([ACCOUNT, SECOND_ACCOUNT]));
    localStorage.setItem("hyeboard.activeAccountId", kind === "active" ? ACCOUNT.id : SECOND_ACCOUNT.id);
    sessionStorage.clear();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { authenticated: false }, error: null })));
    vi.stubGlobal("fetch", fetchMock);

    await api.revokeAndRemoveAccount(ACCOUNT.id);

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/vnu/auth/logout"), expect.objectContaining({
      headers: expect.objectContaining({ Authorization: `Bearer ${ACCOUNT.token}` }),
      body: JSON.stringify({}),
    }));
    expect(listAccounts()).toEqual([SECOND_ACCOUNT]);
  });

  it.each(["active", "inactive"])("removes a %s grantless VNU account through a fully expired descriptor", async (kind) => {
    const expired = { ...ACCOUNT, token: "authenticated-fully-expired-descriptor-token" };
    localStorage.setItem("hyeboard.accounts", JSON.stringify([expired, SECOND_ACCOUNT]));
    localStorage.setItem("hyeboard.activeAccountId", kind === "active" ? expired.id : SECOND_ACCOUNT.id);
    sessionStorage.clear();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { authenticated: false }, error: null })));
    vi.stubGlobal("fetch", fetchMock);

    await api.revokeAndRemoveAccount(expired.id);

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/vnu/auth/logout"), expect.objectContaining({
      headers: expect.objectContaining({ Authorization: `Bearer ${expired.token}` }),
      body: JSON.stringify({}),
    }));
    expect(listAccounts()).toEqual([SECOND_ACCOUNT]);
  });

  it("cancels an in-flight refresh before exact-account revocation can remove state", async () => {
    storeVnuRefreshGrant(ACCOUNT.id, "opaque-grant-alpha");
    let refreshSignal!: AbortSignal;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: null, error: { code: "VNU_SESSION_EXPIRED", message: "Synthetic expiry" } }), { status: 401 }))
      .mockImplementationOnce((_url, init: RequestInit) => {
        refreshSignal = init.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => refreshSignal.addEventListener("abort", () => reject(refreshSignal.reason), { once: true }));
      })
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { authenticated: false }, error: null })));
    vi.stubGlobal("fetch", fetchMock);

    const refreshing = api.timetable("vnu");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await api.revokeAndRemoveAccount(ACCOUNT.id);
    await expect(refreshing).rejects.toMatchObject({ code: "VNU_SESSION_EXPIRED" });

    expect(refreshSignal.aborted).toBe(true);
    expect(listAccounts()).toEqual([]);
    expect(readVnuRefreshGrant(ACCOUNT.id)).toBeUndefined();
  });

  it("does not start a refresh when a recoverable response arrives after account refresh cancellation", async () => {
    storeVnuRefreshGrant(ACCOUNT.id, "opaque-grant-alpha");
    let releaseRequest!: (response: Response) => void;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = new URL(String(input), "https://hyeboard.invalid").pathname;
      if (path === "/api/vnu/auth/logout") return Promise.resolve(jsonOk({ authenticated: false }));
      return new Promise<Response>((resolve) => { releaseRequest = resolve; });
    });
    vi.stubGlobal("fetch", fetchMock);
    const pending = api.timetable("vnu");

    cancelVnuRefreshForAccount(ACCOUNT.id);
    releaseRequest(jsonError("VNU_SESSION_EXPIRED", 401));
    await expect(pending).rejects.toMatchObject({ code: "VNU_SESSION_EXPIRED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(listAccounts()).toEqual([ACCOUNT]);
    expect(readVnuRefreshGrant(ACCOUNT.id)).toBe("opaque-grant-alpha");

    await api.revokeAndRemoveAccount(ACCOUNT.id);
  });

  it("clears reconnecting status when exact-account revoke fails after cancelling refresh", async () => {
    storeVnuRefreshGrant(ACCOUNT.id, "opaque-grant-alpha");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: null, error: { code: "VNU_SESSION_EXPIRED", message: "Synthetic expiry" } }), { status: 401 }))
      .mockImplementationOnce((_url, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        const signal = init.signal as AbortSignal;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: null, error: { code: "VNU_REFRESH_UNAVAILABLE", message: "Synthetic logout unavailable" } }), { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const refreshing = api.timetable("vnu");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await expect(api.revokeAndRemoveAccount(ACCOUNT.id)).rejects.toMatchObject({ code: "VNU_REFRESH_UNAVAILABLE" });
    await expect(refreshing).rejects.toMatchObject({ code: "VNU_SESSION_EXPIRED" });

    const statusStates = vi.mocked(window.dispatchEvent).mock.calls
      .map(([event]) => event as unknown as { type: string; detail: { accountId: string; state: string } })
      .filter((event) => event.type === VNU_REFRESH_STATUS_EVENT && event.detail.accountId === ACCOUNT.id)
      .map((event) => event.detail.state);
    expect(statusStates).toEqual(["reconnecting", "idle"]);
    expect(listAccounts()).toEqual([ACCOUNT]);
    expect(readVnuRefreshGrant(ACCOUNT.id)).toBe("opaque-grant-alpha");
  });

  it("blocks a newer reconnect while an old revoke generation is cancelling", async () => {
    storeVnuRefreshGrant(ACCOUNT.id, "opaque-grant-alpha");
    let releaseLogout!: (response: Response) => void;
    let requestNumber = 0;
    const expiryResponse = () => new Response(JSON.stringify({ data: null, error: { code: "VNU_SESSION_EXPIRED", message: "Synthetic expiry" } }), { status: 401 });
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      requestNumber += 1;
      if (requestNumber === 1 || requestNumber === 4) return Promise.resolve(expiryResponse());
      if (requestNumber === 2) {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init.signal as AbortSignal;
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      if (requestNumber === 3) return new Promise<Response>((resolve) => { releaseLogout = resolve; });
      return Promise.resolve(new Response(JSON.stringify({ data: [], error: null })));
    });
    vi.stubGlobal("fetch", fetchMock);

    const oldRefreshing = api.timetable("vnu").then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const revoking = api.revokeAndRemoveAccount(ACCOUNT.id);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await expect(oldRefreshing).resolves.toMatchObject({ code: "VNU_SESSION_EXPIRED" });

    const newerRefreshing = api.timetable("vnu");
    await expect(newerRefreshing).rejects.toMatchObject({ code: "VNU_SESSION_EXPIRED" });
    expect(fetchMock).toHaveBeenCalledTimes(4);

    releaseLogout(new Response(JSON.stringify({ data: null, error: { code: "VNU_REFRESH_UNAVAILABLE", message: "Synthetic old logout unavailable" } }), { status: 503 }));
    await expect(revoking).rejects.toMatchObject({ code: "VNU_REFRESH_UNAVAILABLE" });
    expect(listAccounts()).toEqual([ACCOUNT]);
    expect(readVnuRefreshGrant(ACCOUNT.id)).toBe("opaque-grant-alpha");
  });

  it("leaves a newer same-account token and grant untouched after old revocation succeeds", async () => {
    storeVnuRefreshGrant(ACCOUNT.id, "old-grant");
    let release!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = api.revokeAndRemoveAccount(ACCOUNT.id);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const replacement = { ...ACCOUNT, token: "newer-token" };
    localStorage.setItem("hyeboard.accounts", JSON.stringify([replacement]));
    storeVnuRefreshGrant(ACCOUNT.id, "newer-grant");
    release(new Response(JSON.stringify({ data: { authenticated: false }, error: null })));
    await pending;

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/vnu/auth/logout"), expect.objectContaining({
      headers: expect.objectContaining({ Authorization: `Bearer ${ACCOUNT.token}` }),
      body: JSON.stringify({ refreshGrant: "old-grant" }),
    }));
    expect(listAccounts()).toEqual([replacement]);
    expect(readVnuRefreshGrant(ACCOUNT.id)).toBe("newer-grant");
  });

  it("leaves a newer same-account token and grant untouched after old revocation fails", async () => {
    storeVnuRefreshGrant(ACCOUNT.id, "old-grant");
    let release!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { release = resolve; })));

    const pending = api.revokeAndRemoveAccount(ACCOUNT.id);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const replacement = { ...ACCOUNT, token: "newer-token" };
    localStorage.setItem("hyeboard.accounts", JSON.stringify([replacement]));
    storeVnuRefreshGrant(ACCOUNT.id, "newer-grant");
    release(new Response(JSON.stringify({ data: null, error: { code: "VNU_REFRESH_GRANT_REVOKED", message: "Synthetic old logout rejected" } }), { status: 401 }));

    await expect(pending).rejects.toMatchObject({ code: "VNU_REFRESH_GRANT_REVOKED" });
    expect(listAccounts()).toEqual([replacement]);
    expect(readVnuRefreshGrant(ACCOUNT.id)).toBe("newer-grant");
  });
});
