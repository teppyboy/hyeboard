import { getLogger, HyeboardError } from "@hyeboard/core";
import { listUniversities } from "@hyeboard/university-adapters";
import {
  adminActorSchema,
  featurePolicyAuditEntrySchema,
  featurePolicySnapshotSchema,
  publishFeaturePolicySchema,
  rollbackFeaturePolicySchema,
  type AdminActor,
  type FeaturePolicyAuditEntry,
  type FeaturePolicySnapshot,
  type PublishFeaturePolicyInput as PolicyInput,
} from "@hyeboard/schemas";
import { emptyPolicy, validatePolicy } from "./feature-policy";

const MAX_HISTORY_LIMIT = 100;
export const MAX_FEATURE_POLICY_SSE_SUBSCRIBERS = 256;
const storePublicationSchema = publishFeaturePolicySchema.extend({ actor: adminActorSchema });
const storeRollbackSchema = rollbackFeaturePolicySchema.extend({ actor: adminActorSchema });

export type PublishFeaturePolicyInput = PolicyInput & { actor: AdminActor };
export type RollbackFeaturePolicyInput = {
  baseRevision: number;
  targetRevision: number;
  reason: string;
  actor: AdminActor;
};
export type HistoryInput = { beforeRevision?: number; limit: number };
export type HistoryPage = { items: FeaturePolicyAuditEntry[]; nextBeforeRevision?: number };

export interface FeaturePolicyStore {
  current(): Promise<FeaturePolicySnapshot>;
  publish(input: PublishFeaturePolicyInput): Promise<FeaturePolicyAuditEntry>;
  history(input: HistoryInput): Promise<HistoryPage>;
  revision(revision: number): Promise<FeaturePolicyAuditEntry | undefined>;
  consumeAdminLoginAttempt?(bucketHash: string, limit: number, windowMs: number): Promise<{ allowed: boolean; retryAfterSeconds?: number }>;
  close?(): Promise<void>;
}

export interface FeaturePolicyEvents {
  publish(revision: number): Promise<void>;
  subscribe(listener: (revision: number) => void): () => void;
  stream(lastRevision: number | undefined, signal: AbortSignal, currentRevision?: number): Promise<Response>;
  close?(): Promise<void>;
}

/** Test-only authority. Production startup must inject a durable store. */
export class MemoryFeaturePolicyStore implements FeaturePolicyStore {
  private snapshot = featurePolicySnapshotSchema.parse({ ...emptyPolicy(), revision: 0 });
  private entries: FeaturePolicyAuditEntry[] = [];
  private queue: Promise<void> = Promise.resolve();

  async current(): Promise<FeaturePolicySnapshot> {
    return cloneSnapshot(this.snapshot);
  }

  publish(input: PublishFeaturePolicyInput): Promise<FeaturePolicyAuditEntry> {
    return this.serialized(async () => {
      const parsed = parsePublication(input);
      if (parsed.baseRevision !== this.snapshot.revision) {
        throw new HyeboardError(
          "ADMIN_POLICY_CONFLICT",
          "Feature policy changed before publication.",
          409,
          { currentRevision: this.snapshot.revision },
        );
      }

      const revision = this.snapshot.revision + 1;
      const entry = featurePolicyAuditEntrySchema.parse({
        revision,
        baseRevision: parsed.baseRevision,
        actor: parsed.actor,
        reason: parsed.reason,
        publishedAt: new Date().toISOString(),
        snapshot: { ...parsed.policy, revision },
      });
      this.snapshot = cloneSnapshot(entry.snapshot);
      this.entries.unshift(cloneEntry(entry));
      return cloneEntry(entry);
    });
  }

  async history(input: HistoryInput): Promise<HistoryPage> {
    const { beforeRevision, limit } = parseHistoryInput(input);
    const eligible = beforeRevision === undefined
      ? this.entries
      : this.entries.filter(({ revision }) => revision < beforeRevision);
    const items = eligible.slice(0, limit).map(cloneEntry);
    return {
      items,
      ...(eligible.length > items.length && items.length > 0
        ? { nextBeforeRevision: items.at(-1)!.revision }
        : {}),
    };
  }

