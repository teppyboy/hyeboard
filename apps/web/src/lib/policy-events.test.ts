import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_SWITCHED_EVENT, SESSION_TOKEN_ROTATED_EVENT, type StoredAccount } from "./api";
import {
  policyReconnectDelay,
  subscribeToPolicyEvents,
} from "./policy-events";

const account: StoredAccount = {
  id: "account-1",
  universityId: "uet",
  token: "student-token",
  addedAt: "2026-01-01T00:00:00.000Z",
};

function stream(body: string): Response {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

beforeEach(() => {
  vi.stubGlobal("window", new EventTarget());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("subscribeToPolicyEvents", () => {
  it("fetches SSE with the active student Bearer and accepts only newer canonical revisions", async () => {
    const fetcher = vi.fn().mockImplementation(async () => stream([
      "event: revision\ndata: 01\n\n",
      "event: revision\ndata: 2\n\n",
      "event: revision\ndata: 2\n\n",
      "event: revision\ndata: 9007199254740992\n\n",
      "event: other\ndata: 4\n\n",
      "event: revision\ndata: 3\n\n",
    ].join("")));
    const onRevision = vi.fn();
    const stop = subscribeToPolicyEvents({ getAccount: () => account, fetcher, onRevision });

    await vi.waitFor(() => expect(onRevision).toHaveBeenCalledTimes(2));
    stop();

    expect(onRevision.mock.calls).toEqual([[2], [3]]);
    const [, init] = fetcher.mock.calls[0]!;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init.headers)).toEqual(new Headers({
      Accept: "text/event-stream",
      Authorization: "Bearer student-token",
    }));
    expect(init.credentials).toBeUndefined();
  });

  it("reconnects immediately with the current token after same-account rotation", async () => {
    const signals: AbortSignal[] = [];
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal as AbortSignal);
      return new Response(new ReadableStream({ start(controller) { controllers.push(controller); } }));
    });
    const onRevision = vi.fn();
    let current = account;
    const stop = subscribeToPolicyEvents({ getAccount: () => current, fetcher, onRevision });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());

    current = { ...account, token: "rotated-student-token" };
    window.dispatchEvent(new CustomEvent(SESSION_TOKEN_ROTATED_EVENT, { detail: { accountId: account.id } }));

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(signals[0]?.aborted).toBe(true);
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("Authorization")).toBe("Bearer rotated-student-token");

    controllers[1]?.enqueue(new TextEncoder().encode("event: revision\ndata: 4\n\n"));
    await vi.waitFor(() => expect(onRevision).toHaveBeenCalledWith(4));
    stop();
    expect(signals[1]?.aborted).toBe(true);
  });

  it("aborts on account switch and cleanup without leaking old-account events", async () => {
    let requestSignal: AbortSignal | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Response(new ReadableStream({ start(value) { controller = value; } }));
    });
    const onRevision = vi.fn();
    let current: StoredAccount | undefined = account;
    const stop = subscribeToPolicyEvents({ getAccount: () => current, fetcher, onRevision });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());

    current = { ...account, id: "account-2", token: "other-token" };
    window.dispatchEvent(new CustomEvent(ACCOUNT_SWITCHED_EVENT));
    controller?.enqueue(new TextEncoder().encode("event: revision\ndata: 4\n\n"));
    await Promise.resolve();

    expect(requestSignal?.aborted).toBe(true);
    expect(onRevision).not.toHaveBeenCalled();
    stop();
    expect(requestSignal?.aborted).toBe(true);
  });

  it("keeps polling active after a successful reconnect and deduplicates the current revision", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(stream("event: revision\ndata: 2\n\nevent: revision\ndata: 2\n\n"))
      .mockResolvedValueOnce(stream("event: revision\ndata: 3\n\n"));
    const onRevision = vi.fn();
    const onPoll = vi.fn();
    const stop = subscribeToPolicyEvents({ getAccount: () => account, fetcher, onRevision, onPoll });

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(onRevision).toHaveBeenCalledWith(2));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(onRevision.mock.calls.filter(([revision]) => revision === 2)).toHaveLength(1);
    expect(onRevision).toHaveBeenCalledWith(3);
    expect(onPoll).toHaveBeenCalledWith(account, expect.any(AbortSignal));
    stop();
  });

  it("bounds reconnect delay and polls with the current same-account token", async () => {
    vi.useFakeTimers();
    let current = account;
    const fetcher = vi.fn().mockRejectedValue(new TypeError("offline"));
    const onPoll = vi.fn();
    const stop = subscribeToPolicyEvents({ getAccount: () => current, fetcher, onRevision: vi.fn(), onPoll });
    await vi.advanceTimersByTimeAsync(1_000);

    current = { ...account, token: "rotated-student-token" };
    window.dispatchEvent(new CustomEvent(SESSION_TOKEN_ROTATED_EVENT, { detail: { accountId: account.id } }));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(policyReconnectDelay(99)).toBe(30_000);
    expect(fetcher.mock.calls.length).toBeGreaterThan(1);
    expect(fetcher.mock.calls.length).toBeLessThan(10);
    expect(new Headers(fetcher.mock.calls.at(-1)?.[1]?.headers).get("Authorization")).toBe("Bearer rotated-student-token");
    expect(onPoll).toHaveBeenCalledWith(expect.objectContaining({ id: account.id, token: "rotated-student-token" }), expect.any(AbortSignal));
    stop();
  });

  it("retries failed polling with bounded backoff and aborts it on cleanup", async () => {
    vi.useFakeTimers();
    const onPoll = vi.fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(undefined);
    const stop = subscribeToPolicyEvents({ getAccount: () => account, fetcher: vi.fn().mockRejectedValue(new TypeError("offline")), onRevision: vi.fn(), onPoll });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(onPoll).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onPoll).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onPoll).toHaveBeenCalledTimes(2);
  });

  it("does nothing without an active student session", () => {
    const fetcher = vi.fn();
    const stop = subscribeToPolicyEvents({ getAccount: () => undefined, fetcher, onRevision: vi.fn() });
    expect(fetcher).not.toHaveBeenCalled();
    stop();
  });
});
