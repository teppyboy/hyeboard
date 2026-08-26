import { configureLogger } from "@hyeboard/core";
import { env } from "cloudflare:workers";
import { CloudflareAdapter } from "elysia/adapter/cloudflare-worker";
import { createApp, setAdminLoginRateLimit, setCaptchaRelayCoordinator, setCloudflareBrowserBinding, setFeaturePolicyRuntime, setRuntimeConfig, setVnuProbeBudgetCoordinator, setVnuRefreshControlCoordinator } from "./app";
import { DurableObjectCaptchaRelayCoordinator } from "./captcha-relay-cloudflare";
import { DurableObjectVnuProbeBudgetCoordinator } from "./vnu-probe-budget";
import { DurableObjectVnuRefreshControlCoordinator } from "./vnu-refresh-control";
import { DurableObjectFeaturePolicyEvents, DurableObjectFeaturePolicyStore } from "./feature-policy-cloudflare";
import { FeaturePolicyRuntime } from "./feature-policy-store";

export { CaptchaRelayDurableObject } from "./captcha-relay-durable-object";
export { FeaturePolicyDurableObject } from "./feature-policy-durable-object";
export { VnuProbeBudgetDurableObject } from "./vnu-probe-budget-durable-object";
export { VnuRefreshControlDurableObject } from "./vnu-refresh-control-durable-object";

const cfEnv = env;
const adminEnv = cfEnv as typeof cfEnv & Partial<Pick<import("./app").RuntimeConfig,
  | "HYEB_ADMIN_SESSION_SECRET"
  | "HYEB_ADMIN_SESSION_TTL_SECONDS"
  | "HYEB_ADMIN_PASSWORD_HASH"
  | "HYEB_ADMIN_PUBLIC_ORIGIN"
  | "HYEB_ADMIN_GITHUB_CLIENT_ID"
  | "HYEB_ADMIN_GITHUB_CLIENT_SECRET"
  | "HYEB_ADMIN_GITHUB_IDS"
  | "HYEB_ADMIN_DISCORD_CLIENT_ID"
  | "HYEB_ADMIN_DISCORD_CLIENT_SECRET"
  | "HYEB_ADMIN_DISCORD_IDS"
>>;

configureLogger({ level: cfEnv.HYEB_LOG_LEVEL, mode: "browser" });
setRuntimeConfig({
  HYEB_SESSION_SECRET: cfEnv.HYEB_SESSION_SECRET,
  HYEB_ALLOWED_ORIGINS: cfEnv.HYEB_ALLOWED_ORIGINS,
  HYEB_BROWSER_WS_ENDPOINT: cfEnv.HYEB_BROWSER_WS_ENDPOINT,
  HYEB_LOG_LEVEL: cfEnv.HYEB_LOG_LEVEL,
  VNU_CODE_LOOKUP_CONCURRENCY: cfEnv.VNU_CODE_LOOKUP_CONCURRENCY,
  VNU_CROSS_LOOKUP_BULK_MAX_TARGETS: cfEnv.VNU_CROSS_LOOKUP_BULK_MAX_TARGETS,
  VNU_CROSS_LOOKUP_DIRECT_CHUNK_MAX_TARGETS: cfEnv.VNU_CROSS_LOOKUP_DIRECT_CHUNK_MAX_TARGETS,
  VNU_CODE_LOOKUP_BULK_TARGET_CONCURRENCY: cfEnv.VNU_CODE_LOOKUP_BULK_TARGET_CONCURRENCY,
  VNU_CROSS_LOOKUP_REQUEST_TIMEOUT_MS: cfEnv.VNU_CROSS_LOOKUP_REQUEST_TIMEOUT_MS,
  VNU_CROSS_DETAIL_MAX_TARGETS: cfEnv.VNU_CROSS_DETAIL_MAX_TARGETS,
  VNU_CROSS_DETAIL_MAX_ROWS: cfEnv.VNU_CROSS_DETAIL_MAX_ROWS,
  VNU_CROSS_DETAIL_CONCURRENCY: cfEnv.VNU_CROSS_DETAIL_CONCURRENCY,
  VNU_CROSS_DETAIL_BUDGET: cfEnv.VNU_CROSS_DETAIL_BUDGET,
  VNU_CROSS_DETAIL_WINDOW_SECONDS: cfEnv.VNU_CROSS_DETAIL_WINDOW_SECONDS,
  VNU_CROSS_DETAIL_PERMIT_TTL_SECONDS: cfEnv.VNU_CROSS_DETAIL_PERMIT_TTL_SECONDS,
  VNU_CROSS_DETAIL_EXPORT_MODE: cfEnv.VNU_CROSS_DETAIL_EXPORT_MODE,
  HYEB_ADMIN_SESSION_SECRET: adminEnv.HYEB_ADMIN_SESSION_SECRET,
  HYEB_ADMIN_SESSION_TTL_SECONDS: adminEnv.HYEB_ADMIN_SESSION_TTL_SECONDS,
  HYEB_ADMIN_PASSWORD_HASH: adminEnv.HYEB_ADMIN_PASSWORD_HASH,
  HYEB_ADMIN_PUBLIC_ORIGIN: adminEnv.HYEB_ADMIN_PUBLIC_ORIGIN,
  HYEB_ADMIN_GITHUB_CLIENT_ID: adminEnv.HYEB_ADMIN_GITHUB_CLIENT_ID,
  HYEB_ADMIN_GITHUB_CLIENT_SECRET: adminEnv.HYEB_ADMIN_GITHUB_CLIENT_SECRET,
  HYEB_ADMIN_GITHUB_IDS: adminEnv.HYEB_ADMIN_GITHUB_IDS,
  HYEB_ADMIN_DISCORD_CLIENT_ID: adminEnv.HYEB_ADMIN_DISCORD_CLIENT_ID,
  HYEB_ADMIN_DISCORD_CLIENT_SECRET: adminEnv.HYEB_ADMIN_DISCORD_CLIENT_SECRET,
  HYEB_ADMIN_DISCORD_IDS: adminEnv.HYEB_ADMIN_DISCORD_IDS,
});
setCloudflareBrowserBinding(cfEnv.BROWSER);
setCaptchaRelayCoordinator(new DurableObjectCaptchaRelayCoordinator(cfEnv.CAPTCHA_RELAY));
setVnuProbeBudgetCoordinator(new DurableObjectVnuProbeBudgetCoordinator(cfEnv.VNU_PROBE_BUDGET));
setVnuRefreshControlCoordinator(new DurableObjectVnuRefreshControlCoordinator(cfEnv.VNU_REFRESH_CONTROL));
const featurePolicyStore = new DurableObjectFeaturePolicyStore(cfEnv.FEATURE_POLICY);
setAdminLoginRateLimit({
  consume: (bucketHash, limit, windowMs) => featurePolicyStore.consumeAdminLoginAttempt(bucketHash, limit, windowMs),
});
setFeaturePolicyRuntime(new FeaturePolicyRuntime(
  featurePolicyStore,
  new DurableObjectFeaturePolicyEvents(cfEnv.FEATURE_POLICY),
));

export default createApp(CloudflareAdapter, {
  clientIp: (request) => request.headers.get("CF-Connecting-IP") ?? undefined,
});
