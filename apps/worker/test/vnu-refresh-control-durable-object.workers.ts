import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VnuRefreshControlDurableObject } from "../src/vnu-refresh-control-durable-object";
import {
  DurableObjectVnuRefreshControlCoordinator,
  VNU_MANUAL_ACTIVATION_LIMIT,
  VNU_MANUAL_ACTIVATION_WINDOW_MS,
  VNU_REFRESH_ATTEMPT_LIMIT,
  VNU_REFRESH_STATE_KEY,
  VNU_REFRESH_WINDOW_MS,
  vnuRefreshUnavailable,
  type LinkedPair,
  type VnuRefreshControlNamespace,
  type VnuRefreshControlState,
  type VnuRefreshControlStorage,
} from "../src/vnu-refresh-control";

declare module "cloudflare:workers" { interface ProvidedEnv { VNU_REFRESH_CONTROL: Env["VNU_REFRESH_CONTROL"] } }

const NOW = Date.parse("2036-02-03T04:05:06.000Z");
const EXPIRY = NOW + 8 * 60 * 60 * 1000;
const OLD: LinkedPair = { accessTokenId: "A".repeat(22), accessExpiresAt: EXPIRY - 60_000, grantId: "B".repeat(22), grantExpiresAt: EXPIRY };
const NEXT: LinkedPair = { accessTokenId: "C".repeat(22), accessExpiresAt: EXPIRY + 60_000, grantId: "D".repeat(22), grantExpiresAt: EXPIRY };
const NEWER: LinkedPair = { accessTokenId: "E".repeat(22), accessExpiresAt: EXPIRY + 120_000, grantId: "F".repeat(22), grantExpiresAt: EXPIRY };
const RETENTION_MS = EXPIRY - NOW;
type Counters = { get: number; transaction: number; put: number; deleteState: number; setAlarm: number; deleteAlarm: number };
type InstrumentedInstance = VnuRefreshControlDurableObject & { __counters?: Counters };
const zero = (): Counters => ({ get: 0, transaction: 0, put: 0, deleteState: 0, setAlarm: 0, deleteAlarm: 0 });

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); return reset(); });

async function instrument(stub: DurableObjectStub<VnuRefreshControlDurableObject>): Promise<void> {
  await runInDurableObject(stub, async (raw) => {
    const instance = raw as InstrumentedInstance;
    const real = instance.storage;
    const counters = zero();
    instance.__counters = counters;
    instance.storage = {
      async get() { counters.get += 1; return real.get(); },
      async transaction(body) {
        counters.transaction += 1;
        return real.transaction((stored, put, deleteState, setAlarm) => body(
          stored,
          async (state) => { counters.put += 1; await put(state); },
          async () => { counters.deleteState += 1; await deleteState(); },
          async (at) => {
            if (at === undefined) counters.deleteAlarm += 1; else counters.setAlarm += 1;
            await setAlarm(at);
          },
        ));
      },
    } satisfies VnuRefreshControlStorage;
  });
}

async function counters(stub: DurableObjectStub<VnuRefreshControlDurableObject>, clear = false): Promise<Counters> {
  return runInDurableObject(stub, async (raw) => {
    const instance = raw as InstrumentedInstance;
    const current = { ...(instance.__counters ?? zero()) };
    if (clear && instance.__counters) Object.assign(instance.__counters, zero());
    return current;
  });
}

async function snapshot(stub: DurableObjectStub<VnuRefreshControlDurableObject>) {
  return runInDurableObject(stub, async (_instance, context) => ({ bytes: JSON.stringify([...await context.storage.list()]), alarm: await context.storage.getAlarm() }));
}

function coordinator(namespace: VnuRefreshControlNamespace = env.VNU_REFRESH_CONTROL) {
  return new DurableObjectVnuRefreshControlCoordinator(namespace);
}

