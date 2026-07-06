import { fileURLToPath } from "node:url";
import { node } from "@elysiajs/node";
import { createApp, setRuntimeConfig } from "./app";
import { registerStaticAssets } from "./serve-static";

// Self-hosted entry point for plain Node.js — no Cloudflare-specific APIs.
// Config comes from process.env (see .env.example); HYEB_BROWSER_WS_ENDPOINT
// must point at a running headless-Chrome CDP endpoint (e.g. a
// browserless/chrome or ghcr.io/puppeteer/puppeteer container) for the UET
// Google-login automation feature to work — without it, that one feature
// fails with SERVER_CONFIG_ERROR while every other route works normally.
setRuntimeConfig({
  HYEB_SESSION_SECRET: process.env.HYEB_SESSION_SECRET,
  HYEB_ALLOWED_ORIGINS: process.env.HYEB_ALLOWED_ORIGINS,
  HYEB_BROWSER_WS_ENDPOINT: process.env.HYEB_BROWSER_WS_ENDPOINT,
});

const app = createApp(node());
const distDir = fileURLToPath(new URL("../../web/dist", import.meta.url));
registerStaticAssets(app, distDir);

const port = Number(process.env.PORT ?? 8787);
app.listen(port);

console.log(`Hyeboard (Node) listening on http://localhost:${port}`);
