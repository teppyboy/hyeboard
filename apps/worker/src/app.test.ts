import { configureLogger, decryptSession, encryptSession, HyeboardError, type EncryptedSessionPayload } from "@hyeboard/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const adapterMocks = vi.hoisted(() => ({
  getAdapter: vi.fn(),
  importSession: vi.fn(),
}));

vi.mock("@hyeboard/university-adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hyeboard/university-adapters")>();
  return { ...actual, getAdapter: adapterMocks.getAdapter };
});

import { createApp, createCaptchaRelayToken, resolveSession, setCaptchaRelayCoordinator, setRuntimeConfig } from "./app";
import { LocalCaptchaRelayCoordinator, type CaptchaRelayCoordinator } from "./captcha-relay";

const SESSION_SECRET = "worker-test-secret-worker-test-secret";
const SESSION_DEATH_CODES = ["MISSING_SESSION", "SESSION_EXPIRED", "INVALID_SESSION"];
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

describe("lazy parent session refresh", () => {
  let logOutput: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    adapterMocks.getAdapter.mockReturnValue({ importSession: adapterMocks.importSession });
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET });
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
    expect(SESSION_DEATH_CODES).not.toContain(code);
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
