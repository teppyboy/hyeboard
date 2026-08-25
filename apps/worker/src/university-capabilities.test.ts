import { encryptSession, type EncryptedSessionPayload } from "@hyeboard/core";
import { DaotaoClient } from "@hyeboard/university-adapters";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp, setFeaturePolicyRuntime, setRuntimeConfig, setVnuProbeBudgetCoordinator } from "./app";
import { FeaturePolicyRuntime, InProcessFeaturePolicyEvents, MemoryFeaturePolicyStore } from "./feature-policy-store";
import type { VnuProbeBudgetCoordinator } from "./vnu-probe-budget";

// Self-hosted (Node/Bun) deployments never install a probe-budget
// coordinator, so every cross-lookup route there fails closed with 503. The
// capability payload must say so honestly instead of rendering cross-lookup
// UI whose every request errors; the static adapter record itself stays
// untouched for the Cloudflare deployment. This file gets its own module
// graph (vitest isolates per file), so the coordinator starts uninstalled
// here regardless of what app.test.ts installs.
//
// ORDER MATTERS: the coordinator-install test must run last within this
// file — installation is module-level state and cannot be uninstalled.

const SESSION_SECRET = "worker-test-secret-worker-test-secret";

type UniversitiesPayload = {
  data: Array<{
    id: string;
    capabilities: Record<string, boolean>;
    limits?: { crossLookup?: { bulkMaxTargets: number; crossDetail?: { maxTargets: number; maxRows: number; concurrency: number } } };
  }>;
};

