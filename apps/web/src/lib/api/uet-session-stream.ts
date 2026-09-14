export type UetSessionStreamResult = {
  token: string;
  session?: { studentCode?: string };
};

type StreamErrorFactory = (message: string, code?: string, status?: number) => Error;

type CaptchaSubmission = {
  challengeId: string;
  controller: AbortController;
  outcome: Promise<{ ok: true } | { ok: false; error: unknown }>;
};

type StreamOptions = {
  onProgress?: (message: string) => void;
  onCaptchaNeeded?: (imageDataUrl: string, signal: AbortSignal) => Promise<string>;
  submitCaptcha: (challengeId: string, answer: string) => Promise<void>;
  createError: StreamErrorFactory;
};

type EventData = {
  message?: string;
  token?: string;
  session?: { studentCode?: string };
  code?: string;
  status?: number;
  challengeId?: string;
  image?: string;
};

export async function readUetSessionStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options: StreamOptions,
): Promise<UetSessionStreamResult> {
  const decoder = new TextDecoder();
  const handledCaptchaChallenges = new Set<string>();
  let activeCaptcha: CaptchaSubmission | undefined;
  let pendingRead: Promise<{ kind: "read"; result: ReadableStreamReadResult<Uint8Array> }> | undefined;
  let buffer = "";

  try {
    for (;;) {
      pendingRead ??= reader.read().then((result) => ({ kind: "read" as const, result }));
      const next = activeCaptcha
        ? await Promise.race([
            pendingRead,
            activeCaptcha.outcome.then((result) => ({ kind: "captcha" as const, result })),
          ])
        : await pendingRead;

      if (next.kind === "captcha") {
        activeCaptcha = undefined;
        if (!next.result.ok) throw next.result.error;
        continue;
      }

      pendingRead = undefined;
      if (next.result.done) {
        throw options.createError("The sign-in stream ended unexpectedly. Try again.", undefined, 502);
      }
      buffer += decoder.decode(next.result.value, { stream: true });

      let separatorIndex: number;
      while ((separatorIndex = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        const eventMatch = /^event: (.+)$/m.exec(rawEvent);
        const dataMatch = /^data: (.+)$/m.exec(rawEvent);
        if (!eventMatch || !dataMatch) continue;

        const data = JSON.parse(dataMatch[1]) as EventData;
        if (eventMatch[1] === "progress" && data.message) {
          options.onProgress?.(data.message);
        } else if (eventMatch[1] === "done" && data.token) {
          if (activeCaptcha) {
            activeCaptcha.controller.abort(options.createError("The verification request ended before an answer was accepted."));
            await activeCaptcha.outcome;
          }
          return { token: data.token, session: data.session };
        } else if (eventMatch[1] === "error") {
          throw options.createError(data.message ?? "Google sign-in failed.", data.code, data.status);
        } else if (eventMatch[1] === "captcha_required" && data.challengeId && data.image) {
          if (handledCaptchaChallenges.has(data.challengeId)) continue;
          handledCaptchaChallenges.add(data.challengeId);
          if (!options.onCaptchaNeeded) {
            throw options.createError("This sign-in requires a verification code.", "STUDENTHUB_CAPTCHA_REQUIRED", 422);
          }
          if (activeCaptcha) {
            throw options.createError("The sign-in stream sent overlapping verification requests.", "STUDENTHUB_CAPTCHA_RELAY_FAILED", 502);
          }

          const controller = new AbortController();
          const challengeId = data.challengeId;
          const outcome = (async () => {
            const answer = await options.onCaptchaNeeded!(data.image!, controller.signal);
            await options.submitCaptcha(challengeId, answer);
          })().then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
          );
          activeCaptcha = { challengeId, controller, outcome };
        }
      }
    }
  } catch (error) {
    if (activeCaptcha) {
      activeCaptcha.controller.abort(error);
      await activeCaptcha.outcome;
    }
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
