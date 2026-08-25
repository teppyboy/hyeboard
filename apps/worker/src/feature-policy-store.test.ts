import { featurePolicyAuditEntrySchema, featurePolicySnapshotSchema, type FeaturePolicySnapshot } from "@hyeboard/schemas";
import { describe, expect, it } from "vitest";
import { emptyPolicy } from "./feature-policy";
import {
  FeaturePolicyRuntime,
  InProcessFeaturePolicyEvents,
  MAX_FEATURE_POLICY_SSE_SUBSCRIBERS,
  MemoryFeaturePolicyStore,
  type FeaturePolicyEvents,
  type FeaturePolicyStore,
  type PublishFeaturePolicyInput,
} from "./feature-policy-store";

const actor = { method: "password" as const, subject: "password-admin" };

function publication(baseRevision: number, reason = `Publish ${baseRevision + 1}`): PublishFeaturePolicyInput {
  return { baseRevision, policy: emptyPolicy(), reason, actor };
}

export function featurePolicyStoreContract(
  name: string,
  create: () => Promise<FeaturePolicyStore>,
): void {
  describe(name, () => {
    it("bootstraps revision zero and atomically publishes revision one", async () => {
      const store = await create();
      expect(await store.current()).toEqual({ ...emptyPolicy(), revision: 0 });
      const entry = await store.publish(publication(0, "  Publish 1  "));
      expect(entry).toMatchObject({ revision: 1, baseRevision: 0, actor, reason: "Publish 1" });
      expect((await store.history({ limit: 10 })).items).toEqual([entry]);
    });

    it("clones and parses values at every boundary", async () => {
      const store = await create();
      const malformed = publication(0);
      malformed.policy.global.capabilities = { secret: { enabled: true } } as never;
      await expect(store.publish(malformed)).rejects.toBeTruthy();
      expect(await store.current()).toEqual({ ...emptyPolicy(), revision: 0 });
      expect((await store.history({ limit: 1 })).items).toEqual([]);

      const input = publication(0);
      input.policy.global.capabilities.grades = { enabled: false };
      const entry = await store.publish(input);
      input.policy.global.capabilities.grades.enabled = true;
      entry.snapshot.global.capabilities.grades!.enabled = true;

      const current = await store.current();
      expect(current.global.capabilities.grades?.enabled).toBe(false);
      current.global.capabilities.grades!.enabled = true;
      const history = await store.history({ limit: 1 });
      history.items[0]!.snapshot.global.capabilities.grades!.enabled = true;
      expect(featurePolicySnapshotSchema.parse(await store.current()).global.capabilities.grades?.enabled).toBe(false);
      expect(featurePolicyAuditEntrySchema.parse(await store.revision(1)).snapshot.global.capabilities.grades?.enabled).toBe(false);
    });

    it("serializes CAS publication and rejects a stale revision without overwriting", async () => {
      const store = await create();
      const results = await Promise.allSettled([
        store.publish(publication(0, "First")),
        store.publish(publication(0, "Second")),
      ]);
      expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      const rejected = results.find(({ status }) => status === "rejected");
      expect(rejected).toMatchObject({
        status: "rejected",
        reason: { code: "ADMIN_POLICY_CONFLICT", status: 409, details: { currentRevision: 1 } },
      });
      expect((await store.current()).revision).toBe(1);
      expect((await store.history({ limit: 10 })).items).toHaveLength(1);
    });

    it("returns bounded newest-first history pages", async () => {
      const store = await create();
      await store.publish(publication(0));
      await store.publish(publication(1));
      await store.publish(publication(2));

      const first = await store.history({ limit: 2 });
      expect(first.items.map(({ revision }) => revision)).toEqual([3, 2]);
      expect(first.nextBeforeRevision).toBe(2);
      const second = await store.history({ beforeRevision: first.nextBeforeRevision, limit: 200 });
      expect(second.items.map(({ revision }) => revision)).toEqual([1]);
      expect(second.nextBeforeRevision).toBeUndefined();

      for (let baseRevision = 3; baseRevision < 104; baseRevision += 1) {
        await store.publish(publication(baseRevision));
      }
      expect((await store.history({ limit: 200 })).items).toHaveLength(100);
    });
  });
}

featurePolicyStoreContract("MemoryFeaturePolicyStore", async () => new MemoryFeaturePolicyStore());

