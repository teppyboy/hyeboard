const DEFAULT_VITE_HOST = "127.0.0.1";
const DEFAULT_VITE_PORT = 5173;
const DEFAULT_WORKER_PORT = 8787;
const DEFAULT_WORKERS = 1;

function parseInteger(name, rawValue, fallback) {
  const value = rawValue === undefined ? fallback : Number(rawValue);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function parsePort(name, rawValue, fallback) {
  const port = parseInteger(name, rawValue, fallback);
  if (port < 1 || port > 65_535) throw new Error(`${name} must be between 1 and 65535`);
  return port;
}

function isValidIpv4(host) {
  const parts = host.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isValidHostname(host) {
  if (host.length > 253 || !host.includes(".")) return false;
  return host.split(".").every((label) => (
    label.length >= 1
    && label.length <= 63
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
  ));
}

function parseHost(rawValue) {
  const host = rawValue?.trim() || DEFAULT_VITE_HOST;
  if (host === "localhost" || isValidIpv4(host)) return host;
  if (!/^\d+(?:\.\d+){3}$/.test(host) && isValidHostname(host)) return host;
  throw new Error("PW_VITE_HOST must be localhost, an IPv4 address, or a valid DNS hostname");
}

export function parsePlaywrightRuntimeConfig(environment = {}) {
  const host = parseHost(environment.PW_VITE_HOST);
  const vitePort = parsePort("PW_VITE_PORT", environment.PW_VITE_PORT, DEFAULT_VITE_PORT);
  const workerPort = parsePort("PW_WORKER_PORT", environment.PW_WORKER_PORT, DEFAULT_WORKER_PORT);
  const workers = parseInteger("PW_WORKERS", environment.PW_WORKERS, DEFAULT_WORKERS);

  if (vitePort === workerPort) throw new Error("PW_VITE_PORT and PW_WORKER_PORT must differ");
  if (workers < 1 || workers > 6) throw new Error("PW_WORKERS must be between 1 and 6");

  return Object.freeze({
    host,
    vitePort,
    workerPort,
    workers,
    baseUrl: `http://${host}:${vitePort}`,
    proxyTarget: `http://127.0.0.1:${workerPort}`,
  });
}

export const playwrightRuntimeConfig = parsePlaywrightRuntimeConfig(process.env);
