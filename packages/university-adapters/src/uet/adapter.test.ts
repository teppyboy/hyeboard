import { HyeboardError } from "@hyeboard/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUetAdapter } from "./adapter";

vi.mock("./google-login-automation", () => ({
  automateVnuGoogleLogin: vi.fn(),
}));
vi.mock("./studenthub-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./studenthub-client")>();
  return { ...actual, StudentHubClient: vi.fn().mockImplementation(() => ({ getProfile: vi.fn().mockResolvedValue({ studentCode: "20200001" }) })) };
});

import { automateVnuGoogleLogin } from "./google-login-automation";

describe("uet adapter importSession — Google automation path", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires a browserBinding when uetGoogleEmail/Password are provided", async () => {
    const adapter = createUetAdapter();
    await expect(adapter.importSession({ uetGoogleEmail: "a@vnu.edu.vn", uetGooglePassword: "x" })).rejects.toThrow(HyeboardError);
  });

  it("builds a session from a successful automation result and persists uetGoogleCredential with a long expiry", async () => {
    vi.mocked(automateVnuGoogleLogin).mockResolvedValue({
      studenthub: { accessToken: "sh-token", accountCode: "20200001" },
      canvas: { cookie: "a=b", csrfToken: "csrf" },
    });
    const adapter = createUetAdapter();
    const imported = await adapter.importSession(
      { uetGoogleEmail: "a@vnu.edu.vn", uetGooglePassword: "hunter2" },
      { browserBinding: { fetch: vi.fn() } },
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
      { browserBinding: { fetch: vi.fn() } },
    );
    expect(imported.session.studenthub).toBeDefined();
    expect(imported.session.canvas).toBeUndefined();
  });

  it("propagates a HyeboardError thrown by automation (e.g. GOOGLE_2FA_REQUIRED) unchanged", async () => {
    vi.mocked(automateVnuGoogleLogin).mockRejectedValue(new HyeboardError("GOOGLE_2FA_REQUIRED", "2FA required", 401));
    const adapter = createUetAdapter();
    await expect(
      adapter.importSession({ uetGoogleEmail: "a@vnu.edu.vn", uetGooglePassword: "hunter2" }, { browserBinding: { fetch: vi.fn() } }),
    ).rejects.toMatchObject({ code: "GOOGLE_2FA_REQUIRED" });
  });
});
