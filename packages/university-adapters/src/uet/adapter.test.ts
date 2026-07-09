import { HyeboardError } from "@hyeboard/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUetAdapter } from "./adapter";

vi.mock("./google-login-automation", () => ({
  automateVnuGoogleLogin: vi.fn(),
}));
const authenticateDirectMock = vi.fn();
vi.mock("./studenthub-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./studenthub-client")>();
  return {
    ...actual,
    StudentHubClient: vi.fn().mockImplementation(() => ({
      getProfile: vi.fn().mockResolvedValue({ studentCode: "20200001" }),
      authenticateDirect: authenticateDirectMock,
    })),
  };
});

import { automateVnuGoogleLogin } from "./google-login-automation";

describe("uet adapter importSession — Google automation path", () => {
  beforeEach(() => vi.clearAllMocks());

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
      studenthub: { accessToken: "sh-token", accountCode: "20200001" },
      canvas: { cookie: "a=b", csrfToken: "csrf" },
    });
    const adapter = createUetAdapter();
    const imported = await adapter.importSession(
      { uetGoogleEmail: "a@vnu.edu.vn", uetGooglePassword: "hunter2" },
      { browserConnection: { kind: "cloudflare", binding: { fetch: vi.fn() } } },
    );
    expect(imported.session.uetGoogleCredential).toEqual({ email: "a@vnu.edu.vn", password: "hunter2" });
    expect(imported.session.studenthub).toEqual({ kind: "bearer", value: "sh-token", expiresAt: expect.any(String) });
    expect(imported.session.canvas).toEqual({ kind: "cookie", value: "a=b", csrfToken: "csrf", expiresAt: expect.any(String) });
    // 30-day window, not the ~1hr JWT-derived window used by manual paste.
    const days = (Date.parse(imported.expiresAt) - Date.now()) / (1000 * 60 * 60 * 24);
    expect(days).toBeGreaterThan(29);
  });

  it("commits a partial result when only one of studenthub/canvas succeeds", async () => {
    vi.mocked(automateVnuGoogleLogin).mockResolvedValue({ studenthub: { accessToken: "sh-token" } });
    const adapter = createUetAdapter();
    const imported = await adapter.importSession(
      { uetGoogleEmail: "a@vnu.edu.vn", uetGooglePassword: "hunter2" },
      { browserConnection: { kind: "cloudflare", binding: { fetch: vi.fn() } } },
    );
    expect(imported.session.studenthub).toBeDefined();
    expect(imported.session.canvas).toBeUndefined();
  });

  it("propagates a HyeboardError thrown by automation (e.g. GOOGLE_2FA_REQUIRED) unchanged", async () => {
    vi.mocked(automateVnuGoogleLogin).mockRejectedValue(new HyeboardError("GOOGLE_2FA_REQUIRED", "2FA required", 401));
    const adapter = createUetAdapter();
    await expect(
      adapter.importSession({ uetGoogleEmail: "a@vnu.edu.vn", uetGooglePassword: "hunter2" }, { browserConnection: { kind: "cloudflare", binding: { fetch: vi.fn() } } }),
    ).rejects.toMatchObject({ code: "GOOGLE_2FA_REQUIRED" });
  });
});

describe("uet adapter importSession — parent/guardian direct-login path", () => {
  beforeEach(() => vi.clearAllMocks());

  it("detects a 'PH'-prefixed username and authenticates directly, without needing a browserConnection", async () => {
    authenticateDirectMock.mockResolvedValue({ accountCode: "PH12345678", accessToken: "parent-token", role: "PARENT", dependAccountCode: "12345678" });
    const adapter = createUetAdapter();
    const imported = await adapter.importSession({ uetGoogleEmail: "PH12345678", uetGooglePassword: "hunter2" });
    expect(authenticateDirectMock).toHaveBeenCalledWith("PH12345678", "hunter2");
    expect(automateVnuGoogleLogin).not.toHaveBeenCalled();
    expect(imported.session.uetParentCredential).toEqual({ username: "PH12345678", password: "hunter2" });
    expect(imported.session.uetGoogleCredential).toBeUndefined();
    expect(imported.session.studenthub).toEqual({ kind: "bearer", value: "parent-token", expiresAt: expect.any(String) });
    expect(imported.studentCode).toBe("PH12345678");
  });

  it("detects the prefix case-insensitively and after trimming whitespace", async () => {
    authenticateDirectMock.mockResolvedValue({ accountCode: "ph00000001", accessToken: "parent-token" });
    const adapter = createUetAdapter();
    await adapter.importSession({ uetGoogleEmail: "  ph00000001  ", uetGooglePassword: "hunter2" });
    expect(authenticateDirectMock).toHaveBeenCalledWith("ph00000001", "hunter2");
  });

  it("throws INVALID_STUDENTHUB_CREDENTIAL when the direct login returns no accessToken", async () => {
    authenticateDirectMock.mockResolvedValue({});
    const adapter = createUetAdapter();
    await expect(adapter.importSession({ uetGoogleEmail: "PH12345678", uetGooglePassword: "wrong" })).rejects.toMatchObject({
      code: "INVALID_STUDENTHUB_CREDENTIAL",
    });
  });

  it("does not require a browserConnection for parent logins (unlike the Google automation path)", async () => {
    authenticateDirectMock.mockResolvedValue({ accountCode: "PH12345678", accessToken: "parent-token" });
    const adapter = createUetAdapter();
    await expect(adapter.importSession({ uetGoogleEmail: "PH12345678", uetGooglePassword: "hunter2" })).resolves.toBeDefined();
  });
});
