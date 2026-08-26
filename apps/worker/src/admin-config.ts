import type { RuntimeConfig } from "./app";
import { parseAdminPasswordHash } from "./admin-auth";

export type AdminAuthMethod = "password" | "github" | "discord";
export type AdminOAuthProviderConfig = Readonly<{
  clientId: string;
  clientSecret: string;
  allowedIds: readonly string[];
}>;
export type AdminAuthConfig = Readonly<{
  sessionSecret: string;
  sessionTtlSeconds: number;
  publicOrigin?: string;
  databasePath?: string;
  passwordHash?: string;
  github?: AdminOAuthProviderConfig;
  discord?: AdminOAuthProviderConfig;
  methods: readonly AdminAuthMethod[];
}>;

const DEFAULT_SESSION_TTL_SECONDS = 3600;
const MAX_SESSION_TTL_SECONDS = 86_400;
const MAX_OAUTH_CLIENT_ID_LENGTH = 256;
const CANONICAL_POSITIVE_INTEGER = /^[1-9]\d*$/;
const NUMERIC_ID = /^[1-9]\d*$/;

function invalid(name: string): never {
  throw new Error(`${name} is invalid.`);
}

function parseTtl(value: string | undefined): number {
  if (value === undefined) return DEFAULT_SESSION_TTL_SECONDS;
  if (!CANONICAL_POSITIVE_INTEGER.test(value)) invalid("HYEB_ADMIN_SESSION_TTL_SECONDS");
  const ttl = Number(value);
  if (!Number.isSafeInteger(ttl) || ttl > MAX_SESSION_TTL_SECONDS) invalid("HYEB_ADMIN_SESSION_TTL_SECONDS");
  return ttl;
}

function parseOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.origin !== value || !["http:", "https:"].includes(url.protocol) || url.protocol === "http:" && !loopback || url.username || url.password) invalid("HYEB_ADMIN_PUBLIC_ORIGIN");
    return value;
  } catch {
    return invalid("HYEB_ADMIN_PUBLIC_ORIGIN");
  }
}

function parseDatabasePath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const windowsFilePath = /^[A-Za-z]:[\\/]/.test(value);
  if (!value || value.includes("\0") || value.startsWith(":") || value.startsWith("//") || value.startsWith("\\\\")
    || !windowsFilePath && /^[A-Za-z][A-Za-z\d+.-]*:/.test(value)) invalid("HYEB_ADMIN_DB_PATH");
  return value;
}

export function parseNumericIdAllowlist(value: string | undefined, name = "numeric ID allowlist"): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  const ids = value.split(",").map((id) => id.trim());
  if (ids.length === 0 || ids.some((id) => !NUMERIC_ID.test(id)) || new Set(ids).size !== ids.length) invalid(name);
  return Object.freeze(ids);
}

function parseOAuth(config: RuntimeConfig, provider: "GITHUB" | "DISCORD"): AdminOAuthProviderConfig | undefined {
  const prefix = `HYEB_ADMIN_${provider}` as const;
  const clientId = config[`${prefix}_CLIENT_ID`];
  const clientSecret = config[`${prefix}_CLIENT_SECRET`];
  const idsValue = config[`${prefix}_IDS`];
  const present = [clientId, clientSecret, idsValue].filter((value) => value !== undefined).length;
  if (present === 0) return undefined;
  if (present !== 3 || !clientId || clientId.length > MAX_OAUTH_CLIENT_ID_LENGTH || !clientSecret) invalid(prefix);
  const allowedIds = parseNumericIdAllowlist(idsValue, prefix);
  if (allowedIds.length === 0) invalid(prefix);
  return Object.freeze({ clientId, clientSecret, allowedIds });
}

export function parseAdminConfig(config: RuntimeConfig): AdminAuthConfig {
  if (typeof config.HYEB_ADMIN_SESSION_SECRET !== "string" || config.HYEB_ADMIN_SESSION_SECRET.length < 32) invalid("HYEB_ADMIN_SESSION_SECRET");

  const publicOrigin = parseOrigin(config.HYEB_ADMIN_PUBLIC_ORIGIN);
  const databasePath = parseDatabasePath(config.HYEB_ADMIN_DB_PATH);
  const github = parseOAuth(config, "GITHUB");
  const discord = parseOAuth(config, "DISCORD");
  if ((github || discord) && !publicOrigin) invalid("HYEB_ADMIN_PUBLIC_ORIGIN");
  const methods: AdminAuthMethod[] = [];
  if (config.HYEB_ADMIN_PASSWORD_HASH !== undefined) {
    try { parseAdminPasswordHash(config.HYEB_ADMIN_PASSWORD_HASH); } catch { invalid("HYEB_ADMIN_PASSWORD_HASH"); }
    methods.push("password");
  }
  if (github) methods.push("github");
  if (discord) methods.push("discord");

  return Object.freeze({
    sessionSecret: config.HYEB_ADMIN_SESSION_SECRET,
    sessionTtlSeconds: parseTtl(config.HYEB_ADMIN_SESSION_TTL_SECONDS),
    ...(publicOrigin === undefined ? {} : { publicOrigin }),
    ...(databasePath === undefined ? {} : { databasePath }),
    ...(config.HYEB_ADMIN_PASSWORD_HASH === undefined ? {} : { passwordHash: config.HYEB_ADMIN_PASSWORD_HASH }),
    ...(github ? { github } : {}),
    ...(discord ? { discord } : {}),
    methods: Object.freeze(methods),
  });
}
