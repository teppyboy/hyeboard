import { createClient, createClientPool, type RedisClientOptions, type RedisClientPoolType, type RedisClientType } from "redis";

export type RedisClient = RedisClientType;
export type RedisBlockingPool = RedisClientPoolType;
export type RedisClientConfig = RedisClientOptions;

export type RedisSetOptions = {
  expiration?: { type: "PX" | "EX"; value: number };
  condition?: "NX" | "XX";
};

export interface RedisMultiLike {
  set(key: string, value: string, options?: RedisSetOptions): RedisMultiLike;
  del(key: string): RedisMultiLike;
  exec(): Promise<unknown[] | null>;
}

export interface RedisCommandClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: RedisSetOptions): Promise<string | null>;
  del(key: string): Promise<number>;
  eval(script: string, options: { keys?: string[]; arguments?: string[] }): Promise<unknown>;
  watch(key: string): Promise<unknown>;
  unwatch(): Promise<unknown>;
  multi(): RedisMultiLike;
}

export interface RedisBlockingClient extends RedisCommandClient {
  blPop(key: string, timeout: number): Promise<{ key: string; element: string } | null>;
}

export interface RedisPublishClient {
  publish(channel: string, message: string): Promise<number>;
}

export interface RedisSubscribeClient {
  subscribe(channel: string, listener: (message: string) => void): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
}

export type RedisClients = {
  client: RedisClient;
  blocking: RedisBlockingPool;
  subscriber: RedisClient;
};

export function createRedisClient(config: RedisClientConfig = {}): RedisClient {
  return createClient(config);
}

export function createRedisClients(config: RedisClientConfig = {}): RedisClients {
  const client = createRedisClient(config);
  const blocking = createClientPool(config);
  const subscriber = client.duplicate();
  // Redis clients emit asynchronous connection errors. Always attach a
  // listener so an outage is converted at the request/readiness boundary
  // instead of becoming an uncaught process exception.
  client.on("error", () => undefined);
  blocking.on("error", () => undefined);
  subscriber.on("error", () => undefined);
  return { client, blocking, subscriber };
}

export async function connectRedis(clients: RedisClients | RedisClient | RedisBlockingPool): Promise<void> {
  if ("client" in clients) {
    try {
      await Promise.all([clients.client.connect(), clients.blocking.connect(), clients.subscriber.connect()]);
    } catch (error) {
      await Promise.allSettled([
        closeRedis(clients.client),
        closeRedis(clients.blocking),
        closeRedis(clients.subscriber),
      ]);
      throw error;
    }
    return;
  }
  await clients.connect();
}

export async function closeRedis(clients: RedisClients | RedisClient | RedisBlockingPool): Promise<void> {
  if ("client" in clients) {
    await Promise.all([closeRedis(clients.client), closeRedis(clients.blocking), closeRedis(clients.subscriber)]);
    return;
  }
  if (clients.isOpen) clients.destroy();
}
