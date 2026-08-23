import { Buffer } from "node:buffer";
import { assertKeyring, type AutomationKeyring } from "@hyeboard/automation-protocol";
import { ConfigurationError } from "./errors";

export type AutomationExecutionMode = "distributed" | "local";
export type AutomationBrowserProvider = "browserless" | "patchright";

export type AutomationWorkerConfig = {
  redisUrl: string;
  jobStream: string;
  eventStream: string;
  controlStream: string;
  consumerGroup: string;
  consumerName: string;
  controlConsumerGroup: string;
  controlConsumerName: string;
  executionMode: AutomationExecutionMode;
  browserProvider: AutomationBrowserProvider;
  browserlessEndpoint?: string;
  browserlessToken?: string;
  jobEnvelopeAad: string;
  credentialEnvelopeAadPrefix: string;
  resultEnvelopeAadPrefix: string;
  eventEnvelopeAadPrefix: string;
  leaseTtlMs: number;
  heartbeatIntervalMs: number;
  reclaimIdleMs: number;
  readBlockMs: number;
  redisConnectTimeoutMs: number;
  shutdownTimeoutMs: number;
  maxDeliveryCount: number;
  resultTtlMs: number;
  keyring: AutomationKeyring;
};

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigurationError(`Missing required configuration: ${name}.`);
  return value;
}

function positiveInteger(env: Env, name: string, fallback: number): number {
  const raw = env[name] ?? String(fallback);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new ConfigurationError(`${name} must be a positive integer.`);
  return value;
}

function oneOf<T extends string>(env: Env, name: string, fallback: T, values: readonly T[]): T {
  const value = (env[name] ?? fallback) as T;
  if (!values.includes(value)) throw new ConfigurationError(`${name} has an unsupported value.`);
  return value;
}

function url(env: Env, name: string, protocols: readonly string[]): string {
  const value = required(env, name);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigurationError(`${name} must be a valid URL.`);
  }
  if (!protocols.includes(parsed.protocol)) throw new ConfigurationError(`${name} has an unsupported URL protocol.`);
  return parsed.toString();
}

function decodeKey(value: string, name: string): Uint8Array {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/"), "base64");
  } catch {
    throw new ConfigurationError(`${name} must be base64 encoded.`);
  }
  if (bytes.byteLength !== 32) throw new ConfigurationError(`${name} must decode to 32 bytes.`);
  return new Uint8Array(bytes);
}

function keyring(env: Env): AutomationKeyring {
  const currentId = required(env, "AUTOMATION_KEY_CURRENT_ID");
  const current: AutomationKeyring["current"] = {
    id: currentId,
    material: decodeKey(required(env, "AUTOMATION_KEY_CURRENT_B64"), "AUTOMATION_KEY_CURRENT_B64"),
  };
  const previousId = env.AUTOMATION_KEY_PREVIOUS_ID?.trim();
  const previousValue = env.AUTOMATION_KEY_PREVIOUS_B64?.trim();
  if ((previousId && !previousValue) || (!previousId && previousValue)) {
    throw new ConfigurationError("AUTOMATION_KEY_PREVIOUS_ID and AUTOMATION_KEY_PREVIOUS_B64 must be provided together.");
  }
  const result = {
    current,
    ...(previousId && previousValue ? {
      previous: { id: previousId, material: decodeKey(previousValue, "AUTOMATION_KEY_PREVIOUS_B64") },
    } : {}),
  };
  try {
    assertKeyring(result);
  } catch {
    throw new ConfigurationError("Automation keyring is invalid.");
  }
  return result;
}

export function assertBrowserProviderSupported(mode: AutomationExecutionMode, provider: AutomationBrowserProvider): void {
  if (mode === "distributed" && provider === "patchright") {
    throw new ConfigurationError("Patchright is not supported in distributed automation mode; use Browserless.");
  }
}

