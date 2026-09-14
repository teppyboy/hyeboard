import { describe, expect, it } from "vitest";
import { lookupFreshnessKey } from "./lookup";

describe("lookupFreshnessKey", () => {
  it("changes for a new session generation on the same account", () => {
    expect(lookupFreshnessKey("vnu", "account-a", 4)).not.toBe(lookupFreshnessKey("vnu", "account-a", 5));
  });
});
