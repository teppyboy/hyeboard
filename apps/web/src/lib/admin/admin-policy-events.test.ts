import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeToAdminPolicyEvents } from "./admin-policy-events";

function stream(body: string): Response {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  }));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("subscribeToAdminPolicyEvents", () => {
  it("invalidates only for revisions newer than the authoritative admin cache", async () => {
    let currentRevision = 4;
    const onRevision = vi.fn(async (revision: number) => { currentRevision = revision; });
    const connect = vi.fn(async () => stream("event: revision\ndata: 4\n\nevent: revision\ndata: 5\n\nevent: revision\ndata: 5\n\n"));
    const stop = subscribeToAdminPolicyEvents({ getRevision: () => currentRevision, onRevision, onPoll: vi.fn(), connect });

    await vi.waitFor(() => expect(onRevision).toHaveBeenCalledOnce());
    stop();

    expect(onRevision).toHaveBeenCalledWith(5);
    expect(connect).toHaveBeenCalledWith(expect.any(AbortSignal), 4);
  });

  it("aborts the stream on logout or layout unmount cleanup", async () => {
    let signal: AbortSignal | undefined;
    const connect = vi.fn(async (requestSignal: AbortSignal) => {
      signal = requestSignal;
      return new Response(new ReadableStream({ start() {} }));
    });
    const stop = subscribeToAdminPolicyEvents({ getRevision: () => 2, onRevision: vi.fn(), onPoll: vi.fn(), connect });
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());

    stop();

    expect(signal?.aborted).toBe(true);
  });

  it("keeps polling active after a successful reconnect and deduplicates the current revision", async () => {
    vi.useFakeTimers();
    let currentRevision = 1;
    const onRevision = vi.fn(async (revision: number) => { currentRevision = revision; });
    const onPoll = vi.fn();
    const connect = vi.fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(stream("event: revision\ndata: 2\n\nevent: revision\ndata: 2\n\n"))
      .mockResolvedValueOnce(stream("event: revision\ndata: 3\n\n"));
    const stop = subscribeToAdminPolicyEvents({ getRevision: () => currentRevision, onRevision, onPoll, connect });

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(onRevision).toHaveBeenCalledWith(2));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(onRevision.mock.calls.filter(([revision]) => revision === 2)).toHaveLength(1);
    expect(onRevision).toHaveBeenCalledWith(3);
    expect(onPoll).toHaveBeenCalled();
    stop();
  });

  it("uses bounded polling while the admin event stream is unavailable", async () => {
    vi.useFakeTimers();
    const onPoll = vi.fn();
    const connect = vi.fn().mockRejectedValue(new TypeError("offline"));
    const stop = subscribeToAdminPolicyEvents({ getRevision: () => 3, onRevision: vi.fn(), onPoll, connect });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(connect.mock.calls.length).toBeGreaterThan(1);
    expect(onPoll).toHaveBeenCalledOnce();
    stop();
  });

  it("retries failed polling and aborts the request on cleanup", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const onPoll = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return signals.length === 1 ? Promise.reject(new TypeError("offline")) : Promise.resolve();
    });
    const stop = subscribeToAdminPolicyEvents({ getRevision: () => 3, onRevision: vi.fn(), onPoll, connect: vi.fn().mockRejectedValue(new TypeError("offline")) });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(onPoll).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onPoll).toHaveBeenCalledTimes(2);
    stop();
    expect(signals[1]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onPoll).toHaveBeenCalledTimes(2);
  });
});
