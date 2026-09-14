import type { EncryptedSessionPayload } from "@hyeboard/core";

export const HA_MODES = ["cloudflare", "distributed", "memory"] as const;
export type HaMode = (typeof HA_MODES)[number];

export const DEFAULT_HA_CONFIG: HaConfig = {
  mode: "memory",
  sessionEpoch: 0,
  enforceSessionEpoch: false,
};

export type HaConfig = {
  mode: HaMode;
  nodeId?: string;
  sessionEpoch: number;
  enforceSessionEpoch: boolean;
};

export type HaEnvironment = Readonly<Record<string, string | undefined>>;

export type HaFileConfig = {
  ha?: {
    mode?: unknown;
    node_id?: unknown;
    session_epoch?: unknown;
    enforce_session_epoch?: unknown;
  };
};

export type HaConfigSetting =
  | "HYEB_HA_MODE"
  | "HYEB_HA_NODE_ID"
  | "HYEB_HA_SESSION_EPOCH"
  | "HYEB_HA_ENFORCE_SESSION_EPOCH";

export type HaConfigWarning = (setting: HaConfigSetting, effectiveFallback: HaMode | number | boolean | undefined) => void;

const CANONICAL_INTEGER = /^(?:0|[1-9]\d*)$/;
const MAX_NODE_ID_LENGTH = 128;

function envOrFile(environment: HaEnvironment, environmentKey: HaConfigSetting, fileValue: unknown): unknown {
  return environment[environmentKey] !== undefined ? environment[environmentKey] : fileValue;
}

function parseMode(value: unknown): HaMode | undefined {
  return typeof value === "string" && HA_MODES.includes(value as HaMode) ? value as HaMode : undefined;
}

function parseNodeId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_NODE_ID_LENGTH ? value : undefined;
}

function parseSessionEpoch(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  if (typeof value !== "string" || !CANONICAL_INTEGER.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return undefined;
}

export function parseHaConfig(environment: HaEnvironment = {}, fileConfig: HaFileConfig = {}, warn?: HaConfigWarning): HaConfig {
  const fileHa = fileConfig.ha;
  const modeInput = envOrFile(environment, "HYEB_HA_MODE", fileHa?.mode);
  const nodeIdInput = envOrFile(environment, "HYEB_HA_NODE_ID", fileHa?.node_id);
  const epochInput = envOrFile(environment, "HYEB_HA_SESSION_EPOCH", fileHa?.session_epoch);
  const enforceInput = envOrFile(environment, "HYEB_HA_ENFORCE_SESSION_EPOCH", fileHa?.enforce_session_epoch);

  const mode = modeInput === undefined ? DEFAULT_HA_CONFIG.mode : parseMode(modeInput);
  const nodeId = nodeIdInput === undefined ? undefined : parseNodeId(nodeIdInput);
  const sessionEpoch = epochInput === undefined ? DEFAULT_HA_CONFIG.sessionEpoch : parseSessionEpoch(epochInput);
  const requestedEnforcement = enforceInput === undefined ? DEFAULT_HA_CONFIG.enforceSessionEpoch : parseBoolean(enforceInput);

  if (modeInput !== undefined && mode === undefined) warn?.("HYEB_HA_MODE", DEFAULT_HA_CONFIG.mode);
  if (nodeIdInput !== undefined && nodeIdInput !== "" && nodeId === undefined) warn?.("HYEB_HA_NODE_ID", undefined);
  if (epochInput !== undefined && sessionEpoch === undefined) warn?.("HYEB_HA_SESSION_EPOCH", DEFAULT_HA_CONFIG.sessionEpoch);
  if (enforceInput !== undefined && requestedEnforcement === undefined) warn?.("HYEB_HA_ENFORCE_SESSION_EPOCH", DEFAULT_HA_CONFIG.enforceSessionEpoch);

  const effectiveMode = mode ?? DEFAULT_HA_CONFIG.mode;
  const effectiveEpoch = sessionEpoch ?? DEFAULT_HA_CONFIG.sessionEpoch;
  const enforceSessionEpoch = effectiveMode === "distributed"
    && requestedEnforcement === true
    && epochInput !== undefined
    && sessionEpoch !== undefined;

  // Epoch enforcement is deliberately fail-closed for malformed epochs, but
  // remains opt-in so existing tokens are unaffected by a mode/config rollout.
  if (requestedEnforcement === true && !enforceSessionEpoch) {
    warn?.("HYEB_HA_ENFORCE_SESSION_EPOCH", false);
  }

  return {
    mode: effectiveMode,
    ...(nodeId === undefined ? {} : { nodeId }),
    sessionEpoch: effectiveEpoch,
    enforceSessionEpoch,
  };
}

export type SessionEpochCheck =
  | { accepted: true; reason: "enforcement-disabled" | "legacy-token" | "matching-epoch" }
  | { accepted: false; reason: "missing-session-metadata" | "session-epoch-mismatch" };

export function checkSessionEpoch(payload: Pick<EncryptedSessionPayload, "sessionId" | "sessionEpoch">, config: HaConfig): SessionEpochCheck {
  if (config.mode !== "distributed" || !config.enforceSessionEpoch) return { accepted: true, reason: "enforcement-disabled" };
  if (!payload.sessionId || payload.sessionEpoch === undefined) return { accepted: false, reason: "missing-session-metadata" };
  if (payload.sessionEpoch !== config.sessionEpoch) return { accepted: false, reason: "session-epoch-mismatch" };
  return { accepted: true, reason: "matching-epoch" };
}

export type HaReadinessState = "starting" | "ready" | "degraded" | "draining" | "stopped";

export type HaDependencyReadiness = "ready" | "degraded" | "unavailable";

export type HaReadiness = {
  state: HaReadinessState;
  mode: HaMode;
  checkedAt: string;
  nodeId?: string;
  reason?: string;
  dependencies?: Readonly<Record<string, HaDependencyReadiness>>;
};

export type HaReadinessProbe = () => HaReadiness | Promise<HaReadiness>;

export type HaLifecycle = {
  start(): Promise<void>;
  readiness(): HaReadiness | Promise<HaReadiness>;
  drain(): Promise<void>;
  stop(): Promise<void>;
};