  async revision(revision: number): Promise<FeaturePolicyAuditEntry | undefined> {
    if (!Number.isSafeInteger(revision) || revision <= 0) return undefined;
    const entry = this.entries.find((candidate) => candidate.revision === revision);
    return entry && cloneEntry(entry);
  }

  private serialized<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action, action);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

/** Test-only/in-process propagation. Distributed startup must inject shared events. */
export class InProcessFeaturePolicyEvents implements FeaturePolicyEvents {
  private readonly listeners = new Set<(revision: number) => void>();
  private readonly closeStreams = new Set<() => void>();
  private highestRevision = -1;
  private activeStreams = 0;

  async publish(revision: number): Promise<void> {
    if (!isRevision(revision)) return;
    this.highestRevision = Math.max(this.highestRevision, revision);
    let failure: unknown;
    for (const listener of this.listeners) {
      try {
        listener(revision);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  }

  subscribe(listener: (revision: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async stream(lastRevision: number | undefined, signal: AbortSignal, currentRevision = this.highestRevision): Promise<Response> {
    if (this.activeStreams >= MAX_FEATURE_POLICY_SSE_SUBSCRIBERS) throw featurePolicyStreamLimited();
    this.activeStreams += 1;
    currentRevision = Math.max(currentRevision, this.highestRevision);
    let seen = isRevision(lastRevision) ? lastRevision : -1;
    let unsubscribe = () => {};
    let cleanup = () => {};
    let abort = () => {};
    let close = () => {};
    try {
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          let open = true;
          cleanup = () => {
            if (!open) return;
            open = false;
            this.activeStreams -= 1;
            unsubscribe();
            this.closeStreams.delete(close);
            signal.removeEventListener("abort", abort);
          };
          close = () => {
            if (!open) return;
            cleanup();
            controller.close();
          };
          abort = close;
          unsubscribe = this.subscribe((revision) => {
            if (!open || revision <= seen) return;
            seen = revision;
            try {
              controller.enqueue(new TextEncoder().encode(`event: revision\ndata: ${revision}\n\n`));
            } catch {
              close();
            }
          });
          if (isRevision(currentRevision) && currentRevision > seen) {
            seen = currentRevision;
            controller.enqueue(new TextEncoder().encode(`event: revision\ndata: ${currentRevision}\n\n`));
          }
          this.closeStreams.add(close);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        },
        cancel: () => cleanup(),
      });
      return new Response(stream, {
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "text/event-stream",
        },
      });
    } catch (error) {
      this.activeStreams -= 1;
      throw error;
    }
  }

  async close(): Promise<void> {
    for (const close of [...this.closeStreams]) close();
    this.listeners.clear();
  }
}

