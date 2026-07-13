import { HyeboardError } from "@hyeboard/core";

export type CaptchaOcrSolver = (imageDataUrl: string) => Promise<string | undefined>;

let captchaOcrSolver: CaptchaOcrSolver | undefined;

export function setCaptchaOcrSolver(solver: CaptchaOcrSolver | undefined): void {
  captchaOcrSolver = solver;
}

export async function resolveCaptchaAnswer(
  imageDataUrl: string,
  onCaptchaNeeded?: (imageDataUrl: string) => Promise<string>,
  options: { skipOcr?: boolean } = {},
): Promise<{ answer: string; source: "ocr" | "human" }> {
  if (!options.skipOcr && captchaOcrSolver) {
    const answer = (await captchaOcrSolver(imageDataUrl).catch(() => undefined))?.trim();
    if (answer) return { answer, source: "ocr" };
  }

  const answer = (await onCaptchaNeeded?.(imageDataUrl))?.trim();
  if (answer) return { answer, source: "human" };

  throw new HyeboardError(
    "STUDENTHUB_CAPTCHA_REQUIRED",
    "This sign-in requires a verification code that could not be completed automatically.",
    422,
  );
}
