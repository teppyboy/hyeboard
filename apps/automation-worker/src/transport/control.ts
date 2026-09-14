import {
  assertOpaqueId,
  type UetImportJob,
} from "@hyeboard/automation-protocol";
import type { StreamsBroker, StreamMessage } from "./broker";
import { CancellationError, errorCode } from "../runtime/errors";
import type { AutomationEnvelopeCodec } from "./envelope";
import type { AutomationWorkerConfig } from "../runtime/config";

export type AutomationControl = {
  type: "captcha-answer";
  jobId: string;
  accountId: string;
  fence: number;
  challengeId: string;
  answer: string;
} | {
  type: "cancel";
  jobId: string;
  accountId: string;
  fence: number;
  challengeId?: string;
  reason: "requested";
};

export type CaptchaWaitRequest = {
  job: UetImportJob;
  challengeId: string;
  image: string;
  signal: AbortSignal;
  publishChallenge: () => Promise<void>;
};

export type AutomationControlLogger = {
  warn?(message: string, fields?: Record<string, unknown>): void;
  error?(message: string, fields?: Record<string, unknown>): void;
};

function asRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAutomationControl(value: unknown): AutomationControl {
  if (!asRecord(value)
    || (value.type !== "captcha-answer" && value.type !== "cancel")
    || typeof value.jobId !== "string"
    || typeof value.accountId !== "string"
    || typeof value.fence !== "number"
    || !Number.isSafeInteger(value.fence)
    || value.fence < 1) {
    throw new Error("Invalid automation control.");
  }
  assertOpaqueId(value.jobId);
  assertOpaqueId(value.accountId);
  const allowedKeys = value.type === "captcha-answer"
    ? ["type", "jobId", "accountId", "fence", "challengeId", "answer"]
    : ["type", "jobId", "accountId", "fence", "challengeId", "reason"];
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) throw new Error("Invalid automation control fields.");
  if (value.challengeId !== undefined) {
    if (typeof value.challengeId !== "string") throw new Error("Invalid automation control challenge.");
    assertOpaqueId(value.challengeId);
  }
  if (value.type === "captcha-answer") {
    if (typeof value.challengeId !== "string" || typeof value.answer !== "string" || value.answer.length === 0 || value.answer.length > 64) {
      throw new Error("Invalid CAPTCHA control.");
    }
  } else if (value.reason !== "requested" || value.answer !== undefined) {
    throw new Error("Invalid cancellation control.");
  }
  return value as AutomationControl;
}

type PendingCaptcha = {
  jobId: string;
  accountId: string;
  fence: number;
  resolve(answer: string): void;
  reject(error: unknown): void;
  signal: AbortSignal;
  onAbort: () => void;
};

export class CaptchaControlBridge {
  private readonly pending = new Map<string, PendingCaptcha>();

  async waitForAnswer(request: CaptchaWaitRequest): Promise<string> {
    if (request.signal.aborted) throw request.signal.reason ?? new CancellationError("requested");
    const answer = new Promise<string>((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(request.challengeId);
        reject(request.signal.reason ?? new CancellationError("requested"));
      };
      this.pending.set(request.challengeId, {
        jobId: request.job.jobId,
        accountId: request.job.accountId,
        fence: request.job.fence,
        resolve,
        reject,
        signal: request.signal,
        onAbort,
      });
      request.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await request.publishChallenge();
      return await answer;
    } catch (error) {
      this.reject(request.challengeId, error);
      throw error;
    }
  }

  applyAnswer(control: Extract<AutomationControl, { type: "captcha-answer" }>): boolean {
    const pending = this.pending.get(control.challengeId);
    if (!pending || !this.matches(pending, control) || pending.signal.aborted) return false;
    this.pending.delete(control.challengeId);
    pending.signal.removeEventListener("abort", pending.onAbort);
    pending.resolve(control.answer);
    return true;
  }

  matchesChallenge(control: Pick<AutomationControl, "jobId" | "accountId" | "fence" | "challengeId">): boolean {
    if (!control.challengeId) return false;
    const pending = this.pending.get(control.challengeId);
    return Boolean(pending && this.matches(pending, control));
  }

