import { fileURLToPath } from "node:url";
import { BunAdapter } from "elysia/adapter/bun";
import { createApp, setRuntimeConfig } from "./app";
import { registerStaticAssets } from "./serve-static";

// Self-hosted entry point for Bun — no Cloudflare-specific APIs.
// Config comes from process.env (Bun also populates process.env from its
// own .env loading); HYEB_BROWSER_WS_ENDPOINT must point at a running
// headless-Chrome CDP endpoint (e.g. a browserless/chrome or
// ghcr.io/puppeteer/puppeteer container) for the UET Google-login
// automation feature to work — without it, that one feature fails with
// SERVER_CONFIG_ERROR while every other route works normally.
setRuntimeConfig({
  HYEB_SESSION_SECRET: process.env.HYEB_SESSION_SECRET,
  HYEB_ALLOWED_ORIGINS: process.env.HYEB_ALLOWED_ORIGINS,
  HYEB_BROWSER_WS_ENDPOINT: process.env.HYEB_BROWSER_WS_ENDPOINT,
});

const app = createApp(BunAdapter);
const distDir = fileURLToPath(new URL("../../web/dist", import.meta.url));
registerStaticAssets(app, distDir);

const port = Number(process.env.PORT ?? 8787);
app.listen(port);

console.log(`Hyeboard (Bun) listening on http://localhost:${port}`);
