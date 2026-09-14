import { describe, expect, it } from "vitest";
import {
  DurableObjectVnuProbeBudgetCoordinator,
  VNU_CROSS_DETAIL_POLICY_VERSION,
  VNU_PROBE_BUDGET_LIMIT,
  VNU_PROBE_BUDGET_WINDOW_SECONDS,
  type VnuCrossDetailConsumeResult,
  type VnuCrossDetailLimits,
} from "./vnu-probe-budget";

const SESSION_IDENTITY = "a".repeat(64);

describe("VNU probe-budget coordinators", () => {
  const stub = (
    operation: () => Promise<
      { allowed: true } | { allowed: false; retryAfterSeconds: number }
    >,
  ) => ({
    consume: operation,
    reserve: operation,
    acquireBrc1Permit: async () => ({
      allowed: true as const,
      leaseId: "b".repeat(32),
      expiresAt: Date.now() + 1_000,
    }),
    releaseBrc1Permit: async () => undefined,
    issueCrossDetailPermits: async () => undefined,
    consumeCrossDetailPermit: async () => ({
      allowed: false as const,
      reason: "invalid" as const,
    }),
    releaseCrossDetailLease: async () => undefined,
  });

  it("maps confirmed Durable Object exhaustion to rate-limit semantics", async () => {
    const budget = new DurableObjectVnuProbeBudgetCoordinator({
      getByName: () =>
        stub(async () => ({
          allowed: false,
          retryAfterSeconds: VNU_PROBE_BUDGET_WINDOW_SECONDS,
        })),
    });

    await expect(budget.consume(SESSION_IDENTITY)).rejects.toMatchObject({
      code: "VNU_RATE_LIMITED",
      status: 429,
      details: {
        retryAfterSeconds: VNU_PROBE_BUDGET_WINDOW_SECONDS,
        limit: VNU_PROBE_BUDGET_LIMIT,
        windowSeconds: VNU_PROBE_BUDGET_WINDOW_SECONDS,
      },
    });
  });

  it("maps Durable Object failure to unavailable rather than exhaustion", async () => {
    const budget = new DurableObjectVnuProbeBudgetCoordinator({
      getByName: () =>
        stub(async () => {
          throw new Error("unavailable");
        }),
    });

    await expect(budget.consume(SESSION_IDENTITY)).rejects.toMatchObject({
      code: "VNU_PROBE_BUDGET_UNAVAILABLE",
      status: 503,
      details: { retryAfterSeconds: 5 },
    });
  });

  it("uses only the opaque HMAC identity as the Durable Object name", async () => {
    const names: string[] = [];
    const budget = new DurableObjectVnuProbeBudgetCoordinator({
      getByName: (name) => {
        names.push(name);
        return stub(async () => ({ allowed: true }));
      },
    });

    await budget.consume(SESSION_IDENTITY);

    expect(names).toEqual([SESSION_IDENTITY]);
  });

  it("uses one reserve RPC for a whole bulk allowance", async () => {
    const amounts: number[] = [];
    const budget = new DurableObjectVnuProbeBudgetCoordinator({
      getByName: () => ({
        consume: async () => ({ allowed: true }),
        reserve: async (amount) => {
          amounts.push(amount);
          return { allowed: true };
        },
        acquireBrc1Permit: async () => ({
          allowed: true,
          leaseId: "b".repeat(32),
          expiresAt: Date.now() + 1_000,
        }),
        releaseBrc1Permit: async () => undefined,
        issueCrossDetailPermits: async () => undefined,
        consumeCrossDetailPermit: async () => ({
          allowed: false as const,
          reason: "invalid" as const,
        }),
        releaseCrossDetailLease: async () => undefined,
      }),
    });

    await budget.reserve(SESSION_IDENTITY, 66);

    expect(amounts).toEqual([66]);
  });

  it("maps saturated Brc1 permits to bounded busy semantics", async () => {
    const budget = new DurableObjectVnuProbeBudgetCoordinator({
      getByName: () => ({
        consume: async () => ({ allowed: true }),
        reserve: async () => ({ allowed: true }),
        acquireBrc1Permit: async () => ({
          allowed: false,
          retryAfterSeconds: 1,
        }),
        releaseBrc1Permit: async () => undefined,
        issueCrossDetailPermits: async () => undefined,
        consumeCrossDetailPermit: async () => ({
          allowed: false as const,
          reason: "invalid" as const,
        }),
        releaseCrossDetailLease: async () => undefined,
      }),
    });
    await expect(
      budget.acquireBrc1Permit(SESSION_IDENTITY),
    ).rejects.toMatchObject({
      code: "VNU_CROSS_LOOKUP_BUSY",
      status: 429,
      details: { retryAfterSeconds: 1 },
    });
  });

  it("releases a permit granted after cancellation deterministically", async () => {
    let grant!: (result: {
      allowed: true;
      leaseId: string;
      expiresAt: number;
    }) => void;
    let releaseObserved!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseObserved = resolve;
    });
    const budget = new DurableObjectVnuProbeBudgetCoordinator({
      getByName: () => ({
        consume: async () => ({ allowed: true }),
        reserve: async () => ({ allowed: true }),
        acquireBrc1Permit: () =>
          new Promise((resolve) => {
            grant = resolve;
          }),
        releaseBrc1Permit: async (leaseId) => {
          expect(leaseId).toBe("b".repeat(32));
          releaseObserved();
        },
        issueCrossDetailPermits: async () => undefined,
        consumeCrossDetailPermit: async () => ({
          allowed: false as const,
          reason: "invalid" as const,
        }),
        releaseCrossDetailLease: async () => undefined,
      }),
    });
    const controller = new AbortController();
    const cancelled = budget.acquireBrc1Permit(
      SESSION_IDENTITY,
      controller.signal,
    );

    controller.abort(new DOMException("Synthetic cancellation", "AbortError"));
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    grant({
      allowed: true,
      leaseId: "b".repeat(32),
      expiresAt: Date.now() + 1_000,
    });

    await released;
  });
});