  rejectForJob(jobId: string, error: unknown): void {
    for (const [challengeId, pending] of this.pending) {
      if (pending.jobId === jobId) this.reject(challengeId, error);
    }
  }

  private reject(challengeId: string, error: unknown): void {
    const pending = this.pending.get(challengeId);
    if (!pending) return;
    this.pending.delete(challengeId);
    pending.signal.removeEventListener("abort", pending.onAbort);
    pending.reject(error);
  }

  private matches(left: Pick<PendingCaptcha, "jobId" | "accountId" | "fence">, right: Pick<AutomationControl, "jobId" | "accountId" | "fence">): boolean {
    return left.jobId === right.jobId && left.accountId === right.accountId && left.fence === right.fence;
  }
}

export type AutomationControlHandler = (control: AutomationControl) => boolean | Promise<boolean>;

export class AutomationControlConsumer {
  private readonly shutdown = new AbortController();
  private running = false;
  private groupReady = false;
  private loopPromise?: Promise<void>;

  constructor(
    private readonly options: {
      config: AutomationWorkerConfig;
      broker: StreamsBroker;
      envelopeCodec: AutomationEnvelopeCodec;
      onControl: AutomationControlHandler;
      logger?: AutomationControlLogger;
      onFatalError?: (error: unknown) => void;
      now?: () => number;
    },
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    await this.ensureGroup();
    this.running = true;
    this.loopPromise = this.consume().catch((error) => {
      if (this.shutdown.signal.aborted) return;
      this.options.logger?.error?.(
        "Automation control consumer stopped unexpectedly.",
        { code: errorCode(error) },
      );
      this.options.onFatalError?.(error);
    });
  }

  async stop(timeoutMs: number): Promise<void> {
    this.running = false;
    this.shutdown.abort();
    if (!this.loopPromise) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.loopPromise,
        new Promise<void>((resolve) => { timeout = setTimeout(resolve, timeoutMs); }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async ensureGroup(): Promise<void> {
    if (this.groupReady) return;
    await this.options.broker.ensureGroup(this.options.config.controlStream, this.options.config.controlConsumerGroup);
    this.groupReady = true;
  }

  private async consume(): Promise<void> {
    while (this.running && !this.shutdown.signal.aborted) {
      const processed = await this.runOnce();
      if (processed === 0) await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async runOnce(): Promise<number> {
    await this.ensureGroup();
    const reclaimed = await this.options.broker.reclaimPending({
      stream: this.options.config.controlStream,
      group: this.options.config.controlConsumerGroup,
      consumer: this.options.config.controlConsumerName,
      count: 10,
      minIdleMs: this.options.config.reclaimIdleMs,
      signal: this.shutdown.signal,
    });
    const messages = reclaimed.length > 0 ? reclaimed : await this.options.broker.readGroup({
      stream: this.options.config.controlStream,
      group: this.options.config.controlConsumerGroup,
      consumer: this.options.config.controlConsumerName,
      count: 10,
      blockMs: this.options.config.readBlockMs,
      signal: this.shutdown.signal,
    });
    for (const message of messages) await this.process(message);
    return messages.length;
  }

  private async process(message: StreamMessage): Promise<void> {
    const envelope = message.fields.controlEnvelope;
    if (!envelope) {
      await this.ack(message.id);
      return;
    }
    try {
      const control = parseAutomationControl(await this.options.envelopeCodec.open<unknown>(
        envelope,
        `${this.options.config.credentialEnvelopeAadPrefix}${message.fields.jobId ?? ""}`,
      ));
      if (control.jobId !== message.fields.jobId) {
        this.options.logger?.warn?.("Discarding automation control with a job mismatch.", { messageId: message.id });
      } else {
        await this.options.onControl(control);
      }
    } catch (error) {
      this.options.logger?.warn?.("Discarding invalid automation control.", { messageId: message.id, code: errorCode(error) });
    } finally {
      await this.ack(message.id);
    }
  }

  private ack(messageId: string): Promise<void> {
    return this.options.broker.ack(this.options.config.controlStream, this.options.config.controlConsumerGroup, messageId);
  }
}
