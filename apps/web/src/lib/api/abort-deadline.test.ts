import { afterEach, describe, expect, it, vi } from "vitest";
import { createLinkedAbortController } from "./abort-deadline";

describe("createLinkedAbortController", () => {
  afterEach(() => vi.useRealTimers());

  it("forwards caller cancellation and clears its deadline", () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const cancelled = new Error("cancelled");
    const deadline = new Error("deadline");
    const linked = createLinkedAbortController(caller.signal, 180_000, cancelled, deadline);

    caller.abort();

    expect(linked.signal.aborted).toBe(true);
    expect(linked.signal.reason).toBe(cancelled);
    linked.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts at the deadline with the supplied timeout error", async () => {
    vi.useFakeTimers();
    const cancelled = new Error("cancelled");
    const deadline = new Error("deadline");
    const linked = createLinkedAbortController(undefined, 180_000, cancelled, deadline);

    await vi.advanceTimersByTimeAsync(180_000);

    expect(linked.signal.aborted).toBe(true);
    expect(linked.signal.reason).toBe(deadline);
    linked.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
