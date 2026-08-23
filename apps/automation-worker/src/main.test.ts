import {
  createAccountId,
  createChallengeId,
  createJobId,
  encryptEnvelope,
  type AutomationKeyring,
  createUetImportJob,
} from "@hyeboard/automation-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  AutomationControlConsumer,
  CaptchaControlBridge,
  createAutomationHost,
  createRedisHostClients,
  automationHealthResponse,
  type AutomationControl,
} from "./index";
import { InMemoryStreamsBroker, type NodeRedisStreamsClient } from "./index";
import { AutomationEnvelopeCodec } from "./envelope";
import type { AutomationWorkerConfig } from "./config";
import type { PuppeteerBrowser } from "./provider";

const keyring: AutomationKeyring = {
  current: { id: "current", material: new Uint8Array(32).fill(3) },
};
const jobId = createJobId(() => new Uint8Array(16).fill(1));
const accountId = createAccountId(() => new Uint8Array(16).fill(2));
const challengeId = createChallengeId(() => new Uint8Array(16).fill(4));

const config: AutomationWorkerConfig = {
  redisUrl: "redis://localhost:6379/0",
  jobStream: "jobs",
  eventStream: "events",
  controlStream: "control",
  consumerGroup: "jobs-workers",
  consumerName: "worker-1",
  controlConsumerGroup: "control-workers",
  controlConsumerName: "control-1",
  executionMode: "distributed",
  browserProvider: "browserless",
  browserlessEndpoint: "wss://browserless.example.test",
  browserlessToken: "private-browserless-token",
  jobEnvelopeAad: "job",
  credentialEnvelopeAadPrefix: "credential:",
  resultEnvelopeAadPrefix: "result:",
  eventEnvelopeAadPrefix: "event:",
  leaseTtlMs: 30_000,
  heartbeatIntervalMs: 10_000,
  reclaimIdleMs: 1_000,
  readBlockMs: 1,
  redisConnectTimeoutMs: 10,
  shutdownTimeoutMs: 50,
  maxDeliveryCount: 3,
  resultTtlMs: 30_000,
  keyring,
};

function control(): AutomationControl {
  return {
    type: "captcha-answer",
    jobId,
    accountId,
    fence: 1,
    challengeId,
    answer: "typed-answer",
  };
}

describe("automation worker health", () => {
  it("reports liveness before readiness and readiness after startup", () => {
    expect(automationHealthResponse("/healthz", false)).toMatchObject({
      status: 200,
    });
    expect(automationHealthResponse("/readyz", false)).toMatchObject({
      status: 503,
    });
    expect(automationHealthResponse("/readyz", true)).toMatchObject({
      status: 200,
    });
  });
});

describe("automation Redis clients", () => {
  it("handles asynchronous node-redis errors on both clients", () => {
    const clients = createRedisHostClients("redis://localhost:6379/0");
    const normal = clients.normal as unknown as { listenerCount(event: string): number };
    const blocking = clients.blocking as unknown as { listenerCount(event: string): number };

    expect(normal.listenerCount("error")).toBeGreaterThan(0);
    expect(blocking.listenerCount("error")).toBeGreaterThan(0);
  });
});

describe("automation control host bridge", () => {
  it("decrypts controls in a separate group and fences stale CAPTCHA answers", async () => {
    const broker = new InMemoryStreamsBroker();
    const codec = new AutomationEnvelopeCodec(keyring);
    const bridge = new CaptchaControlBridge();
    const handled: AutomationControl[] = [];
    const consumer = new AutomationControlConsumer({
      config,
      broker,
      envelopeCodec: codec,
      onControl: (value) => {
        handled.push(value);
        return bridge.applyAnswer(
          value as Extract<AutomationControl, { type: "captcha-answer" }>,
        );
      },
    });
    const job = createUetImportJob({
      jobId,
      accountId,
      fence: 1,
      credentialEnvelope: "aep1.synthetic.credentials",
      issuedAt: "2036-01-02T03:00:00.000Z",
      expiresAt: "2036-01-02T04:00:00.000Z",
    });
    const publish = vi.fn(async () => undefined);
    const waiting = bridge.waitForAnswer({
      job,
      challengeId,
      image: "data:image/png;base64:private-image",
      signal: new AbortController().signal,
      publishChallenge: publish,
    });
    expect(publish).toHaveBeenCalledOnce();
    const staleEnvelope = await codec.close(
      {
        ...control(),
        accountId: createAccountId(() => new Uint8Array(16).fill(8)),
      },
      `${config.credentialEnvelopeAadPrefix}${jobId}`,
      "2036-01-02T04:00:00.000Z",
    );
    await broker.add(config.controlStream, {
      jobId,
      controlEnvelope: staleEnvelope,
    });
    const envelope = await codec.close(
      control(),
      `${config.credentialEnvelopeAadPrefix}${jobId}`,
      "2036-01-02T04:00:00.000Z",
    );
    await broker.add(config.controlStream, {
      jobId,
      controlEnvelope: envelope,
    });
    await consumer.runOnce();
    await expect(waiting).resolves.toBe("typed-answer");
    expect(handled).toHaveLength(2);
    await consumer.stop(50);
  });
});

