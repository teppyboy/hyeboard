import { afterEach, describe, expect, it, vi } from "vitest";
import {
  invalidatePolicyQueries,
  shouldInvalidateAccountQuery,
  shouldInvalidateScopedAccountQuery,
} from "@/lib/query-scope";
import { accountTermCode, accountTermState, runAccountScoped } from "@/state";

afterEach(() => vi.unstubAllGlobals());

describe("account-scoped term state", () => {
  it("does not expose the previous account term during a switch", () => {
    const timetable = vi.fn();
    const exams = vi.fn();
    const previous = accountTermState("account-a", "251");

    timetable(accountTermCode(previous, "account-b"));
    exams(accountTermCode(previous, "account-b"));

    expect(timetable).toHaveBeenCalledWith(undefined);
    expect(exams).toHaveBeenCalledWith(undefined);
  });

  it("lets the new dashboard initialize its own term", () => {
    let current = accountTermState("account-a", "251");
    const timetable = vi.fn();
    const exams = vi.fn();

    current = accountTermState("account-b");
    timetable(accountTermCode(current, "account-b"));
    exams(accountTermCode(current, "account-b"));
    current = accountTermState("account-b", "252");
    timetable(accountTermCode(current, "account-b"));
    exams(accountTermCode(current, "account-b"));

    expect(timetable.mock.calls).toEqual([[undefined], ["252"]]);
    expect(exams.mock.calls).toEqual([[undefined], ["252"]]);
  });

  it("does not expose the removed account term during an auto-switch", () => {
    const removed = accountTermState("account-b", "252");

    expect(accountTermCode(removed, "account-a")).toBeUndefined();
    expect(accountTermCode(accountTermState("account-a", "251"), "account-a")).toBe("251");
  });

  it("does not launch a feature request for a stale account render", async () => {
    const activeAccountId = "account-b";
    const request = vi.fn().mockResolvedValue("old-account-data");
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => key === "hyeboard.activeAccountId" ? activeAccountId : null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    vi.stubGlobal("sessionStorage", { getItem: () => null, removeItem: () => undefined });

    await expect(runAccountScoped("account-a", request)).rejects.toMatchObject({ name: "AbortError" });
    expect(request).not.toHaveBeenCalled();
  });
});

describe("shouldInvalidateAccountQuery", () => {
  const query = (queryKey: readonly unknown[], active = true) => ({
    queryKey,
    isActive: () => active,
  });

  it("invalidates active feature queries", () => {
    expect(shouldInvalidateAccountQuery(query(["dashboard", "uet", undefined, 1]))).toBe(true);
    expect(shouldInvalidateAccountQuery(query(["grades", "vnu", "251", 1]))).toBe(true);
  });

  it("keeps static and inactive queries cached", () => {
    expect(shouldInvalidateAccountQuery(query(["universities"]))).toBe(false);
    expect(shouldInvalidateAccountQuery(query(["grades", "vnu", undefined, 1], false))).toBe(false);
    expect(shouldInvalidateAccountQuery(query(["unknown", "uet", undefined, 1]))).toBe(false);
  });

  it("scopes policy updates to the originating account generation", () => {
    expect(shouldInvalidateScopedAccountQuery(query(["dashboard", "uet", undefined, 4]), "uet", 4)).toBe(true);
    expect(shouldInvalidateScopedAccountQuery(query(["grades", "uet", "251", 4]), "uet", 4)).toBe(true);
    expect(shouldInvalidateScopedAccountQuery(query(["grades", "vnu", "251", 4]), "uet", 4)).toBe(false);
    expect(shouldInvalidateScopedAccountQuery(query(["grades", "uet", "251", 5]), "uet", 4)).toBe(false);
  });

  it("invalidates universities plus only active queries from the originating account", async () => {
    const cancelQueries = vi.fn().mockResolvedValue(undefined);
    const invalidateQueries = vi.fn().mockResolvedValue(undefined);
    const queryClient = { cancelQueries, invalidateQueries, clear: vi.fn() };

    await invalidatePolicyQueries(queryClient, { universityId: "uet", sessionNonce: 4 });

    expect(cancelQueries).toHaveBeenCalledTimes(1);
    const cancelOptions = cancelQueries.mock.calls[0]?.[0];
    expect(cancelOptions.predicate(query(["grades", "uet", "251", 4]))).toBe(true);
    expect(cancelOptions.predicate(query(["grades", "uet", "251", 5]))).toBe(false);
    expect(invalidateQueries).toHaveBeenCalledTimes(2);
    expect(invalidateQueries.mock.calls[0]?.[0]).toEqual({ queryKey: ["universities"], refetchType: "active" });
    const featureOptions = invalidateQueries.mock.calls[1]?.[0];
    expect(featureOptions.refetchType).toBe("active");
    expect(featureOptions.predicate(query(["grades", "uet", "251", 4]))).toBe(true);
    expect(featureOptions.predicate(query(["grades", "vnu", "251", 4]))).toBe(false);
    expect(featureOptions.predicate(query(["grades", "uet", "251", 5]))).toBe(false);
    expect(featureOptions.predicate(query(["universities"]))).toBe(false);
    expect(featureOptions.predicate(query(["grades", "uet", "251", 4], false))).toBe(false);
    expect(queryClient.clear).not.toHaveBeenCalled();
  });
});
