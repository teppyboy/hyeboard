import { configureLogger } from "@hyeboard/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudentHubClient } from "./studenthub-client";

const CAPTCHA_IMAGE = "data:image/png;base64,iVBORw0KGgo=";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("StudentHubClient CAPTCHA API", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    configureLogger({ level: "silent", mode: "node" });
  });

  it("gets and validates a CAPTCHA challenge", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      code: "200",
      data: { captchaId: "challenge-1", image: CAPTCHA_IMAGE },
    }));

    await expect(new StudentHubClient().getCaptchaChallenge()).resolves.toEqual({
      captchaId: "challenge-1",
      image: CAPTCHA_IMAGE,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://studenthub.uet.edu.vn/api/auth/captcha",
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it("posts exactly four login fields and returns only narrow login data", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      code: 200,
      data: {
        accessToken: "fake-token",
        accountCode: "PH00000001",
        name: "discard-me",
        email: "discard-me@example.invalid",
      },
    }));

    const result = await new StudentHubClient().authenticateDirect("PH00000001", "fake-password", "challenge-1", "ABCD");

    expect(result).toEqual({
      code: "200",
      login: { accessToken: "fake-token", accountCode: "PH00000001" },
    });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      userName: "PH00000001",
      password: "fake-password",
      captchaId: "challenge-1",
      captchaValue: "ABCD",
    });
    expect(Object.keys(JSON.parse(String(init?.body))).sort()).toEqual(["captchaId", "captchaValue", "password", "userName"]);
  });

  it("returns a well-formed application rejection without account data", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: "EX102", data: null, account: "discard-me" }));

    await expect(new StudentHubClient().authenticateDirect("PH00000001", "fake-password", "challenge-1", "ABCD")).resolves.toEqual({
      code: "EX102",
    });
  });

  it.each([
    ["missing", { image: CAPTCHA_IMAGE }],
    ["empty", { captchaId: "", image: CAPTCHA_IMAGE }],
    ["whitespace", { captchaId: "   ", image: CAPTCHA_IMAGE }],
  ])("rejects a %s CAPTCHA id", async (_label, data) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: "200", data }));

    await expect(new StudentHubClient().getCaptchaChallenge()).rejects.toMatchObject({
      code: "STUDENTHUB_REQUEST_FAILED",
      status: 502,
    });
  });

  it("rejects a non-PNG CAPTCHA data URL", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      code: "200",
      data: { captchaId: "challenge-1", image: "data:image/jpeg;base64,QQ==" },
    }));

    await expect(new StudentHubClient().getCaptchaChallenge()).rejects.toMatchObject({ code: "STUDENTHUB_REQUEST_FAILED", status: 502 });
  });

  it.each([
    ["empty", "data:image/png;base64,"],
    ["malformed", "data:image/png;base64,%%%="],
    ["bad padding", "data:image/png;base64,A==="],
    ["oversized", `data:image/png;base64,${"A".repeat(256 * 1024 + 4)}`],
  ])("rejects %s CAPTCHA base64", async (_label, image) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: "200", data: { captchaId: "challenge-1", image } }));

    await expect(new StudentHubClient().getCaptchaChallenge()).rejects.toMatchObject({
      code: "STUDENTHUB_REQUEST_FAILED",
      status: 502,
    });
  });

  it("rejects a direct-login response without an application code", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { accessToken: "fake-token" } }));

    await expect(new StudentHubClient().authenticateDirect("PH00000001", "fake-password", "challenge-1", "ABCD")).rejects.toMatchObject({
      code: "STUDENTHUB_REQUEST_FAILED",
      status: 502,
    });
  });

  it("rejects malformed direct-login token data", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: "200", data: { accessToken: 123 } }));

    await expect(new StudentHubClient().authenticateDirect("PH00000001", "fake-password", "challenge-1", "ABCD")).rejects.toMatchObject({
      code: "STUDENTHUB_REQUEST_FAILED",
      status: 502,
    });
  });

  it("preserves the existing non-JSON failure behavior", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not-json", { status: 200 }));

    await expect(new StudentHubClient().getCaptchaChallenge()).rejects.toMatchObject({
      code: "STUDENTHUB_REQUEST_FAILED",
      status: 502,
    });
  });

  it("preserves the existing network failure behavior", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network unavailable"));

    await expect(new StudentHubClient().getCaptchaChallenge()).rejects.toMatchObject({
      code: "STUDENTHUB_REQUEST_FAILED",
      status: 502,
    });
  });

  it("preserves the existing non-2xx failure status", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: "error", data: null }, 503));

    await expect(new StudentHubClient().getCaptchaChallenge()).rejects.toMatchObject({
      code: "STUDENTHUB_REQUEST_FAILED",
      status: 503,
    });
  });

  it("does not log sensitive direct-login values on success or malformed failure", async () => {
    const sentinels = [
      "PH_USERNAME_SENTINEL",
      "PASSWORD_SENTINEL",
      "CAPTCHA_ANSWER_SENTINEL",
      "UPSTREAM_CAPTCHA_ID_SENTINEL",
      "data:image/png;base64,SU1BR0VfU0VOVElORUw=",
      "ACCOUNT_FIELD_SENTINEL",
      "ACCESS_TOKEN_SENTINEL",
      "RAW_BODY_SENTINEL",
    ];
    const output: string[] = [];
    configureLogger({ level: "debug", mode: "node", destination: { write: (line: string) => output.push(line) } });
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        code: "200",
        data: {
          captchaId: "UPSTREAM_CAPTCHA_ID_SENTINEL",
          image: "data:image/png;base64,SU1BR0VfU0VOVElORUw=",
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        code: "200",
        data: {
          accessToken: "ACCESS_TOKEN_SENTINEL",
          accountCode: "ACCOUNT_FIELD_SENTINEL",
          profileField: "ACCOUNT_FIELD_SENTINEL",
        },
      }))
      .mockResolvedValueOnce(new Response("RAW_BODY_SENTINEL", { status: 200 }));
    const client = new StudentHubClient();

    await client.getCaptchaChallenge();
    await client.authenticateDirect(
      "PH_USERNAME_SENTINEL",
      "PASSWORD_SENTINEL",
      "UPSTREAM_CAPTCHA_ID_SENTINEL",
      "CAPTCHA_ANSWER_SENTINEL",
    );
    await expect(client.authenticateDirect(
      "PH_USERNAME_SENTINEL",
      "PASSWORD_SENTINEL",
      "UPSTREAM_CAPTCHA_ID_SENTINEL",
      "CAPTCHA_ANSWER_SENTINEL",
    )).rejects.toMatchObject({ code: "STUDENTHUB_REQUEST_FAILED", status: 502 });

    for (const sentinel of sentinels) expect(output.join("\n")).not.toContain(sentinel);
  });
});