describe("real Durable Object persistence matrix", () => {
  it("rejects ambiguous grant tombstones with exact access tombstones without writes", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const authority = coordinator();
    let caseIndex = 0;
    for (const active of [undefined, NEXT]) {
      const ambiguousGrantTombstones = [
        OLD.grantExpiresAt,
        { accessTokenId: active?.accessTokenId ?? "Y".repeat(22), accessExpiresAt: OLD.accessExpiresAt, grantExpiresAt: OLD.grantExpiresAt },
        { accessTokenId: OLD.accessTokenId, accessExpiresAt: OLD.accessExpiresAt - 1, grantExpiresAt: OLD.grantExpiresAt },
      ];
      for (const tombstone of ambiguousGrantTombstones) {
        const principal = caseIndex.toString(16).padStart(64, "0");
        caseIndex += 1;
        const stub = env.VNU_REFRESH_CONTROL.getByName(principal);
        await runInDurableObject(stub, async (_instance, context) => {
          await context.storage.put(VNU_REFRESH_STATE_KEY, {
            ...(active ? { active } : {}),
            revokedAccess: { [OLD.accessTokenId]: OLD.accessExpiresAt },
            revokedGrants: { [OLD.grantId]: tombstone },
            window: { count: 0, resetAt: EXPIRY + 1 },
          });
          await context.storage.setAlarm(OLD.accessExpiresAt);
        });
        await instrument(stub);
        const before = await snapshot(stub);
        expect(await authority.revokeLinkedPairByAccess(principal, OLD)).toBe("mismatch");
        expect(await counters(stub)).toEqual({ get: 0, transaction: 1, put: 0, deleteState: 0, setAlarm: 0, deleteAlarm: 0 });
        expect(await snapshot(stub)).toEqual(before);
      }
    }
  });

  it("accepts an exact linked tombstone idempotently without touching unrelated active state", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const principal = "fe".repeat(32);
    const stub = env.VNU_REFRESH_CONTROL.getByName(principal);
    await runInDurableObject(stub, async (_instance, context) => {
      await context.storage.put(VNU_REFRESH_STATE_KEY, {
        active: NEXT,
        revokedAccess: { [OLD.accessTokenId]: OLD.accessExpiresAt },
        revokedGrants: { [OLD.grantId]: { accessTokenId: OLD.accessTokenId, accessExpiresAt: OLD.accessExpiresAt, grantExpiresAt: OLD.grantExpiresAt } },
        window: { count: 0, resetAt: EXPIRY + 1 },
      });
      await context.storage.setAlarm(OLD.accessExpiresAt);
    });
    await instrument(stub);
    const before = await snapshot(stub);
    expect(await coordinator().revokeLinkedPairByAccess(principal, OLD)).toBe("revoked");
    expect(await counters(stub)).toEqual({ get: 0, transaction: 1, put: 0, deleteState: 0, setAlarm: 0, deleteAlarm: 0 });
    expect(await snapshot(stub)).toEqual(before);
  });

  it("deletes quiescent state and alarm after final grant and window expiry", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const principal = "dead".repeat(16);
    const pair = { ...OLD, accessExpiresAt: NOW + 1_000, grantExpiresAt: NOW + 2_000 };
    const stub = env.VNU_REFRESH_CONTROL.getByName(principal);
    await instrument(stub);
    const authority = coordinator();
    await authority.activatePair(principal, pair);
    await authority.beginRefresh(principal, pair);
    await authority.abortRefresh(principal, { pair, terminal: false });
    await authority.revokeLinkedPairByAccess(principal, pair);
    await counters(stub, true);
    vi.setSystemTime(pair.accessExpiresAt);
    await runInDurableObject(stub, async (instance) => instance.alarm());
    vi.setSystemTime(pair.grantExpiresAt);
    await runInDurableObject(stub, async (instance) => instance.alarm());
    vi.setSystemTime(NOW + VNU_REFRESH_WINDOW_MS);
    await runInDurableObject(stub, async (instance) => instance.alarm());
    expect(await counters(stub, true)).toEqual({ get: 0, transaction: 3, put: 2, deleteState: 1, setAlarm: 2, deleteAlarm: 1 });
    const settled = await runInDurableObject(stub, async (_instance, context) => ({ stored: await context.storage.get(VNU_REFRESH_STATE_KEY), alarm: await context.storage.getAlarm() }));
    expect(settled).toEqual({ stored: undefined, alarm: null });
    await runInDurableObject(stub, async (instance) => instance.alarm());
    expect(await counters(stub)).toEqual({ get: 0, transaction: 1, put: 0, deleteState: 0, setAlarm: 0, deleteAlarm: 0 });
  });
  it("changed mutations each put once and perform exactly one alarm operation", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const stub = env.VNU_REFRESH_CONTROL.getByName("a".repeat(64));
    await instrument(stub);
    const authority = coordinator();
    await authority.activatePair("a".repeat(64), OLD);
    expect(await counters(stub, true)).toEqual({ get: 0, transaction: 1, put: 1, deleteState: 0, setAlarm: 1, deleteAlarm: 0 });
    await authority.beginRefresh("a".repeat(64), OLD);
    expect(await counters(stub, true)).toEqual({ get: 0, transaction: 1, put: 1, deleteState: 0, setAlarm: 1, deleteAlarm: 0 });
    await authority.activatePair("a".repeat(64), OLD);
    expect(await counters(stub, true)).toEqual({ get: 0, transaction: 1, put: 1, deleteState: 0, setAlarm: 1, deleteAlarm: 0 });
    await authority.beginRefresh("a".repeat(64), OLD);
    await counters(stub, true);
    await authority.abortRefresh("a".repeat(64), { pair: OLD, terminal: false });
    expect(await counters(stub, true)).toEqual({ get: 0, transaction: 1, put: 1, deleteState: 0, setAlarm: 1, deleteAlarm: 0 });
    await authority.beginRefresh("a".repeat(64), OLD);
    await counters(stub, true);
    await authority.completeRefresh("a".repeat(64), { old: OLD, next: NEXT });
    expect(await counters(stub, true)).toEqual({ get: 0, transaction: 1, put: 1, deleteState: 0, setAlarm: 1, deleteAlarm: 0 });
    await authority.revokeLinkedPairByAccess("a".repeat(64), NEXT);
    expect(await counters(stub)).toEqual({ get: 0, transaction: 1, put: 1, deleteState: 0, setAlarm: 1, deleteAlarm: 0 });

    const terminalPrincipal = "7".repeat(64);
    const terminalStub = env.VNU_REFRESH_CONTROL.getByName(terminalPrincipal);
    await instrument(terminalStub);
    await authority.activatePair(terminalPrincipal, OLD); await authority.beginRefresh(terminalPrincipal, OLD); await counters(terminalStub, true);
    await authority.abortRefresh(terminalPrincipal, { pair: OLD, terminal: true });
    expect(await counters(terminalStub)).toEqual({ get: 0, transaction: 1, put: 1, deleteState: 0, setAlarm: 1, deleteAlarm: 0 });

    const exactPrincipal = "8".repeat(64);
    const exactStub = env.VNU_REFRESH_CONTROL.getByName(exactPrincipal);
    await instrument(exactStub); await authority.activatePair(exactPrincipal, OLD); await counters(exactStub, true);
    await authority.revokeExactLinkedPair(exactPrincipal, OLD);
    expect(await counters(exactStub)).toEqual({ get: 0, transaction: 1, put: 1, deleteState: 0, setAlarm: 1, deleteAlarm: 0 });

    const replacementPrincipal = "b1".repeat(32);
    const replacementStub = env.VNU_REFRESH_CONTROL.getByName(replacementPrincipal);
    await instrument(replacementStub); await authority.activatePair(replacementPrincipal, OLD); await counters(replacementStub, true);
    await authority.activatePair(replacementPrincipal, NEXT);
    expect(await counters(replacementStub)).toEqual({ get: 0, transaction: 1, put: 1, deleteState: 0, setAlarm: 1, deleteAlarm: 0 });
  });

  it("every mutating no-op preserves exact bytes/alarm with zero writes", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const stub = env.VNU_REFRESH_CONTROL.getByName("b".repeat(64));
    await instrument(stub);
    const authority = coordinator();
    await authority.activatePair("b".repeat(64), OLD);
    const seedStaleCandidate = () => runInDurableObject(stub, async (_instance, context) => {
      const state = await context.storage.get<Record<string, unknown>>(VNU_REFRESH_STATE_KEY);
      const alarm = await context.storage.getAlarm();
      await context.storage.put(VNU_REFRESH_STATE_KEY, { ...state, revokedAccess: { ...state?.revokedAccess as object, ["S".repeat(22)]: NOW } });
      if (alarm !== null) await context.storage.setAlarm(alarm);
    });
    const assertNoWrite = async (operation: () => Promise<unknown>) => {
      await seedStaleCandidate();
      const before = await snapshot(stub); await counters(stub, true);
      await operation();
      expect(await counters(stub)).toMatchObject({ put: 0, setAlarm: 0, deleteAlarm: 0 });
      expect(await snapshot(stub)).toEqual(before);
    };
    await assertNoWrite(() => authority.activatePair("b".repeat(64), OLD));
    await authority.beginRefresh("b".repeat(64), OLD); await counters(stub, true);
    await assertNoWrite(() => authority.beginRefresh("b".repeat(64), OLD));
    await assertNoWrite(() => authority.completeRefresh("b".repeat(64), { old: NEXT, next: OLD }));
    await authority.abortRefresh("b".repeat(64), { pair: OLD, terminal: false }); await counters(stub, true);
    await assertNoWrite(() => authority.abortRefresh("b".repeat(64), { pair: OLD, terminal: false }));
    await assertNoWrite(() => authority.revokeLinkedPairByAccess("b".repeat(64), { ...OLD, grantId: "Z".repeat(22) }));
    await authority.revokeLinkedPairByAccess("b".repeat(64), OLD); await counters(stub, true);
    await assertNoWrite(() => authority.revokeLinkedPairByAccess("b".repeat(64), OLD));
    await assertNoWrite(() => authority.beginRefresh("b".repeat(64), OLD));
    const expired = { ...OLD, accessExpiresAt: NOW, grantExpiresAt: NOW };
    await assertNoWrite(() => authority.revokeLinkedPairByAccess("b".repeat(64), expired));
    await runInDurableObject(stub, async (instance) => instance.alarm());
    await assertNoWrite(() => authority.revokeLinkedPairByAccess("b".repeat(64), expired));
  });

  it("rate-limited begin is byte-identical and write-free", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const principal = "9".repeat(64);
    const stub = env.VNU_REFRESH_CONTROL.getByName(principal);
    await instrument(stub);
    const authority = coordinator();
    await authority.activatePair(principal, OLD);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await authority.beginRefresh(principal, OLD);
      await authority.abortRefresh(principal, { pair: OLD, terminal: false });
    }
    await runInDurableObject(stub, async (_instance, context) => {
      const state = await context.storage.get<Record<string, unknown>>(VNU_REFRESH_STATE_KEY);
      const alarm = await context.storage.getAlarm();
      await context.storage.put(VNU_REFRESH_STATE_KEY, { ...state, revokedAccess: { ...state?.revokedAccess as object, ["S".repeat(22)]: NOW } });
      if (alarm !== null) await context.storage.setAlarm(alarm);
    });
    const before = await snapshot(stub); await counters(stub, true);
    expect(await authority.beginRefresh(principal, OLD)).toMatchObject({ kind: "rate-limited" });
    expect(await counters(stub)).toEqual({ get: 0, transaction: 1, put: 0, deleteState: 0, setAlarm: 0, deleteAlarm: 0 });
    expect(await snapshot(stub)).toEqual(before);
  });

  it("fully expired revoke is write-free before and after real alarm cleanup", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const principal = "ab".repeat(32);
    const expired = { ...OLD, accessExpiresAt: NOW, grantExpiresAt: NOW };
    const stub = env.VNU_REFRESH_CONTROL.getByName(principal);
    await runInDurableObject(stub, async (_instance, context) => {
      await context.storage.put(VNU_REFRESH_STATE_KEY, { active: expired, revokedAccess: { ["S".repeat(22)]: NOW }, revokedGrants: {}, window: { count: 0, resetAt: NOW + VNU_REFRESH_WINDOW_MS } });
      await context.storage.setAlarm(NOW);
    });
    await instrument(stub);
    const authority = coordinator();
    const before = await snapshot(stub);
    expect(await authority.revokeLinkedPairByAccess(principal, expired)).toBe("expired");
    expect(await counters(stub, true)).toMatchObject({ put: 0, setAlarm: 0, deleteAlarm: 0 });
    expect(await snapshot(stub)).toEqual(before);
    await runInDurableObject(stub, async (instance) => instance.alarm());
    await counters(stub, true);
    const cleaned = await snapshot(stub);
    expect(await authority.revokeLinkedPairByAccess(principal, expired)).toBe("expired");
    expect(await counters(stub)).toMatchObject({ put: 0, setAlarm: 0, deleteAlarm: 0 });
    expect(await snapshot(stub)).toEqual(cleaned);
  });

  it("steady access checks use direct gets; grant alarm cleans once", async () => {
    vi.useFakeTimers();
    const accessExpiry = NOW + 1_000;
    const grantExpiry = NOW + 2_000;
    const pair = { ...OLD, accessExpiresAt: accessExpiry, grantExpiresAt: grantExpiry };
    const stub = env.VNU_REFRESH_CONTROL.getByName("c".repeat(64));
    vi.setSystemTime(NOW);
    await instrument(stub);
    await coordinator().activatePair("c".repeat(64), pair);
    await counters(stub, true);
    vi.setSystemTime(accessExpiry);
    const before = await snapshot(stub);
    expect(await coordinator().checkAccess("c".repeat(64), pair)).toEqual({ kind: "revoked" });
    expect(await coordinator().checkAccess("c".repeat(64), pair)).toEqual({ kind: "revoked" });
    expect(await counters(stub, true)).toEqual({ get: 2, transaction: 0, put: 0, deleteState: 0, setAlarm: 0, deleteAlarm: 0 });
    expect(await snapshot(stub)).toEqual(before);
    expect(before.alarm).toBe(grantExpiry);
    vi.setSystemTime(grantExpiry);
    await runInDurableObject(stub, async (instance) => instance.alarm());
    expect(await counters(stub, true)).toEqual({ get: 0, transaction: 1, put: 1, deleteState: 0, setAlarm: 1, deleteAlarm: 0 });
    const cleaned = await snapshot(stub);
    expect(cleaned.bytes).not.toContain(pair.accessTokenId);
    expect(cleaned.alarm).toBe(NOW + VNU_MANUAL_ACTIVATION_WINDOW_MS);
    vi.setSystemTime(NOW + VNU_MANUAL_ACTIVATION_WINDOW_MS);
    await runInDurableObject(stub, async (instance) => instance.alarm());
    expect(await counters(stub, true)).toEqual({ get: 0, transaction: 1, put: 0, deleteState: 1, setAlarm: 0, deleteAlarm: 1 });
    await runInDurableObject(stub, async (instance) => instance.alarm());
    expect(await counters(stub)).toEqual({ get: 0, transaction: 1, put: 0, deleteState: 0, setAlarm: 0, deleteAlarm: 0 });
  });

  it("uses live-grant no-mutation proof after access tombstone expiry; live unmatched access mismatches", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const pair = { ...OLD, accessExpiresAt: NOW };
    const principal = "d".repeat(64);
    const stub = env.VNU_REFRESH_CONTROL.getByName(principal);
    await instrument(stub);
    const authority = coordinator();
    await authority.activatePair(principal, pair);
    vi.setSystemTime(NOW + 1);
    expect(await authority.revokeLinkedPairByAccess(principal, pair)).toBe("revoked");
    const first = await snapshot(stub); await counters(stub, true);
    expect(await authority.revokeLinkedPairByAccess(principal, pair)).toBe("revoked");
    expect(await counters(stub)).toMatchObject({ put: 0, setAlarm: 0, deleteAlarm: 0 });
    expect(await snapshot(stub)).toEqual(first);
    // The independent access tombstone is gone, but its bounded linkage remains
    // inside the corresponding grant tombstone through grant expiry.
    expect(await authority.revokeLinkedPairByAccess(principal, { ...pair, accessTokenId: "Y".repeat(22) })).toBe("mismatch");
    expect(await snapshot(stub)).toEqual(first);
    expect(await authority.revokeLinkedPairByAccess(principal, { ...pair, accessTokenId: "Z".repeat(22), accessExpiresAt: NOW + 2 })).toBe("mismatch");
  });

  it("keeps next active while an exact old live grant proves logout after access tombstone cleanup", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW - 1);
    const principal = "d1".repeat(32);
    const old = { ...OLD, accessExpiresAt: NOW };
    const stub = env.VNU_REFRESH_CONTROL.getByName(principal);
    await instrument(stub);
    const authority = coordinator();
    await authority.activatePair(principal, old);
    await authority.beginRefresh(principal, old);
    vi.setSystemTime(NOW);
    await authority.completeRefresh(principal, { old, next: NEXT });
    vi.setSystemTime(NOW + 1);
    await runInDurableObject(stub, async (instance) => instance.alarm());
    const cleaned = await snapshot(stub); await counters(stub, true);
    const cleanedState = await runInDurableObject(stub, async (_instance, context) => context.storage.get<VnuRefreshControlState>(VNU_REFRESH_STATE_KEY));
    expect(cleanedState?.revokedAccess[old.accessTokenId]).toBeUndefined();
    expect(cleanedState?.revokedGrants[old.grantId]).toEqual({
      accessTokenId: old.accessTokenId,
      accessExpiresAt: old.accessExpiresAt,
      grantExpiresAt: old.grantExpiresAt,
      refreshSuccessor: NEXT,
    });
    expect(await authority.revokeLinkedPairByAccess(principal, old)).toBe("revoked");
    expect(await counters(stub, true)).toEqual({ get: 0, transaction: 1, put: 0, deleteState: 0, setAlarm: 0, deleteAlarm: 0 });
    expect(await snapshot(stub)).toEqual(cleaned);
    for (const wrong of [
      { ...old, accessTokenId: "Y".repeat(22) },
      { ...old, accessExpiresAt: old.accessExpiresAt - 1 },
      { ...old, grantId: "Z".repeat(22) },
      { ...old, grantExpiresAt: old.grantExpiresAt + 1 },
    ]) {
      expect(await authority.revokeLinkedPairByAccess(principal, wrong)).toBe("mismatch");
      expect(await counters(stub, true)).toEqual({ get: 0, transaction: 1, put: 0, deleteState: 0, setAlarm: 0, deleteAlarm: 0 });
      expect(await snapshot(stub)).toEqual(cleaned);
      expect(await authority.revokePrincipalByLinkedGrant(principal, wrong)).toBe("mismatch");
      expect(await counters(stub, true)).toEqual({ get: 0, transaction: 1, put: 0, deleteState: 0, setAlarm: 0, deleteAlarm: 0 });
      expect(await snapshot(stub)).toEqual(cleaned);
    }
    expect(await authority.checkAccess(principal, NEXT)).toEqual({ kind: "active" });
    await authority.beginRefresh(principal, NEXT);
    const leased = await snapshot(stub); await counters(stub, true);
    for (const wrong of [{ ...old, accessTokenId: "Y".repeat(22) }, { ...old, accessExpiresAt: old.accessExpiresAt - 1 }]) {
      expect(await authority.revokePrincipalByLinkedGrant(principal, wrong)).toBe("mismatch");
      expect(await counters(stub, true)).toEqual({ get: 0, transaction: 1, put: 0, deleteState: 0, setAlarm: 0, deleteAlarm: 0 });
      expect(await snapshot(stub)).toEqual(leased);
    }
    expect(await authority.revokePrincipalByLinkedGrant(principal, old)).toBe("revoked");
    expect(await counters(stub, true)).toEqual({ get: 0, transaction: 1, put: 1, deleteState: 0, setAlarm: 1, deleteAlarm: 0 });
    const revoked = await snapshot(stub);
    expect(await authority.revokePrincipalByLinkedGrant(principal, old)).toBe("revoked");
    expect(await counters(stub, true)).toEqual({ get: 0, transaction: 1, put: 0, deleteState: 0, setAlarm: 0, deleteAlarm: 0 });
    expect(await snapshot(stub)).toEqual(revoked);
    expect(await authority.checkAccess(principal, NEXT)).toEqual({ kind: "revoked" });
  });

  it("unrelated live grants cannot retain an expired access tombstone", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW + 1);
    const principal = "cd".repeat(32);
    const stub = env.VNU_REFRESH_CONTROL.getByName(principal);
    await runInDurableObject(stub, async (_instance, context) => {
      await context.storage.put(VNU_REFRESH_STATE_KEY, {
        revokedAccess: { [OLD.accessTokenId]: NOW },
        revokedGrants: { [NEXT.grantId]: EXPIRY },
        window: { count: 0, resetAt: EXPIRY + 1 },
      });
      await context.storage.setAlarm(NOW);
    });
    await instrument(stub);
    await runInDurableObject(stub, async (instance) => instance.alarm());
    expect(await counters(stub)).toEqual({ get: 0, transaction: 1, put: 1, deleteState: 0, setAlarm: 1, deleteAlarm: 0 });
    const state = await runInDurableObject(stub, async (_instance, context) => context.storage.get<{ revokedAccess: Record<string, number>; revokedGrants: Record<string, number> }>(VNU_REFRESH_STATE_KEY));
    expect(state?.revokedAccess).toEqual({});
    expect(state?.revokedGrants).toEqual({ [NEXT.grantId]: EXPIRY });
  });

  it("one stale entry causes one transactional cleanup then steady direct reads", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const principal = "0".repeat(64);
    const stub = env.VNU_REFRESH_CONTROL.getByName(principal);
    await instrument(stub); await coordinator().activatePair(principal, OLD);
    await counters(stub, true);
    expect(await coordinator().checkAccess(principal, OLD)).toEqual({ kind: "active" });
    expect(await coordinator().checkAccess(principal, OLD)).toEqual({ kind: "active" });
    expect(await coordinator().checkAccess(principal, OLD)).toEqual({ kind: "active" });
    expect(await counters(stub, true)).toEqual({ get: 3, transaction: 0, put: 0, deleteState: 0, setAlarm: 0, deleteAlarm: 0 });
    await runInDurableObject(stub, async (_instance, context) => {
      const state = await context.storage.get<Record<string, unknown>>(VNU_REFRESH_STATE_KEY);
      await context.storage.put(VNU_REFRESH_STATE_KEY, { ...state, revokedAccess: { ["S".repeat(22)]: NOW } });
    });
    expect(await coordinator().checkAccess(principal, OLD)).toEqual({ kind: "active" });
    expect(await counters(stub, true)).toEqual({ get: 1, transaction: 1, put: 1, deleteState: 0, setAlarm: 1, deleteAlarm: 0 });
    expect(await coordinator().checkAccess(principal, OLD)).toEqual({ kind: "active" });
    expect(await counters(stub)).toEqual({ get: 1, transaction: 0, put: 0, deleteState: 0, setAlarm: 0, deleteAlarm: 0 });
  });
});

