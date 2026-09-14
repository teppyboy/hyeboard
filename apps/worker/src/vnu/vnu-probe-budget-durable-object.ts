import { DurableObject } from "cloudflare:workers";
import {
  assertValidVnuCrossDetailConsumeInput,
  assertValidVnuCrossDetailIssuedPermits,
  assertValidVnuCrossDetailLimits,
  VNU_BRC1_PERMIT_LEASE_MS,
  VNU_BRC1_PERMIT_LIMIT,
  VNU_CROSS_DETAIL_HMAC_PATTERN,
  VNU_CROSS_DETAIL_LEASE_ID_PATTERN,
  VNU_CROSS_DETAIL_LEASE_MS,
  VNU_CROSS_DETAIL_NONCE_PATTERN,
  VNU_CROSS_DETAIL_PERMIT_HASH_PATTERN,
  VNU_CROSS_DETAIL_POLICY_VERSION,
  VNU_PROBE_BUDGET_LIMIT,
  VNU_PROBE_BUDGET_WINDOW_SECONDS,
  type VnuBrc1PermitResult,
  type VnuCrossDetailConsumeInput,
  type VnuCrossDetailConsumeResult,
  type VnuCrossDetailIssuedPermit,
  type VnuCrossDetailLimits,
  type VnuCrossDetailPermitRecord,
  type VnuProbeBudgetResult,
} from "./vnu-probe-budget";

const STATE_KEY = "window";
const PERMITS_KEY = "brc1-permits";
const CROSS_DETAIL_PERMITS_KEY = "cross-detail-permits";
const CROSS_DETAIL_WINDOW_KEY = "cross-detail-window";
const CROSS_DETAIL_LEASES_KEY = "cross-detail-leases";

export type StoredBudgetWindow = {
  count: number;
  resetAt: number;
};

export type BudgetWindowTransition = {
  window: StoredBudgetWindow;
  result: VnuProbeBudgetResult;
};

export type StoredCrossDetailPermit = VnuCrossDetailPermitRecord & {
  consumedAt?: number;
};

function parseStoredWindow(value: unknown): StoredBudgetWindow | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Stored VNU probe budget is invalid");
  const window = value as Record<string, unknown>;
  if (!Number.isSafeInteger(window.count) || (window.count as number) < 0)
    throw new Error("Stored VNU probe count is invalid");
  if (!Number.isSafeInteger(window.resetAt) || (window.resetAt as number) <= 0)
    throw new Error("Stored VNU probe reset time is invalid");
  return { count: window.count as number, resetAt: window.resetAt as number };
}

export function consumeBudgetWindow(
  stored: StoredBudgetWindow | undefined,
  amount: number,
  now: number,
  limit = VNU_PROBE_BUDGET_LIMIT,
  windowSeconds = VNU_PROBE_BUDGET_WINDOW_SECONDS,
): BudgetWindowTransition {
  const window =
    !stored || now >= stored.resetAt
      ? { count: 0, resetAt: now + windowSeconds * 1000 }
      : stored;

  if (window.count + amount > limit) {
    return {
      window,
      result: {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((window.resetAt - now) / 1000),
        ),
      },
    };
  }

  return {
    window: { ...window, count: window.count + amount },
    result: { allowed: true },
  };
}

