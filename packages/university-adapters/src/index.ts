export * from "./registry";
export * from "./types";
export { DaotaoClient } from "./vnu/daotao-client";
// Deliberately NOT re-exporting anything from ./uet/google-login-automation-
// patchright.ts here — see that file and setPatchrightLauncher's doc
// comment in google-login-automation.ts for why (keeping the large
// Node-only patchright dependency out of this barrel file matters: apps/worker's
// Cloudflare entry point imports this whole module).
export {
  setPatchrightLauncher,
  setPatchrightCloseHandler,
  type PatchrightLauncher,
  closeCachedBrowserSessions,
} from "./uet/google-login-automation";
export { setCaptchaOcrSolver, type CaptchaOcrSolver } from "./uet/captcha";
