import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCaptchaAnswer, setCaptchaOcrSolver } from "./captcha";

const IMAGE = "data:image/png;base64,QQ==";

describe("resolveCaptchaAnswer", () => {
  afterEach(() => setCaptchaOcrSolver(undefined));

  it("uses and trims an OCR answer first", async () => {
    setCaptchaOcrSolver(async () => " OCR1 ");

    await expect(resolveCaptchaAnswer(IMAGE)).resolves.toEqual({ answer: "OCR1", source: "ocr" });
  });

  it("falls back to a trimmed human answer when OCR returns undefined", async () => {
    setCaptchaOcrSolver(async () => undefined);
    const onCaptchaNeeded = vi.fn(async () => " HUMAN ");

    await expect(resolveCaptchaAnswer(IMAGE, onCaptchaNeeded)).resolves.toEqual({ answer: "HUMAN", source: "human" });
    expect(onCaptchaNeeded).toHaveBeenCalledWith(IMAGE);
  });

  it("falls back to a human answer when OCR throws", async () => {
    setCaptchaOcrSolver(async () => {
      throw new Error("OCR unavailable");
    });

    await expect(resolveCaptchaAnswer(IMAGE, async () => "ABCD")).resolves.toEqual({ answer: "ABCD", source: "human" });
  });

  it("skips OCR when requested", async () => {
    const solver = vi.fn(async () => "OCR1");
    setCaptchaOcrSolver(solver);

    await expect(resolveCaptchaAnswer(IMAGE, async () => "HUMAN", { skipOcr: true })).resolves.toEqual({ answer: "HUMAN", source: "human" });
    expect(solver).not.toHaveBeenCalled();
  });

  it("throws when no nonempty answer is available", async () => {
    setCaptchaOcrSolver(async () => "  ");

    await expect(resolveCaptchaAnswer(IMAGE, async () => " ", { skipOcr: false })).rejects.toMatchObject({
      code: "STUDENTHUB_CAPTCHA_REQUIRED",
      status: 422,
    });
  });

  it("throws when OCR is skipped and no human callback exists", async () => {
    await expect(resolveCaptchaAnswer(IMAGE, undefined, { skipOcr: true })).rejects.toMatchObject({
      code: "STUDENTHUB_CAPTCHA_REQUIRED",
      status: 422,
    });
  });
});
