import {
  createChallengeId,
  parseUetImportJob,
  type UetImportJob,
} from "@hyeboard/automation-protocol";
import type { AutomationWorkerConfig } from "./config";
import { CancellationToken } from "./cancellation";
import type { StreamsBroker, StreamMessage } from "../transport/broker";
import { errorCode, isRetryable, type CancellationReason } from "./errors";
import type { AutomationEnvelopeCodec } from "../transport/envelope";
import { JobEventWriter } from "../transport/events";
import type { AutomationEventSink } from "../transport/events";
import type { AutomationExecutor } from "../browser/executor";
import { JobHeartbeat } from "./heartbeat";
import type { JobLease, JobLeaseStore } from "../transport/lease";
import type { BrowserProvider } from "../browser/provider";

export type AutomationWorkerLogger = {
  info?(message: string, fields?: Record<string, unknown>): void;
  warn?(message: string, fields?: Record<string, unknown>): void;
  error?(message: string, fields?: Record<string, unknown>): void;
};

export type AutomationWorkerOptions<TCredential, TResult> = {
  config: AutomationWorkerConfig;
  broker: StreamsBroker;
  leaseStore: JobLeaseStore;
  envelopeCodec: AutomationEnvelopeCodec;
  browserProvider: BrowserProvider;
  executor: AutomationExecutor<TCredential, TResult>;
  events: AutomationEventSink;
  logger?: AutomationWorkerLogger;
  onFatalError?: (error: unknown) => void;
  onCaptchaNeeded?: (request: {
    job: UetImportJob;
    challengeId: string;
    image: string;
    signal: AbortSignal;
    publishChallenge: () => Promise<void>;
  }) => Promise<string>;
  now?: () => number;
};

type ActiveRun = {
  token: CancellationToken;
  lease: JobLease;
  accountId: string;
  fence: number;
};

export class AutomationWorker<TCredential, TResult> {
  private readonly now: () => number;
  private readonly active = new Map<string, ActiveRun>();
  private readonly shutdown = new AbortController();
  private running = false;
  private draining = false;
  private loopPromise?: Promise<void>;
  private runOncePromise?: Promise<number>;
  private groupReady = false;

  constructor(
    private readonly options: AutomationWorkerOptions<TCredential, TResult>,
  ) {
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.draining = false;
    await this.ensureGroup();
    this.loopPromise = this.consume().catch((error) => {
      if (this.draining) return;
      this.options.logger?.error?.(
        "Automation job consumer stopped unexpectedly.",
        { code: errorCode(error) },
      );
      this.options.onFatalError?.(error);
    });
  }

