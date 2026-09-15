import { WebStandardAdapter } from "elysia/adapter/web-standard";

export const CloudflareAdapter = {
  ...WebStandardAdapter,
  name: "cloudflare-worker",
  runtime: "cloudflare-worker",
} as typeof WebStandardAdapter;