function vnuSession(): EncryptedSessionPayload {
  return {
    version: 1,
    universityId: "vnu",
    vnu: { kind: "cookie", value: "SYNTHETIC_SELFHOST_COOKIE", expiresAt: "2099-01-01T00:00:00.000Z" },
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

async function listUniversities(app: ReturnType<typeof createApp>): Promise<UniversitiesPayload["data"]> {
  const response = await app.handle(new Request("http://localhost/api/universities"));
  expect(response.status).toBe(200);
  const body = await response.json() as UniversitiesPayload;
  expect(body.data.length).toBeGreaterThan(0);
  return body.data;
}

describe("university capability serialization", () => {
  let policyRuntime: FeaturePolicyRuntime;

  beforeEach(() => {
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET });
    policyRuntime = new FeaturePolicyRuntime(new MemoryFeaturePolicyStore(), new InProcessFeaturePolicyEvents());
    setFeaturePolicyRuntime(policyRuntime);
  });

  afterEach(async () => {
    setFeaturePolicyRuntime(undefined);
    await policyRuntime.close();
  });

  it("masks crossLookup off without an installed coordinator and keeps the routes fail-closed 503", async () => {
    const app = createApp(undefined);

    const universities = await listUniversities(app);
    const vnu = universities.find((university) => university.id === "vnu");
    expect(vnu?.capabilities.crossLookup).toBe(false);
    // Only crossLookup is masked — the rest of the static record (and the
    // other universities) passes through untouched.
    expect(vnu?.capabilities.classLookup).toBe(true);
    expect(vnu?.capabilities.grades).toBe(true);
    expect(universities.find((university) => university.id === "mock")?.capabilities.crossLookup).toBe(false);
    expect(universities.find((university) => university.id === "uet")?.capabilities.crossLookup).toBe(false);

    const profileSpy = vi.spyOn(DaotaoClient.prototype, "getProfileHtml")
      .mockResolvedValue(`<input name="hidStdID" value="1000"><input name="StdCode" value="20000000">`);
    const transcriptSpy = vi.spyOn(DaotaoClient.prototype, "getTranscriptByStdIdHtml")
      .mockResolvedValue("<table></table>");
    try {
      const token = await encryptSession(vnuSession(), SESSION_SECRET);
      const response = await app.handle(new Request("http://localhost/api/vnu/cross-lookup/student-code?stdId=1002&allowCrossLookup=true", {
        headers: { Authorization: `Bearer ${token}` },
      }));

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "FEATURE_DISABLED", details: { capability: "crossLookup" } } });
      expect(transcriptSpy).not.toHaveBeenCalled();
    } finally {
      profileSpy.mockRestore();
      transcriptSpy.mockRestore();
    }
  });

  it("serializes effective policy without changing the universities response shape", async () => {
    setVnuProbeBudgetCoordinator({
      async consume() {}, async reserve() {}, async acquireBrc1Permit() { return { leaseId: "a".repeat(32), expiresAt: Date.now() + 1_000 }; },
      async releaseBrc1Permit() {}, async issueCrossDetailPermits() {}, async consumeCrossDetailPermit() { throw new Error("not exercised"); }, async releaseCrossDetailLease() {},
    });
    await policyRuntime.publish({
      baseRevision: 0,
      policy: {
        global: { capabilities: { grades: { enabled: false } }, limits: { "crossLookup.bulkMaxTargets": 20 } },
        universities: {},
      },
      reason: "Synthetic university serialization policy",
      actor: { method: "password", subject: "test-admin" },
    });
    const universities = await listUniversities(createApp(undefined));

    expect(Array.isArray(universities)).toBe(true);
    expect(universities.every((university) => university.capabilities.grades === false)).toBe(true);
    expect(universities.find((university) => university.id === "vnu")?.limits?.crossLookup?.bulkMaxTargets).toBe(20);
  });

  it("publishes a supplied VNU bulk limit as effective metadata without mutating other universities", async () => {
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET, VNU_CROSS_LOOKUP_BULK_MAX_TARGETS: "500" });
    const coordinator: VnuProbeBudgetCoordinator = {
      async consume() { /* not exercised — capability wiring only */ },
      async reserve() { /* not exercised — capability wiring only */ },
      async acquireBrc1Permit() { return { leaseId: "a".repeat(32), expiresAt: Date.now() + 1_000 }; },
      async releaseBrc1Permit() { /* not exercised — capability wiring only */ },
      async issueCrossDetailPermits() { /* not exercised — capability wiring only */ },
      async consumeCrossDetailPermit() { throw new Error("not exercised"); },
      async releaseCrossDetailLease() { /* not exercised — capability wiring only */ },
    };
    setVnuProbeBudgetCoordinator(coordinator);

    const universities = await listUniversities(createApp(undefined));

    expect(universities.find((university) => university.id === "vnu")).toMatchObject({
      capabilities: { crossLookup: true },
      limits: {
        crossLookup: {
          bulkMaxTargets: 500,
          bulkDirectChunkMaxTargets: 32,
          bulkModeMaxTargets: {
            "stdid-to-code": 500,
            "stdid-to-transcript": 500,
            "code-to-stdid": 9,
          },
        },
      },
    });
    expect(universities.find((university) => university.id === "mock")?.limits).toBeUndefined();
    expect(universities.find((university) => university.id === "uet")?.limits).toBeUndefined();

    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET, VNU_CROSS_LOOKUP_BULK_MAX_TARGETS: "0" });
    const disabledBulkUniversities = await listUniversities(createApp(undefined));
    expect(disabledBulkUniversities.find((university) => university.id === "vnu")).toMatchObject({ capabilities: { crossLookup: false } });
    expect(disabledBulkUniversities.find((university) => university.id === "vnu")?.limits).toBeUndefined();
  });

  // These cross-detail tests rely on the coordinator installed by the test
  // above (module-level, cannot be uninstalled) — they must run after it.
  it("publishes cross-detail limits with documented defaults alongside bulk limits", async () => {
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET });

    const vnu = (await listUniversities(createApp(undefined))).find((university) => university.id === "vnu");

    expect(vnu?.limits?.crossLookup).toMatchObject({
      bulkMaxTargets: 500,
      crossDetail: { maxTargets: 50, maxRows: 200, concurrency: 6 },
    });
    expect((await listUniversities(createApp(undefined))).find((university) => university.id === "mock")?.limits).toBeUndefined();
  });

  it("publishes configured cross-detail limits", async () => {
    setRuntimeConfig({
      HYEB_SESSION_SECRET: SESSION_SECRET,
      VNU_CROSS_DETAIL_MAX_TARGETS: "12",
      VNU_CROSS_DETAIL_MAX_ROWS: "34",
      VNU_CROSS_DETAIL_CONCURRENCY: "2",
    });

    const vnu = (await listUniversities(createApp(undefined))).find((university) => university.id === "vnu");

    expect(vnu?.limits?.crossLookup?.crossDetail).toEqual({ maxTargets: 12, maxRows: 34, concurrency: 2 });
  });

  it.each([
    ["malformed bound", { VNU_CROSS_DETAIL_MAX_ROWS: "raw" }],
    ["zero bound", { VNU_CROSS_DETAIL_BUDGET: "0" }],
    ["non-selected export mode", { VNU_CROSS_DETAIL_EXPORT_MODE: "all" }],
  ] as const)("omits cross-detail limits but keeps bulk limits when disabled by %s", async (_label, overrides) => {
    setRuntimeConfig({ HYEB_SESSION_SECRET: SESSION_SECRET, ...overrides });

    const vnu = (await listUniversities(createApp(undefined))).find((university) => university.id === "vnu");

    expect(vnu?.limits?.crossLookup?.bulkMaxTargets).toBe(500);
    expect(vnu?.limits?.crossLookup?.crossDetail).toBeUndefined();
  });
});