describe("VNU cross-detail permit coordinator", () => {
  const LIMITS: VnuCrossDetailLimits = {
    maxTargets: 2,
    maxRows: 3,
    concurrency: 2,
    budget: 7,
    windowSeconds: 90,
  };

  const consumeInput = () => ({
    permitHash: "1".repeat(64),
    nonce: "2".repeat(32),
    requesterHmac: "3".repeat(64),
    targetHmac: "4".repeat(64),
    revisionHmac: "5".repeat(64),
    rowHmac: "6".repeat(64),
    policyVersion: VNU_CROSS_DETAIL_POLICY_VERSION,
  });

  const issuedPermit = () => ({
    permitHash: "1".repeat(64),
    record: {
      requesterHmac: "3".repeat(64),
      targetHmac: "4".repeat(64),
      revisionHmac: "5".repeat(64),
      rowHmac: "6".repeat(64),
      policyVersion: VNU_CROSS_DETAIL_POLICY_VERSION,
      nonce: "2".repeat(32),
      envelope: "AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAA",
      expiresAt: Date.now() + 60_000,
    },
  });

  function coordinatorFor(stub: {
    issueCrossDetailPermits?: () => Promise<void>;
    consumeCrossDetailPermit?: () => Promise<VnuCrossDetailConsumeResult>;
    releaseCrossDetailLease?: () => Promise<void>;
  }) {
    return new DurableObjectVnuProbeBudgetCoordinator({
      getByName: () => ({
        consume: async () => ({ allowed: true }),
        reserve: async () => ({ allowed: true }),
        acquireBrc1Permit: async () => ({
          allowed: true as const,
          leaseId: "b".repeat(32),
          expiresAt: Date.now() + 1_000,
        }),
        releaseBrc1Permit: async () => undefined,
        issueCrossDetailPermits:
          stub.issueCrossDetailPermits ?? (async () => undefined),
        consumeCrossDetailPermit:
          stub.consumeCrossDetailPermit ??
          (async () => ({
            allowed: false as const,
            reason: "invalid" as const,
          })),
        releaseCrossDetailLease:
          stub.releaseCrossDetailLease ?? (async () => undefined),
      }),
    });
  }

  it("returns the lease and stored envelope on a successful consume", async () => {
    const coordinator = coordinatorFor({
      consumeCrossDetailPermit: async () => ({
        allowed: true,
        leaseId: "c".repeat(32),
        expiresAt: Date.now() + 125_000,
        envelope: "AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAA",
      }),
    });

    await expect(
      coordinator.consumeCrossDetailPermit(
        SESSION_IDENTITY,
        consumeInput(),
        LIMITS,
      ),
    ).resolves.toMatchObject({
      leaseId: "c".repeat(32),
      envelope: "AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAA",
    });
  });

  it("maps an invalid consume to one generic 403 permit error without the reason", async () => {
    const coordinator = coordinatorFor({
      consumeCrossDetailPermit: async () => ({
        allowed: false,
        reason: "invalid",
      }),
    });

    const rejection = await coordinator
      .consumeCrossDetailPermit(SESSION_IDENTITY, consumeInput(), LIMITS)
      .catch((error: unknown) => error);
    expect(rejection).toMatchObject({
      code: "VNU_CROSS_DETAIL_PERMIT_INVALID",
      status: 403,
    });
    expect(JSON.stringify(rejection)).not.toContain("reason");
  });

  it("maps budget exhaustion to 429 with the configured detail budget details", async () => {
    const coordinator = coordinatorFor({
      consumeCrossDetailPermit: async () => ({
        allowed: false,
        reason: "budget",
        retryAfterSeconds: 42,
      }),
    });

    await expect(
      coordinator.consumeCrossDetailPermit(
        SESSION_IDENTITY,
        consumeInput(),
        LIMITS,
      ),
    ).rejects.toMatchObject({
      code: "VNU_RATE_LIMITED",
      status: 429,
      details: { retryAfterSeconds: 42, limit: 7, windowSeconds: 90 },
    });
  });

  it("maps lease saturation to bounded busy semantics", async () => {
    const coordinator = coordinatorFor({
      consumeCrossDetailPermit: async () => ({
        allowed: false,
        reason: "busy",
        retryAfterSeconds: 1,
      }),
    });

    await expect(
      coordinator.consumeCrossDetailPermit(
        SESSION_IDENTITY,
        consumeInput(),
        LIMITS,
      ),
    ).rejects.toMatchObject({
      code: "VNU_CROSS_LOOKUP_BUSY",
      status: 429,
      details: { retryAfterSeconds: 1 },
    });
  });

  it.each(["issue", "consume", "release"] as const)(
    "maps a Durable Object %s failure to unavailable rather than a permit verdict",
    async (operation) => {
      const coordinator = coordinatorFor({
        issueCrossDetailPermits: async () => {
          throw new Error("synthetic outage");
        },
        consumeCrossDetailPermit: async () => {
          throw new Error("synthetic outage");
        },
        releaseCrossDetailLease: async () => {
          throw new Error("synthetic outage");
        },
      });

      if (operation === "issue")
        await expect(
          coordinator.issueCrossDetailPermits(
            SESSION_IDENTITY,
            [issuedPermit()],
            LIMITS,
          ),
        ).rejects.toMatchObject({
          code: "VNU_PROBE_BUDGET_UNAVAILABLE",
          status: 503,
        });
      if (operation === "consume")
        await expect(
          coordinator.consumeCrossDetailPermit(
            SESSION_IDENTITY,
            consumeInput(),
            LIMITS,
          ),
        ).rejects.toMatchObject({
          code: "VNU_PROBE_BUDGET_UNAVAILABLE",
          status: 503,
        });
      if (operation === "release")
        await expect(
          coordinator.releaseCrossDetailLease(SESSION_IDENTITY, "c".repeat(32)),
        ).rejects.toMatchObject({
          code: "VNU_PROBE_BUDGET_UNAVAILABLE",
          status: 503,
        });
    },
  );

  it("uses only the opaque HMAC identity as the Durable Object name for detail operations", async () => {
    const names: string[] = [];
    const coordinator = new DurableObjectVnuProbeBudgetCoordinator({
      getByName: (name) => {
        names.push(name);
        return {
          consume: async () => ({ allowed: true }),
          reserve: async () => ({ allowed: true }),
          acquireBrc1Permit: async () => ({
            allowed: true as const,
            leaseId: "b".repeat(32),
            expiresAt: Date.now() + 1_000,
          }),
          releaseBrc1Permit: async () => undefined,
          issueCrossDetailPermits: async () => undefined,
          consumeCrossDetailPermit: async () => ({
            allowed: false as const,
            reason: "invalid" as const,
          }),
          releaseCrossDetailLease: async () => undefined,
        };
      },
    });

    await coordinator.issueCrossDetailPermits(
      SESSION_IDENTITY,
      [issuedPermit()],
      LIMITS,
    );
    await coordinator
      .consumeCrossDetailPermit(SESSION_IDENTITY, consumeInput(), LIMITS)
      .catch(() => undefined);
    await coordinator.releaseCrossDetailLease(SESSION_IDENTITY, "c".repeat(32));

    expect(names).toEqual([
      SESSION_IDENTITY,
      SESSION_IDENTITY,
      SESSION_IDENTITY,
    ]);
  });

  it.each([
    ["permitHash", { permitHash: "1".repeat(63) }],
    ["nonce", { nonce: "2".repeat(31) }],
    ["requesterHmac", { requesterHmac: "3".repeat(63) }],
    ["targetHmac", { targetHmac: "4".repeat(63) }],
    ["revisionHmac", { revisionHmac: "5".repeat(63) }],
    ["rowHmac", { rowHmac: "6".repeat(63) }],
    ["policyVersion", { policyVersion: 2 }],
  ])(
    "fails fast on a malformed consume %s before any RPC",
    async (_label, mutation) => {
      let rpcCalled = false;
      const coordinator = coordinatorFor({
        consumeCrossDetailPermit: async () => {
          rpcCalled = true;
          return { allowed: false, reason: "invalid" };
        },
      });

      await expect(
        coordinator.consumeCrossDetailPermit(
          SESSION_IDENTITY,
          { ...consumeInput(), ...mutation },
          LIMITS,
        ),
      ).rejects.toThrowError(/invalid/i);
      expect(rpcCalled).toBe(false);
    },
  );

  it.each([
    ["empty batch", []],
    [
      "over-max-rows batch",
      [issuedPermit(), issuedPermit(), issuedPermit(), issuedPermit()],
    ],
    [
      "over-max-targets batch",
      [
        issuedPermit(),
        {
          ...issuedPermit(),
          permitHash: "7".repeat(64),
          record: { ...issuedPermit().record, targetHmac: "8".repeat(64) },
        },
        {
          ...issuedPermit(),
          permitHash: "9".repeat(64),
          record: { ...issuedPermit().record, targetHmac: "a".repeat(64) },
        },
      ],
    ],
    [
      "malformed record",
      [
        {
          ...issuedPermit(),
          record: { ...issuedPermit().record, nonce: "2".repeat(31) },
        },
      ],
    ],
  ])("fails fast on an %s before any RPC", async (_label, permits) => {
    let rpcCalled = false;
    const coordinator = coordinatorFor({
      issueCrossDetailPermits: async () => {
        rpcCalled = true;
      },
    });

    await expect(
      coordinator.issueCrossDetailPermits(SESSION_IDENTITY, permits, LIMITS),
    ).rejects.toThrowError(/invalid/i);
    expect(rpcCalled).toBe(false);
  });
});