function parseStoredCrossDetailPermits(
  value: unknown,
): Record<string, StoredCrossDetailPermit> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Stored VNU cross-detail permits are invalid");
  const permits: Record<string, StoredCrossDetailPermit> = {};
  for (const [permitHash, record] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (!VNU_CROSS_DETAIL_PERMIT_HASH_PATTERN.test(permitHash))
      throw new Error("Stored VNU cross-detail permits are invalid");
    if (typeof record !== "object" || record === null || Array.isArray(record))
      throw new Error("Stored VNU cross-detail permits are invalid");
    const candidate = record as Record<string, unknown>;
    if (
      typeof candidate.requesterHmac !== "string" ||
      !VNU_CROSS_DETAIL_HMAC_PATTERN.test(candidate.requesterHmac)
    )
      throw new Error("Stored VNU cross-detail permits are invalid");
    if (
      typeof candidate.targetHmac !== "string" ||
      !VNU_CROSS_DETAIL_HMAC_PATTERN.test(candidate.targetHmac)
    )
      throw new Error("Stored VNU cross-detail permits are invalid");
    if (
      typeof candidate.revisionHmac !== "string" ||
      !VNU_CROSS_DETAIL_HMAC_PATTERN.test(candidate.revisionHmac)
    )
      throw new Error("Stored VNU cross-detail permits are invalid");
    if (
      typeof candidate.rowHmac !== "string" ||
      !VNU_CROSS_DETAIL_HMAC_PATTERN.test(candidate.rowHmac)
    )
      throw new Error("Stored VNU cross-detail permits are invalid");
    if (candidate.policyVersion !== VNU_CROSS_DETAIL_POLICY_VERSION)
      throw new Error("Stored VNU cross-detail permits are invalid");
    if (
      typeof candidate.nonce !== "string" ||
      !VNU_CROSS_DETAIL_NONCE_PATTERN.test(candidate.nonce)
    )
      throw new Error("Stored VNU cross-detail permits are invalid");
    if (
      typeof candidate.envelope !== "string" ||
      candidate.envelope.length === 0
    )
      throw new Error("Stored VNU cross-detail permits are invalid");
    if (
      !Number.isSafeInteger(candidate.expiresAt) ||
      (candidate.expiresAt as number) <= 0
    )
      throw new Error("Stored VNU cross-detail permits are invalid");
    if (
      candidate.consumedAt !== undefined &&
      (!Number.isSafeInteger(candidate.consumedAt) ||
        (candidate.consumedAt as number) <= 0)
    )
      throw new Error("Stored VNU cross-detail permits are invalid");
    permits[permitHash] = candidate as unknown as StoredCrossDetailPermit;
  }
  return permits;
}

