import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalCaptchaRelayCoordinator } from "./captcha-relay";

describe("LocalCaptchaRelayCoordinator", () => {
  afterEach(() => vi.useRealTimers());

  it("coordinates prepare, wait, and answer with an opaque Hyeboard ID", async () => {
    const coordinator = new LocalCaptchaRelayCoordinator(() => "HYEB_RELAY_ID_SENTINEL");
    const relay = await coordinator.prepare("data:image/png;base64,SU1BR0VfU0VOVElORUw=");
    const answerPromise = relay.wait();

    expect(relay).toMatchObject({
      challengeId: "HYEB_RELAY_ID_SENTINEL",
      image: "data:image/png;base64,SU1BR0VfU0VOVElORUw=",
    });
    await coordinator.answer(relay.challengeId, " HUMAN_ANSWER_SENTINEL ");
    await expect(answerPromise).resolves.toBe(" HUMAN_ANSWER_SENTINEL ");
  });

  it("preserves an early answer until wait and then clears its timer", async () => {
    vi.useFakeTimers();
    const coordinator = new LocalCaptchaRelayCoordinator(() => "HYEB_RELAY_ID_SENTINEL", 25);
    const relay = await coordinator.prepare("data:image/png;base64,QQ==");

    await coordinator.answer(relay.challengeId, "ANSWER_SENTINEL");
    expect(vi.getTimerCount()).toBe(1);
    await expect(relay.wait()).resolves.toBe("ANSWER_SENTINEL");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels before wait and clears its timer", async () => {
    vi.useFakeTimers();
    const coordinator = new LocalCaptchaRelayCoordinator(() => "HYEB_RELAY_ID_SENTINEL", 25);
    const relay = await coordinator.prepare("data:image/png;base64,QQ==");

    await relay.cancel();

    expect(vi.getTimerCount()).toBe(0);
    await expect(relay.wait()).rejects.toMatchObject({
      code: "STUDENTHUB_CAPTCHA_CHALLENGE_NOT_FOUND",
      status: 404,
    });
  });

  it("cancels an active waiter and removes the relay", async () => {
    const coordinator = new LocalCaptchaRelayCoordinator(() => "HYEB_RELAY_ID_SENTINEL");
    const relay = await coordinator.prepare("data:image/png;base64,QQ==");
    const answerPromise = relay.wait();
    const rejection = expect(answerPromise).rejects.toMatchObject({ code: "STUDENTHUB_CAPTCHA_CANCELLED", status: 499 });

    await relay.cancel();

    await rejection;
    await expect(coordinator.answer(relay.challengeId, "LATE_ANSWER_SENTINEL")).rejects.toMatchObject({
      code: "STUDENTHUB_CAPTCHA_CHALLENGE_NOT_FOUND",
      status: 404,
    });
  });

  it("cancels through AbortSignal and cleans its timer", async () => {
    vi.useFakeTimers();
    const coordinator = new LocalCaptchaRelayCoordinator(() => "HYEB_RELAY_ID_SENTINEL", 25);
    const relay = await coordinator.prepare("data:image/png;base64,QQ==");
    const abortController = new AbortController();
    const answerPromise = relay.wait(abortController.signal);
    const rejection = expect(answerPromise).rejects.toMatchObject({ code: "STUDENTHUB_CAPTCHA_CANCELLED", status: 499 });

    abortController.abort();

    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves answer-not-found and timeout semantics", async () => {
    vi.useFakeTimers();
    const coordinator = new LocalCaptchaRelayCoordinator(() => "HYEB_RELAY_ID_SENTINEL", 25);
    const relay = await coordinator.prepare("data:image/png;base64,QQ==");
    const rejection = expect(relay.wait()).rejects.toMatchObject({ code: "STUDENTHUB_CAPTCHA_TIMEOUT", status: 408 });

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    await expect(coordinator.answer("UNKNOWN_RELAY_ID_SENTINEL", "ANSWER_SENTINEL")).rejects.toMatchObject({
      code: "STUDENTHUB_CAPTCHA_CHALLENGE_NOT_FOUND",
      status: 404,
    });
  });
});
