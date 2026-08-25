import { featurePolicyStreamLimited, MAX_FEATURE_POLICY_SSE_SUBSCRIBERS, type FeaturePolicyEvents } from "../../feature-policy-store";
import type { RedisPublishClient, RedisSubscribeClient } from "./client";

export const FEATURE_POLICY_REVISION_CHANNEL = "hyeboard:v1:feature-policy:revision";
const HEARTBEAT_MS = 15_000;
const encoder = new TextEncoder();

export class RedisFeaturePolicyEvents implements FeaturePolicyEvents {
  private readonly listeners = new Set<(revision: number) => void>();
  private readonly closeStreams = new Set<() => void>();
  private highestRevision = -1;
  private activeStreams = 0;
  private started = false;
  private closed = false;

  constructor(
    private readonly publisher: RedisPublishClient,
    private readonly subscriber: RedisSubscribeClient,
  ) {}

  async start(): Promise<void> {
    if (this.closed) throw new Error("Redis feature policy events are closed");
    if (this.started) return;
    await this.subscriber.subscribe(FEATURE_POLICY_REVISION_CHANNEL, this.receive);
    this.started = true;
  }

  async publish(revision: number): Promise<void> {
    if (!isRevision(revision)) return;
    try {
      await this.publisher.publish(FEATURE_POLICY_REVISION_CHANNEL, String(revision));
    } finally {
      this.notify(revision);
    }
  }

  subscribe(listener: (revision: number) => void): () => void {
    if (this.closed) return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async stream(lastRevision: number | undefined, signal: AbortSignal, currentRevision = this.highestRevision): Promise<Response> {
    if (this.activeStreams >= MAX_FEATURE_POLICY_SSE_SUBSCRIBERS) throw featurePolicyStreamLimited();
    this.activeStreams += 1;
    currentRevision = Math.max(currentRevision, this.highestRevision);
    let seen = isRevision(lastRevision) ? lastRevision : -1;
    let unsubscribe = () => {};
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let abort = () => {};
    let cleanup = () => {};
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
            if (heartbeat !== undefined) clearInterval(heartbeat);
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
            controller.enqueue(encode(`event: revision\ndata: ${revision}\n\n`));
          });
          if (isRevision(currentRevision) && currentRevision > seen) {
            seen = currentRevision;
            controller.enqueue(encode(`event: revision\ndata: ${currentRevision}\n\n`));
          }
          heartbeat = setInterval(() => {
            try {
              if (open) controller.enqueue(encode(": heartbeat\n\n"));
            } catch {
              close();
            }
          }, HEARTBEAT_MS);
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
    if (this.closed) return;
    this.closed = true;
    for (const close of [...this.closeStreams]) close();
    this.listeners.clear();
    if (this.started) await this.subscriber.unsubscribe(FEATURE_POLICY_REVISION_CHANNEL);
    this.started = false;
  }

  private readonly receive = (message: string): void => {
    const revision = parseRevision(message);
    if (revision !== undefined) this.notify(revision);
  };

  private notify(revision: number): void {
    if (revision <= this.highestRevision || this.closed) return;
    this.highestRevision = revision;
    for (const listener of [...this.listeners]) {
      try {
        listener(revision);
      } catch {
        // One broken local SSE consumer must not block cache invalidation or peers.
      }
    }
  }
}

function parseRevision(message: string): number | undefined {
  if (!/^(0|[1-9]\d*)$/.test(message)) return undefined;
  const revision = Number(message);
  return isRevision(revision) && String(revision) === message ? revision : undefined;
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function encode(value: string): Uint8Array {
  return encoder.encode(value);
}
