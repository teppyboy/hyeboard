import { HyeboardError } from "@hyeboard/core";

export const VNU_PROBE_BUDGET_LIMIT = 300;
export const VNU_PROBE_BUDGET_WINDOW_SECONDS = 600;
export const VNU_PROBE_BUDGET_UNAVAILABLE_RETRY_SECONDS = 5;
export const VNU_BRC1_PERMIT_LIMIT = 6;
// Longer than the 60s route deadline so the route, not lease expiry, owns
// normal cancellation. The extra guard covers release/transport cleanup.
export const VNU_BRC1_PERMIT_LEASE_MS = 125_000;

// Cross-student grade-detail permits: single-use, requester-bound, short-TTL
// authorizations minted only after a validated cross-transcript fetch. The
// concurrency lease borrows the Brc1 guard duration for the same reason.
export const VNU_CROSS_DETAIL_POLICY_VERSION = 1;
export const VNU_CROSS_DETAIL_LEASE_MS = 125_000;
export const VNU_CROSS_DETAIL_PERMIT_HASH_PATTERN = /^[0-9a-f]{64}$/;
export const VNU_CROSS_DETAIL_NONCE_PATTERN = /^[0-9a-f]{32}$/;
export const VNU_CROSS_DETAIL_HMAC_PATTERN = /^[0-9a-f]{64}$/;
export const VNU_CROSS_DETAIL_LEASE_ID_PATTERN = /^[0-9a-f]{32}$/;
export const VNU_CROSS_DETAIL_ENVELOPE_MAX_LENGTH = 1_024;

export type VnuCrossDetailLimits = {
  maxTargets: number;
  maxRows: number;
  concurrency: number;
  budget: number;
  windowSeconds: number;
};

// Everything the Durable Object stores about one permit: keyed HMAC bindings
// (never plaintext identity), the server-encrypted selector envelope, policy
// and expiry. consumption state is added by the DO (consumedAt).
export type VnuCrossDetailPermitRecord = {
  requesterHmac: string;
  targetHmac: string;
  revisionHmac: string;
  rowHmac: string;
  policyVersion: number;
  nonce: string;
  envelope: string;
  expiresAt: number;
};

export type VnuCrossDetailIssuedPermit = {
  permitHash: string;
  record: VnuCrossDetailPermitRecord;
};

export type VnuCrossDetailConsumeInput = {
  permitHash: string;
  nonce: string;
  requesterHmac: string;
  targetHmac: string;
  revisionHmac: string;
  rowHmac: string;
  policyVersion: number;
};

export type VnuCrossDetailConsumeResult =
  | { allowed: true; leaseId: string; expiresAt: number; envelope: string }
  | {
      allowed: false;
      reason: "invalid" | "budget" | "busy";
      retryAfterSeconds?: number;
    };

export function assertValidVnuCrossDetailLimits(
  limits: VnuCrossDetailLimits,
): void {
  if (!Number.isSafeInteger(limits.maxTargets) || limits.maxTargets <= 0)
    throw new Error("VNU cross-detail limits are invalid");
  if (!Number.isSafeInteger(limits.maxRows) || limits.maxRows <= 0)
    throw new Error("VNU cross-detail limits are invalid");
  if (
    !Number.isSafeInteger(limits.concurrency) ||
    limits.concurrency <= 0 ||
    limits.concurrency > 16
  )
    throw new Error("VNU cross-detail limits are invalid");
  if (!Number.isSafeInteger(limits.budget) || limits.budget <= 0)
    throw new Error("VNU cross-detail limits are invalid");
  if (!Number.isSafeInteger(limits.windowSeconds) || limits.windowSeconds <= 0)
    throw new Error("VNU cross-detail limits are invalid");
}