  async stop(reason: CancellationReason = "shutdown"): Promise<void> {
    this.draining = true;
    this.shutdown.abort(reason);
    for (const run of this.active.values()) run.token.cancel(reason);
    const operations: Array<Promise<void | number>> = [
      ...(this.loopPromise ? [this.loopPromise] : []),
      ...(this.runOncePromise ? [this.runOncePromise] : []),
    ];
    if (operations.length) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled(operations).then(() => undefined),
          new Promise<void>((resolve) => {
            timeout = setTimeout(
              resolve,
              this.options.config.shutdownTimeoutMs,
            );
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
    this.running = false;
  }

  async runOnce(signal?: AbortSignal): Promise<number> {
    if (this.runOncePromise) return this.runOncePromise;
    const operation = this.runOnceImpl(signal);
    this.runOncePromise = operation;
    try {
      return await operation;
    } finally {
      if (this.runOncePromise === operation) this.runOncePromise = undefined;
    }
  }

  private async runOnceImpl(signal?: AbortSignal): Promise<number> {
    if (this.draining) return 0;
    await this.ensureGroup();
    const reclaimed = await this.options.broker.reclaimPending({
      stream: this.options.config.jobStream,
      group: this.options.config.consumerGroup,
      consumer: this.options.config.consumerName,
      count: 10,
      minIdleMs: this.options.config.reclaimIdleMs,
      signal,
    });
    const messages =
      reclaimed.length > 0
        ? reclaimed
        : await this.options.broker.readGroup({
            stream: this.options.config.jobStream,
            group: this.options.config.consumerGroup,
            consumer: this.options.config.consumerName,
            count: 10,
            blockMs: this.options.config.readBlockMs,
            signal,
          });
    let processed = 0;
    for (const message of messages) {
      if (this.draining) break;
      await this.process(message);
      processed += 1;
    }
    return processed;
  }

  requestCancel(
    jobId: string,
    reason: Exclude<
      CancellationReason,
      "shutdown" | "lease-lost"
    > = "requested",
  ): boolean {
    const active = this.active.get(jobId);
    if (!active) return false;
    active.token.cancel(reason);
    return true;
  }

  requestFencedCancel(input: {
    jobId: string;
    accountId: string;
    fence: number;
    reason?: "requested";
  }): boolean {
    const active = this.active.get(input.jobId);
    if (
      !active ||
      active.accountId !== input.accountId ||
      active.fence !== input.fence
    )
      return false;
    active.token.cancel(input.reason ?? "requested");
    return true;
  }

  private async ensureGroup(): Promise<void> {
    if (this.groupReady) return;
    await this.options.broker.ensureGroup(
      this.options.config.jobStream,
      this.options.config.consumerGroup,
    );
    this.groupReady = true;
  }

  private async consume(): Promise<void> {
    while (!this.draining) {
      const processed = await this.runOnce(this.shutdown.signal);
      if (processed === 0)
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private async process(message: StreamMessage): Promise<void> {
    const envelope = message.fields.jobEnvelope ?? message.fields.job;
    if (!envelope) {
      this.options.logger?.warn?.(
        "Discarding automation message without a job envelope.",
        { messageId: message.id },
      );
      await this.ack(message.id);
      return;
    }

    let job: UetImportJob;
    try {
      const opened = await this.options.envelopeCodec.open<unknown>(
        envelope,
        this.options.config.jobEnvelopeAad,
      );
      job = parseUetImportJob(opened, this.now());
    } catch (error) {
      this.options.logger?.warn?.("Discarding invalid automation job.", {
        messageId: message.id,
        code: errorCode(error),
      });
      await this.ack(message.id);
      return;
    }

    const lease = await this.options.leaseStore.acquire(
      job.jobId,
      job.fence,
      this.options.config.leaseTtlMs,
    );
    if (!lease) {
      this.options.logger?.info?.(
        "Automation job is already fenced by another worker.",
        { jobId: job.jobId },
      );
      return;
    }

    const cancellation = new CancellationToken(
      Date.parse(job.expiresAt),
      this.shutdown.signal,
      this.now,
    );
    this.active.set(job.jobId, {
      token: cancellation,
      lease,
      accountId: job.accountId,
      fence: job.fence,
    });
    const events = new JobEventWriter(
      job,
      this.options.events,
      this.options.config.resultTtlMs,
      this.now,
    );
    const heartbeat = new JobHeartbeat(
      lease,
      this.options.config.heartbeatIntervalMs,
      () => events.emit("heartbeat").then(() => undefined),
      () => cancellation.cancel("lease-lost"),
    );
    let connection: Awaited<ReturnType<BrowserProvider["open"]>> | undefined;
    try {
      await events.emit("started");
      heartbeat.start();
      const credential = await this.options.envelopeCodec.open<TCredential>(
        job.credentialEnvelope,
        `${this.options.config.credentialEnvelopeAadPrefix}${job.jobId}`,
      );
      cancellation.throwIfCancelled();
      connection = await this.options.browserProvider.open(cancellation.signal);
      const result = await this.options.executor.execute({
        job,
        credential,
        browser: connection,
        cancellation,
        onCaptchaNeeded: this.options.onCaptchaNeeded
          ? (image: string, signal?: AbortSignal) => {
              const challengeId = createChallengeId();
              return this.options.onCaptchaNeeded!({
                job,
                challengeId,
                image,
                signal: signal ?? cancellation.signal,
                publishChallenge: () =>
                  events
                    .emit("challenge-required", { challengeId, image })
                    .then(() => undefined),
              });
            }
          : undefined,
        progress: async (phase, percent) => {
          await lease.assertHeld();
          await events.emit("progress", { phase, percent });
        },
      });
      cancellation.throwIfCancelled();
      await lease.assertHeld();
      const resultEnvelope = await this.options.envelopeCodec.close(
        result,
        `${this.options.config.resultEnvelopeAadPrefix}${job.jobId}`,
        new Date(
          Math.min(
            Date.parse(job.expiresAt),
            this.now() + this.options.config.resultTtlMs,
          ),
        ).toISOString(),
      );
      await events.emit("succeeded", { resultEnvelope });
      await this.ack(message.id);
    } catch (error) {
      const reason = cancellation.reason;
      if (
        reason === "shutdown" ||
        reason === "lease-lost" ||
        errorCode(error) === "LEASE_LOST"
      )
        return;
      if (reason === "requested" || reason === "deadline") {
        await events.emit("cancelled", {
          reason: reason === "deadline" ? "expired" : "requested",
        });
        await this.ack(message.id);
        return;
      }
      const retryable =
        isRetryable(error) &&
        message.deliveryCount < this.options.config.maxDeliveryCount;
      if (!retryable) {
        await events.emit("failed", {
          code: errorCode(error),
          retryable: false,
        });
        await this.ack(message.id);
      }
    } finally {
      heartbeat.stop();
      if (connection) await connection.disconnect();
      await lease.release();
      this.active.delete(job.jobId);
    }
  }

  private ack(messageId: string): Promise<void> {
    return this.options.broker.ack(
      this.options.config.jobStream,
      this.options.config.consumerGroup,
      messageId,
    );
  }
}