describe("entered-operation races", () => {
  async function gateReadAndTransaction(stub: DurableObjectStub<VnuRefreshControlDurableObject>) {
    await runInDurableObject(stub, async (raw) => {
      const instance = raw as VnuRefreshControlDurableObject & { __entered?: number; __allEntered?: Promise<void>; __release?: () => void };
      instance.__entered = 0;
      let enteredResolve!: () => void;
      instance.__allEntered = new Promise<void>((resolve) => { enteredResolve = resolve; });
      let releaseResolve!: () => void;
      const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
      instance.__release = releaseResolve;
      const real = instance.storage;
      const entered = async () => {
        instance.__entered = (instance.__entered ?? 0) + 1;
        if (instance.__entered === 2) enteredResolve();
        await release;
      };
      instance.storage = {
        async get() { await entered(); return real.get(); },
        async transaction(body) { await entered(); return real.transaction(body); },
      };
    });
    return () => runInDurableObject(stub, async (raw) => {
      const instance = raw as VnuRefreshControlDurableObject & { __allEntered?: Promise<void>; __release?: () => void };
      await instance.__allEntered;
      instance.__release?.();
    });
  }

  async function gateTransactions(stub: DurableObjectStub<VnuRefreshControlDurableObject>, expectedEntries: number) {
    await runInDurableObject(stub, async (raw) => {
      const instance = raw as VnuRefreshControlDurableObject & { __allTransactions?: Promise<void>; __releaseTransactions?: () => void };
      let enteredCount = 0;
      let enteredResolve!: () => void;
      instance.__allTransactions = new Promise<void>((resolve) => { enteredResolve = resolve; });
      let releaseResolve!: () => void;
      const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
      instance.__releaseTransactions = releaseResolve;
      const real = instance.storage;
      instance.storage = {
        get: () => real.get(),
        async transaction(body) {
          enteredCount += 1;
          if (enteredCount === expectedEntries) enteredResolve();
          await release;
          return real.transaction(body);
        },
      };
    });
    return () => runInDurableObject(stub, async (raw) => {
      const instance = raw as VnuRefreshControlDurableObject & { __allTransactions?: Promise<void>; __releaseTransactions?: () => void };
      await instance.__allTransactions;
      instance.__releaseTransactions?.();
    });
  }

  it("concurrent activation and check expose no half pair", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const stub = env.VNU_REFRESH_CONTROL.getByName("e".repeat(64));
    const release = await gateReadAndTransaction(stub);
    const activate = stub.activatePair(OLD);
    const check = stub.checkAccess(OLD);
    await release();
    await expect(activate).resolves.toEqual({ kind: "activated" });
    await expect(check).resolves.toMatchObject({ kind: expect.stringMatching(/active|revoked/) });
    const stored = await runInDurableObject(stub, async (_instance, context) => context.storage.get(VNU_REFRESH_STATE_KEY));
    expect(stored).toMatchObject({ active: OLD });
  });

  it("logout-before-complete beats late completion; completed-first linked-grant logout revokes next", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const firstPrincipal = "f".repeat(64);
    const first = env.VNU_REFRESH_CONTROL.getByName(firstPrincipal);
    const auth = coordinator();
    await auth.activatePair(firstPrincipal, OLD); await auth.beginRefresh(firstPrincipal, OLD);
    expect(await auth.revokeLinkedPairByAccess(firstPrincipal, OLD)).toBe("revoked");
    expect(await auth.completeRefresh(firstPrincipal, { old: OLD, next: NEXT })).toBe("revoked");
    const secondPrincipal = "1".repeat(64);
    await auth.activatePair(secondPrincipal, OLD); await auth.beginRefresh(secondPrincipal, OLD);
    expect(await auth.completeRefresh(secondPrincipal, { old: OLD, next: NEXT })).toBe("completed");
    const second = env.VNU_REFRESH_CONTROL.getByName(secondPrincipal);
    await instrument(second);
    const before = await snapshot(second); await counters(second, true);
    expect(await auth.revokePrincipalByLinkedGrant(secondPrincipal, OLD)).toBe("revoked");
    expect(await counters(second)).toEqual({ get: 0, transaction: 1, put: 1, deleteState: 0, setAlarm: 1, deleteAlarm: 0 });
    const revoked = await snapshot(second);
    expect(revoked).not.toEqual(before);
    for (const wrong of [{ ...OLD, accessExpiresAt: OLD.accessExpiresAt + 1 }, { ...OLD, grantId: "Z".repeat(22) }]) {
      await counters(second, true);
      expect(await auth.revokePrincipalByLinkedGrant(secondPrincipal, wrong)).toBe("mismatch");
      expect(await counters(second)).toEqual({ get: 0, transaction: 1, put: 0, deleteState: 0, setAlarm: 0, deleteAlarm: 0 });
      expect(await snapshot(second)).toEqual(revoked);
    }
    expect(await auth.revokePrincipalByLinkedGrant(secondPrincipal, OLD)).toBe("revoked");
    expect(await counters(second, true)).toEqual({ get: 0, transaction: 2, put: 0, deleteState: 0, setAlarm: 0, deleteAlarm: 0 });
    expect(await auth.checkAccess(secondPrincipal, NEXT)).toEqual({ kind: "revoked" });

    const partialPrincipal = "12".repeat(32);
    const partial = env.VNU_REFRESH_CONTROL.getByName(partialPrincipal);
    await runInDurableObject(partial, async (_instance, context) => {
      await context.storage.put(VNU_REFRESH_STATE_KEY, {
        active: NEXT,
        revokedAccess: { [OLD.accessTokenId]: OLD.accessExpiresAt },
        revokedGrants: {},
        window: { count: 1, resetAt: NOW + VNU_REFRESH_WINDOW_MS },
      });
      await context.storage.setAlarm(OLD.accessExpiresAt);
    });
    await instrument(partial);
    const partialBefore = await snapshot(partial);
    expect(await auth.revokeLinkedPairByAccess(partialPrincipal, OLD)).toBe("mismatch");
    expect(await counters(partial)).toEqual({ get: 0, transaction: 1, put: 0, deleteState: 0, setAlarm: 0, deleteAlarm: 0 });
    expect(await snapshot(partial)).toEqual(partialBefore);
    expect(first).toBeDefined();
  });

  it("manual replacement makes stale old linked logout byte-identical and write-free", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const principal = "13".repeat(32);
    const stub = env.VNU_REFRESH_CONTROL.getByName(principal);
    const auth = coordinator();
    await auth.activatePair(principal, OLD);
    await auth.activatePair(principal, NEXT);
    await instrument(stub);
    const before = await snapshot(stub);

    expect(await auth.revokePrincipalByLinkedGrant(principal, OLD)).toBe("mismatch");
    expect(await counters(stub)).toEqual({ get: 0, transaction: 1, put: 0, deleteState: 0, setAlarm: 0, deleteAlarm: 0 });
    expect(await snapshot(stub)).toEqual(before);
    expect(await auth.checkAccess(principal, NEXT)).toEqual({ kind: "active" });
  });

  it("manual replacement wins either concurrent ordering against old linked logout", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const principal = "14".repeat(32);
    const stub = env.VNU_REFRESH_CONTROL.getByName(principal);
    const auth = coordinator();
    await auth.activatePair(principal, OLD);
    const release = await gateTransactions(stub, 2);
    const activation = auth.activatePair(principal, NEWER);
    const logout = auth.revokePrincipalByLinkedGrant(principal, OLD);
    await release();

    await expect(activation).resolves.toEqual({ kind: "activated" });
    await expect(logout).resolves.toMatch(/^(revoked|mismatch)$/);
    await expect(auth.checkAccess(principal, NEWER)).resolves.toEqual({ kind: "active" });
  });

  it("old refresh proof cannot cross a later manual successor replacement", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const principal = "15".repeat(32);
    const stub = env.VNU_REFRESH_CONTROL.getByName(principal);
    const auth = coordinator();
    await auth.activatePair(principal, OLD);
    await auth.beginRefresh(principal, OLD);
    await auth.completeRefresh(principal, { old: OLD, next: NEXT });
    await auth.beginRefresh(principal, NEXT);
    await auth.activatePair(principal, NEWER);
    await instrument(stub);
    const before = await snapshot(stub);

    expect(await auth.revokePrincipalByLinkedGrant(principal, OLD)).toBe("mismatch");
    expect(await counters(stub)).toEqual({ get: 0, transaction: 1, put: 0, deleteState: 0, setAlarm: 0, deleteAlarm: 0 });
    expect(await snapshot(stub)).toEqual(before);
    expect(await auth.checkAccess(principal, NEWER)).toEqual({ kind: "active" });
  });

  it("concurrent refresh completion and logout serialize to a complete valid outcome", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const principal = "a1".repeat(32);
    const stub = env.VNU_REFRESH_CONTROL.getByName(principal);
    const auth = coordinator();
    await auth.activatePair(principal, OLD); await auth.beginRefresh(principal, OLD);
    const release = await gateTransactions(stub, 2);
    const completion = auth.completeRefresh(principal, { old: OLD, next: NEXT });
    const logout = auth.revokeLinkedPairByAccess(principal, OLD);
    await release();
    const [completeResult, logoutResult] = await Promise.all([completion, logout]);
    expect([["completed", "revoked"], ["revoked", "revoked"]]).toContainEqual([completeResult, logoutResult]);
    const state = await runInDurableObject(stub, async (_instance, context) => context.storage.get(VNU_REFRESH_STATE_KEY));
    const serialized = JSON.stringify(state);
    expect(serialized.includes(OLD.accessTokenId) && serialized.includes(NEXT.grantId) && !serialized.includes(NEXT.accessTokenId)).toBe(false);
  });

  it("committed completion survives response delivery loss", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const principal = "ef".repeat(32);
    const stub = env.VNU_REFRESH_CONTROL.getByName(principal);
    const normal = coordinator();
    await normal.activatePair(principal, OLD);
    await normal.beginRefresh(principal, OLD);
    const lossyNamespace: VnuRefreshControlNamespace = { getByName: () => ({
      activatePair: (pair) => stub.activatePair(pair),
      checkAccess: (pair) => stub.checkAccess(pair),
      beginRefresh: (pair) => stub.beginRefresh(pair),
      async completeRefresh(input) { await stub.completeRefresh(input); throw new Error("SENTINEL_RESPONSE_LOST"); },
      abortRefresh: (input) => stub.abortRefresh(input),
      revokeLinkedPairByAccess: (pair) => stub.revokeLinkedPairByAccess(pair),
      revokePrincipalByLinkedGrant: (pair) => stub.revokePrincipalByLinkedGrant(pair),
      revokeExactLinkedPair: (pair) => stub.revokeExactLinkedPair(pair),
    }) };
    await expect(coordinator(lossyNamespace).completeRefresh(principal, { old: OLD, next: NEXT })).rejects.toEqual(vnuRefreshUnavailable());
    expect(await normal.checkAccess(principal, OLD)).toEqual({ kind: "revoked" });
    expect(await normal.beginRefresh(principal, OLD)).toEqual({ kind: "revoked" });
    expect(await normal.checkAccess(principal, NEXT)).toEqual({ kind: "active" });
    const state = await runInDurableObject(stub, async (_instance, context) => context.storage.get<{ active: LinkedPair; revokedAccess: Record<string, number>; revokedGrants: Record<string, number> }>(VNU_REFRESH_STATE_KEY));
    expect(state?.active).toEqual(NEXT);
    expect(state?.revokedAccess[OLD.accessTokenId]).toBe(OLD.accessExpiresAt);
    expect(state?.revokedGrants[OLD.grantId]).toEqual({
      accessTokenId: OLD.accessTokenId,
      accessExpiresAt: OLD.accessExpiresAt,
      grantExpiresAt: OLD.grantExpiresAt,
      refreshSuccessor: NEXT,
    });
    expect(await normal.revokePrincipalByLinkedGrant(principal, OLD)).toBe("revoked");
    expect(await normal.checkAccess(principal, NEXT)).toEqual({ kind: "revoked" });
  });

  it("concurrent callers atomically consume exactly five leased attempts", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const principal = "2".repeat(64);
    const stub = env.VNU_REFRESH_CONTROL.getByName(principal);
    const auth = coordinator();
    await auth.activatePair(principal, OLD);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const release = await gateTransactions(stub, 5);
      const calls = Array.from({ length: 5 }, () => auth.beginRefresh(principal, OLD));
      await release();
      const results = await Promise.all(calls);
      expect(results.filter((result) => result.kind === "accepted")).toHaveLength(1);
      expect(results.filter((result) => result.kind === "in-progress")).toHaveLength(4);
      await auth.abortRefresh(principal, { pair: OLD, terminal: false });
    }
    const state = await runInDurableObject(stub, async (_instance, context) => context.storage.get<{ window: { count: number }; lease?: unknown }>(VNU_REFRESH_STATE_KEY));
    expect(state).toMatchObject({ window: { count: 5 } });
    expect(state?.lease).toBeUndefined();
    expect(await auth.beginRefresh(principal, OLD)).toMatchObject({ kind: "rate-limited", limit: 5 });
  });

  it("serializes concurrent manual activations and writes only the bounded winners", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const principal = "21".repeat(32);
    const stub = env.VNU_REFRESH_CONTROL.getByName(principal);
    await instrument(stub);
    const callCount = VNU_MANUAL_ACTIVATION_LIMIT + 7;
    const pairs = Array.from({ length: callCount }, (_, index): LinkedPair => ({
      accessTokenId: index.toString(36).padStart(22, "a"),
      accessExpiresAt: EXPIRY,
      grantId: index.toString(36).padStart(22, "b"),
      grantExpiresAt: EXPIRY,
    }));
    const release = await gateTransactions(stub, callCount);
    const pending = pairs.map((pair) => coordinator().activatePair(principal, pair));
    await release();
    const results = await Promise.all(pending);

    expect(results.filter((result) => result.kind === "activated")).toHaveLength(VNU_MANUAL_ACTIVATION_LIMIT);
    expect(results.filter((result) => result.kind === "rate-limited")).toHaveLength(callCount - VNU_MANUAL_ACTIVATION_LIMIT);
    expect(results.filter((result) => result.kind === "rate-limited")).toEqual(
      Array(callCount - VNU_MANUAL_ACTIVATION_LIMIT).fill({ kind: "rate-limited", retryAfterSeconds: 900, limit: 5, windowSeconds: 900 }),
    );
    expect(await counters(stub)).toEqual({
      get: 0,
      transaction: callCount,
      put: VNU_MANUAL_ACTIVATION_LIMIT,
      deleteState: 0,
      setAlarm: VNU_MANUAL_ACTIVATION_LIMIT,
      deleteAlarm: 0,
    });
    const state = await runInDurableObject(stub, async (_instance, context) => context.storage.get<VnuRefreshControlState>(VNU_REFRESH_STATE_KEY));
    expect(state?.activationWindow).toEqual({ count: VNU_MANUAL_ACTIVATION_LIMIT, resetAt: NOW + VNU_MANUAL_ACTIVATION_WINDOW_MS });
    expect(Object.keys(state?.revokedGrants ?? {})).toHaveLength(VNU_MANUAL_ACTIVATION_LIMIT - 1);
  });
});

