import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { env } from "node:process";
import puppeteer from "puppeteer-core";
import { createClient, createClientPool } from "redis";
import {
  AutomationControlConsumer,
  CaptchaControlBridge,
  type AutomationControl,
} from "./control";
import {
  parseAutomationWorkerConfig,
  safeConfigSummary,
  type AutomationWorkerConfig,
} from "./config";
import { AutomationEnvelopeCodec } from "./envelope";
import { EncryptedStreamAutomationEventSink } from "./events";
import { errorCode } from "./errors";
import { RedisJobLeaseStore } from "./lease";
import { RedisStreamsBroker, type NodeRedisStreamsClient } from "./broker";
import {
  createBrowserlessPuppeteerProvider,
  type BrowserProvider,
  type PuppeteerConnector,
} from "./provider";
import { createUetAutomationExecutor } from "./uet-executor";
import type { UetAutomationCredential } from "./uet-executor";
import type { ImportedSession } from "@hyeboard/university-adapters";
import { AutomationWorker, type AutomationWorkerLogger } from "./worker";

export type AutomationRedisHostClient = NodeRedisStreamsClient & {
  set(
    key: string,
    value: string,
    options: { PX: number; NX: boolean },
  ): Promise<unknown>;
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
  connect(): Promise<void>;
  ping(): Promise<string>;
  isOpen?: boolean;
  quit?(): Promise<unknown>;
  close?(): Promise<unknown>;
  destroy?(): void;
};

export type AutomationHostLogger = AutomationWorkerLogger & {
  info?(message: string, fields?: Record<string, unknown>): void;
};

export type AutomationHealth = {
  server: Server;
  setReady(ready: boolean): void;
  close(): Promise<void>;
};

export type AutomationHostOptions = {
  env?: Record<string, string | undefined>;
  redis?: {
    normal: AutomationRedisHostClient;
    blocking: AutomationRedisHostClient;
    close?: () => Promise<void>;
  };
  connectBrowser?: PuppeteerConnector;
  browserProvider?: BrowserProvider;
  logger?: AutomationHostLogger;
  now?: () => number;
  health?: AutomationHealth;
};

export type AutomationHost = {
  readonly config: AutomationWorkerConfig;
  readonly worker: AutomationWorker<UetAutomationCredential, ImportedSession>;
  readonly controls: AutomationControlConsumer;
  start(): Promise<void>;
  stop(): Promise<void>;
  waitForFailure(): Promise<never>;
};

export function automationHealthResponse(
  path: string | undefined,
  ready: boolean,
): { status: number; body: string } {
  const status = path === "/readyz" && !ready ? 503 : 200;
  return {
    status,
    body: JSON.stringify({
      status: status === 200 ? "ok" : "starting",
      service: "hyeboard-automation-worker",
    }),
  };
}

