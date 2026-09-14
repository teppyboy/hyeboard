import type { AdminActor } from "@hyeboard/schemas";
import type { AdminOAuthProviderConfig } from "./admin-config";

export type AdminSession = {
  version: 1;
  purpose: "hyeboard-admin";
  actor: AdminActor;
  csrfToken: string;
  issuedAt: string;
  expiresAt: string;
};
export type OAuthProvider = "github" | "discord";
export type AdminOAuthState = {
  version: 1;
  purpose: "hyeboard-admin-oauth";
  provider: OAuthProvider;
  state: string;
  verifier: string;
  returnPath: string;
  issuedAt: string;
  expiresAt: string;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const PASSWORD_ITERATIONS = 31 * 10_000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const ADMIN_COOKIE = "hyeboard_admin";
const OAUTH_COOKIE = "hyeboard_admin_oauth";
const NUMERIC_ID = /^(0|[1-9]\d*)$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SESSION_KEYS = ["version", "purpose", "actor", "csrfToken", "issuedAt", "expiresAt"];
const STATE_KEYS = ["version", "purpose", "provider", "state", "verifier", "returnPath", "issuedAt", "expiresAt"];
const SESSION_SALT = textEncoder.encode("hyeboard:admin-session:v1:salt");
const SESSION_INFO = textEncoder.encode("hyeboard:admin-session:v1:aes-gcm");
const SESSION_AAD = textEncoder.encode("hyeboard:admin-session:v1");
const STATE_SALT = textEncoder.encode("hyeboard:admin-oauth-state:v1:salt");
const STATE_INFO = textEncoder.encode("hyeboard:admin-oauth-state:v1:aes-gcm");
const STATE_AAD = textEncoder.encode("hyeboard:admin-oauth-state:v1");

function invalidHash(): Error { return new Error("Admin password hash is invalid."); }
function invalidSession(): Error { return new Error("Admin session is invalid or expired."); }
function invalidState(): Error { return new Error("OAuth state is invalid or expired."); }
function unauthorized(): Error { return new Error("Admin request is unauthorized."); }
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function fromBase64Url(value: string): Uint8Array {
  if (!BASE64URL.test(value)) throw new Error("Invalid base64url");
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
function randomBase64Url(length: number): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(length)));
}
function isBase64UrlBytes(value: unknown, length: number): value is string {
  if (typeof value !== "string" || !BASE64URL.test(value)) return false;
  try {
    const bytes = fromBase64Url(value);
    return bytes.byteLength === length && toBase64Url(bytes) === value;
  } catch {
    return false;
  }
}
function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}
function canonicalTime(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : undefined;
}
function validActor(value: unknown): value is AdminActor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (!exactObject(value, Object.hasOwn(value, "label") ? ["method", "subject", "label"] : ["method", "subject"])) return false;
  return ["password", "github", "discord"].includes(String(value.method))
    && typeof value.subject === "string" && value.subject.length > 0 && value.subject.length <= 128
    && (value.label === undefined || typeof value.label === "string" && value.label.length > 0 && value.label.length <= 128);
}
function validReturnPath(value: unknown): value is string {
  return typeof value === "string" && (value === "/admin" || value.startsWith("/admin/")) && !value.includes("\\") && !value.startsWith("//");
}
function assertSecret(secret: string): void {
  if (secret.length < 32) throw new Error("Admin session secret must contain at least 32 characters.");
}

export function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== 32 || right.byteLength !== 32) throw invalidHash();
  let difference = 0;
  for (let index = 0; index < 32; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

export function parseAdminPasswordHash(encoded: string): { iterations: number; salt: Uint8Array; digest: Uint8Array } {
  try {
    const parts = encoded.split("$");
    if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256" || parts[1] !== String(PASSWORD_ITERATIONS)) throw invalidHash();
    const salt = fromBase64Url(parts[2]!);
    const digest = fromBase64Url(parts[3]!);
    if (salt.byteLength !== 16 || digest.byteLength !== 32 || toBase64Url(salt) !== parts[2] || toBase64Url(digest) !== parts[3]) throw invalidHash();
    return { iterations: PASSWORD_ITERATIONS, salt, digest };
  } catch {
    throw invalidHash();
  }
}

async function derivePassword(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", textEncoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: toArrayBuffer(salt), iterations: PASSWORD_ITERATIONS }, key, 256));
}

export async function createAdminPasswordHash(password: string, salt = crypto.getRandomValues(new Uint8Array(16))): Promise<string> {
  if (!password || salt.byteLength !== 16) throw invalidHash();
  const digest = await derivePassword(password, salt);
  return `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(digest)}`;
}

export async function verifyAdminPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = parseAdminPasswordHash(encoded);
  return timingSafeEqual(await derivePassword(password, parsed.salt), parsed.digest);
}