describe("combined activation and refresh retention bound", () => {
  it("retains the exact aggregate maximum below the conservative value-size ceiling and then quiesces", async () => {
    vi.useFakeTimers();
    const principal = "22".repeat(32);
    const stub = env.VNU_REFRESH_CONTROL.getByName(principal);
    const authority = coordinator();
    const fullRetentionWindowCount = RETENTION_MS / VNU_MANUAL_ACTIVATION_WINDOW_MS;
    const retainedManualGenerationBound = fullRetentionWindowCount * VNU_MANUAL_ACTIVATION_LIMIT + VNU_MANUAL_ACTIVATION_LIMIT - 1;
    const retainedRefreshGenerationBound = ((RETENTION_MS / VNU_REFRESH_WINDOW_MS) + 1) * VNU_REFRESH_ATTEMPT_LIMIT;
    const retainedGenerationBound = retainedManualGenerationBound + retainedRefreshGenerationBound;
    const conservativeSerializedStateCeiling = 96 * 1024;
    const observationTime = NOW + RETENTION_MS + 14 * 60 * 1000;
    const retentionBoundary = observationTime - RETENTION_MS;
    const firstWindowReset = NOW + VNU_MANUAL_ACTIVATION_WINDOW_MS;
    const lastFullBoundary = observationTime - 14 * 60 * 1000;
    let sequence = 0;
    const pair = (now: number, grantExpiresAt = now + RETENTION_MS): LinkedPair => {
      const id = sequence.toString(36);
      sequence += 1;
      return {
        accessTokenId: id.padStart(22, "a"),
        accessExpiresAt: now + RETENTION_MS,
        grantId: id.padStart(22, "b"),
        grantExpiresAt,
      };
    };
    const consumeManualBudget = async (now: number, count = VNU_MANUAL_ACTIVATION_LIMIT) => {
      vi.setSystemTime(now);
      for (let activation = 0; activation < count; activation += 1) {
        await expect(authority.activatePair(principal, pair(now))).resolves.toEqual({ kind: "activated" });
      }
    };
    const consumeRefreshBudget = async (now: number) => {
      vi.setSystemTime(now);
      for (let refresh = 0; refresh < VNU_REFRESH_ATTEMPT_LIMIT; refresh += 1) {
        const active = await runInDurableObject(stub, async (_instance, context) => (await context.storage.get<VnuRefreshControlState>(VNU_REFRESH_STATE_KEY))!.active!);
        await expect(authority.beginRefresh(principal, active)).resolves.toMatchObject({ kind: "accepted" });
        await expect(authority.completeRefresh(principal, { old: active, next: pair(now, active.grantExpiresAt) })).resolves.toBe("completed");
      }
    };

    await consumeManualBudget(NOW, 1);
    await consumeManualBudget(retentionBoundary + 1, VNU_MANUAL_ACTIVATION_LIMIT - 1);
    await consumeRefreshBudget(retentionBoundary + 1);
    for (let boundary = firstWindowReset; boundary <= lastFullBoundary; boundary += VNU_MANUAL_ACTIVATION_WINDOW_MS) {
      await consumeManualBudget(boundary);
      await consumeRefreshBudget(boundary);
    }
    vi.setSystemTime(observationTime);

    const bounded = await runInDurableObject(stub, async (_instance, context) => ({
      state: await context.storage.get<VnuRefreshControlState>(VNU_REFRESH_STATE_KEY),
      alarm: await context.storage.getAlarm(),
    }));
    const serializedByteLength = new TextEncoder().encode(JSON.stringify(bounded.state)).byteLength;
    expect(retainedManualGenerationBound).toBe(164);
    expect(retainedRefreshGenerationBound).toBe(165);
    expect(Object.keys(bounded.state?.revokedAccess ?? {})).toHaveLength(retainedGenerationBound - 1);
    expect(Object.keys(bounded.state?.revokedGrants ?? {})).toHaveLength(retainedGenerationBound - 1);
    expect(serializedByteLength).toBe(82_447);
    expect(serializedByteLength).toBeLessThanOrEqual(conservativeSerializedStateCeiling);
    expect(bounded.state?.activationWindow).toEqual({ count: VNU_MANUAL_ACTIVATION_LIMIT, resetAt: lastFullBoundary + VNU_MANUAL_ACTIVATION_WINDOW_MS });
    expect(bounded.state?.window).toEqual({ count: VNU_REFRESH_ATTEMPT_LIMIT, resetAt: lastFullBoundary + VNU_REFRESH_WINDOW_MS });
    expect(bounded.alarm).toBe(observationTime + 1);

    vi.setSystemTime(observationTime + 1);
    await runInDurableObject(stub, async (instance) => instance.alarm());
    const afterExtendedAccessCleanup = await runInDurableObject(stub, async (_instance, context) => ({
      state: await context.storage.get<VnuRefreshControlState>(VNU_REFRESH_STATE_KEY),
      alarm: await context.storage.getAlarm(),
    }));
    expect(Object.keys(afterExtendedAccessCleanup.state?.revokedAccess ?? {})).toHaveLength(retainedGenerationBound - 1 - (VNU_MANUAL_ACTIVATION_LIMIT - 1) - VNU_REFRESH_ATTEMPT_LIMIT);
    expect(Object.keys(afterExtendedAccessCleanup.state?.revokedGrants ?? {})).toHaveLength(retainedGenerationBound - 1 - (VNU_MANUAL_ACTIVATION_LIMIT - 1) - VNU_REFRESH_ATTEMPT_LIMIT);
    expect(afterExtendedAccessCleanup.alarm).toBe(observationTime + 60_000);

    vi.setSystemTime(observationTime + 60_000);
    await runInDurableObject(stub, async (instance) => instance.alarm());
    const afterWindowCleanup = await runInDurableObject(stub, async (_instance, context) => ({
      state: await context.storage.get<VnuRefreshControlState>(VNU_REFRESH_STATE_KEY),
      alarm: await context.storage.getAlarm(),
    }));
    expect(afterWindowCleanup.state?.activationWindow).toBeUndefined();
    expect(afterWindowCleanup.state?.window.count).toBe(0);
    expect(afterWindowCleanup.alarm).toBe(observationTime + 16 * 60_000);

    vi.setSystemTime(lastFullBoundary + RETENTION_MS);
    await runInDurableObject(stub, async (instance) => instance.alarm());
    expect(await runInDurableObject(stub, async (_instance, context) => ({
      state: await context.storage.get(VNU_REFRESH_STATE_KEY),
      alarm: await context.storage.getAlarm(),
    }))).toEqual({ state: undefined, alarm: null });
  });
});