function assertValidCrossDetailRecord(
  record: VnuCrossDetailPermitRecord,
): void {
  if (!VNU_CROSS_DETAIL_HMAC_PATTERN.test(record.requesterHmac))
    throw new Error("VNU cross-detail permit record is invalid");
  if (!VNU_CROSS_DETAIL_HMAC_PATTERN.test(record.targetHmac))
    throw new Error("VNU cross-detail permit record is invalid");
  if (!VNU_CROSS_DETAIL_HMAC_PATTERN.test(record.revisionHmac))
    throw new Error("VNU cross-detail permit record is invalid");
  if (!VNU_CROSS_DETAIL_HMAC_PATTERN.test(record.rowHmac))
    throw new Error("VNU cross-detail permit record is invalid");
  if (record.policyVersion !== VNU_CROSS_DETAIL_POLICY_VERSION)
    throw new Error("VNU cross-detail permit record is invalid");
  if (!VNU_CROSS_DETAIL_NONCE_PATTERN.test(record.nonce))
    throw new Error("VNU cross-detail permit record is invalid");
  if (
    typeof record.envelope !== "string" ||
    record.envelope.length === 0 ||
    record.envelope.length > VNU_CROSS_DETAIL_ENVELOPE_MAX_LENGTH
  )
    throw new Error("VNU cross-detail permit record is invalid");
  if (!Number.isSafeInteger(record.expiresAt) || record.expiresAt <= 0)
    throw new Error("VNU cross-detail permit record is invalid");
}

export function assertValidVnuCrossDetailIssuedPermits(
  permits: VnuCrossDetailIssuedPermit[],
  limits: VnuCrossDetailLimits,
): void {
  if (
    !Array.isArray(permits) ||
    permits.length === 0 ||
    permits.length > limits.maxRows
  )
    throw new Error("VNU cross-detail permit issuance is invalid");
  const targets = new Set<string>();
  for (const permit of permits) {
    if (!VNU_CROSS_DETAIL_PERMIT_HASH_PATTERN.test(permit.permitHash))
      throw new Error("VNU cross-detail permit issuance is invalid");
    assertValidCrossDetailRecord(permit.record);
    targets.add(permit.record.targetHmac);
  }
  if (targets.size > limits.maxTargets)
    throw new Error("VNU cross-detail permit issuance is invalid");
}

export function assertValidVnuCrossDetailConsumeInput(
  input: VnuCrossDetailConsumeInput,
): void {
  if (!VNU_CROSS_DETAIL_PERMIT_HASH_PATTERN.test(input.permitHash))
    throw new Error("VNU cross-detail consume input is invalid");
  if (!VNU_CROSS_DETAIL_NONCE_PATTERN.test(input.nonce))
    throw new Error("VNU cross-detail consume input is invalid");
  if (!VNU_CROSS_DETAIL_HMAC_PATTERN.test(input.requesterHmac))
    throw new Error("VNU cross-detail consume input is invalid");
  if (!VNU_CROSS_DETAIL_HMAC_PATTERN.test(input.targetHmac))
    throw new Error("VNU cross-detail consume input is invalid");
  if (!VNU_CROSS_DETAIL_HMAC_PATTERN.test(input.revisionHmac))
    throw new Error("VNU cross-detail consume input is invalid");
  if (!VNU_CROSS_DETAIL_HMAC_PATTERN.test(input.rowHmac))
    throw new Error("VNU cross-detail consume input is invalid");
  if (input.policyVersion !== VNU_CROSS_DETAIL_POLICY_VERSION)
    throw new Error("VNU cross-detail consume input is invalid");
}

export type VnuProbeBudgetResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };
export type VnuBrc1PermitResult =
  | { allowed: true; leaseId: string; expiresAt: number }
  | { allowed: false; retryAfterSeconds: number };

export interface VnuProbeBudgetCoordinator {
  consume(sessionIdentity: string, amount?: number): Promise<void>;
  reserve(sessionIdentity: string, amount: number): Promise<void>;
  acquireBrc1Permit(
    sessionIdentity: string,
    signal?: AbortSignal,
  ): Promise<{ leaseId: string; expiresAt: number }>;
  releaseBrc1Permit(sessionIdentity: string, leaseId: string): Promise<void>;
  issueCrossDetailPermits(
    sessionIdentity: string,
    permits: VnuCrossDetailIssuedPermit[],
    limits: VnuCrossDetailLimits,
  ): Promise<void>;
  consumeCrossDetailPermit(
    sessionIdentity: string,
    input: VnuCrossDetailConsumeInput,
    limits: VnuCrossDetailLimits,
  ): Promise<{ leaseId: string; expiresAt: number; envelope: string }>;
  releaseCrossDetailLease(
    sessionIdentity: string,
    leaseId: string,
  ): Promise<void>;
}