async function deriveEnvelopeKey(secret: string, salt: Uint8Array, info: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  assertSecret(secret);
  const material = await crypto.subtle.importKey("raw", textEncoder.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: toArrayBuffer(salt), info: toArrayBuffer(info) }, material, { name: "AES-GCM", length: 256 }, false, usages);
}
async function encryptEnvelope(value: unknown, secret: string, salt: Uint8Array, info: Uint8Array, aad: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveEnvelopeKey(secret, salt, info, ["encrypt"]);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: toArrayBuffer(iv), additionalData: toArrayBuffer(aad) }, key, textEncoder.encode(JSON.stringify(value)));
  return `${toBase64Url(iv)}.${toBase64Url(new Uint8Array(encrypted))}`;
}
async function decryptEnvelope(token: string, secret: string, salt: Uint8Array, info: Uint8Array, aad: Uint8Array): Promise<unknown> {
  const parts = token.split(".");
  if (parts.length !== 2) throw new Error("Invalid envelope");
  const iv = fromBase64Url(parts[0]!);
  const encrypted = fromBase64Url(parts[1]!);
  if (iv.byteLength !== 12 || encrypted.byteLength < 17 || toBase64Url(iv) !== parts[0] || toBase64Url(encrypted) !== parts[1]) throw new Error("Invalid envelope");
  const key = await deriveEnvelopeKey(secret, salt, info, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: toArrayBuffer(iv), additionalData: toArrayBuffer(aad) }, key, toArrayBuffer(encrypted));
  return JSON.parse(textDecoder.decode(plaintext)) as unknown;
}

export function createAdminSession(actor: AdminActor, ttlSeconds: number, now = new Date()): AdminSession {
  if (!validActor(actor) || !Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) throw invalidSession();
  return { version: 1, purpose: "hyeboard-admin", actor, csrfToken: randomBase64Url(32), issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString() };
}
export function encryptAdminSession(session: AdminSession, secret: string): Promise<string> {
  assertAdminSession(session, new Date(session.issuedAt));
  return encryptEnvelope(session, secret, SESSION_SALT, SESSION_INFO, SESSION_AAD);
}
function assertAdminSession(value: unknown, now: Date): asserts value is AdminSession {
  if (!exactObject(value, SESSION_KEYS) || value.version !== 1 || value.purpose !== "hyeboard-admin" || !validActor(value.actor)
    || !isBase64UrlBytes(value.csrfToken, 32)) throw invalidSession();
  const issuedAt = canonicalTime(value.issuedAt);
  const expiresAt = canonicalTime(value.expiresAt);
  if (issuedAt === undefined || expiresAt === undefined || issuedAt >= expiresAt || now.getTime() < issuedAt || now.getTime() >= expiresAt) throw invalidSession();
}
export async function decryptAdminSession(token: string, secret: string, now = new Date()): Promise<AdminSession> {
  try {
    const value = await decryptEnvelope(token, secret, SESSION_SALT, SESSION_INFO, SESSION_AAD);
    assertAdminSession(value, now);
    return value;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Admin session secret")) throw error;
    throw invalidSession();
  }
}

