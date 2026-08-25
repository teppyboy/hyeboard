import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { emptyPolicy } from "../../feature-policy";
import { FeaturePolicyRuntime, InProcessFeaturePolicyEvents, type PublishFeaturePolicyInput } from "../../feature-policy-store";
import { openSqliteFeaturePolicyStore, type SqliteFeaturePolicyStore } from "./feature-policy-store";

const actor = { method: "password" as const, subject: "password-admin" };
const directories: string[] = [];
const stores: SqliteFeaturePolicyStore[] = [];

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hyeboard-feature-policy-"));
  directories.push(directory);
  return join(directory, "policy.sqlite");
}

async function open(path: string): Promise<SqliteFeaturePolicyStore> {
  const store = await openSqliteFeaturePolicyStore(path);
  stores.push(store);
  return store;
}

function publication(baseRevision: number, reason = `Publish ${baseRevision + 1}`): PublishFeaturePolicyInput {
  return { baseRevision, policy: emptyPolicy(), reason, actor };
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("SqliteFeaturePolicyStore", () => {
  it("bootstraps revision zero and persists current plus append-only history across reopen", async () => {
    const path = await databasePath();
    const first = await open(path);
    expect(await first.current()).toEqual({ ...emptyPolicy(), revision: 0 });
    await first.publish(publication(0));
    await first.close();
    stores.splice(stores.indexOf(first), 1);

    const reopened = await open(path);
    expect((await reopened.current()).revision).toBe(1);
    expect((await reopened.history({ limit: 10 })).items.map(({ revision }) => revision)).toEqual([1]);
  });

  it("uses atomic CAS across connections and never overwrites a stale publication", async () => {
    const path = await databasePath();
    const first = await open(path);
    const second = await open(path);
    const results = await Promise.allSettled([
      first.publish(publication(0, "First")),
      second.publish(publication(0, "Second")),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.find(({ status }) => status === "rejected")).toMatchObject({
      status: "rejected",
      reason: { code: "ADMIN_POLICY_CONFLICT", status: 409, details: { currentRevision: 1 } },
    });
    expect((await first.history({ limit: 10 })).items).toHaveLength(1);
  });

  it("returns bounded newest-first keyset pages", async () => {
    const store = await open(await databasePath());
    for (let revision = 0; revision < 3; revision += 1) await store.publish(publication(revision));

    const first = await store.history({ limit: 2 });
    expect(first.items.map(({ revision }) => revision)).toEqual([3, 2]);
    expect(first.nextBeforeRevision).toBe(2);
    expect((await store.history({ beforeRevision: 2, limit: 200 })).items.map(({ revision }) => revision)).toEqual([1]);
  });

  it("rejects malformed current and history JSON rows", async () => {
    const path = await databasePath();
    const store = await open(path);
    await store.publish(publication(0));
    await store.close();
    stores.splice(stores.indexOf(store), 1);

    const database = new DatabaseSync(path);
    database.prepare("UPDATE feature_policy_history SET actor_json = ? WHERE revision = 1").run("not-json");
    expect(() => database.prepare("SELECT actor_json FROM feature_policy_history").get()).not.toThrow();
    database.close();

    const malformedHistory = await open(path);
    await expect(malformedHistory.history({ limit: 1 })).rejects.toBeTruthy();
    await malformedHistory.close();
    stores.splice(stores.indexOf(malformedHistory), 1);

    const currentDatabase = new DatabaseSync(path);
    currentDatabase.prepare("UPDATE feature_policy_current SET snapshot_json = ? WHERE singleton = 1").run("{}");
    currentDatabase.close();
    await expect((await open(path)).current()).rejects.toBeTruthy();
  });

  it("rolls back history when the current-row update fails after insertion", async () => {
    const path = await databasePath();
    const store = await open(path);
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TRIGGER reject_policy_current_update
      BEFORE UPDATE ON feature_policy_current
      BEGIN SELECT RAISE(ABORT, 'forced failure'); END;
    `);

    await expect(store.publish(publication(0))).rejects.toThrow("forced failure");
    expect((await store.current()).revision).toBe(0);
    expect((await store.history({ limit: 10 })).items).toEqual([]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM feature_policy_history").get()).toMatchObject({ count: 0 });
    database.exec("DROP TRIGGER reject_policy_current_update");
    database.close();
    await expect(store.publish(publication(0))).resolves.toMatchObject({ revision: 1 });
  });

  it("rejects relationally inconsistent history rows", async () => {
    const path = await databasePath();
    const store = await open(path);
    await store.publish(publication(0));
    await store.close();
    stores.splice(stores.indexOf(store), 1);

    const database = new DatabaseSync(path);
    const snapshot = JSON.stringify({ ...emptyPolicy(), revision: 9 });
    database.prepare("UPDATE feature_policy_history SET snapshot_json = ? WHERE revision = 1").run(snapshot);
    database.close();

    const reopened = await open(path);
    await expect(reopened.history({ limit: 10 })).rejects.toThrow("Invalid SQLite feature policy history row");
    await expect(reopened.revision(1)).rejects.toThrow("Invalid SQLite feature policy history row");
  });

  it("keeps rollback append-only by publishing the target as a new revision", async () => {
    const store = await open(await databasePath());
    const runtime = new FeaturePolicyRuntime(store, new InProcessFeaturePolicyEvents());
    const disabled = publication(0, "Disable grades");
    disabled.policy.global.capabilities.grades = { enabled: false };
    await runtime.publish(disabled);
    await runtime.publish(publication(1, "Restore grades"));

    const rolledBack = await runtime.rollback({
      baseRevision: 2,
      targetRevision: 1,
      reason: "Rollback incident",
      actor,
    });
    expect(rolledBack).toMatchObject({ revision: 3, baseRevision: 2 });
    expect(rolledBack.snapshot.global.capabilities.grades?.enabled).toBe(false);
    expect((await store.revision(1))?.snapshot.revision).toBe(1);
  });
});
