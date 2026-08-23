import { describe, expect, it } from "vitest";
import { AutomationWorker } from "./worker";
import type { StreamsBroker } from "./broker";

const config = {
  redisUrl: "redis://localhost:6379",
  jobStream: "jobs",
  eventStream: "events",
  controlStream: "control",
  consumerGroup: "workers",
  consumerName: "worker-a",
  controlConsumerGroup: "controls",
  controlConsumerName: "control-a",
  executionMode: "distributed" as const,
  browserProvider: "browserless" as const,
  browserlessEndpoint: "wss://browserless.example.test",
  browserlessToken: "token",
  jobEnvelopeAad: "job",
  credentialEnvelopeAadPrefix: "credential:",
  resultEnvelopeAadPrefix: "result:",
  eventEnvelopeAadPrefix: "event:",
  leaseTtlMs: 30_000,
  heartbeatIntervalMs: 10_000,
  reclaimIdleMs: 30_000,
  readBlockMs: 1_000,
  redisConnectTimeoutMs: 30_000,
  shutdownTimeoutMs: 100,
  maxDeliveryCount: 3,
  resultTtlMs: 300_000,
  keyring: {
    current: { id: "current", material: new Uint8Array(32) },
  },
};

describe("AutomationWorker fatal loop handling", () => {
  it("reports an unexpected stream failure instead of staying alive", async () => {
    const fatal = new Error("stream disconnected");
    const broker: StreamsBroker = {
      ensureGroup: async () => undefined,
      reclaimPending: async () => [],
      readGroup: async () => {
        throw fatal;
      },
      ack: async () => undefined,
      add: async () => "1-0",
    };
    const failure = new Promise<unknown>((resolve) => {
      const worker = new AutomationWorker({
        config,
        broker,
        leaseStore: {} as never,
        envelopeCodec: {} as never,
        browserProvider: {} as never,
        executor: {} as never,
        events: {} as never,
        onFatalError: resolve,
      });
      void worker.start().then(() => {
        setTimeout(() => void worker.stop(), 25);
      });
    });

    await expect(failure).resolves.toBe(fatal);
  });
});
