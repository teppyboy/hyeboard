import type { ApiError, ApiResponse } from "@hyeboard/schemas";

export type UpstreamCredential = {
  kind: "bearer" | "cookie" | "manual";
  value: string;
  csrfToken?: string;
  expiresAt?: string;
};

export type EncryptedSessionPayload = {
  version: 1;
  universityId: string;
  studentCode?: string;
  studenthub?: UpstreamCredential;
  canvas?: UpstreamCredential;
  vnu?: UpstreamCredential;
  expiresAt: string;
};

export function ok<T>(data: T, meta?: Record<string, unknown>): ApiResponse<T> {
  return { data, error: null, meta };
}

export function fail(code: string, message: string, details?: unknown): ApiResponse<never> {
  const error: ApiError = { code, message, details };
  return { data: null, error };
}

export class HyeboardError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 500,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export function assertSupported(value: boolean, feature: string): void {
  if (!value) throw new HyeboardError("UNSUPPORTED_FEATURE", `${feature} is not supported by this university`, 501);
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function addHours(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

export function isExpired(isoDate: string): boolean {
  return new Date(isoDate).getTime() <= Date.now();
}

export function parseBearerToken(authorizationHeader?: string | null): string | null {
  if (!authorizationHeader) return null;
  const [scheme, token] = authorizationHeader.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function deriveKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSession(payload: EncryptedSessionPayload, secret: string): Promise<string> {
  if (secret.length < 32) throw new HyeboardError("WEAK_SESSION_SECRET", "HYEB_SESSION_SECRET must be at least 32 characters", 500);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(secret);
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: toArrayBuffer(iv) }, key, toArrayBuffer(encoded)));
  return `${toBase64Url(iv)}.${toBase64Url(encrypted)}`;
}

export async function decryptSession(token: string, secret: string): Promise<EncryptedSessionPayload> {
  try {
    const [ivPart, payloadPart] = token.split(".");
    if (!ivPart || !payloadPart) throw new Error("Malformed token");
    const key = await deriveKey(secret);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: toArrayBuffer(fromBase64Url(ivPart)) }, key, toArrayBuffer(fromBase64Url(payloadPart)));
    const payload = JSON.parse(new TextDecoder().decode(decrypted)) as EncryptedSessionPayload;
    if (payload.version !== 1) throw new Error("Unsupported token version");
    if (isExpired(payload.expiresAt)) throw new HyeboardError("SESSION_EXPIRED", "Session expired", 401);
    return payload;
  } catch (error) {
    if (error instanceof HyeboardError) throw error;
    throw new HyeboardError("INVALID_SESSION", "Invalid session token", 401);
  }
}

export function unwrapStudentHubEnvelope<T>(input: { code?: unknown; msgCode?: unknown; data?: T } | T): T {
  if (input && typeof input === "object" && "data" in input && "code" in input) {
    return (input as { data: T }).data;
  }
  return input as T;
}

export function combineDateTime(date?: string, time?: string): string {
  if (!date && !time) return isoNow();
  if (date && !time) return new Date(date).toISOString();
  const normalized = `${date ?? new Date().toISOString().slice(0, 10)}T${time}`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? isoNow() : parsed.toISOString();
}
