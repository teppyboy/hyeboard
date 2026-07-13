import { configureLogger, HyeboardError } from "@hyeboard/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUetAdapter } from "./adapter";
import { setCaptchaOcrSolver } from "./captcha";

const clientMocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
  getCaptchaChallenge: vi.fn(),
  authenticateDirect: vi.fn(),
}));
vi.mock("./google-login-automation", () => ({ automateVnuGoogleLogin: vi.fn() }));
vi.mock("./studenthub-client", () => ({
  StudentHubClient: vi.fn().mockImplementation(() => clientMocks),
}));

import { automateVnuGoogleLogin } from "./google-login-automation";
import { StudentHubClient } from "./studenthub-client";

beforeEach(() => {
  vi.clearAllMocks();
  clientMocks.getProfile.mockResolvedValue({ studentCode: "20200001" });
  clientMocks.getCaptchaChallenge.mockResolvedValue({ captchaId: "challenge-1", image: "data:image/png;base64,QQ==" });
  clientMocks.authenticateDirect.mockResolvedValue({
    code: "200",
    login: { accountCode: "PH00000001", accessToken: "fake-parent-token" },
  });
  setCaptchaOcrSolver(async () => "ABCD");
});

afterEach(() => {
  setCaptchaOcrSolver(undefined);
  configureLogger({ level: "silent", mode: "node" });
});

describe("uet adapter importSession - Google automation path", () => {
  it("requires a browserBinding when uetGoogleEmail/Password are provided", async () => {
    const adapter = createUetAdapter();
    await expect(adapter.importSession({ uetGoogleEmail: "a@vnu.edu.vn", uetGooglePassword: "x" })).rejects.toMatchObject({
      code: "SERVER_CONFIG_ERROR",
    });
  });

  it("requires both uetGoogleEmail and uetGooglePassword together", async () => {
    const adapter = createUetAdapter();
    await expect(adapter.importSession({ uetGoogleEmail: "a@vnu.edu.vn" })).rejects.toMatchObject({
      code: "MISSING_UPSTREAM_CREDENTIAL",
    });
  });

  it("builds a session from a successful automation result and persists uetGoogleCredential with a long expiry", async () => {
    vi.mocked(automateVnuGoogleLogin).mockResolvedValue({
      studenthub: { accessToken: "fake-student-token", accountCode: "20200001" },
      canvas: { cookie: "fake=cookie", csrfToken: "fake-csrf" },
    });
    const adapter = createUetAdapter();
    const imported = await adapter.importSession(
      { uetGoogleEmail: "a@vnu.edu.vn", uetGooglePassword: "fake-password" },
      { browserConnection: { kind: "cloudflare", binding: { fetch: vi.fn() } } },
    );
    expect(imported.session.uetGoogleCredential).toEqual({ email: "a@vnu.edu.vn", password: "fake-password" });
    expect(imported.session.studenthub).toEqual({ kind: "bearer", value: "fake-student-token", expiresAt: expect.any(String) });
    expect(imported.session.canvas).toEqual({ kind: "cookie", value: "fake=cookie", csrfToken: "fake-csrf", expiresAt: expect.any(String) });
    const days = (Date.parse(imported.expiresAt) - Date.now()) / (1000 * 60 * 60 * 24);
    expect(days).toBeGreaterThan(29);
  });

  it("commits a partial result when only one of studenthub/canvas succeeds", async () => {
    vi.mocked(automateVnuGoogleLogin).mockResolvedValue({ studenthub: { accessToken: "fake-student-token" } });
    const adapter = createUetAdapter();
    const imported = await adapter.importSession(
      { uetGoogleEmail: "a@vnu.edu.vn", uetGooglePassword: "fake-password" },
      { browserConnection: { kind: "cloudflare", binding: { fetch: vi.fn() } } },
    );
    expect(imported.session.studenthub).toBeDefined();
    expect(imported.session.canvas).toBeUndefined();
  });

  it("propagates a HyeboardError thrown by automation unchanged", async () => {
    vi.mocked(automateVnuGoogleLogin).mockRejectedValue(new HyeboardError("GOOGLE_2FA_REQUIRED", "2FA required", 401));
    const adapter = createUetAdapter();
    await expect(
      adapter.importSession(
        { uetGoogleEmail: "a@vnu.edu.vn", uetGooglePassword: "fake-password" },
        { browserConnection: { kind: "cloudflare", binding: { fetch: vi.fn() } } },
      ),
    ).rejects.toMatchObject({ code: "GOOGLE_2FA_REQUIRED" });
  });
});

