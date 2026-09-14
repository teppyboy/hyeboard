import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  consumeBudgetWindow,
  type VnuProbeBudgetDurableObject,
} from "../src/vnu/vnu-probe-budget-durable-object";
import {
  VNU_CROSS_DETAIL_POLICY_VERSION,
  VNU_PROBE_BUDGET_LIMIT,
  VNU_PROBE_BUDGET_WINDOW_SECONDS,
  type VnuCrossDetailConsumeInput,
  type VnuCrossDetailIssuedPermit,
  type VnuCrossDetailLimits,
} from "../src/vnu/vnu-probe-budget";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    VNU_PROBE_BUDGET: Env["VNU_PROBE_BUDGET"];
  }
}

afterEach(() => reset());

describe("VnuProbeBudgetDurableObject", () => {
  it("authoritatively rejects concurrent consumption beyond the fixed-window limit", async () => {
    const stub = env.VNU_PROBE_BUDGET.getByName("a".repeat(64));
    const results = await Promise.all(
      Array.from({ length: VNU_PROBE_BUDGET_LIMIT + 1 }, () => stub.consume(1)),
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(
      VNU_PROBE_BUDGET_LIMIT,
    );
    expect(results.filter((result) => !result.allowed)).toHaveLength(1);
  });

  it("atomically accepts or rejects whole concurrent reservations", async () => {
    const stub = env.VNU_PROBE_BUDGET.getByName("c".repeat(64));
    const results = await Promise.all(
      Array.from({ length: 5 }, () => stub.reserve(66)),
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(4);
    expect(results.filter((result) => !result.allowed)).toHaveLength(1);
    const entries = await runInDurableObject(
      stub,
      async (_instance: VnuProbeBudgetDurableObject, state) => [
        ...(await state.storage.list()),
      ],
    );
    expect(entries[0]?.[1]).toEqual({
      count: 264,
      resetAt: expect.any(Number),
    });
  });

  it("stores only count and resetAt under a constant key", async () => {
    const stub = env.VNU_PROBE_BUDGET.getByName("b".repeat(64));
    await stub.consume(1);

    const entries = await runInDurableObject(
      stub,
      async (_instance: VnuProbeBudgetDurableObject, state) => {
        return [...(await state.storage.list())];
      },
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.[0]).toBe("window");
    expect(entries[0]?.[1]).toEqual({ count: 1, resetAt: expect.any(Number) });
    expect(JSON.stringify(entries)).not.toContain("cookie");
    expect(JSON.stringify(entries)).not.toMatch(/20000001|00000001002/);
  });

  it("uses exact fixed-window boundaries with deterministic time", () => {
    const firstNow = 1_000_000;
    const expectedFirstResetAt =
      firstNow + VNU_PROBE_BUDGET_WINDOW_SECONDS * 1000;

    const first = consumeBudgetWindow(undefined, 1, firstNow);
    expect(first).toEqual({
      window: { count: 1, resetAt: expectedFirstResetAt },
      result: { allowed: true },
    });

    const full = consumeBudgetWindow(
      first.window,
      VNU_PROBE_BUDGET_LIMIT - 1,
      firstNow,
    );
    expect(full).toEqual({
      window: { count: VNU_PROBE_BUDGET_LIMIT, resetAt: expectedFirstResetAt },
      result: { allowed: true },
    });

    const rejected301st = consumeBudgetWindow(full.window, 1, firstNow);
    expect(rejected301st).toEqual({
      window: full.window,
      result: {
        allowed: false,
        retryAfterSeconds: VNU_PROBE_BUDGET_WINDOW_SECONDS,
      },
    });

    const rejectedBeforeReset = consumeBudgetWindow(
      full.window,
      1,
      expectedFirstResetAt - 1,
    );
    expect(rejectedBeforeReset).toEqual({
      window: full.window,
      result: { allowed: false, retryAfterSeconds: 1 },
    });

    const reset = consumeBudgetWindow(full.window, 1, expectedFirstResetAt);
    expect(reset).toEqual({
      window: {
        count: 1,
        resetAt: expectedFirstResetAt + VNU_PROBE_BUDGET_WINDOW_SECONDS * 1000,
      },
      result: { allowed: true },
    });
  });

  it("leases six Brc1 permits, rejects a seventh, and safely releases only its own lease", async () => {
    const stub = env.VNU_PROBE_BUDGET.getByName("d".repeat(64));
    const leases = await Promise.all(
      Array.from({ length: 6 }, () => stub.acquireBrc1Permit()),
    );
    expect(leases.every((lease) => lease.allowed)).toBe(true);
    await expect(stub.acquireBrc1Permit()).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    });
    const first = leases[0];
    if (!first?.allowed) throw new Error("Synthetic permit was not granted");
    await stub.releaseBrc1Permit("0".repeat(32));
    await expect(stub.acquireBrc1Permit()).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    });
    await stub.releaseBrc1Permit(first.leaseId);
    await expect(stub.acquireBrc1Permit()).resolves.toMatchObject({
      allowed: true,
    });
  });

  it("alarm removes expired permits without changing legacy quota window storage", async () => {
    const stub = env.VNU_PROBE_BUDGET.getByName("e".repeat(64));
    await runInDurableObject(
      stub,
      async (instance: VnuProbeBudgetDurableObject, state) => {
        await state.storage.put("window", {
          count: 42,
          resetAt: Date.now() + 60_000,
        });
        await state.storage.put("brc1-permits", {
          ["a".repeat(32)]: Date.now() - 1,
        });
        await instance.alarm();
        expect(await state.storage.get("window")).toEqual({
          count: 42,
          resetAt: expect.any(Number),
        });
        expect(await state.storage.get("brc1-permits")).toBeUndefined();
      },
    );
    await expect(stub.reserve(1)).resolves.toEqual({ allowed: true });
    const entries = await runInDurableObject(
      stub,
      async (_instance: VnuProbeBudgetDurableObject, state) => [
        ...(await state.storage.list()),
      ],
    );
    expect(entries.find(([key]) => key === "window")?.[1]).toEqual({
      count: 43,
      resetAt: expect.any(Number),
    });
  });
});

