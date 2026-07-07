import { defineConfig, devices } from "@playwright/test";

function env(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

const PW_VITE_HOST = env("PW_VITE_HOST", "127.0.0.1");
const PW_VITE_PORT = env("PW_VITE_PORT", "5173");
const PW_WORKER_PORT = env("PW_WORKER_PORT", "8787");

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://${PW_VITE_HOST}:${PW_VITE_PORT}`,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: `pnpm --filter @hyeboard/worker dev --port ${PW_WORKER_PORT}`,
      url: `http://127.0.0.1:${PW_WORKER_PORT}/api/health`,
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: `pnpm --filter @hyeboard/web dev --host ${PW_VITE_HOST} --strictPort --port ${PW_VITE_PORT}`,
      url: `http://${PW_VITE_HOST}:${PW_VITE_PORT}`,
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-safari", use: { ...devices["iPhone 13"] } },
  ],
});
