import {
  applyAbortRefresh,
  applyActivatePair,
  applyBeginRefresh,
  applyCheckAccess,
  applyCompleteRefresh,
  applyRevokeExactLinkedPair,
  applyRevokeLinkedPairByAccess,
  applyRevokePrincipalByLinkedGrant,
  assertAccessDescriptorRef,
  assertLinkedPair,
  isQuiescentVnuRefreshState,
  nextVnuRefreshAlarm,
  parseVnuRefreshControlState,
  vnuRefreshUnavailable,
  type AccessDescriptorRef,
  type ActivatePairResult,
  type BeginRefreshResult,
  type LinkedPair,
  type VnuRefreshControlCoordinator,
  type VnuRefreshControlState,
} from "../../vnu/vnu-refresh-control";
import type { RedisCommandClient } from "./client";
import { refreshStateKey } from "./keys";

export type RedisVnuRefreshCoordinatorOptions = {
  client: RedisCommandClient;
  maxAttempts?: number;
};

export class RedisVnuRefreshControlCoordinator
  implements VnuRefreshControlCoordinator
{
  private readonly transitionQueues = new Map<string, Promise<void>>();

  constructor(private readonly options: RedisVnuRefreshCoordinatorOptions) {
    const attempts = options.maxAttempts ?? 8;
    if (!Number.isSafeInteger(attempts) || attempts <= 0)
      throw new Error("Redis refresh transaction attempts must be positive");
  }

  private async serialize<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.transitionQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.transitionQueues.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.transitionQueues.get(key) === current)
        this.transitionQueues.delete(key);
    }
  }

  private async transition<T>(
    principalKey: string,
    transition: (
      state: VnuRefreshControlState | undefined,
      now: number,
    ) => { state: VnuRefreshControlState; result: T; changed: boolean },
  ): Promise<T> {
    if (!/^[0-9a-f]{64}$/.test(principalKey)) throw vnuRefreshUnavailable();
    const key = refreshStateKey(principalKey);
    const attempts = this.options.maxAttempts ?? 8;
    return this.serialize(key, async () => {
      try {
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          try {
            await this.options.client.watch(key);
            const raw = await this.options.client.get(key);
            const stored =
              raw === null
                ? undefined
                : parseVnuRefreshControlState(JSON.parse(raw));
            const output = transition(stored, Date.now());
            if (!output.changed) {
              await this.options.client.unwatch();
              return output.result;
            }
            const multi = this.options.client.multi();
            if (isQuiescentVnuRefreshState(output.state)) {
              multi.del(key);
            } else {
              const alarm = nextVnuRefreshAlarm(output.state);
              const ttl = Math.max(
                1,
                (alarm ?? Date.now() + 86_400_000) - Date.now(),
              );
              multi.set(key, JSON.stringify(output.state), {
                expiration: { type: "PX", value: ttl },
              });
            }
            if ((await multi.exec()) !== null) return output.result;
          } catch (error) {
            // A concurrent refresh on another replica legitimately aborts a
            // WATCH transaction. Retry the pure transition against the new
            // state instead of converting normal contention into a 503.
            if (
              error instanceof Error &&
              (error.name === "WatchError" ||
                error.constructor.name === "WatchError")
            )
              continue;
            throw error;
          }
        }
        throw new Error("Redis refresh transaction contention");
      } catch {
        throw vnuRefreshUnavailable();
      } finally {
        await this.options.client.unwatch().catch(() => undefined);
      }
    });
  }

  activatePair(
    principalKey: string,
    pair: LinkedPair,
  ): Promise<ActivatePairResult> {
    assertLinkedPair(pair);
    return this.transition(principalKey, (state, now) =>
      applyActivatePair(state, pair, now),
    );
  }
  checkAccess(principalKey: string, access: AccessDescriptorRef) {
    assertAccessDescriptorRef(access);
    return this.transition(principalKey, (state, now) =>
      applyCheckAccess(state, access, now),
    );
  }
  beginRefresh(
    principalKey: string,
    pair: LinkedPair,
  ): Promise<BeginRefreshResult> {
    assertLinkedPair(pair);
    return this.transition(principalKey, (state, now) =>
      applyBeginRefresh(state, pair, now),
    );
  }
  async completeRefresh(
    principalKey: string,
    input: { old: LinkedPair; next: LinkedPair },
  ): Promise<"completed" | "revoked"> {
    assertLinkedPair(input.old);
    assertLinkedPair(input.next);
    return (
      await this.transition(principalKey, (state, now) =>
        applyCompleteRefresh(state, input, now),
      )
    ).kind;
  }
  async abortRefresh(
    principalKey: string,
    input: { pair: LinkedPair; terminal: boolean },
  ): Promise<void> {
    assertLinkedPair(input.pair);
    await this.transition(principalKey, (state, now) =>
      applyAbortRefresh(state, input, now),
    );
  }
  async revokeLinkedPairByAccess(
    principalKey: string,
    pair: AccessDescriptorRef,
  ) {
    assertAccessDescriptorRef(pair);
    return (
      await this.transition(principalKey, (state, now) =>
        applyRevokeLinkedPairByAccess(state, pair, now),
      )
    ).kind;
  }
  async revokePrincipalByLinkedGrant(principalKey: string, pair: LinkedPair) {
    assertLinkedPair(pair);
    return (
      await this.transition(principalKey, (state, now) =>
        applyRevokePrincipalByLinkedGrant(state, pair, now),
      )
    ).kind;
  }
  async revokeExactLinkedPair(principalKey: string, pair: LinkedPair) {
    assertLinkedPair(pair);
    return (
      await this.transition(principalKey, (state, now) =>
        applyRevokeExactLinkedPair(state, pair, now),
      )
    ).kind;
  }
}
