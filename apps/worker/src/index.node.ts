import { setCaptchaOcrSolver, setPatchrightCloseHandler, setPatchrightLauncher } from "@hyeboard/university-adapters";
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
  // (build-node.mjs marks "patchright" external, so it must stay
  // resolvable from node_modules only when actually needed).
  const patchrightModule = await import("@hyeboard/university-adapters/src/uet/google-login-automation-patchright");
  setPatchrightLauncher(patchrightModule.automateVnuGoogleLoginPatchright);
  setPatchrightCloseHandler(patchrightModule.closeCachedPatchrightSessions);
}

// OCR-based CAPTCHA solving for the parent/guardian direct-login flow (see
// captcha-ocr.ts) — on by default (best-effort, first attempt before
// falling back to relaying the CAPTCHA image to the end user during an
// interactive login), opt-out via
// HYEB_CAPTCHA_OCR=false for deployments that don't want the extra
// tesseract.js dependency loaded at all. Dynamic import for the same
// reason as patchright above: tesseract.js is only an optional dependency
// of @hyeboard/university-adapters (large — WASM + language data), and
// build-node.mjs marks it external so it stays resolvable from
// node_modules only when actually loaded here. Wrapped in try/catch so a
// failure to load it (e.g. missing package in a minimal deployment) falls
// back to the human-relay path instead of crashing startup.
if (process.env.HYEB_CAPTCHA_OCR !== "false") {
  try {
    const captchaOcrModule = await import("@hyeboard/university-adapters/src/uet/captcha-ocr");
    setCaptchaOcrSolver(captchaOcrModule.solveCaptchaImage);
  } catch {
    // Interactive direct login falls back to its human relay automatically.
  }
}

await start();
