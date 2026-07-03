import { describe, expect, it } from "vitest";
import { decryptSession, encryptSession, type EncryptedSessionPayload } from "./index";

const SECRET = "a".repeat(32);

describe("encryptSession / decryptSession", () => {
  it("roundtrips a payload carrying uetGoogleCredential", async () => {
    const payload: EncryptedSessionPayload = {
      version: 1,
      universityId: "uet",
      studentCode: "20200001",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      studenthub: { kind: "bearer", value: "sh-token", expiresAt: new Date(Date.now() + 60_000).toISOString() },
      uetGoogleCredential: { email: "student@vnu.edu.vn", password: "correct horse battery staple" },
    };
    const token = await encryptSession(payload, SECRET);
    const decrypted = await decryptSession(token, SECRET);
    expect(decrypted.uetGoogleCredential).toEqual(payload.uetGoogleCredential);
    expect(decrypted.studenthub?.value).toBe("sh-token");
  });

  it("omits uetGoogleCredential when not set (manual-paste sessions unaffected)", async () => {
    const payload: EncryptedSessionPayload = {
      version: 1,
      universityId: "uet",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      studenthub: { kind: "bearer", value: "sh-token", expiresAt: new Date(Date.now() + 60_000).toISOString() },
    };
    const token = await encryptSession(payload, SECRET);
    const decrypted = await decryptSession(token, SECRET);
    expect(decrypted.uetGoogleCredential).toBeUndefined();
  });
});