type FakeRedis = NodeRedisStreamsClient & {
  get(key: string): Promise<string | null>;
  connect(): Promise<void>;
  ping(): Promise<string>;
  set(
    key: string,
    value: string,
    options: { PX: number; NX: boolean },
  ): Promise<unknown>;
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
  isOpen: boolean;
  quit(): Promise<void>;
};

function fakeRedis(): FakeRedis {
  const values = new Map<string, string>();
  let open = false;
  return {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value, options) => {
      if (options?.NX && values.has(key)) return null;
      values.set(key, value);
      return "OK";
    },
    eval: async () => 0,
    xGroupCreate: async () => undefined,
    xReadGroup: async () => [],
    xAutoClaim: async () => ["0-0", []],
    xAck: async () => 1,
    xAdd: async () => "1-0",
    connect: async () => {
      open = true;
    },
    ping: async () => {
      if (!open) throw new Error("Redis is not connected.");
      return "PONG";
    },
    get isOpen() {
      return open;
    },
    quit: async () => {
      open = false;
    },
  };
}

const browser: PuppeteerBrowser = {
  connected: true,
  newPage: async () => ({
    close: async () => undefined,
    setCookie: async () => undefined,
    goto: async () => undefined,
    url: () => "about:blank",
    waitForSelector: async () => ({ click: async () => undefined }),
    click: async () => undefined,
    type: async () => undefined,
    waitForNavigation: async () => undefined,
    bringToFront: async () => undefined,
    isClosed: () => false,
    evaluate: async <T>() => null as T,
    once: () => undefined,
    cookies: async () => [],
    waitForNetworkIdle: async () => undefined,
  }),
  close: async () => undefined,
  disconnect: async () => undefined,
  on: () => undefined,
  off: () => undefined,
};

describe("executable host readiness", () => {
  it("does not report ready before both Redis and Browserless are valid", async () => {
    const normal = fakeRedis();
    const blocking = fakeRedis();
    const ready = vi.fn();
    let browserConnected = false;
    const host = createAutomationHost({
      env: {
        REDIS_URL: config.redisUrl,
        BROWSERLESS_ENDPOINT: config.browserlessEndpoint,
        BROWSERLESS_TOKEN: config.browserlessToken,
        AUTOMATION_KEY_CURRENT_ID: "current",
        AUTOMATION_KEY_CURRENT_B64: Buffer.from(
          keyring.current.material as Uint8Array,
        ).toString("base64"),
      },
      redis: {
        normal,
        blocking,
        close: async () => {
          await normal.quit();
          await blocking.quit();
        },
      },
      connectBrowser: async () => {
        browserConnected = true;
        return browser;
      },
      logger: { info: ready },
    });
    expect(ready).not.toHaveBeenCalled();
    await host.start();
    expect(browserConnected).toBe(true);
    expect(ready).toHaveBeenCalledOnce();
    await host.stop();
  });

  it("bounds Redis bootstrap and destroys clients when connection hangs", async () => {
    vi.useFakeTimers();
    try {
      const connect = vi.fn(() => new Promise<void>(() => undefined));
      const destroy = vi.fn();
      const normal = { ...fakeRedis(), connect, destroy };
      const blocking = { ...fakeRedis(), connect, destroy };
      const close = vi.fn(async () => undefined);
      const host = createAutomationHost({
        env: {
          REDIS_URL: config.redisUrl,
          BROWSERLESS_ENDPOINT: config.browserlessEndpoint,
          BROWSERLESS_TOKEN: config.browserlessToken,
          AUTOMATION_REDIS_CONNECT_TIMEOUT_MS: "10",
          AUTOMATION_KEY_CURRENT_ID: "current",
          AUTOMATION_KEY_CURRENT_B64: Buffer.from(
            keyring.current.material as Uint8Array,
          ).toString("base64"),
        },
        redis: { normal, blocking, close },
        connectBrowser: async () => browser,
      });

      const starting = host.start().then(
        () => ({ error: undefined }),
        (error) => ({ error }),
      );
      await vi.advanceTimersByTimeAsync(10);
      const result = await starting;
      expect(result.error).toHaveProperty("message", "Redis bootstrap timed out after 10ms.");
      expect(connect).toHaveBeenCalledTimes(2);
      expect(destroy).toHaveBeenCalledTimes(2);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
