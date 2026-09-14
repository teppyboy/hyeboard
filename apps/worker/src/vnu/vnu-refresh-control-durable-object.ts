import { DurableObject } from "cloudflare:workers";
import {
  VNU_REFRESH_STATE_KEY,
  applyAbortRefresh,
  applyActivatePair,
  applyBeginRefresh,
  applyCheckAccess,
  applyCompleteRefresh,
  applyRevokeExactLinkedPair,
  applyRevokeLinkedPairByAccess,
  applyRevokePrincipalByLinkedGrant,
  checkAccessAuthoritatively,
  cleanVnuRefreshState,
  isQuiescentVnuRefreshState,
  nextVnuRefreshAlarm,
  parseVnuRefreshControlState,
  sameVnuRefreshState,
  type AccessDescriptorRef,
  type LinkedPair,
  type TransitionOutput,
  type VnuRefreshControlState,
  type VnuRefreshControlStorage,
} from "./vnu-refresh-control";

function cloudflareStorage(
  storage: DurableObjectStorage,
): VnuRefreshControlStorage {
  return {
    get: () => storage.get(VNU_REFRESH_STATE_KEY),
    transaction: (body) =>
      storage.transaction(async (transaction) =>
        body(
          await transaction.get(VNU_REFRESH_STATE_KEY),
          (state) => transaction.put(VNU_REFRESH_STATE_KEY, state),
          async () => {
            await transaction.delete(VNU_REFRESH_STATE_KEY);
          },
          (at) =>
            at === undefined
              ? transaction.deleteAlarm()
              : transaction.setAlarm(at),
        ),
      ),
  };
}

export class VnuRefreshControlDurableObject extends DurableObject<Env> {
  storage: VnuRefreshControlStorage;

  constructor(context: DurableObjectState, environment: Env) {
    super(context, environment);
    this.storage = cloudflareStorage(context.storage);
  }

  private async mutate<T>(
    transition: (
      state: VnuRefreshControlState | undefined,
      now: number,
    ) => TransitionOutput<T>,
  ): Promise<T> {
    return this.storage.transaction(async (raw, put, deleteState, setAlarm) => {
      const stored = parseVnuRefreshControlState(raw);
      const output = transition(stored, Date.now());
      if (output.changed) {
        if (isQuiescentVnuRefreshState(output.state)) await deleteState();
        else await put(output.state);
        await setAlarm(nextVnuRefreshAlarm(output.state));
      }
      return output.result;
    });
  }

  activatePair(pair: LinkedPair) {
    return this.mutate((state, now) => applyActivatePair(state, pair, now));
  }
  checkAccess(access: AccessDescriptorRef) {
    return checkAccessAuthoritatively(this.storage, access, Date.now());
  }
  beginRefresh(pair: LinkedPair) {
    return this.mutate((state, now) => applyBeginRefresh(state, pair, now));
  }
  completeRefresh(input: { old: LinkedPair; next: LinkedPair }) {
    return this.mutate((state, now) => applyCompleteRefresh(state, input, now));
  }
  abortRefresh(input: { pair: LinkedPair; terminal: boolean }) {
    return this.mutate((state, now) => applyAbortRefresh(state, input, now));
  }
  revokeLinkedPairByAccess(pair: AccessDescriptorRef) {
    return this.mutate((state, now) =>
      applyRevokeLinkedPairByAccess(state, pair, now),
    );
  }
  revokePrincipalByLinkedGrant(pair: LinkedPair) {
    return this.mutate((state, now) =>
      applyRevokePrincipalByLinkedGrant(state, pair, now),
    );
  }
  revokeExactLinkedPair(pair: LinkedPair) {
    return this.mutate((state, now) =>
      applyRevokeExactLinkedPair(state, pair, now),
    );
  }
  async alarm() {
    await this.mutate((state, now) => {
      const next = cleanVnuRefreshState(state, now);
      return {
        state: next,
        result: undefined,
        changed: state !== undefined && !sameVnuRefreshState(state, next),
      };
    });
  }
}
