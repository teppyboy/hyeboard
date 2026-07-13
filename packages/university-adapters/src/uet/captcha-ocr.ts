import type { Worker } from "tesseract.js";

// Best-effort OCR for the image returned by StudentHub's direct CAPTCHA API.
// CAPTCHAs are specifically designed to defeat OCR, so this is deliberately
// a "try it, fall back if unsure" tool, not a guaranteed solver. Interactive
// callers can relay the image through ImportSessionContext.onCaptchaNeeded.
//
// Kept in its own module and never statically imported by captcha.ts so
// tesseract.js — a large dependency with WASM + language-data files —
// never reaches the Cloudflare Workers bundle.
// Registered via setCaptchaOcrSolver() from a Node-only entry point (see
// apps/worker/src/index.node.ts).

let workerPromise: Promise<Worker> | undefined;

async function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    const { createWorker } = await import("tesseract.js");
    workerPromise = createWorker("eng").then(async (worker) => {
      // Restrict to alphanumeric — the captcha appears to be a short
      // alphanumeric code (unverified exact character set; tune once live
      // success/failure rates are observed).
      await worker.setParameters({
        tessedit_char_whitelist: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
      });
      return worker;
    });
  }
  return workerPromise;
}

// Returns undefined (not a thrown error) whenever OCR isn't confident
// enough to trust so the resolver can use a human relay when one is available.
export async function solveCaptchaImage(imageDataUrl: string): Promise<string | undefined> {
  try {
    const worker = await getWorker();
    const { data } = await worker.recognize(imageDataUrl);
    const text = data.text.trim().replace(/\s+/g, "");
    // Both the confidence threshold and minimum length are unverified
    // guesses — no ground-truth captcha samples were available to tune
    // against; adjust once real success/failure rates are observed.
    if (!text || text.length < 3 || data.confidence < 60) return undefined;
    return text;
  } catch {
    return undefined;
  }
}
