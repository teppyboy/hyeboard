export type StreamFields = Record<string, string>;

export type StreamMessage = {
  id: string;
  fields: StreamFields;
  deliveryCount: number;
  idleMs?: number;
};

export type ReadGroupInput = {
  stream: string;
  group: string;
  consumer: string;
  count: number;
  blockMs: number;
  signal?: AbortSignal;
};

export type ReclaimPendingInput = Omit<ReadGroupInput, "blockMs"> & { minIdleMs: number };

export interface StreamsBroker {
  ensureGroup(stream: string, group: string): Promise<void>;
  readGroup(input: ReadGroupInput): Promise<StreamMessage[]>;
  reclaimPending(input: ReclaimPendingInput): Promise<StreamMessage[]>;
  ack(stream: string, group: string, messageId: string): Promise<void>;
  add(stream: string, fields: StreamFields): Promise<string>;
}

export type NodeRedisStreamsClient = {
  xGroupCreate(stream: string, group: string, id: string, options: { MKSTREAM: boolean }): Promise<unknown>;
  xReadGroup(group: string, consumer: string, streams: Record<string, string>, options: { COUNT: number; BLOCK: number }): Promise<unknown>;
  xAutoClaim(stream: string, group: string, consumer: string, minIdleMs: number, start: string, options: { COUNT: number }): Promise<unknown>;
  xAck(stream: string, group: string, messageId: string): Promise<unknown>;
  xAdd(stream: string, id: string, fields: StreamFields): Promise<string>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fieldRecord(value: unknown): StreamFields {
  if (value instanceof Map) return Object.fromEntries([...value.entries()].map(([key, item]) => [String(key), String(item)]));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
  throw new Error("Redis stream message fields are malformed.");
}

function normalizeMessages(value: unknown): StreamMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((stream) => {
    if (!stream || typeof stream !== "object") return [];
    const messages = (stream as { messages?: unknown }).messages;
    if (!Array.isArray(messages)) return [];
    return messages.map((message) => {
      if (!message || typeof message !== "object") throw new Error("Redis stream message is malformed.");
      const item = message as { id?: unknown; message?: unknown; deliveriesCounter?: unknown; millisElapsedFromDelivery?: unknown };
      if (typeof item.id !== "string" || item.message === undefined) throw new Error("Redis stream message is malformed.");
      return {
        id: item.id,
        fields: fieldRecord(item.message),
        deliveryCount: typeof item.deliveriesCounter === "number" ? item.deliveriesCounter : 1,
        ...(typeof item.millisElapsedFromDelivery === "number" ? { idleMs: item.millisElapsedFromDelivery } : {}),
      };
    });
  });
}

export class RedisStreamsBroker implements StreamsBroker {
  constructor(
    private readonly client: NodeRedisStreamsClient,
    private readonly blockingClient: NodeRedisStreamsClient = client,
  ) {}

  async ensureGroup(stream: string, group: string): Promise<void> {
    try {
      await this.client.xGroupCreate(stream, group, "0", { MKSTREAM: true });
    } catch (error) {
      if (!errorMessage(error).toUpperCase().includes("BUSYGROUP")) throw error;
    }
  }

  async readGroup(input: ReadGroupInput): Promise<StreamMessage[]> {
    if (input.signal?.aborted) return [];
    return normalizeMessages(await this.blockingClient.xReadGroup(
      input.group,
      input.consumer,
      { key: input.stream, id: ">" },
      { COUNT: input.count, BLOCK: input.blockMs },
    ));
  }

  async reclaimPending(input: ReclaimPendingInput): Promise<StreamMessage[]> {
    if (input.signal?.aborted) return [];
    const result = await this.client.xAutoClaim(input.stream, input.group, input.consumer, input.minIdleMs, "0-0", { COUNT: input.count });
    if (Array.isArray(result)) return normalizeMessages([{ messages: result[1] }]);
    if (result && typeof result === "object" && "messages" in result) return normalizeMessages([{ messages: (result as { messages: unknown }).messages }]);
    return [];
  }

  ack(stream: string, group: string, messageId: string): Promise<void> {
    return this.client.xAck(stream, group, messageId).then(() => undefined);
  }

  add(stream: string, fields: StreamFields): Promise<string> {
    return this.client.xAdd(stream, "*", fields);
  }
}

type Pending = StreamMessage & { consumer: string; claimedAt: number };
type GroupState = { lastIndex: number; pending: Map<string, Pending> };

export class InMemoryStreamsBroker implements StreamsBroker {
  private readonly streams = new Map<string, Array<{ id: string; fields: StreamFields }>>();
  private readonly groups = new Map<string, GroupState>();
  private sequence = 0;

  constructor(private readonly now: () => number = Date.now) {}

  async ensureGroup(stream: string, group: string): Promise<void> {
    this.streams.set(stream, this.streams.get(stream) ?? []);
    const key = `${stream}:${group}`;
    this.groups.set(key, this.groups.get(key) ?? { lastIndex: -1, pending: new Map() });
  }

  async readGroup(input: ReadGroupInput): Promise<StreamMessage[]> {
    const group = this.groups.get(`${input.stream}:${input.group}`);
    const entries = this.streams.get(input.stream) ?? [];
    if (!group) throw new Error("Consumer group has not been created.");
    const output: StreamMessage[] = [];
    for (let index = group.lastIndex + 1; index < entries.length && output.length < input.count; index += 1) {
      const entry = entries[index];
      const message: Pending = { id: entry.id, fields: { ...entry.fields }, deliveryCount: 1, consumer: input.consumer, claimedAt: this.now() };
      group.pending.set(entry.id, message);
      group.lastIndex = index;
      output.push({ ...message });
    }
    return input.signal?.aborted ? [] : output;
  }

  async reclaimPending(input: ReclaimPendingInput): Promise<StreamMessage[]> {
    const group = this.groups.get(`${input.stream}:${input.group}`);
    if (!group) throw new Error("Consumer group has not been created.");
    const now = this.now();
    const output: StreamMessage[] = [];
    for (const pending of group.pending.values()) {
      if (output.length >= input.count) break;
      if (now - pending.claimedAt < input.minIdleMs) continue;
      pending.consumer = input.consumer;
      pending.claimedAt = now;
      pending.deliveryCount += 1;
      pending.idleMs = 0;
      output.push({ ...pending });
    }
    return input.signal?.aborted ? [] : output;
  }

  async ack(stream: string, group: string, messageId: string): Promise<void> {
    this.groups.get(`${stream}:${group}`)?.pending.delete(messageId);
  }

  async add(stream: string, fields: StreamFields): Promise<string> {
    const id = `${++this.sequence}-0`;
    const entries = this.streams.get(stream) ?? [];
    entries.push({ id, fields: { ...fields } });
    this.streams.set(stream, entries);
    return id;
  }

  pending(stream: string, group: string): readonly StreamMessage[] {
    return [...(this.groups.get(`${stream}:${group}`)?.pending.values() ?? [])].map(({ consumer: _consumer, claimedAt: _claimedAt, ...message }) => message);
  }
}