export function parseAutomationWorkerConfig(env: Env): AutomationWorkerConfig {
  const executionMode = oneOf(env, "AUTOMATION_EXECUTION_MODE", "distributed", ["distributed", "local"] as const);
  const browserProvider = oneOf(env, "AUTOMATION_BROWSER_PROVIDER", "browserless", ["browserless", "patchright"] as const);
  assertBrowserProviderSupported(executionMode, browserProvider);

  const browserlessEndpoint = env.BROWSERLESS_ENDPOINT?.trim();
  const browserlessToken = env.BROWSERLESS_TOKEN?.trim();
  if (browserProvider === "browserless" && (!browserlessEndpoint || !browserlessToken)) {
    throw new ConfigurationError("BROWSERLESS_ENDPOINT and BROWSERLESS_TOKEN are required for Browserless mode.");
  }
  if (browserlessEndpoint) {
    const parsedEndpoint = url({ BROWSERLESS_ENDPOINT: browserlessEndpoint }, "BROWSERLESS_ENDPOINT", ["wss:", "ws:", "https:"]);
    const endpoint = new URL(parsedEndpoint);
    if (endpoint.searchParams.has("token")) throw new ConfigurationError("BROWSERLESS_ENDPOINT must not contain a token.");
  }

  const heartbeatIntervalMs = positiveInteger(env, "AUTOMATION_HEARTBEAT_INTERVAL_MS", 10_000);
  const leaseTtlMs = positiveInteger(env, "AUTOMATION_LEASE_TTL_MS", 30_000);
  if (heartbeatIntervalMs >= leaseTtlMs) throw new ConfigurationError("AUTOMATION_HEARTBEAT_INTERVAL_MS must be less than AUTOMATION_LEASE_TTL_MS.");

  return {
    redisUrl: url(env, "REDIS_URL", ["redis:", "rediss:"]),
    jobStream: env.AUTOMATION_JOB_STREAM?.trim() || "hyeboard:automation:jobs",
    eventStream: env.AUTOMATION_EVENT_STREAM?.trim() || "hyeboard:automation:events",
    controlStream: env.AUTOMATION_CONTROL_STREAM?.trim() || "hyeboard:automation:control",
    consumerGroup: env.AUTOMATION_CONSUMER_GROUP?.trim() || "automation-workers",
    consumerName: env.AUTOMATION_CONSUMER_NAME?.trim() || `worker-${process.pid}`,
    controlConsumerGroup: env.AUTOMATION_CONTROL_CONSUMER_GROUP?.trim() || "automation-control-workers",
    controlConsumerName: env.AUTOMATION_CONTROL_CONSUMER_NAME?.trim() || `control-${process.pid}`,
    executionMode,
    browserProvider,
    ...(browserlessEndpoint ? { browserlessEndpoint: url({ BROWSERLESS_ENDPOINT: browserlessEndpoint }, "BROWSERLESS_ENDPOINT", ["wss:", "ws:", "https:"]) } : {}),
    ...(browserlessToken ? { browserlessToken } : {}),
    jobEnvelopeAad: env.AUTOMATION_JOB_ENVELOPE_AAD?.trim() || "hyeboard:automation:job:v1",
    credentialEnvelopeAadPrefix: env.AUTOMATION_CREDENTIAL_AAD_PREFIX?.trim() || "hyeboard:automation:credential:",
    resultEnvelopeAadPrefix: env.AUTOMATION_RESULT_AAD_PREFIX?.trim() || "hyeboard:automation:result:",
    eventEnvelopeAadPrefix: env.AUTOMATION_EVENT_AAD_PREFIX?.trim() || "hyeboard:automation:event:",
    leaseTtlMs,
    heartbeatIntervalMs,
    reclaimIdleMs: positiveInteger(env, "AUTOMATION_RECLAIM_IDLE_MS", leaseTtlMs),
    readBlockMs: positiveInteger(env, "AUTOMATION_READ_BLOCK_MS", 1_000),
    redisConnectTimeoutMs: positiveInteger(env, "AUTOMATION_REDIS_CONNECT_TIMEOUT_MS", 30_000),
    shutdownTimeoutMs: positiveInteger(env, "AUTOMATION_SHUTDOWN_TIMEOUT_MS", 30_000),
    maxDeliveryCount: positiveInteger(env, "AUTOMATION_MAX_DELIVERY_COUNT", 3),
    resultTtlMs: positiveInteger(env, "AUTOMATION_RESULT_TTL_MS", 300_000),
    keyring: keyring(env),
  };
}

export function safeConfigSummary(config: AutomationWorkerConfig): Record<string, unknown> {
  return {
    redisUrl: new URL(config.redisUrl).origin,
    jobStream: config.jobStream,
    eventStream: config.eventStream,
    controlStream: config.controlStream,
    consumerGroup: config.consumerGroup,
    consumerName: config.consumerName,
    controlConsumerGroup: config.controlConsumerGroup,
    controlConsumerName: config.controlConsumerName,
    executionMode: config.executionMode,
    browserProvider: config.browserProvider,
    browserlessEndpoint: config.browserlessEndpoint ? new URL(config.browserlessEndpoint).origin : undefined,
    redisConnectTimeoutMs: config.redisConnectTimeoutMs,
    keyIds: [config.keyring.current.id, config.keyring.previous?.id].filter(Boolean),
  };
}