function cookie(name: string, value: string, maxAge: number, secure: boolean): string {
  return `${name}=${value}; Max-Age=${maxAge}; Path=/api/admin; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}
export function buildAdminSessionCookie(token: string, ttlSeconds: number, secure: boolean): string { return cookie(ADMIN_COOKIE, token, ttlSeconds, secure); }
export function buildClearAdminSessionCookie(secure: boolean): string { return cookie(ADMIN_COOKIE, "", 0, secure); }
export function buildOAuthStateCookie(token: string, secure: boolean): string { return cookie(OAUTH_COOKIE, token, OAUTH_STATE_TTL_MS / 1000, secure); }
export function buildClearOAuthStateCookie(secure: boolean): string { return cookie(OAUTH_COOKIE, "", 0, secure); }
export function readCookie(request: Request, name: typeof ADMIN_COOKIE | typeof OAUTH_COOKIE): string | undefined {
  return request.headers.get("Cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) || undefined;
}
export async function authenticateAdminRequest(request: Request, secret: string, now = new Date()): Promise<AdminSession> {
  if (request.headers.has("Authorization")) throw unauthorized();
  const token = readCookie(request, ADMIN_COOKIE);
  if (!token) throw unauthorized();
  return decryptAdminSession(token, secret, now);
}

export function assertAdminMutation(request: Request, session: AdminSession, allowedOrigin?: string): void {
  if (request.headers.has("Authorization")) throw unauthorized();
  const origin = request.headers.get("Origin");
  const requestOrigin = new URL(request.url).origin;
  if (origin === null || origin !== requestOrigin && origin !== allowedOrigin) throw unauthorized();
  if (request.headers.get("X-Hyeboard-CSRF") !== session.csrfToken) throw unauthorized();
  if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw unauthorized();
}

function assertOAuthState(value: unknown, provider: OAuthProvider, expectedState: string, now: Date): asserts value is AdminOAuthState {
  if (!exactObject(value, STATE_KEYS) || value.version !== 1 || value.purpose !== "hyeboard-admin-oauth" || value.provider !== provider
    || value.state !== expectedState || !isBase64UrlBytes(value.state, 24) || !isBase64UrlBytes(value.verifier, 32)
    || !validReturnPath(value.returnPath)) throw invalidState();
  const issuedAt = canonicalTime(value.issuedAt);
  const expiresAt = canonicalTime(value.expiresAt);
  if (issuedAt === undefined || expiresAt === undefined || expiresAt - issuedAt !== OAUTH_STATE_TTL_MS || now.getTime() < issuedAt || now.getTime() >= expiresAt) throw invalidState();
}
export function adminOAuthCallbackUrl(publicOrigin: string, provider: OAuthProvider): string {
  const origin = new URL(publicOrigin);
  if (origin.origin !== publicOrigin) throw invalidState();
  return `${publicOrigin}/api/admin/oauth/${provider}/callback`;
}
export async function derivePkceS256Challenge(verifier: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", textEncoder.encode(verifier))));
}

export async function createOAuthAuthorization(provider: OAuthProvider, secret: string, clientId: string, returnPath = "/admin", now = new Date(), redirectUri?: string): Promise<{ url: string; stateCookieValue: string }> {
  if (!clientId || !validReturnPath(returnPath)) throw invalidState();
  const state = randomBase64Url(24);
  const verifier = randomBase64Url(32);
  const payload: AdminOAuthState = { version: 1, purpose: "hyeboard-admin-oauth", provider, state, verifier, returnPath, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + OAUTH_STATE_TTL_MS).toISOString() };
  const url = new URL(provider === "github" ? "https://github.com/login/oauth/authorize" : "https://discord.com/oauth2/authorize");
  url.search = new URLSearchParams({ client_id: clientId, response_type: "code", scope: provider === "github" ? "read:user" : "identify", state, code_challenge: await derivePkceS256Challenge(verifier), code_challenge_method: "S256", ...(redirectUri ? { redirect_uri: redirectUri } : {}) }).toString();
  return { url: url.toString(), stateCookieValue: await encryptEnvelope(payload, secret, STATE_SALT, STATE_INFO, STATE_AAD) };
}
export async function decryptOAuthState(token: string, secret: string, provider: OAuthProvider, expectedState: string, now = new Date()): Promise<AdminOAuthState> {
  try {
    const value = await decryptEnvelope(token, secret, STATE_SALT, STATE_INFO, STATE_AAD);
    assertOAuthState(value, provider, expectedState, now);
    return value;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Admin session secret")) throw error;
    throw invalidState();
  }
}

export async function exchangeOAuthCode(provider: OAuthProvider, config: AdminOAuthProviderConfig, code: string, verifier: string, redirectUri: string, fetcher: typeof fetch = fetch): Promise<AdminActor> {
  try {
    if (!code || !verifier) throw unauthorized();
    const tokenUrl = provider === "github" ? "https://github.com/login/oauth/access_token" : "https://discord.com/api/oauth2/token";
    const tokenResponse = await fetcher(tokenUrl, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: "authorization_code" }) });
    if (!tokenResponse.ok) throw unauthorized();
    const tokenBody = await tokenResponse.json() as Record<string, unknown>;
    if (typeof tokenBody.access_token !== "string" || !tokenBody.access_token) throw unauthorized();
    const userUrl = provider === "github" ? "https://api.github.com/user" : "https://discord.com/api/users/@me";
    const userResponse = await fetcher(userUrl, { headers: { Accept: "application/json", Authorization: `Bearer ${tokenBody.access_token}` } });
    if (!userResponse.ok) throw unauthorized();
    const user = await userResponse.json() as Record<string, unknown>;
    const id = typeof user.id === "number" && Number.isSafeInteger(user.id) ? String(user.id) : user.id;
    if (typeof id !== "string" || !NUMERIC_ID.test(id) || !config.allowedIds.includes(id)) throw unauthorized();
    const labelValue = provider === "github" ? user.login : user.global_name ?? user.username;
    const label = typeof labelValue === "string" && labelValue.length > 0 ? labelValue.slice(0, 128) : undefined;
    return { method: provider, subject: id, ...(label ? { label } : {}) };
  } catch {
    throw unauthorized();
  }
}
