import {
  featurePolicyStreamLimited,
  type FeaturePolicyEvents,
  type FeaturePolicyStore,
  type HistoryInput,
  type HistoryPage,
  type PublishFeaturePolicyInput,
} from "./feature-policy-store";
import type {
  AdminLoginAttemptResult,
  FeaturePolicyDurableObject,
} from "./feature-policy-durable-object";
import type { FeaturePolicyAuditEntry, FeaturePolicySnapshot } from "@hyeboard/schemas";

type FeaturePolicyStub = DurableObjectStub<FeaturePolicyDurableObject>;

class DurableObjectFeaturePolicyBinding {
  constructor(protected readonly namespace: Env["FEATURE_POLICY"]) {}

  protected stub(): FeaturePolicyStub {
    return this.namespace.get(this.namespace.idFromName("global"));
  }
}

export class DurableObjectFeaturePolicyStore extends DurableObjectFeaturePolicyBinding implements FeaturePolicyStore {
  current(): Promise<FeaturePolicySnapshot> {
    return Promise.resolve(this.stub().current());
  }

  publish(input: PublishFeaturePolicyInput): Promise<FeaturePolicyAuditEntry> {
    return Promise.resolve(this.stub().publish(input));
  }

  history(input: HistoryInput): Promise<HistoryPage> {
    return Promise.resolve(this.stub().history(input));
  }

  revision(revision: number): Promise<FeaturePolicyAuditEntry | undefined> {
    return Promise.resolve(this.stub().revision(revision));
  }

  consumeAdminLoginAttempt(bucketHash: string, limit: number, windowMs: number): Promise<AdminLoginAttemptResult> {
    return Promise.resolve(this.stub().consumeAdminLoginAttempt(bucketHash, limit, windowMs));
  }
}

export class DurableObjectFeaturePolicyEvents extends DurableObjectFeaturePolicyBinding implements FeaturePolicyEvents {
  async publish(revision: number): Promise<void> {
    await this.stub().publishRevision(revision);
  }

  subscribe(): () => void {
    return () => {};
  }

  async stream(lastRevision: number | undefined, signal: AbortSignal, currentRevision?: number): Promise<Response> {
    const subscriptionId = crypto.randomUUID();
    const stub = this.stub();
    const response = await stub.subscribe(lastRevision, subscriptionId, currentRevision);
    if (response.status === 503) {
      await response.body?.cancel();
      throw featurePolicyStreamLimited();
    }
    if (!response.body || signal.aborted) {
      await Promise.all([response.body?.cancel(), stub.unsubscribe(subscriptionId)]);
      return new Response(null, { headers: response.headers, status: response.status });
    }

    const reader = response.body.getReader();
    let cleaned = false;
    const cleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      await Promise.all([reader.cancel(), stub.unsubscribe(subscriptionId)]);
    };
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const abort = () => void cleanup().finally(() => controller.close());
        signal.addEventListener("abort", abort, { once: true });
        void (async () => {
          try {
            while (!signal.aborted) {
              const chunk = await reader.read();
              if (chunk.done) break;
              controller.enqueue(chunk.value);
            }
            if (!signal.aborted) controller.close();
          } catch (error) {
            if (!signal.aborted) controller.error(error);
          } finally {
            signal.removeEventListener("abort", abort);
            await cleanup();
          }
        })();
      },
      cancel: cleanup,
    });
    return new Response(stream, { headers: response.headers, status: response.status });
  }
}
