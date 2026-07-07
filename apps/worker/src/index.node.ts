import { setPatchrightLauncher } from "@hyeboard/university-adapters";
import { start } from "./start";

// Node/Bun-only entry point. Identical to index.ts except it additionally
// registers the Patchright (github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs)
// browser automation launcher for the "local" BrowserConnection kind
// before starting the server — gated behind HYEB_BROWSER_PATCHRIGHT=true
// so deployments that don't want it never pay for the extra dependency.
//
// wrangler.jsonc's "main" points at ./index.ts, NOT this file, and
// index.ts never imports this file (only the reverse) — so this is the
// ONLY place in the entire codebase where the patchright package is
// referenced, keeping it completely out of the Cloudflare Workers bundle
// (a static or dynamic import of it from any file reachable by wrangler's
// build was confirmed to balloon the deployment from ~6MB to ~13MB, since
// Cloudflare Workers has no runtime package resolution).
//
// dev:node / dev:bun / build:node scripts point at this file instead of
// index.ts to opt into Patchright support for self-hosted deployments.

declare const process: { env: Record<string, string | undefined> };

if (process.env.HYEB_BROWSER_PATCHRIGHT === "true") {
  // Dynamic, not static: patchright is only an optional dependency of
  // @hyeboard/university-adapters. A static import here would make
  // Node's ESM loader require patchright to be resolvable the moment
  // this file loads, unconditionally — breaking dist/index.js startup
  // for any self-hosted deployment that doesn't opt into Patchright
  // (esbuild marks "patchright" external in build-node.mjs, so it must
  // stay resolvable from node_modules only when actually needed).
  const { automateVnuGoogleLoginPatchright } = await import("@hyeboard/university-adapters/src/uet/google-login-automation-patchright");
  setPatchrightLauncher(automateVnuGoogleLoginPatchright);
}

await start();