describe("coordinator failure and privacy boundary", () => {
  it("fails closed on every relationally impossible stored state", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const principal = "bad0".repeat(16);
    const stub = env.VNU_REFRESH_CONTROL.getByName(principal);
    const states = [
      { lease: { pair: OLD, expiresAt: NOW + 1 }, revokedAccess: {}, revokedGrants: {}, window: { count: 0, resetAt: EXPIRY } },
      { active: OLD, lease: { pair: NEXT, expiresAt: NOW + 1 }, revokedAccess: {}, revokedGrants: {}, window: { count: 0, resetAt: EXPIRY } },
      { active: OLD, lease: { pair: OLD, expiresAt: OLD.grantExpiresAt + 1 }, revokedAccess: {}, revokedGrants: {}, window: { count: 0, resetAt: EXPIRY } },
      { active: OLD, revokedAccess: { [OLD.accessTokenId]: OLD.accessExpiresAt }, revokedGrants: {}, window: { count: 0, resetAt: EXPIRY } },
      { active: OLD, revokedAccess: {}, revokedGrants: { [OLD.grantId]: OLD.grantExpiresAt }, window: { count: 0, resetAt: EXPIRY } },
      { active: OLD, revokedAccess: {}, revokedGrants: {}, window: { count: 6, resetAt: EXPIRY } },
    ];
    for (const state of states) {
      const failure = await runInDurableObject(stub, async (instance, context) => {
        await context.storage.put(VNU_REFRESH_STATE_KEY, state);
        const local = coordinator({ getByName: () => instance });
        try { await local.checkAccess(principal, OLD); } catch (error) { return error; }
        return undefined;
      });
      expect(failure).toEqual(vnuRefreshUnavailable());
      expect(JSON.stringify(failure)).not.toContain("SENTINEL");
    }
  });

  it("rejects invalid rotations through coordinator without changing bytes or alarm", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const principal = "bad1".repeat(16);
    const stub = env.VNU_REFRESH_CONTROL.getByName(principal);
    const authority = coordinator();
    await authority.activatePair(principal, OLD);
    await authority.beginRefresh(principal, OLD);
    for (const next of [{ ...NEXT, accessTokenId: OLD.accessTokenId }, { ...NEXT, grantId: OLD.grantId }]) {
      const before = await snapshot(stub);
      const failure = await runInDurableObject(stub, async (instance) => {
        const local = coordinator({ getByName: () => instance });
        try { await local.completeRefresh(principal, { old: OLD, next }); } catch (error) { return error; }
        return undefined;
      });
      expect(failure).toEqual(vnuRefreshUnavailable());
      expect(await snapshot(stub)).toEqual(before);
    }
    await runInDurableObject(stub, async (_instance, context) => {
      const state = await context.storage.get<Record<string, unknown>>(VNU_REFRESH_STATE_KEY);
      await context.storage.put(VNU_REFRESH_STATE_KEY, { ...state, revokedAccess: { [NEXT.accessTokenId]: NEXT.accessExpiresAt }, revokedGrants: { [NEXT.grantId]: NEXT.grantExpiresAt } });
    });
    const before = await snapshot(stub);
    const failure = await runInDurableObject(stub, async (instance) => {
      const local = coordinator({ getByName: () => instance });
      try { await local.completeRefresh(principal, { old: OLD, next: NEXT }); } catch (error) { return error; }
      return undefined;
    });
    expect(failure).toEqual(vnuRefreshUnavailable());
    expect(await snapshot(stub)).toEqual(before);
  });
  it("isolates wrong principal and exact descriptor fields without mutation", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const principal = "3".repeat(64);
    const other = "4".repeat(64);
    const auth = coordinator();
    const stub = env.VNU_REFRESH_CONTROL.getByName(principal);
    const otherStub = env.VNU_REFRESH_CONTROL.getByName(other);
    await auth.activatePair(principal, OLD);
    const before = await snapshot(stub);
    const otherBefore = await snapshot(otherStub);
    expect(await auth.checkAccess(other, OLD)).toEqual({ kind: "revoked" });
    expect(await auth.revokePrincipalByLinkedGrant(other, OLD)).toBe("mismatch");
    expect(await auth.checkAccess(principal, OLD)).toEqual({ kind: "active" });
    for (const wrong of [{ ...OLD, accessTokenId: "X".repeat(22) }, { ...OLD, grantId: "Y".repeat(22) }, { ...OLD, accessExpiresAt: OLD.accessExpiresAt + 1 }, { ...OLD, grantExpiresAt: OLD.grantExpiresAt + 1 }]) {
      expect(await auth.revokeLinkedPairByAccess(principal, wrong)).toBe("mismatch");
    }
    expect(await snapshot(stub)).toEqual(before);
    expect(await snapshot(otherStub)).toEqual(otherBefore);
  });

  it("stores and serializes no raw credential or identity fields", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const principal = "5".repeat(64);
    const calls: unknown[] = [];
    const namespace: VnuRefreshControlNamespace = { getByName: (name) => {
      const stub = env.VNU_REFRESH_CONTROL.getByName(name);
      return {
        activatePair: (pair) => { calls.push(["activatePair", pair]); return stub.activatePair(pair); },
        checkAccess: (pair) => { calls.push(["checkAccess", pair]); return stub.checkAccess(pair); },
        beginRefresh: (pair) => { calls.push(["beginRefresh", pair]); return stub.beginRefresh(pair); },
        completeRefresh: (input) => { calls.push(["completeRefresh", input]); return stub.completeRefresh(input); },
        abortRefresh: (input) => { calls.push(["abortRefresh", input]); return stub.abortRefresh(input); },
        revokeLinkedPairByAccess: (pair) => { calls.push(["revokeLinkedPairByAccess", pair]); return stub.revokeLinkedPairByAccess(pair); },
        revokePrincipalByLinkedGrant: (pair) => { calls.push(["revokePrincipalByLinkedGrant", pair]); return stub.revokePrincipalByLinkedGrant(pair); },
        revokeExactLinkedPair: (pair) => { calls.push(["revokeExactLinkedPair", pair]); return stub.revokeExactLinkedPair(pair); },
      };
    } };
    const auth = coordinator(namespace);
    await auth.activatePair(principal, OLD);
    await auth.checkAccess(principal, OLD);
    await auth.beginRefresh(principal, OLD);
    await auth.abortRefresh(principal, { pair: OLD, terminal: false });
    await auth.beginRefresh(principal, OLD);
    await auth.completeRefresh(principal, { old: OLD, next: NEXT });
    await auth.revokeLinkedPairByAccess(principal, NEXT);
    await auth.revokeExactLinkedPair(principal, NEXT);
    const stored = await snapshot(env.VNU_REFRESH_CONTROL.getByName(principal));
    expect(JSON.stringify([calls, stored])).not.toMatch(/username|password|studentCode|cookie|raw.?token|SENTINEL_IDENTITY/i);
  });

  it.each(["malformed", "get", "transaction", "put", "deleteState", "setAlarm", "deleteAlarm", "namespace", "rpc"])("sanitizes %s failure exactly", async (failure) => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const capturedLogs: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => { capturedLogs.push(args); });
    vi.spyOn(console, "warn").mockImplementation((...args) => { capturedLogs.push(args); });
    vi.spyOn(console, "info").mockImplementation((...args) => { capturedLogs.push(args); });
    vi.spyOn(console, "log").mockImplementation((...args) => { capturedLogs.push(args); });
    vi.spyOn(console, "debug").mockImplementation((...args) => { capturedLogs.push(args); });
    const principal = "6".repeat(64);
    const stub = env.VNU_REFRESH_CONTROL.getByName(principal);
    let caught: unknown;
    if (["malformed", "get", "transaction", "put", "deleteState", "setAlarm", "deleteAlarm"].includes(failure)) {
      caught = await runInDurableObject(stub, async (raw, context) => {
        const instance = raw as VnuRefreshControlDurableObject;
        if (failure === "malformed") await context.storage.put(VNU_REFRESH_STATE_KEY, { sentinel: "SENTINEL_STATE" });
        const deleteTarget = { ...OLD, accessExpiresAt: NOW, grantExpiresAt: NOW };
        if (failure === "deleteState") await context.storage.put(VNU_REFRESH_STATE_KEY, { active: deleteTarget, revokedAccess: {}, revokedGrants: {}, window: { count: 0, resetAt: NOW + VNU_REFRESH_WINDOW_MS } });
        const real = instance.storage;
        if (failure !== "malformed") instance.storage = {
          get: failure === "get" ? async () => { throw new Error("SENTINEL_GET"); } : () => real.get(),
          transaction: async (body) => {
            if (failure === "transaction") throw new Error("SENTINEL_TRANSACTION");
            return real.transaction((stored, put, deleteState, setAlarm) => body(
              stored,
              failure === "put" ? async () => { throw new Error("SENTINEL_PUT"); } : put,
              failure === "deleteState" ? async () => { throw new Error("SENTINEL_DELETE_STATE"); } : deleteState,
              failure === "setAlarm" ? async () => { throw new Error("SENTINEL_SET_ALARM"); }
                : failure === "deleteAlarm" ? async () => { await setAlarm(undefined); throw new Error("SENTINEL_DELETE_ALARM"); }
                  : setAlarm,
            ));
          },
        };
        const local = coordinator({ getByName: () => instance });
        try {
          if (failure === "get" || failure === "malformed") await local.checkAccess(principal, OLD);
          else if (failure === "deleteState") await local.checkAccess(principal, deleteTarget);
          else await local.activatePair(principal, OLD);
        } catch (error) { return error; }
        return undefined;
      });
    } else {
      const namespace: VnuRefreshControlNamespace = failure === "namespace"
        ? { getByName() { throw new Error("SENTINEL_NAMESPACE"); } }
        : { getByName() { return { activatePair: async () => { throw new Error("SENTINEL_RPC"); } } as never; } };
      try { await coordinator(namespace).activatePair(principal, OLD); } catch (error) { caught = error; }
    }
    expect(caught).toEqual(vnuRefreshUnavailable());
    expect(JSON.stringify({ message: (caught as Error).message, details: (caught as { details?: unknown }).details })).not.toContain("SENTINEL");
    expect(JSON.stringify(capturedLogs)).not.toContain("SENTINEL");
  });
});
