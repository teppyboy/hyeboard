import { randomBytes } from "node:crypto";
import { HyeboardError } from "@hyeboard/core";
import {
  assertValidVnuCrossDetailConsumeInput,
  assertValidVnuCrossDetailIssuedPermits,
  assertValidVnuCrossDetailLimits,
  VNU_BRC1_PERMIT_LEASE_MS,
  VNU_BRC1_PERMIT_LIMIT,
  VNU_CROSS_DETAIL_LEASE_ID_PATTERN,
  VNU_CROSS_DETAIL_LEASE_MS,
  VNU_PROBE_BUDGET_LIMIT,
  VNU_PROBE_BUDGET_UNAVAILABLE_RETRY_SECONDS,
  VNU_PROBE_BUDGET_WINDOW_SECONDS,
  type VnuCrossDetailConsumeInput,
  type VnuCrossDetailIssuedPermit,
  type VnuCrossDetailLimits,
  type VnuProbeBudgetCoordinator,
} from "../../vnu/vnu-probe-budget";
import type { RedisCommandClient } from "./client";
import {
  brc1PermitKey,
  crossDetailLeaseKey,
  crossDetailPermitKey,
  crossDetailWindowKey,
  probeBudgetKey,
} from "./keys";
import {
  consumeCrossDetailScript,
  fixedWindowScript,
  issuePermitScript,
} from "./scripts";
import {
  acquireRedisLease,
  consumeFixedWindow,
  releaseRedisLease,
} from "./primitives";