export interface VnuProbeBudgetDurableObjectStub {
  consume(amount: number): Promise<VnuProbeBudgetResult>;
  reserve(amount: number): Promise<VnuProbeBudgetResult>;
  acquireBrc1Permit(): Promise<VnuBrc1PermitResult>;
  releaseBrc1Permit(leaseId: string): Promise<void>;
  issueCrossDetailPermits(
    permits: VnuCrossDetailIssuedPermit[],
    limits: VnuCrossDetailLimits,
  ): Promise<void>;
  consumeCrossDetailPermit(
    input: VnuCrossDetailConsumeInput,
    limits: VnuCrossDetailLimits,
  ): Promise<VnuCrossDetailConsumeResult>;
  releaseCrossDetailLease(leaseId: string): Promise<void>;
}

export interface VnuProbeBudgetNamespace {
  getByName(name: string): VnuProbeBudgetDurableObjectStub;
}

function assertValidConsumeAmount(amount: number): void {
  if (
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    amount > VNU_PROBE_BUDGET_LIMIT
  ) {
    throw new Error("VNU probe-budget amount is invalid");
  }
}

function rateLimited(retryAfterSeconds: number): HyeboardError {
  return new HyeboardError(
    "VNU_RATE_LIMITED",
    "This session has reached the VNU lookup probe limit. Wait for the probe window to reset and try again.",
    429,
    {
      retryAfterSeconds,
      limit: VNU_PROBE_BUDGET_LIMIT,
      windowSeconds: VNU_PROBE_BUDGET_WINDOW_SECONDS,
    },
  );
}

function busy(retryAfterSeconds: number): HyeboardError {
  return new HyeboardError(
    "VNU_CROSS_LOOKUP_BUSY",
    "This VNU session is handling the maximum number of lookups. Try again shortly.",
    429,
    { retryAfterSeconds },
  );
}

// One generic external verdict for every permit rejection (unknown, expired,
// replayed, or binding-mismatch). The internally typed reason stays inside
// the DO result and never reaches the client.
function crossDetailPermitInvalid(): HyeboardError {
  return new HyeboardError(
    "VNU_CROSS_DETAIL_PERMIT_INVALID",
    "The cross-detail permit is invalid or expired.",
    403,
  );
}

function crossDetailRateLimited(
  retryAfterSeconds: number,
  limits: VnuCrossDetailLimits,
): HyeboardError {
  return new HyeboardError(
    "VNU_RATE_LIMITED",
    "This session has reached the VNU grade-detail lookup limit. Wait for the detail window to reset and try again.",
    429,
    {
      retryAfterSeconds,
      limit: limits.budget,
      windowSeconds: limits.windowSeconds,
    },
  );
}

export function probeBudgetUnavailable(): HyeboardError {
  return new HyeboardError(
    "VNU_PROBE_BUDGET_UNAVAILABLE",
    "The VNU lookup probe budget is temporarily unavailable. Try again shortly.",
    503,
    { retryAfterSeconds: VNU_PROBE_BUDGET_UNAVAILABLE_RETRY_SECONDS },
  );
}