export function createAutomationHealthServer(
  port: number,
  host: string,
): AutomationHealth {
  let ready = false;
  let closed = false;
  const server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      const result = automationHealthResponse(request.url, ready);
      response.writeHead(result.status, { "content-type": "application/json" });
      response.end(result.body);
    },
  ).listen(port, host);
  return {
    server,
    setReady(value) {
      ready = value;
    },
    close: () => {
      if (closed) return Promise.resolve();
      closed = true;
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function closeRedisClient(
  client: AutomationRedisHostClient,
): Promise<void> {
  if (client.isOpen === false) return;
  try {
    if (client.quit) await client.quit();
    else if (client.close) await client.close();
    else client.destroy?.();
  } catch {
    client.destroy?.();
  }
}

function defaultConnector(): PuppeteerConnector {
  return async ({ browserWSEndpoint }) =>
    puppeteer.connect({ browserWSEndpoint }) as never;
}

function createRedisHostClients(redisUrl: string): {
  normal: AutomationRedisHostClient;
  blocking: AutomationRedisHostClient;
  close: () => Promise<void>;
} {
  const normal = createClient({
    url: redisUrl,
  }) as unknown as AutomationRedisHostClient;
  const blocking = createClientPool({
    url: redisUrl,
  }) as unknown as AutomationRedisHostClient;
  return {
    normal,
    blocking,
    close: async () => {
      await Promise.all([closeRedisClient(normal), closeRedisClient(blocking)]);
    },
  };
}

export function createAutomationHost(
  options: AutomationHostOptions = {},
): AutomationHost {
  const config = parseAutomationWorkerConfig(options.env ?? env);
  if (config.browserProvider !== "browserless") {
    throw new Error(
      "The executable automation host supports Browserless only; configure BROWSERLESS_ENDPOINT and BROWSERLESS_TOKEN.",
    );
  }

  const redis = options.redis ?? createRedisHostClients(config.redisUrl);
  const broker = new RedisStreamsBroker(redis.normal, redis.blocking);
  const codec = new AutomationEnvelopeCodec(config.keyring, options.now);
  const provider =
    options.browserProvider ??
    createBrowserlessPuppeteerProvider({
      endpoint: config.browserlessEndpoint!,
      token: config.browserlessToken!,
      connect: options.connectBrowser ?? defaultConnector(),
      now: options.now,
    });
  const captcha = new CaptchaControlBridge();
  let failureSignaled = false;
  let signalFailure!: (error: unknown) => void;
  const failure = new Promise<never>((_, reject) => {
    signalFailure = reject;
  });
  const health = options.health;
  const onFatalError = (error: unknown) => {
    if (failureSignaled) return;
    failureSignaled = true;
    health?.setReady(false);
    signalFailure(error);
  };
  const worker = new AutomationWorker<UetAutomationCredential, ImportedSession>(
    {
      config,
      broker,
      leaseStore: new RedisJobLeaseStore(redis.normal),
      envelopeCodec: codec,
      browserProvider: provider,
      executor: createUetAutomationExecutor(),
      events: new EncryptedStreamAutomationEventSink(
        broker,
        config.eventStream,
        codec,
        config.eventEnvelopeAadPrefix,
      ),
      logger: options.logger,
      now: options.now,
      onFatalError,
      onCaptchaNeeded: (request) => captcha.waitForAnswer(request),
    },
  );
  const controls = new AutomationControlConsumer({
    config,
    broker,
    envelopeCodec: codec,
    logger: options.logger,
    now: options.now,
    onFatalError,
    onControl: async (control) => applyControl(control, worker, captcha),
  });

  let started = false;
  let stopping: Promise<void> | undefined;

  return {
    config,
    worker,
    controls,
    async start() {
      if (started) return;
      const clientsConnected = new Set<AutomationRedisHostClient>();
      try {
        await redis.normal.connect();
        clientsConnected.add(redis.normal);
        await redis.blocking.connect();
        clientsConnected.add(redis.blocking);
        await Promise.all([redis.normal.ping(), redis.blocking.ping()]);
        const probe = await provider.open();
        await probe.disconnect();
        await worker.start();
        await controls.start();
        health?.setReady(true);
        started = true;
        options.logger?.info?.(
          "Automation worker ready.",
          safeConfigSummary(config),
        );
      } catch (error) {
        await controls.stop(config.shutdownTimeoutMs).catch(() => undefined);
        await worker.stop("shutdown").catch(() => undefined);
        if (redis.close) await redis.close().catch(() => undefined);
        else
          await Promise.all(
            [...clientsConnected].map((client) => closeRedisClient(client)),
          );
        health?.setReady(false);
        await health?.close();
        throw error;
      }
    },
    waitForFailure: () => failure,
    async stop() {
      stopping ??= (async () => {
        await controls.stop(config.shutdownTimeoutMs);
        await worker.stop("shutdown");
        if (redis.close) await redis.close();
        else
          await Promise.all([
            closeRedisClient(redis.normal),
            closeRedisClient(redis.blocking),
          ]);
        health?.setReady(false);
        await health?.close();
        started = false;
      })();
      await stopping;
    },
  };
}

function applyControl(
  control: AutomationControl,
  worker: AutomationWorker<UetAutomationCredential, ImportedSession>,
  captcha: CaptchaControlBridge,
): boolean {
  if (control.type === "captcha-answer") return captcha.applyAnswer(control);
  if (control.challengeId && !captcha.matchesChallenge(control)) return false;
  return worker.requestFencedCancel(control);
}

export async function runAutomationWorker(
  environment: Record<string, string | undefined> = env,
): Promise<void> {
  const logger: AutomationHostLogger = {
    info: (message, fields) => console.info(message, fields ?? {}),
    warn: (message, fields) => console.warn(message, fields ?? {}),
    error: (message, fields) => console.error(message, fields ?? {}),
  };
  const health = createAutomationHealthServer(
    Number(environment.AUTOMATION_HEALTH_PORT ?? 8080),
    environment.AUTOMATION_HEALTH_HOST ?? "0.0.0.0",
  );
  let host: AutomationHost;
  try {
    host = createAutomationHost({ env: environment, logger, health });
  } catch (error) {
    await health.close();
    throw error;
  }
  let stopping: Promise<void> | undefined;
  let resolveStopRequested!: () => void;
  const stopRequested = new Promise<void>((resolve) => {
    resolveStopRequested = resolve;
  });
  const stop = () => {
    stopping ??= host
      .stop()
      .catch((error) =>
        logger.error?.("Automation worker shutdown failed.", {
          code: errorCode(error),
        }),
      )
      .finally(resolveStopRequested);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    await host.start();
    await Promise.race([host.waitForFailure(), stopRequested]);
  } catch (error) {
    logger.error?.("Automation worker failed to start.", {
      code: errorCode(error),
    });
    throw error;
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    await host.stop().catch(() => undefined);
  }
}