describe("VnuProbeBudgetDurableObject cross-detail permits", () => {
  const LIMITS: VnuCrossDetailLimits = {
    maxTargets: 2,
    maxRows: 4,
    concurrency: 2,
    budget: 4,
    windowSeconds: 600,
  };
  const SYNTHETIC_TARGET_IDENTITY = "99000000001";
  const SYNTHETIC_CLASS_IDENTITY = "990099";

  function syntheticPermit(
    hashSeed: string,
    overrides: Partial<VnuCrossDetailIssuedPermit["record"]> = {},
  ): VnuCrossDetailIssuedPermit {
    return {
      permitHash: hashSeed.repeat(64),
      record: {
        requesterHmac: "3".repeat(64),
        targetHmac: "4".repeat(64),
        revisionHmac: "5".repeat(64),
        rowHmac: "6".repeat(64),
        policyVersion: VNU_CROSS_DETAIL_POLICY_VERSION,
        nonce: "2".repeat(32),
        envelope: "AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        expiresAt: Date.now() + 60_000,
        ...overrides,
      },
    };
  }

  function consumeInputFor(
    permit: VnuCrossDetailIssuedPermit,
    overrides: Partial<VnuCrossDetailConsumeInput> = {},
  ): VnuCrossDetailConsumeInput {
    return {
      permitHash: permit.permitHash,
      nonce: permit.record.nonce,
      requesterHmac: permit.record.requesterHmac,
      targetHmac: permit.record.targetHmac,
      revisionHmac: permit.record.revisionHmac,
      rowHmac: permit.record.rowHmac,
      policyVersion: permit.record.policyVersion,
      ...overrides,
    };
  }

  it("issues and consumes a permit exactly once, returning the stored envelope only on success", async () => {
    const stub = env.VNU_PROBE_BUDGET.getByName("f".repeat(64));
    const permit = syntheticPermit("1");
    await stub.issueCrossDetailPermits([permit], LIMITS);

    const first = await stub.consumeCrossDetailPermit(
      consumeInputFor(permit),
      LIMITS,
    );
    expect(first).toMatchObject({
      allowed: true,
      leaseId: expect.stringMatching(/^[0-9a-f]{32}$/),
      envelope: permit.record.envelope,
    });

    const replay = await stub.consumeCrossDetailPermit(
      consumeInputFor(permit),
      LIMITS,
    );
    expect(replay).toEqual({ allowed: false, reason: "invalid" });

    const unknown = await stub.consumeCrossDetailPermit(
      consumeInputFor(permit, { permitHash: "8".repeat(64) }),
      LIMITS,
    );
    expect(unknown).toEqual({ allowed: false, reason: "invalid" });
  });

  it.each([
    ["nonce", { nonce: "9".repeat(32) }],
    ["requesterHmac", { requesterHmac: "9".repeat(64) }],
    ["targetHmac", { targetHmac: "9".repeat(64) }],
    ["revisionHmac", { revisionHmac: "9".repeat(64) }],
    ["rowHmac", { rowHmac: "9".repeat(64) }],
  ])(
    "rejects a %s mismatch and keeps the permit retryable",
    async (_label, mutation) => {
      const stub = env.VNU_PROBE_BUDGET.getByName("f".repeat(64));
      const permit = syntheticPermit("2");
      await stub.issueCrossDetailPermits([permit], LIMITS);

      const rejected = await stub.consumeCrossDetailPermit(
        consumeInputFor(permit, mutation),
        LIMITS,
      );
      expect(rejected).toEqual({ allowed: false, reason: "invalid" });

      const stillValid = await stub.consumeCrossDetailPermit(
        consumeInputFor(permit),
        LIMITS,
      );
      expect(stillValid.allowed).toBe(true);
    },
  );

  it("rejects a foreign policy version without consuming the permit", async () => {
    const stub = env.VNU_PROBE_BUDGET.getByName("f".repeat(64));
    const permit = syntheticPermit("3");
    await stub.issueCrossDetailPermits([permit], LIMITS);

    const input = {
      ...consumeInputFor(permit),
      policyVersion: 2,
    } as unknown as VnuCrossDetailConsumeInput;
    await expect(stub.consumeCrossDetailPermit(input, LIMITS)).resolves.toEqual(
      { allowed: false, reason: "invalid" },
    );

    const stillValid = await stub.consumeCrossDetailPermit(
      consumeInputFor(permit),
      LIMITS,
    );
    expect(stillValid.allowed).toBe(true);
  });

  it("rejects an expired permit as invalid", async () => {
    const stub = env.VNU_PROBE_BUDGET.getByName("f".repeat(64));
    const permit = syntheticPermit("4", { expiresAt: Date.now() - 1 });
    await stub.issueCrossDetailPermits([permit], LIMITS);

    const result = await stub.consumeCrossDetailPermit(
      consumeInputFor(permit),
      LIMITS,
    );
    expect(result).toEqual({ allowed: false, reason: "invalid" });
  });

  it("settles concurrent same-permit consumes with exactly one winner and one charge", async () => {
    const stub = env.VNU_PROBE_BUDGET.getByName("f".repeat(64));
    const permit = syntheticPermit("5");
    await stub.issueCrossDetailPermits([permit], LIMITS);

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        stub.consumeCrossDetailPermit(consumeInputFor(permit), LIMITS),
      ),
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(1);
    expect(results.filter((result) => !result.allowed)).toHaveLength(3);
    const entries = await runInDurableObject(
      stub,
      async (_instance: VnuProbeBudgetDurableObject, state) => [
        ...(await state.storage.list()),
      ],
    );
    expect(entries.find(([key]) => key === "cross-detail-window")?.[1]).toEqual(
      { count: 1, resetAt: expect.any(Number) },
    );
  });

  it("exhausts the detail budget without burning the rejected permit", async () => {
    const stub = env.VNU_PROBE_BUDGET.getByName("f".repeat(64));
    const tight: VnuCrossDetailLimits = { ...LIMITS, budget: 1 };
    const first = syntheticPermit("6");
    const second = syntheticPermit("7");
    await stub.issueCrossDetailPermits([first, second], LIMITS);

    await expect(
      stub.consumeCrossDetailPermit(consumeInputFor(first), tight),
    ).resolves.toMatchObject({ allowed: true });
    const rejected = await stub.consumeCrossDetailPermit(
      consumeInputFor(second),
      tight,
    );
    expect(rejected).toEqual({
      allowed: false,
      reason: "budget",
      retryAfterSeconds: expect.any(Number),
    });

    const retriedWithWiderLimit = await stub.consumeCrossDetailPermit(
      consumeInputFor(second),
      { ...LIMITS, budget: 2 },
    );
    expect(retriedWithWiderLimit.allowed).toBe(true);
  });

  it("saturates detail concurrency, frees capacity on release, and ignores foreign lease releases", async () => {
    const stub = env.VNU_PROBE_BUDGET.getByName("f".repeat(64));
    const tight: VnuCrossDetailLimits = { ...LIMITS, concurrency: 1 };
    const first = syntheticPermit("8");
    const second = syntheticPermit("9");
    await stub.issueCrossDetailPermits([first, second], LIMITS);

    const winner = await stub.consumeCrossDetailPermit(
      consumeInputFor(first),
      tight,
    );
    if (!winner.allowed) throw new Error("Synthetic permit was not granted");
    await expect(
      stub.consumeCrossDetailPermit(consumeInputFor(second), tight),
    ).resolves.toEqual({
      allowed: false,
      reason: "busy",
      retryAfterSeconds: 1,
    });

    await stub.releaseCrossDetailLease("0".repeat(32));
    await expect(
      stub.consumeCrossDetailPermit(consumeInputFor(second), tight),
    ).resolves.toEqual({
      allowed: false,
      reason: "busy",
      retryAfterSeconds: 1,
    });

    await stub.releaseCrossDetailLease(winner.leaseId);
    await expect(
      stub.consumeCrossDetailPermit(consumeInputFor(second), tight),
    ).resolves.toMatchObject({ allowed: true });
  });

  it("stores only hashes, HMAC bindings, and the opaque envelope for detail permits", async () => {
    const stub = env.VNU_PROBE_BUDGET.getByName("f".repeat(64));
    await stub.issueCrossDetailPermits([syntheticPermit("a")], LIMITS);

    const entries = await runInDurableObject(
      stub,
      async (_instance: VnuProbeBudgetDurableObject, state) => [
        ...(await state.storage.list()),
      ],
    );
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(SYNTHETIC_TARGET_IDENTITY);
    expect(serialized).not.toContain(SYNTHETIC_CLASS_IDENTITY);
    expect(serialized).not.toContain("cookie");
    const permitsEntry = entries.find(
      ([key]) => key === "cross-detail-permits",
    );
    expect(JSON.stringify(permitsEntry?.[1])).toMatch(/^(\{"[0-9a-f]{64}":)/);
  });

  it("rejects an issuance batch that exceeds configured caps before any storage write", async () => {
    const stub = env.VNU_PROBE_BUDGET.getByName("f".repeat(64));
    const oversized = Array.from({ length: LIMITS.maxRows + 1 }, (_, index) =>
      syntheticPermit(index.toString(16)),
    );

    // Direct (non-RPC) invocation: the assertion is a route-bug guard that
    // throws, and RPC-thrown errors surface as unhandled rejections in the
    // pool rather than as a capturable method rejection.
    await runInDurableObject(
      stub,
      async (instance: VnuProbeBudgetDurableObject) => {
        await expect(
          instance.issueCrossDetailPermits(oversized, LIMITS),
        ).rejects.toThrowError(/invalid/i);
      },
    );

    const entries = await runInDurableObject(
      stub,
      async (_instance: VnuProbeBudgetDurableObject, state) => [
        ...(await state.storage.list()),
      ],
    );
    expect(
      entries.find(([key]) => key === "cross-detail-permits"),
    ).toBeUndefined();
  });

  it("alarm prunes expired detail permits and leases without touching the detail budget window", async () => {
    const stub = env.VNU_PROBE_BUDGET.getByName("f".repeat(64));
    await runInDurableObject(
      stub,
      async (instance: VnuProbeBudgetDurableObject, state) => {
        await state.storage.put("cross-detail-window", {
          count: 3,
          resetAt: Date.now() + 60_000,
        });
        await state.storage.put("cross-detail-permits", {
          ["b".repeat(64)]: {
            ...syntheticPermit("b").record,
            expiresAt: Date.now() - 1,
          },
        });
        await state.storage.put("cross-detail-leases", {
          ["c".repeat(32)]: Date.now() - 1,
        });
        await instance.alarm();
        expect(await state.storage.get("cross-detail-window")).toEqual({
          count: 3,
          resetAt: expect.any(Number),
        });
        expect(await state.storage.get("cross-detail-permits")).toBeUndefined();
        expect(await state.storage.get("cross-detail-leases")).toBeUndefined();
      },
    );
  });
});