describe("uet adapter importSession - parent/guardian direct-login path", () => {
  it("authenticates without a browser and preserves the parent session shape", async () => {
    const adapter = createUetAdapter();
    const imported = await adapter.importSession({ uetGoogleEmail: "PH00000001", uetGooglePassword: "fake-password" });

    expect(StudentHubClient).toHaveBeenCalledWith();
    expect(clientMocks.getCaptchaChallenge).toHaveBeenCalledTimes(1);
    expect(clientMocks.authenticateDirect).toHaveBeenCalledWith("PH00000001", "fake-password", "challenge-1", "ABCD");
    expect(automateVnuGoogleLogin).not.toHaveBeenCalled();
    expect(imported.session.uetParentCredential).toEqual({ username: "PH00000001", password: "fake-password" });
    expect(imported.session.uetGoogleCredential).toBeUndefined();
    expect(imported.session.studenthub).toEqual({ kind: "bearer", value: "fake-parent-token", expiresAt: expect.any(String) });
    expect(imported.studentCode).toBe("PH00000001");
  });

  it("detects the prefix case-insensitively after trimming whitespace", async () => {
    clientMocks.authenticateDirect.mockResolvedValueOnce({
      code: "200",
      login: { accountCode: "ph00000001", accessToken: "fake-parent-token" },
    });
    const adapter = createUetAdapter();

    await adapter.importSession({ uetGoogleEmail: "  ph00000001  ", uetGooglePassword: "fake-password" });

    expect(clientMocks.authenticateDirect).toHaveBeenCalledWith("ph00000001", "fake-password", "challenge-1", "ABCD");
  });

  it("fetches a fresh challenge and forces human resolution after rejected OCR", async () => {
    const order: string[] = [];
    const solver = vi.fn(async (image: string) => {
      order.push(`ocr:${image}`);
      return " OCR1 ";
    });
    const onCaptchaNeeded = vi.fn(async (image: string) => {
      order.push(`human:${image}`);
      return " HUMAN ";
    });
    setCaptchaOcrSolver(solver);
    clientMocks.getCaptchaChallenge
      .mockImplementationOnce(async () => {
        order.push("challenge:challenge-1");
        return { captchaId: "challenge-1", image: "data:image/png;base64,QQ==" };
      })
      .mockImplementationOnce(async () => {
        order.push("challenge:challenge-2");
        return { captchaId: "challenge-2", image: "data:image/png;base64,Qg==" };
      });
    clientMocks.authenticateDirect
      .mockImplementationOnce(async (_username, _password, captchaId, answer) => {
        order.push(`authenticate:${captchaId}:${answer}`);
        return { code: "EX102" };
      })
      .mockImplementationOnce(async (_username, _password, captchaId, answer) => {
        order.push(`authenticate:${captchaId}:${answer}`);
        return { code: "200", login: { accessToken: "fake-parent-token", accountCode: "PH00000001" } };
      });
    const adapter = createUetAdapter();

    await adapter.importSession(
      { uetGoogleEmail: "PH00000001", uetGooglePassword: "fake-password" },
      { onCaptchaNeeded },
    );

    expect(clientMocks.getCaptchaChallenge).toHaveBeenCalledTimes(2);
    expect(solver).toHaveBeenCalledTimes(1);
    expect(solver).toHaveBeenCalledWith("data:image/png;base64,QQ==");
    expect(onCaptchaNeeded).toHaveBeenCalledTimes(1);
    expect(onCaptchaNeeded).toHaveBeenCalledWith("data:image/png;base64,Qg==");
    expect(order).toEqual([
      "challenge:challenge-1",
      "ocr:data:image/png;base64,QQ==",
      "authenticate:challenge-1:OCR1",
      "challenge:challenge-2",
      "human:data:image/png;base64,Qg==",
      "authenticate:challenge-2:HUMAN",
    ]);
    expect(clientMocks.authenticateDirect).toHaveBeenNthCalledWith(1, "PH00000001", "fake-password", "challenge-1", "OCR1");
    expect(clientMocks.authenticateDirect).toHaveBeenNthCalledWith(2, "PH00000001", "fake-password", "challenge-2", "HUMAN");
  });

  it("allows OCR again on the second fresh challenge when no human callback exists", async () => {
    const solver = vi.fn()
      .mockResolvedValueOnce("OCR1")
      .mockResolvedValueOnce("OCR2");
    setCaptchaOcrSolver(solver);
    clientMocks.getCaptchaChallenge
      .mockResolvedValueOnce({ captchaId: "challenge-1", image: "data:image/png;base64,QQ==" })
      .mockResolvedValueOnce({ captchaId: "challenge-2", image: "data:image/png;base64,Qg==" });
    clientMocks.authenticateDirect
      .mockResolvedValueOnce({ code: "EX102" })
      .mockResolvedValueOnce({ code: "200", login: { accessToken: "fake-parent-token" } });
    const adapter = createUetAdapter();

    await adapter.importSession({ uetGoogleEmail: "PH00000001", uetGooglePassword: "fake-password" });

    expect(solver).toHaveBeenNthCalledWith(1, "data:image/png;base64,QQ==");
    expect(solver).toHaveBeenNthCalledWith(2, "data:image/png;base64,Qg==");
  });

  it("throws STUDENTHUB_CAPTCHA_REJECTED after two EX102 responses", async () => {
    clientMocks.authenticateDirect.mockResolvedValue({ code: "EX102" });
    const adapter = createUetAdapter();

    await expect(adapter.importSession({ uetGoogleEmail: "PH00000001", uetGooglePassword: "fake-password" })).rejects.toMatchObject({
      code: "STUDENTHUB_CAPTCHA_REJECTED",
      status: 422,
    });
    expect(clientMocks.getCaptchaChallenge).toHaveBeenCalledTimes(2);
    expect(clientMocks.authenticateDirect).toHaveBeenCalledTimes(2);
  });

  it("throws INVALID_STUDENTHUB_CREDENTIAL without retrying another application code", async () => {
    clientMocks.authenticateDirect.mockResolvedValueOnce({ code: "INVALID_CREDENTIAL" });
    const adapter = createUetAdapter();

    await expect(adapter.importSession({ uetGoogleEmail: "PH00000001", uetGooglePassword: "wrong-password" })).rejects.toMatchObject({
      code: "INVALID_STUDENTHUB_CREDENTIAL",
      status: 401,
    });
    expect(clientMocks.getCaptchaChallenge).toHaveBeenCalledTimes(1);
    expect(clientMocks.authenticateDirect).toHaveBeenCalledTimes(1);
  });

  it("does not log sensitive parent values on success or application rejection", async () => {
    const sentinels = [
      "PH_PARENT_USERNAME_SENTINEL",
      "PARENT_PASSWORD_SENTINEL",
      "CAPTCHA_ANSWER_SENTINEL",
      "UPSTREAM_CAPTCHA_ID_SENTINEL",
      "data:image/png;base64,SU1BR0VfU0VOVElORUw=",
      "ACCOUNT_FIELD_SENTINEL",
      "ACCESS_TOKEN_SENTINEL",
    ];
    const output: string[] = [];
    configureLogger({ level: "debug", mode: "node", destination: { write: (line: string) => output.push(line) } });
    setCaptchaOcrSolver(async () => "CAPTCHA_ANSWER_SENTINEL");
    clientMocks.getCaptchaChallenge.mockResolvedValue({
      captchaId: "UPSTREAM_CAPTCHA_ID_SENTINEL",
      image: "data:image/png;base64,SU1BR0VfU0VOVElORUw=",
    });
    clientMocks.authenticateDirect
      .mockResolvedValueOnce({
        code: "200",
        login: { accountCode: "ACCOUNT_FIELD_SENTINEL", accessToken: "ACCESS_TOKEN_SENTINEL" },
      })
      .mockResolvedValueOnce({ code: "INVALID_CREDENTIAL_SENTINEL" });
    const adapter = createUetAdapter();

    await adapter.importSession({ uetGoogleEmail: "PH_PARENT_USERNAME_SENTINEL", uetGooglePassword: "PARENT_PASSWORD_SENTINEL" });
    await expect(adapter.importSession({
      uetGoogleEmail: "PH_PARENT_USERNAME_SENTINEL",
      uetGooglePassword: "PARENT_PASSWORD_SENTINEL",
    })).rejects.toMatchObject({ code: "INVALID_STUDENTHUB_CREDENTIAL", status: 401 });

    for (const sentinel of sentinels) expect(output.join("\n")).not.toContain(sentinel);
  });
});
