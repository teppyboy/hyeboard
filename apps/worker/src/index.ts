import { configureLogger } from "@hyeboard/core";
import { env } from "cloudflare:workers";
import { CloudflareAdapter } from "elysia/adapter/cloudflare-worker";
import { createApp, setCaptchaRelayCoordinator, setCloudflareBrowserBinding, setRuntimeConfig } from "./app";
import { DurableObjectCaptchaRelayCoordinator } from "./captcha-relay-cloudflare";

export { CaptchaRelayDurableObject } from "./captcha-relay-durable-object";

const cfEnv = env;

configureLogger({ level: cfEnv.HYEB_LOG_LEVEL, mode: "browser" });
setRuntimeConfig({
  HYEB_SESSION_SECRET: cfEnv.HYEB_SESSION_SECRET,
  HYEB_ALLOWED_ORIGINS: cfEnv.HYEB_ALLOWED_ORIGINS,
  HYEB_BROWSER_WS_ENDPOINT: cfEnv.HYEB_BROWSER_WS_ENDPOINT,
  HYEB_LOG_LEVEL: cfEnv.HYEB_LOG_LEVEL,
});
setCloudflareBrowserBinding(cfEnv.BROWSER);
setCaptchaRelayCoordinator(new DurableObjectCaptchaRelayCoordinator(cfEnv.CAPTCHA_RELAY));

export default createApp(CloudflareAdapter);