export class FeaturePolicyRuntime {
  private cached?: FeaturePolicySnapshot;
  private highestNotifiedRevision = 0;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly store: FeaturePolicyStore,
    private readonly events: FeaturePolicyEvents,
  ) {
    this.unsubscribe = events.subscribe((revision) => this.invalidate(revision));
  }

  async current(): Promise<FeaturePolicySnapshot> {
    try {
      return await this.readCurrent();
    } catch {
      if (this.cached) return cloneSnapshot(this.cached);
      throw featurePolicyUnavailable();
    }
  }

  async currentAuthoritative(): Promise<FeaturePolicySnapshot> {
    try {
      return await this.readCurrent();
    } catch {
      throw featurePolicyUnavailable();
    }
  }

  invalidate(revision: number): void {
    if (!isRevision(revision)) return;
    this.highestNotifiedRevision = Math.max(this.highestNotifiedRevision, revision);
    if (this.cached && revision > this.cached.revision) this.cached = undefined;
  }

  async publish(input: PublishFeaturePolicyInput): Promise<FeaturePolicyAuditEntry> {
    const policy = validatePolicy(input.policy, listUniversities(), {});
    const parsed = parsePublication({ ...input, policy });
    let entry: FeaturePolicyAuditEntry;
    try {
      entry = cloneEntry(await this.store.publish(parsed));
    } catch (error) {
      if (error instanceof HyeboardError) throw error;
      throw featurePolicyUnavailable();
    }
    if (entry.revision >= this.highestNotifiedRevision) this.cached = cloneSnapshot(entry.snapshot);
    try {
      await this.events.publish(entry.revision);
    } catch {
      getLogger().warn({ revision: entry.revision }, "feature policy publication notification failed");
    }
    return cloneEntry(entry);
  }

  async rollback(input: RollbackFeaturePolicyInput): Promise<FeaturePolicyAuditEntry> {
    const parsed = storeRollbackSchema.parse(input);
    let storedTarget: FeaturePolicyAuditEntry | undefined;
    try {
      storedTarget = await this.store.revision(parsed.targetRevision);
    } catch (error) {
      if (error instanceof HyeboardError) throw error;
      throw featurePolicyUnavailable();
    }
    if (!storedTarget) {
      throw new HyeboardError("ADMIN_POLICY_REVISION_NOT_FOUND", "Feature policy revision was not found.", 404);
    }
    const target = cloneEntry(storedTarget);
    const { revision: _, ...policy } = validateSnapshot(target.snapshot);
    return this.publish({ baseRevision: parsed.baseRevision, policy, reason: parsed.reason, actor: parsed.actor });
  }

  async history(input: HistoryInput): Promise<HistoryPage> {
    try {
      return await this.store.history(input);
    } catch (error) {
      if (error instanceof HyeboardError) throw error;
      throw featurePolicyUnavailable();
    }
  }

  async revision(revision: number): Promise<FeaturePolicyAuditEntry | undefined> {
    try {
      return await this.store.revision(revision);
    } catch (error) {
      if (error instanceof HyeboardError) throw error;
      throw featurePolicyUnavailable();
    }
  }

  consumeAdminLoginAttempt(bucketHash: string, limit: number, windowMs: number): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
    if (!this.store.consumeAdminLoginAttempt) throw new HyeboardError("HA_DEPENDENCY_UNAVAILABLE", "Admin login limiter is unavailable.", 503);
    return this.store.consumeAdminLoginAttempt(bucketHash, limit, windowMs);
  }

  async stream(lastRevision: number | undefined, signal: AbortSignal): Promise<Response> {
    const current = await this.currentAuthoritative();
    return this.events.stream(lastRevision, signal, current.revision);
  }

  async close(): Promise<void> {
    this.unsubscribe();
    await Promise.all([this.store.close?.(), this.events.close?.()]);
  }

  private async readCurrent(): Promise<FeaturePolicySnapshot> {
    const snapshot = validateSnapshot(await this.store.current());
    if (snapshot.revision >= this.highestNotifiedRevision) this.cached = snapshot;
    return cloneSnapshot(snapshot);
  }
}

export function featurePolicyStreamLimited(): HyeboardError {
  return new HyeboardError("FEATURE_POLICY_STREAM_LIMITED", "Too many feature policy event streams.", 503);
}

function featurePolicyUnavailable(): HyeboardError {
  return new HyeboardError("FEATURE_POLICY_UNAVAILABLE", "Feature policy is unavailable.", 503);
}

function parsePublication(input: PublishFeaturePolicyInput): PublishFeaturePolicyInput {
  return storePublicationSchema.parse(input);
}

function parseHistoryInput(input: HistoryInput): { beforeRevision?: number; limit: number } {
  if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
    throw new HyeboardError("ADMIN_POLICY_INVALID", "Feature policy history request is invalid.", 400);
  }
  if (input.beforeRevision !== undefined && (!isRevision(input.beforeRevision) || input.beforeRevision === 0)) {
    throw new HyeboardError("ADMIN_POLICY_INVALID", "Feature policy history request is invalid.", 400);
  }
  return { ...input, limit: Math.min(input.limit, MAX_HISTORY_LIMIT) };
}

function validateSnapshot(snapshot: FeaturePolicySnapshot): FeaturePolicySnapshot {
  const parsed = cloneSnapshot(snapshot);
  const { revision, ...policy } = parsed;
  return cloneSnapshot({ ...validatePolicy(policy, listUniversities(), {}), revision });
}

function cloneSnapshot(snapshot: FeaturePolicySnapshot): FeaturePolicySnapshot {
  return featurePolicySnapshotSchema.parse(structuredClone(snapshot));
}

function cloneEntry(entry: FeaturePolicyAuditEntry): FeaturePolicyAuditEntry {
  return featurePolicyAuditEntrySchema.parse(structuredClone(entry));
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
