import {
  assertAutomationEvent,
  type AutomationEvent,
  type UetImportJob,
} from "@hyeboard/automation-protocol";
import type { StreamsBroker } from "./broker";
import type { AutomationEnvelopeCodec } from "./envelope";

export interface AutomationEventSink {
  publish(event: AutomationEvent): Promise<void>;
}

export class StreamAutomationEventSink implements AutomationEventSink {
  constructor(private readonly broker: StreamsBroker, private readonly stream: string) {}

  async publish(event: AutomationEvent): Promise<void> {
    await this.broker.add(this.stream, { jobId: event.jobId, event: JSON.stringify(event) });
  }
}

export class EncryptedStreamAutomationEventSink implements AutomationEventSink {
  constructor(
    private readonly broker: StreamsBroker,
    private readonly stream: string,
    private readonly codec: AutomationEnvelopeCodec,
    private readonly aadPrefix: string,
  ) {}

  async publish(event: AutomationEvent): Promise<void> {
    const eventEnvelope = await this.codec.close(event, `${this.aadPrefix}${event.jobId}`, event.expiresAt);
    await this.broker.add(this.stream, { jobId: event.jobId, eventEnvelope });
  }
}

export class InMemoryAutomationEventSink implements AutomationEventSink {
  readonly events: AutomationEvent[] = [];

  async publish(event: AutomationEvent): Promise<void> {
    this.events.push(event);
  }
}

export class JobEventWriter {
  private sequence = 0;
  private tail = Promise.resolve();

  constructor(
    private readonly job: Pick<UetImportJob, "jobId" | "accountId" | "fence" | "expiresAt">,
    private readonly sink: AutomationEventSink,
    private readonly eventTtlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async emit<T extends AutomationEvent["type"]>(type: T, fields: Record<string, unknown> = {}): Promise<AutomationEvent> {
    const operation = this.tail.then(async () => {
      const emittedAt = new Date(this.now()).toISOString();
      const expiresAt = new Date(Math.min(Date.parse(this.job.expiresAt), this.now() + this.eventTtlMs)).toISOString();
      const event = {
        version: 1,
        type,
        jobId: this.job.jobId,
        accountId: this.job.accountId,
        fence: this.job.fence,
        sequence: this.sequence,
        emittedAt,
        expiresAt,
        ...fields,
      } as AutomationEvent;
      assertAutomationEvent(event);
      await this.sink.publish(event);
      this.sequence += 1;
      return event;
    });
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