export class DurableObjectVnuProbeBudgetCoordinator
  implements VnuProbeBudgetCoordinator
{
  constructor(private readonly namespace: VnuProbeBudgetNamespace) {}

  async consume(sessionIdentity: string, amount = 1): Promise<void> {
    await this.charge("consume", sessionIdentity, amount);
  }

  async reserve(sessionIdentity: string, amount: number): Promise<void> {
    await this.charge("reserve", sessionIdentity, amount);
  }

  async acquireBrc1Permit(
    sessionIdentity: string,
    signal?: AbortSignal,
  ): Promise<{ leaseId: string; expiresAt: number }> {
    this.assertIdentity(sessionIdentity);
    if (signal?.aborted)
      throw (
        signal.reason ??
        new DOMException("This operation was aborted", "AbortError")
      );
    const acquire = this.namespace
      .getByName(sessionIdentity)
      .acquireBrc1Permit();
    if (!signal) {
      try {
        const result = await acquire;
        if (!result.allowed) throw busy(result.retryAfterSeconds);
        return result;
      } catch (error) {
        if (error instanceof HyeboardError) throw error;
        throw probeBudgetUnavailable();
      }
    }

    let rejectWhenAborted!: (reason: unknown) => void;
    const rejectOnAbort = new Promise<never>((_resolve, reject) => {
      rejectWhenAborted = reject;
    });
    const onAbort = (): void =>
      rejectWhenAborted(
        signal.reason ??
          new DOMException("This operation was aborted", "AbortError"),
      );
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await Promise.race([acquire, rejectOnAbort]);
      if (!result.allowed) throw busy(result.retryAfterSeconds);
      return result;
    } catch (error) {
      if (signal.aborted) {
        void acquire
          .then(async (granted) => {
            if (granted.allowed)
              await this.releaseBrc1Permit(
                sessionIdentity,
                granted.leaseId,
              ).catch(() => undefined);
          })
          .catch(() => undefined);
        throw signal.reason ?? error;
      }
      if (error instanceof HyeboardError) throw error;
      throw probeBudgetUnavailable();
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async releaseBrc1Permit(
    sessionIdentity: string,
    leaseId: string,
  ): Promise<void> {
    this.assertIdentity(sessionIdentity);
    if (!/^[0-9a-f]{32}$/.test(leaseId))
      throw new Error("VNU Brc1 permit lease is invalid");
    try {
      await this.namespace
        .getByName(sessionIdentity)
        .releaseBrc1Permit(leaseId);
    } catch {
      throw probeBudgetUnavailable();
    }
  }

  async issueCrossDetailPermits(
    sessionIdentity: string,
    permits: VnuCrossDetailIssuedPermit[],
    limits: VnuCrossDetailLimits,
  ): Promise<void> {
    this.assertIdentity(sessionIdentity);
    assertValidVnuCrossDetailLimits(limits);
    assertValidVnuCrossDetailIssuedPermits(permits, limits);
    try {
      await this.namespace
        .getByName(sessionIdentity)
        .issueCrossDetailPermits(permits, limits);
    } catch {
      throw probeBudgetUnavailable();
    }
  }

  async consumeCrossDetailPermit(
    sessionIdentity: string,
    input: VnuCrossDetailConsumeInput,
    limits: VnuCrossDetailLimits,
  ): Promise<{ leaseId: string; expiresAt: number; envelope: string }> {
    this.assertIdentity(sessionIdentity);
    assertValidVnuCrossDetailLimits(limits);
    assertValidVnuCrossDetailConsumeInput(input);

    let result: VnuCrossDetailConsumeResult;
    try {
      result = await this.namespace
        .getByName(sessionIdentity)
        .consumeCrossDetailPermit(input, limits);
    } catch {
      throw probeBudgetUnavailable();
    }

    if (!result.allowed) {
      if (result.reason === "budget")
        throw crossDetailRateLimited(result.retryAfterSeconds ?? 1, limits);
      if (result.reason === "busy") throw busy(result.retryAfterSeconds ?? 1);
      throw crossDetailPermitInvalid();
    }
    return {
      leaseId: result.leaseId,
      expiresAt: result.expiresAt,
      envelope: result.envelope,
    };
  }

  async releaseCrossDetailLease(
    sessionIdentity: string,
    leaseId: string,
  ): Promise<void> {
    this.assertIdentity(sessionIdentity);
    if (!VNU_CROSS_DETAIL_LEASE_ID_PATTERN.test(leaseId))
      throw new Error("VNU cross-detail lease is invalid");
    try {
      await this.namespace
        .getByName(sessionIdentity)
        .releaseCrossDetailLease(leaseId);
    } catch {
      throw probeBudgetUnavailable();
    }
  }

  private async charge(
    operation: "consume" | "reserve",
    sessionIdentity: string,
    amount: number,
  ): Promise<void> {
    this.assertIdentity(sessionIdentity);
    assertValidConsumeAmount(amount);

    let result: VnuProbeBudgetResult;
    try {
      result = await this.namespace
        .getByName(sessionIdentity)
        [operation](amount);
    } catch {
      throw probeBudgetUnavailable();
    }

    if (!result.allowed) throw rateLimited(result.retryAfterSeconds);
  }

  private assertIdentity(sessionIdentity: string): void {
    if (!/^[0-9a-f]{64}$/.test(sessionIdentity))
      throw new Error("VNU probe-budget session identity is invalid");
  }
}
