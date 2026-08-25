import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./test/captcha-relay-worker.ts",
      miniflare: {
        compatibilityDate: "2026-07-02",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: {
          CAPTCHA_RELAY: {
            className: "CaptchaRelayDurableObject",
            useSQLite: true,
          },
          FEATURE_POLICY: {
            className: "FeaturePolicyDurableObject",
            useSQLite: true,
          },
          VNU_PROBE_BUDGET: {
            className: "VnuProbeBudgetDurableObject",
            useSQLite: true,
          },
          VNU_REFRESH_CONTROL: {
            className: "VnuRefreshControlDurableObject",
            useSQLite: true,
          },
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.workers.ts"],
    maxWorkers: process.env.HYEB_COMBINED_GATE === "1" ? 1 : undefined,
  },
});
