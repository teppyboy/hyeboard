import type { AdminPolicyView, FeaturePolicyAuditEntry, FeaturePolicyContent } from "@hyeboard/schemas";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { historyPageState, seedRollbackCaches } from "./admin-history";

const policy = (...disabled: string[]): FeaturePolicyContent => ({
  global: { capabilities: Object.fromEntries(disabled.map((key) => [key, { enabled: false }])), limits: {} },
  universities: {},
});

const entry = (revision: number, baseRevision: number, snapshot: FeaturePolicyContent): FeaturePolicyAuditEntry => ({
  revision,
  baseRevision,
  actor: { method: "password", subject: "operator" },
  reason: `Revision ${revision}`,
  publishedAt: "2026-08-23T12:00:00.000Z",
  snapshot: { revision, ...snapshot },
});

describe("historyPageState", () => {
  it("separates initial and load-more failures", () => {
    expect(historyPageState(undefined, true)).toEqual({ initialError: true, loadMoreError: false });
    expect(historyPageState(3, true)).toEqual({ initialError: false, loadMoreError: true });
    expect(historyPageState(3, false)).toEqual({ initialError: false, loadMoreError: false });
  });
});

describe("seedRollbackCaches", () => {
  it("commits the rollback response before scheduling one history invalidation", () => {
    const queryClient = new QueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const current: AdminPolicyView = {
      snapshot: { revision: 5, ...policy("grades") },
      hardLimits: { "crossLookup.bulkMaxTargets": 100 },
      nativeUniversities: [],
      effectiveUniversities: [],
    };
    queryClient.setQueryData(["admin", "policy"], current);
    queryClient.setQueryData(["admin", "history", undefined], { items: [entry(4, 0, policy())] });

    const published = entry(6, 5, policy());
    seedRollbackCaches(queryClient, published);

    expect(queryClient.getQueryData<AdminPolicyView>(["admin", "policy"])).toEqual({ ...current, snapshot: published.snapshot });
    expect(queryClient.getQueryData<{ items: FeaturePolicyAuditEntry[] }>(["admin", "history", undefined])?.items.map(({ revision }) => revision)).toEqual([6, 4]);
    expect(queryClient.getQueryData(["admin", "history", "revision", 6])).toEqual(published);
    expect(invalidateQueries).toHaveBeenCalledOnce();
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["admin", "history", undefined], exact: true });
  });

  it("keeps the committed revision when the scheduled invalidation rejects", async () => {
    const queryClient = new QueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries").mockRejectedValue(new Error("Synthetic refresh failure"));
    const current: AdminPolicyView = {
      snapshot: { revision: 5, ...policy("grades") },
      hardLimits: {},
      nativeUniversities: [],
      effectiveUniversities: [],
    };
    queryClient.setQueryData(["admin", "policy"], current);

    const published = entry(6, 5, policy());
    seedRollbackCaches(queryClient, published);
    await Promise.resolve();

    expect(invalidateQueries).toHaveBeenCalledOnce();
    expect(queryClient.getQueryData<AdminPolicyView>(["admin", "policy"])?.snapshot.revision).toBe(6);
    expect(queryClient.getQueryData(["admin", "history", "revision", 6])).toEqual(published);
  });
});
