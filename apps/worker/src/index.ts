import { env } from "cloudflare:workers";
import { CloudflareAdapter } from "elysia/adapter/cloudflare-worker";
import { createApp, setCloudflareBrowserBinding, setRuntimeConfig } from "./app";

type AppEnv = Env;

function appEnv(): AppEnv {
  return env as unknown as AppEnv;
}

// Cloudflare Workers vars/secrets aren't guaranteed to be mirrored onto
// process.env, so pass the real `env` object explicitly rather than relying
// on app.ts's process.env default (which Node/Bun entry points use instead).
setRuntimeConfig({
  HYEB_SESSION_SECRET: appEnv().HYEB_SESSION_SECRET,
  HYEB_ALLOWED_ORIGINS: appEnv().HYEB_ALLOWED_ORIGINS,
  HYEB_BROWSER_WS_ENDPOINT: appEnv().HYEB_BROWSER_WS_ENDPOINT,
});
setCloudflareBrowserBinding(appEnv().BROWSER);

const app = createApp(CloudflareAdapter);

export default app;
