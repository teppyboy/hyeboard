import { describe, expect, it } from "vitest";
import { parsePlaywrightRuntimeConfig } from "./playwright-runtime-config.mjs";

describe("Playwright runtime config", () => {
  it("provides one coupled default topology", () => {
    expect(parsePlaywrightRuntimeConfig({})).toEqual({
      host: "127.0.0.1",
      vitePort: 5173,
      workerPort: 8787,
      workers: 1,
      baseUrl: "http://127.0.0.1:5173",
      proxyTarget: "http://127.0.0.1:8787",
    });
  });

  it("parses explicit ports and controlled worker counts", () => {
    expect(parsePlaywrightRuntimeConfig({ PW_VITE_HOST: "localhost", PW_VITE_PORT: "5175", PW_WORKER_PORT: "8789", PW_WORKERS: "6" }))
      .toMatchObject({ host: "localhost", vitePort: 5175, workerPort: 8789, workers: 6, proxyTarget: "http://127.0.0.1:8789" });
  });

  it.each([
    [{ PW_WORKERS: "0" }, "PW_WORKERS must be between 1 and 6"],
    [{ PW_WORKERS: "7" }, "PW_WORKERS must be between 1 and 6"],
    [{ PW_WORKERS: "4.5" }, "PW_WORKERS must be an integer"],
    [{ PW_VITE_PORT: "8787" }, "PW_VITE_PORT and PW_WORKER_PORT must differ"],
    [{ PW_VITE_PORT: "0" }, "PW_VITE_PORT must be between 1 and 65535"],
    [{ PW_VITE_HOST: "127.0.0.1 && whoami" }, "PW_VITE_HOST must be localhost, an IPv4 address, or a valid DNS hostname"],
    [{ PW_VITE_HOST: "localhost;echo" }, "PW_VITE_HOST must be localhost, an IPv4 address, or a valid DNS hostname"],
    [{ PW_VITE_HOST: "256.1.1.1" }, "PW_VITE_HOST must be localhost, an IPv4 address, or a valid DNS hostname"],
  ])("rejects invalid environment %j", (environment, message) => {
    expect(() => parsePlaywrightRuntimeConfig(environment)).toThrow(message);
  });
});
