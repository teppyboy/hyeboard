import { defineConfig, devices } from "@playwright/test";
import { playwrightRuntimeConfig as runtime } from "./src/lib/playwright-runtime-config.mjs";

export default defineConfig({
  testDir: "./tests",
  outputDir: "./test-results/playwright",
  testMatch: /.*\.spec\.ts/,
  testIgnore: /smoke\.spec\.ts/,
  fullyParallel: true,
  // Wrangler/Miniflare's loopback ProxyController is unstable under parallel browser load.
  workers: runtime.workers,
  retries: 0,
  reporter: process.env.PLAYWRIGHT_JSON_OUTPUT_FILE ? [["json"]] : [["line"]],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: runtime.baseUrl,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: `pnpm --filter @hyeboard/worker dev --port ${runtime.workerPort}`,
      url: `${runtime.proxyTarget}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        ...process.env,
        HYEB_SESSION_SECRET: process.env.HYEB_SESSION_SECRET ?? "synthetic-playwright-session-secret-32-bytes",
      },
    },
    {
      command: `pnpm --filter @hyeboard/web dev --host ${runtime.host} --strictPort --port ${runtime.vitePort}`,
      url: runtime.baseUrl,
      reuseExistingServer: false,
      env: { ...process.env, VITE_PROXY_TARGET: runtime.proxyTarget },
      timeout: 60_000,
    },
  ],
  projects: [
    { name: "chromium", grepInvert: /@webkit/, use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", grep: /@webkit/, use: { ...devices["iPhone 13"] } },
  ],
});