function unavailable(): HyeboardError {
  return new HyeboardError(
    "VNU_PROBE_BUDGET_UNAVAILABLE",
    "The VNU lookup probe budget is temporarily unavailable. Try again shortly.",
    503,
    { retryAfterSeconds: VNU_PROBE_BUDGET_UNAVAILABLE_RETRY_SECONDS },
  );
}
function rateLimited(
  retryAfterSeconds: number,
  limit: number,
  windowSeconds: number,
): HyeboardError {
  return new HyeboardError(
    "VNU_RATE_LIMITED",
    "This session has reached the VNU lookup probe limit. Wait for the probe window to reset and try again.",
    429,
    { retryAfterSeconds, limit, windowSeconds },
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

export type RedisVnuProbeBudgetCoordinatorOptions = {
  client: RedisCommandClient;
};

export class RedisVnuProbeBudgetCoordinator
  implements VnuProbeBudgetCoordinator
{
  constructor(
    private readonly options: RedisVnuProbeBudgetCoordinatorOptions,
  ) {}
  private identity(value: string): void {
    if (!/^[0-9a-f]{64}$/.test(value))
      throw new Error("VNU probe-budget session identity is invalid");
  }
  async consume(sessionIdentity: string, amount = 1): Promise<void> {
    return this.charge(sessionIdentity, amount);
  }
  async reserve(sessionIdentity: string, amount: number): Promise<void> {
    return this.charge(sessionIdentity, amount);
  }
  private async charge(sessionIdentity: string, amount: number): Promise<void> {
    this.identity(sessionIdentity);
    if (
      !Number.isSafeInteger(amount) ||
      amount <= 0 ||
      amount > VNU_PROBE_BUDGET_LIMIT
    )
      throw new Error("VNU probe-budget amount is invalid");
    try {
      const result = await consumeFixedWindow(
        this.options.client,
        probeBudgetKey(sessionIdentity),
        amount,
        VNU_PROBE_BUDGET_WINDOW_SECONDS * 1000,
        VNU_PROBE_BUDGET_LIMIT,
      );
      if (!result.allowed)
        throw rateLimited(
          result.retryAfterSeconds,
          VNU_PROBE_BUDGET_LIMIT,
          VNU_PROBE_BUDGET_WINDOW_SECONDS,
        );
    } catch (error) {
      if (error instanceof HyeboardError) throw error;
      throw unavailable();
    }
  }
  async acquireBrc1Permit(
    sessionIdentity: string,
    signal?: AbortSignal,
  ): Promise<{ leaseId: string; expiresAt: number }> {
    this.identity(sessionIdentity);
    if (signal?.aborted)
      throw (
        signal.reason ??
        new DOMException("This operation was aborted", "AbortError")
      );
    try {
      const result = await acquireRedisLease(
        this.options.client,
        brc1PermitKey(sessionIdentity),
        VNU_BRC1_PERMIT_LIMIT,
        VNU_BRC1_PERMIT_LEASE_MS,
      );
      if (!result.allowed) throw busy(result.retryAfterSeconds ?? 1);
      if (signal?.aborted) {
        await this.releaseBrc1Permit(sessionIdentity, result.leaseId!);
        throw (
          signal.reason ??
          new DOMException("This operation was aborted", "AbortError")
        );
      }
      return { leaseId: result.leaseId!, expiresAt: result.expiresAt! };
    } catch (error) {
      if (
        error instanceof HyeboardError ||
        (signal?.aborted && error === signal.reason)
      )
        throw error;
      throw unavailable();
    }
  }
  async releaseBrc1Permit(
    sessionIdentity: string,
    leaseId: string,
  ): Promise<void> {
    this.identity(sessionIdentity);
    if (!/^[0-9a-f]{32}$/.test(leaseId))
      throw new Error("VNU Brc1 permit lease is invalid");
    try {
      await releaseRedisLease(
        this.options.client,
        brc1PermitKey(sessionIdentity),
        leaseId,
      );
    } catch {
      throw unavailable();
    }
  }
  async issueCrossDetailPermits(
    sessionIdentity: string,
    permits: VnuCrossDetailIssuedPermit[],
    limits: VnuCrossDetailLimits,
  ): Promise<void> {
    this.identity(sessionIdentity);
    assertValidVnuCrossDetailLimits(limits);
    assertValidVnuCrossDetailIssuedPermits(permits, limits);
    try {
      const now = Date.now();
      await this.options.client.eval(issuePermitScript, {
        keys: permits.map(({ permitHash }) =>
          crossDetailPermitKey(sessionIdentity, permitHash),
        ),
        arguments: [
          ...permits.map(({ record }) => JSON.stringify(record)),
          ...permits.map(({ record }) =>
            String(Math.max(1, record.expiresAt - now)),
          ),
        ],
      });
    } catch {
      throw unavailable();
    }
  }
  async consumeCrossDetailPermit(
    sessionIdentity: string,
    input: VnuCrossDetailConsumeInput,
    limits: VnuCrossDetailLimits,
  ): Promise<{ leaseId: string; expiresAt: number; envelope: string }> {
    this.identity(sessionIdentity);
    assertValidVnuCrossDetailLimits(limits);
    assertValidVnuCrossDetailConsumeInput(input);
    try {
      const leaseId = randomBytes(16).toString("hex");
      const now = Date.now();
      const expiresAt = now + VNU_CROSS_DETAIL_LEASE_MS;
      const raw = await this.options.client.eval(consumeCrossDetailScript, {
        keys: [
          crossDetailPermitKey(sessionIdentity, input.permitHash),
          crossDetailLeaseKey(sessionIdentity),
          crossDetailWindowKey(sessionIdentity),
        ],
        arguments: [
          String(now),
          input.nonce,
          input.requesterHmac,
          input.targetHmac,
          input.revisionHmac,
          input.rowHmac,
          String(input.policyVersion),
          String(limits.budget),
          String(limits.windowSeconds * 1000),
          String(limits.concurrency),
          String(expiresAt),
          leaseId,
        ],
      });
      if (!Array.isArray(raw))
        throw new Error("Invalid Redis cross-detail result");
      const status = Number(raw[0]);
      if (status === 2)
        throw rateLimited(Number(raw[1]), limits.budget, limits.windowSeconds);
      if (status === 3) throw busy(Number(raw[1]));
      if (status !== 1 || typeof raw[2] !== "string")
        throw new HyeboardError(
          "VNU_CROSS_DETAIL_PERMIT_INVALID",
          "The cross-detail permit is invalid or expired.",
          403,
        );
      return { leaseId, expiresAt: Number(raw[1]), envelope: raw[2] };
    } catch (error) {
      if (error instanceof HyeboardError) throw error;
      throw unavailable();
    }
  }
  async releaseCrossDetailLease(
    sessionIdentity: string,
    leaseId: string,
  ): Promise<void> {
    this.identity(sessionIdentity);
    if (!VNU_CROSS_DETAIL_LEASE_ID_PATTERN.test(leaseId))
      throw new Error("VNU cross-detail lease is invalid");
    try {
      await releaseRedisLease(
        this.options.client,
        crossDetailLeaseKey(sessionIdentity),
        leaseId,
      );
    } catch {
      throw unavailable();
    }
  }
}