describe("FeaturePolicyRuntime", () => {
  it("reads durable authority every request, then uses only last-known-good during outage", async () => {
    const memory = new MemoryFeaturePolicyStore();
    let unavailable = false;
    let reads = 0;
    const store: FeaturePolicyStore = {
      ...memory,
      current: async () => {
        reads += 1;
        if (unavailable) throw new Error("store unavailable");
        return memory.current();
      },
      publish: (input) => memory.publish(input),
      history: (input) => memory.history(input),
      revision: (revision) => memory.revision(revision),
    };
    const runtime = new FeaturePolicyRuntime(store, new InProcessFeaturePolicyEvents());

    expect((await runtime.current()).revision).toBe(0);
    expect((await runtime.current()).revision).toBe(0);
    unavailable = true;
    expect((await runtime.current()).revision).toBe(0);
    await expect(runtime.currentAuthoritative()).rejects.toMatchObject({ code: "FEATURE_POLICY_UNAVAILABLE", status: 503 });
    expect(reads).toBe(4);
  });

  it("does not restore a stale read after a newer invalidation", async () => {
    const oldSnapshot = { ...emptyPolicy(), revision: 0 };
    let resolveRead!: (snapshot: FeaturePolicySnapshot) => void;
    const deferredRead = new Promise<FeaturePolicySnapshot>((resolve) => { resolveRead = resolve; });
    let reads = 0;
    const store: FeaturePolicyStore = {
      ...failingStore(),
      current: async () => {
        reads += 1;
        if (reads === 1) return oldSnapshot;
        if (reads === 2) return deferredRead;
        throw new Error("store unavailable");
      },
    };
    const events = new InProcessFeaturePolicyEvents();
    const runtime = new FeaturePolicyRuntime(store, events);

    await runtime.current();
    const pendingRead = runtime.current();
    await events.publish(1);
    resolveRead(oldSnapshot);
    await expect(pendingRead).resolves.toMatchObject({ revision: 0 });
    await expect(runtime.current()).rejects.toMatchObject({ code: "FEATURE_POLICY_UNAVAILABLE", status: 503 });
  });

  it("fails closed when a cold runtime cannot read valid durable authority", async () => {
    const store = failingStore();
    const runtime = new FeaturePolicyRuntime(store, new InProcessFeaturePolicyEvents());
    await expect(runtime.current()).rejects.toMatchObject({ code: "FEATURE_POLICY_UNAVAILABLE", status: 503 });

    const malformed: FeaturePolicyStore = { ...store, current: async () => ({ revision: 0 } as FeaturePolicySnapshot) };
    await expect(new FeaturePolicyRuntime(malformed, new InProcessFeaturePolicyEvents()).current())
      .rejects.toMatchObject({ code: "FEATURE_POLICY_UNAVAILABLE", status: 503 });
  });

  it("maps durable publication and rollback outages to the safe typed 503", async () => {
    const runtime = new FeaturePolicyRuntime(failingStore(), new InProcessFeaturePolicyEvents());
    await expect(runtime.publish(publication(0))).rejects.toMatchObject({ code: "FEATURE_POLICY_UNAVAILABLE", status: 503 });
    await expect(runtime.rollback({ baseRevision: 1, targetRevision: 1, reason: "Rollback", actor }))
      .rejects.toMatchObject({ code: "FEATURE_POLICY_UNAVAILABLE", status: 503 });
  });

  it("validates before durable publication", async () => {
    let writes = 0;
    const memory = new MemoryFeaturePolicyStore();
    const store: FeaturePolicyStore = {
      current: () => memory.current(),
      publish: async (input) => {
        writes += 1;
        return memory.publish(input);
      },
      history: (input) => memory.history(input),
      revision: (revision) => memory.revision(revision),
    };
    const runtime = new FeaturePolicyRuntime(store, new InProcessFeaturePolicyEvents());
    const invalid = publication(0) as PublishFeaturePolicyInput & { extra?: boolean };
    invalid.extra = true;
    invalid.policy.global.capabilities = { secret: { enabled: true } } as never;

    await expect(runtime.publish(invalid)).rejects.toBeTruthy();
    expect(writes).toBe(0);
  });

  it("rejects malformed durable publication output before caching or notification", async () => {
    let notifications = 0;
    const store: FeaturePolicyStore = {
      ...failingStore(),
      publish: async () => ({ revision: 1 } as never),
    };
    const events = new InProcessFeaturePolicyEvents();
    events.subscribe(() => { notifications += 1; });
    const runtime = new FeaturePolicyRuntime(store, events);

    await expect(runtime.publish(publication(0))).rejects.toBeTruthy();
    expect(notifications).toBe(0);
  });

  it("keeps successful publication when notification fails", async () => {
    const store = new MemoryFeaturePolicyStore();
    const events: FeaturePolicyEvents = {
      publish: async () => { throw new Error("events unavailable"); },
      subscribe: () => () => {},
      stream: async () => new Response(),
    };
    const runtime = new FeaturePolicyRuntime(store, events);

    await expect(runtime.publish(publication(0))).resolves.toMatchObject({ revision: 1 });
    expect((await store.current()).revision).toBe(1);
  });

  it("rolls an earlier snapshot forward as a new immutable revision", async () => {
    const store = new MemoryFeaturePolicyStore();
    const runtime = new FeaturePolicyRuntime(store, new InProcessFeaturePolicyEvents());
    const first = publication(0, "Disable grades");
    first.policy.global.capabilities.grades = { enabled: false };
    await runtime.publish(first);
    await runtime.publish(publication(1, "Restore grades"));

    const rollback = await runtime.rollback({
      baseRevision: 2,
      targetRevision: 1,
      reason: "Rollback incident",
      actor,
    });
    expect(rollback).toMatchObject({ revision: 3, baseRevision: 2, reason: "Rollback incident" });
    expect(rollback.snapshot.global.capabilities.grades?.enabled).toBe(false);
    expect((await store.revision(1))?.snapshot.revision).toBe(1);
    expect((await store.history({ limit: 10 })).items.map(({ revision }) => revision)).toEqual([3, 2, 1]);
  });
});

