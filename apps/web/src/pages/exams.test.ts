import { describe, expect, it } from "vitest";
import { effectiveExamTerm } from "./exams";

describe("effectiveExamTerm", () => {
  const manuallySelected = { accountId: "account-a", sessionNonce: 4, code: "20242" };

  it("keeps a manual selection for the same account generation", () => {
    expect(effectiveExamTerm(manuallySelected, "account-a", 4, "20251")).toBe("20242");
  });

  it("uses the new account term after a switch", () => {
    expect(effectiveExamTerm(manuallySelected, "account-b", 5, "NEW-TERM")).toBe("NEW-TERM");
  });

  it("uses the remaining account term after removal", () => {
    const removedAccountSelection = { accountId: "account-b", sessionNonce: 5, code: "20242" };

    expect(effectiveExamTerm(removedAccountSelection, "account-a", 6, "20251")).toBe("20251");
  });

  it("uses refreshed account state after the session generation changes", () => {
    expect(effectiveExamTerm(manuallySelected, "account-a", 5, "20251")).toBe("20251");
  });
});
