import { describe, expect, it, vi } from "vitest";
import { readUetSessionStream } from "./uet-session-stream";

const encode = (event: string, data: object) => new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const createError = (message: string, code?: string, status?: number) => Object.assign(new Error(message), { code, status });

function controlledStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    cancel,
  });
  return { controller, cancel, reader: stream.getReader() };
}

describe("readUetSessionStream", () => {
  it("aborts a deferred modal when the server reports an error", async () => {
    const { controller, reader } = controlledStream();
    const onCaptchaNeeded = vi.fn((_image: string, signal: AbortSignal) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const result = readUetSessionStream(reader, { onCaptchaNeeded, submitCaptcha: vi.fn(), createError });

    controller.enqueue(encode("captcha_required", { challengeId: "relay-1", image: "data:image/png;base64,QQ==" }));
    controller.enqueue(encode("error", { message: "Relay timed out", code: "STUDENTHUB_CAPTCHA_TIMEOUT", status: 408 }));

    await expect(result).rejects.toMatchObject({ message: "Relay timed out", code: "STUDENTHUB_CAPTCHA_TIMEOUT" });
    expect(onCaptchaNeeded).toHaveBeenCalledOnce();
  });

  it("aborts a deferred modal when the stream closes", async () => {
    const { controller, reader } = controlledStream();
    let aborted = false;
    const result = readUetSessionStream(reader, {
      onCaptchaNeeded: (_image, signal) => new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
      }),
      submitCaptcha: vi.fn(),
      createError,
    });

    controller.enqueue(encode("captcha_required", { challengeId: "relay-1", image: "data:image/png;base64,QQ==" }));
    controller.close();

    await expect(result).rejects.toMatchObject({ message: "The sign-in stream ended unexpectedly. Try again.", status: 502 });
    expect(aborted).toBe(true);
  });

  it("cancels the reader and rejects promptly when answer submission fails", async () => {
    const { controller, cancel, reader } = controlledStream();
    const submissionError = new Error("Answer was rejected");
    const result = readUetSessionStream(reader, {
      onCaptchaNeeded: async () => "ANSWER",
      submitCaptcha: async () => { throw submissionError; },
      createError,
    });

    controller.enqueue(encode("captcha_required", { challengeId: "relay-1", image: "data:image/png;base64,QQ==" }));

    await expect(result).rejects.toBe(submissionError);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("ignores duplicate relay events while one modal submission is pending", async () => {
    const { controller, reader } = controlledStream();
    const onCaptchaNeeded = vi.fn((_image: string, signal: AbortSignal) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const result = readUetSessionStream(reader, { onCaptchaNeeded, submitCaptcha: vi.fn(), createError });

    controller.enqueue(new Uint8Array([
      ...encode("captcha_required", { challengeId: "relay-1", image: "data:image/png;base64,QQ==" }),
      ...encode("captcha_required", { challengeId: "relay-1", image: "data:image/png;base64,QQ==" }),
      ...encode("error", { message: "Stopped", status: 500 }),
    ]));

    await expect(result).rejects.toMatchObject({ message: "Stopped" });
    expect(onCaptchaNeeded).toHaveBeenCalledOnce();
  });
});