describe("InProcessFeaturePolicyEvents", () => {
  it("caps streams and reuses a slot after cancellation", async () => {
    const events = new InProcessFeaturePolicyEvents();
    const streams = await Promise.all(Array.from(
      { length: MAX_FEATURE_POLICY_SSE_SUBSCRIBERS },
      () => events.stream(undefined, new AbortController().signal),
    ));

    await expect(events.stream(undefined, new AbortController().signal)).rejects.toMatchObject({
      code: "FEATURE_POLICY_STREAM_LIMITED",
      status: 503,
    });
    await streams[0]!.body!.cancel();
    const reused = await events.stream(undefined, new AbortController().signal);
    expect(reused.status).toBe(200);
    await reused.body!.cancel();
    await events.close();
  });

  it("reconciles the current revision on reconnect without duplicating an already-seen revision", async () => {
    const events = new InProcessFeaturePolicyEvents();

    const missed = await events.stream(1, new AbortController().signal, 2);
    const missedReader = missed.body!.getReader();
    expect(new TextDecoder().decode((await missedReader.read()).value)).toBe("event: revision\ndata: 2\n\n");
    await missedReader.cancel();

    const current = await events.stream(2, new AbortController().signal, 2);
    const reader = current.body!.getReader();
    const pending = reader.read();
    await events.publish(2);
    await events.publish(3);
    expect(new TextDecoder().decode((await pending).value)).toBe("event: revision\ndata: 3\n\n");
    await reader.cancel();
  });

  it("publishes and streams revision IDs only", async () => {
    const events = new InProcessFeaturePolicyEvents();
    const received: number[] = [];
    const unsubscribe = events.subscribe((revision) => received.push(revision));
    const controller = new AbortController();
    await events.publish(1);
    const response = await events.stream(1, controller.signal);
    const reader = response.body!.getReader();

    await events.publish(1);
    await events.publish(2);
    expect(received).toEqual([1, 1, 2]);
    const chunk = await reader.read();
    expect(new TextDecoder().decode(chunk.value)).toBe("event: revision\ndata: 2\n\n");
    expect(new TextDecoder().decode(chunk.value)).not.toContain("policy");
    controller.abort();
    unsubscribe();
  });
});

function failingStore(): FeaturePolicyStore {
  const unavailable = async (): Promise<never> => { throw new Error("store unavailable"); };
  return {
    current: unavailable,
    publish: unavailable,
    history: unavailable,
    revision: unavailable,
  };
}