function randomHex32(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export class VnuProbeBudgetDurableObject extends DurableObject<Env> {
  async acquireBrc1Permit(): Promise<VnuBrc1PermitResult> {
    return this.ctx.storage.transaction(async (transaction) => {
      const now = Date.now();
      const permits = await this.activePermits(transaction, now);
      if (Object.keys(permits).length >= VNU_BRC1_PERMIT_LIMIT)
        return { allowed: false, retryAfterSeconds: 1 };
      const leaseId = randomHex32();
      const expiresAt = now + VNU_BRC1_PERMIT_LEASE_MS;
      permits[leaseId] = expiresAt;
      await transaction.put(PERMITS_KEY, permits);
      await this.rescheduleAlarm(transaction, now);
      return { allowed: true, leaseId, expiresAt };
    });
  }

  async releaseBrc1Permit(leaseId: string): Promise<void> {
    if (!/^[0-9a-f]{32}$/.test(leaseId)) return;
    await this.ctx.storage.transaction(async (transaction) => {
      const now = Date.now();
      const permits = await this.activePermits(transaction, now);
      if (!(leaseId in permits)) return;
      delete permits[leaseId];
      await this.storePermits(transaction, permits, now);
    });
  }

  // One storage transaction per consume: prune expired permits/leases, find
  // the permit by its opaque hash, exact-match every binding plus policy and
  // nonce/expiry, check the detail budget and concurrency capacity BEFORE
  // mutating (a budget/busy rejection leaves the permit retryable), then
  // atomically mark consumed, charge one unit, and acquire the detail lease.
  // Only then is the stored encrypted selector envelope released.
  async consumeCrossDetailPermit(
    input: VnuCrossDetailConsumeInput,
    limits: VnuCrossDetailLimits,
  ): Promise<VnuCrossDetailConsumeResult> {
    assertValidVnuCrossDetailLimits(limits);
    // A malformed or foreign-policy presentation is simply an invalid permit,
    // not a route bug worth an RPC exception — fail closed with the generic
    // verdict (the coordinator asserts the same shapes before the RPC, so
    // this path is defense in depth).
    try {
      assertValidVnuCrossDetailConsumeInput(input);
    } catch {
      return { allowed: false, reason: "invalid" };
    }
    return this.ctx.storage.transaction(async (transaction) => {
      const now = Date.now();
      const permits = await this.activeCrossDetailPermits(transaction, now);
      const leases = await this.activeCrossDetailLeases(transaction, now);
      const record = permits[input.permitHash];
      if (
        !record ||
        record.consumedAt !== undefined ||
        record.nonce !== input.nonce ||
        record.requesterHmac !== input.requesterHmac ||
        record.targetHmac !== input.targetHmac ||
        record.revisionHmac !== input.revisionHmac ||
        record.rowHmac !== input.rowHmac ||
        record.policyVersion !== input.policyVersion
      ) {
        return { allowed: false, reason: "invalid" };
      }

      const storedWindow = parseStoredWindow(
        await transaction.get(CROSS_DETAIL_WINDOW_KEY),
      );
      const charge = consumeBudgetWindow(
        storedWindow,
        1,
        now,
        limits.budget,
        limits.windowSeconds,
      );
      if (!charge.result.allowed)
        return {
          allowed: false,
          reason: "budget",
          retryAfterSeconds: charge.result.retryAfterSeconds,
        };
      if (Object.keys(leases).length >= limits.concurrency)
        return { allowed: false, reason: "busy", retryAfterSeconds: 1 };

      const leaseId = randomHex32();
      const expiresAt = now + VNU_CROSS_DETAIL_LEASE_MS;
      record.consumedAt = now;
      permits[input.permitHash] = record;
      leases[leaseId] = expiresAt;
      await transaction.put(CROSS_DETAIL_PERMITS_KEY, permits);
      await transaction.put(CROSS_DETAIL_WINDOW_KEY, charge.window);
      await transaction.put(CROSS_DETAIL_LEASES_KEY, leases);
      await this.rescheduleAlarm(transaction, now);
      return { allowed: true, leaseId, expiresAt, envelope: record.envelope };
    });
  }

  async issueCrossDetailPermits(
    permits: VnuCrossDetailIssuedPermit[],
    limits: VnuCrossDetailLimits,
  ): Promise<void> {
    assertValidVnuCrossDetailLimits(limits);
    assertValidVnuCrossDetailIssuedPermits(permits, limits);
    await this.ctx.storage.transaction(async (transaction) => {
      const now = Date.now();
      const stored = await this.activeCrossDetailPermits(transaction, now);
      for (const { permitHash, record } of permits)
        stored[permitHash] = { ...record };
      await transaction.put(CROSS_DETAIL_PERMITS_KEY, stored);
      await this.rescheduleAlarm(transaction, now);
    });
  }

  async releaseCrossDetailLease(leaseId: string): Promise<void> {
    if (!VNU_CROSS_DETAIL_LEASE_ID_PATTERN.test(leaseId)) return;
    await this.ctx.storage.transaction(async (transaction) => {
      const now = Date.now();
      const leases = await this.activeCrossDetailLeases(transaction, now);
      if (!(leaseId in leases)) return;
      delete leases[leaseId];
      await this.storeCrossDetailLeases(transaction, leases, now);
    });
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      const now = Date.now();
      await this.storePermits(
        transaction,
        await this.activePermits(transaction, now),
        now,
      );
      await this.storeCrossDetailPermits(
        transaction,
        await this.activeCrossDetailPermits(transaction, now),
        now,
      );
      await this.storeCrossDetailLeases(
        transaction,
        await this.activeCrossDetailLeases(transaction, now),
        now,
      );
    });
  }

  async consume(amount: number): Promise<VnuProbeBudgetResult> {
    return this.reserve(amount);
  }

  // Bulk callers reserve their full conservative allowance in one storage
  // transaction before touching Brc1. Unused units intentionally remain spent:
  // strict preflight atomicity is more important than maximizing the window.
  async reserve(amount: number): Promise<VnuProbeBudgetResult> {
    if (
      !Number.isSafeInteger(amount) ||
      amount <= 0 ||
      amount > VNU_PROBE_BUDGET_LIMIT
    ) {
      throw new Error("VNU probe-budget amount is invalid");
    }

    return this.ctx.storage.transaction(async (transaction) => {
      const now = Date.now();
      const stored = parseStoredWindow(await transaction.get(STATE_KEY));
      const transition = consumeBudgetWindow(stored, amount, now);
      if (!transition.result.allowed) return transition.result;

      await transaction.put(STATE_KEY, transition.window);
      return transition.result;
    });
  }

  private async activePermits(
    transaction: DurableObjectTransaction,
    now: number,
  ): Promise<Record<string, number>> {
    const stored =
      (await transaction.get<Record<string, unknown>>(PERMITS_KEY)) ?? {};
    const active: Record<string, number> = {};
    for (const [leaseId, expiresAt] of Object.entries(stored)) {
      if (
        /^[0-9a-f]{32}$/.test(leaseId) &&
        typeof expiresAt === "number" &&
        Number.isSafeInteger(expiresAt) &&
        expiresAt > now
      )
        active[leaseId] = expiresAt;
    }
    return active;
  }

  private async storePermits(
    transaction: DurableObjectTransaction,
    permits: Record<string, number>,
    now = Date.now(),
  ): Promise<void> {
    if (Object.keys(permits).length === 0)
      await transaction.delete(PERMITS_KEY);
    else await transaction.put(PERMITS_KEY, permits);
    await this.rescheduleAlarm(transaction, now);
  }

  private async activeCrossDetailPermits(
    transaction: DurableObjectTransaction,
    now: number,
  ): Promise<Record<string, StoredCrossDetailPermit>> {
    const stored = parseStoredCrossDetailPermits(
      await transaction.get(CROSS_DETAIL_PERMITS_KEY),
    );
    const active: Record<string, StoredCrossDetailPermit> = {};
    for (const [permitHash, record] of Object.entries(stored)) {
      if (record.expiresAt > now) active[permitHash] = record;
    }
    return active;
  }

  private async storeCrossDetailPermits(
    transaction: DurableObjectTransaction,
    permits: Record<string, StoredCrossDetailPermit>,
    now: number,
  ): Promise<void> {
    if (Object.keys(permits).length === 0)
      await transaction.delete(CROSS_DETAIL_PERMITS_KEY);
    else await transaction.put(CROSS_DETAIL_PERMITS_KEY, permits);
    await this.rescheduleAlarm(transaction, now);
  }

  private async activeCrossDetailLeases(
    transaction: DurableObjectTransaction,
    now: number,
  ): Promise<Record<string, number>> {
    const stored =
      (await transaction.get<Record<string, unknown>>(
        CROSS_DETAIL_LEASES_KEY,
      )) ?? {};
    const active: Record<string, number> = {};
    for (const [leaseId, expiresAt] of Object.entries(stored)) {
      if (
        VNU_CROSS_DETAIL_LEASE_ID_PATTERN.test(leaseId) &&
        typeof expiresAt === "number" &&
        Number.isSafeInteger(expiresAt) &&
        expiresAt > now
      )
        active[leaseId] = expiresAt;
    }
    return active;
  }

  private async storeCrossDetailLeases(
    transaction: DurableObjectTransaction,
    leases: Record<string, number>,
    now: number,
  ): Promise<void> {
    if (Object.keys(leases).length === 0)
      await transaction.delete(CROSS_DETAIL_LEASES_KEY);
    else await transaction.put(CROSS_DETAIL_LEASES_KEY, leases);
    await this.rescheduleAlarm(transaction, now);
  }

  // The alarm is the shared janitor for every expiring store (Brc1 leases,
  // detail permits, detail leases): schedule it at the earliest active expiry
  // across all three, or delete it when nothing remains to prune.
  private async rescheduleAlarm(
    transaction: DurableObjectTransaction,
    now: number,
  ): Promise<void> {
    const stored = await transaction.get<Record<string, unknown>>([
      PERMITS_KEY,
      CROSS_DETAIL_PERMITS_KEY,
      CROSS_DETAIL_LEASES_KEY,
    ]);
    const expiries: number[] = [];
    for (const expiresAt of Object.values(stored.get(PERMITS_KEY) ?? {})) {
      if (
        typeof expiresAt === "number" &&
        Number.isSafeInteger(expiresAt) &&
        expiresAt > now
      )
        expiries.push(expiresAt);
    }
    for (const record of Object.values(
      parseStoredCrossDetailPermits(stored.get(CROSS_DETAIL_PERMITS_KEY)),
    )) {
      if (record.expiresAt > now) expiries.push(record.expiresAt);
    }
    for (const expiresAt of Object.values(
      stored.get(CROSS_DETAIL_LEASES_KEY) ?? {},
    )) {
      if (
        typeof expiresAt === "number" &&
        Number.isSafeInteger(expiresAt) &&
        expiresAt > now
      )
        expiries.push(expiresAt);
    }
    if (expiries.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.min(...expiries));
  }
}
