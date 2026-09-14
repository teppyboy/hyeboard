import { describe, expect, it } from "vitest";
import { appendBulkLookupChunk, chunkBulkTargets, deriveBulkLookupViewState, executeBulkLookup, parseBulkLookupItems, parseBulkLookupMode, parseBulkTargets } from "./bulk-lookup";
import type { VnuBulkLookupItem } from "../api/api";
import { VnuRequestNotReplayedError } from "../session/vnu-refresh";

describe("bulk lookup input", () => {
  it("trims and deduplicates targets while preserving first occurrence", () => {
    expect(parseBulkTargets(" 12\n34\n12\n\n 34 \n56", 3)).toEqual({ targets: ["12", "34", "56"] });
  });

  it("applies the configured maximum after deduplication", () => {
    expect(parseBulkTargets(" 12\n34\n12 ", 1)).toEqual({ targets: ["12", "34"], error: "tooMany" });
  });

  it("accepts nine code targets from mode metadata and rejects ten", () => {
    const nineTargets = Array.from({ length: 9 }, (_, index) => String(index + 1)).join("\n");
    const tenTargets = `${nineTargets}\n10`;
    expect(parseBulkTargets(nineTargets, 9).error).toBeUndefined();
    expect(parseBulkTargets(tenTargets, 9)).toMatchObject({ error: "tooMany" });
  });

  it.each([undefined, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])("disables bulk input for invalid maximum %s", (maximum) => {
    expect(parseBulkTargets(" 12\n12\n34 ", maximum)).toEqual({ targets: ["12", "34"], error: "disabled" });
  });

  it("allows 51 targets when configured below the safe integer boundary", () => {
    const input = Array.from({ length: 51 }, (_, index) => String(index + 1)).join("\n");
    expect(parseBulkTargets(input, Number.MAX_SAFE_INTEGER)).toEqual({ targets: Array.from({ length: 51 }, (_, index) => String(index + 1)) });
  });

  it("preserves malformed targets for per-item server isolation", () => {
    expect(parseBulkTargets("1001\nmalformed\n1002", 3)).toEqual({ targets: ["1001", "malformed", "1002"] });
  });

  it("keeps mode input limits separate from request chunks", () => {
    const targets = ["1", "2", "3", "4", "5", "6", "7"];
    expect(chunkBulkTargets("code-to-stdid", targets)).toEqual([["1", "2", "3"], ["4", "5", "6"], ["7"]]);
    expect(chunkBulkTargets("stdid-to-code", targets)).toEqual([["1", "2", "3", "4", "5"], ["6", "7"]]);
    expect(chunkBulkTargets("stdid-to-transcript", targets)).toEqual([["1", "2", "3", "4", "5"], ["6", "7"]]);
    expect(chunkBulkTargets("code-to-stdid", Array.from({ length: 9 }, (_, index) => String(index))).map((chunk) => chunk.length)).toEqual([3, 3, 3]);
    expect(chunkBulkTargets("stdid-to-code", Array.from({ length: 33 }, (_, index) => String(index)), 32).map((chunk) => chunk.length)).toEqual([32, 1]);
  });

  it("parses only supported modes", () => {
    expect(parseBulkLookupMode("stdid-to-transcript")).toBe("stdid-to-transcript");
    expect(() => parseBulkLookupMode("unsupported")).toThrowError("Invalid bulk lookup mode");
  });
});

describe("bulk lookup progress", () => {
  it("aggregates chunks in response order and advances processed count", () => {
    const first = appendBulkLookupChunk({ processed: 0, total: 3, items: [] }, [
      { target: "1", status: "error", errorCode: "NOT_FOUND" },
      { target: "2", status: "ok", result: { studentCode: "20000002" } },
    ]);
    const complete = appendBulkLookupChunk(first, [{ target: "3", status: "error", errorCode: "INVALID" }]);

    expect(complete.processed).toBe(3);
    expect(complete.items.map((item) => item.target)).toEqual(["1", "2", "3"]);
    expect(deriveBulkLookupViewState({ targets: ["1", "2", "3"] }, false, complete.processed)).toBe("completed");
  });

  it("executes chunks strictly sequentially", async () => {
    let activeCalls = 0;
    const callOrder: string[] = [];
    const controller = new AbortController();
    const execution = await executeBulkLookup({
      mode: "stdid-to-code",
      targets: ["1", "2", "3", "4", "5", "6"],
      signal: controller.signal,
      requestChunk: async (_mode, targets) => {
        activeCalls += 1;
        expect(activeCalls).toBe(1);
        callOrder.push(targets.join(","));
        await Promise.resolve();
        activeCalls -= 1;
        return targets.map((target) => ({ target, status: "ok", result: { studentCode: target.padStart(8, "0") } }));
      },
    });

    expect(callOrder).toEqual(["1,2,3,4,5", "6"]);
    expect(execution.progress.processed).toBe(6);
    expect(execution.remainingTargets).toEqual([]);
  });

  it("uses one fresh accumulator across progress callbacks without mutating initial progress", async () => {
    const initialProgress: { processed: number; total: number; items: VnuBulkLookupItem[] } = {
      processed: 1,
      total: 8,
      items: [{ target: "prior", status: "error", errorCode: "PRIOR" }],
    };
    const initialItems = initialProgress.items;
    const progressItemReferences: VnuBulkLookupItem[][] = [];
    const execution = await executeBulkLookup({
      mode: "stdid-to-code",
      targets: ["1", "2", "3", "4", "5", "6", "7"],
      signal: new AbortController().signal,
      initialProgress,
      requestChunk: async (_mode, chunk) => chunk.map((target) => ({ target, status: "ok", result: { studentCode: target.padStart(8, "0") } })),
      onProgress: (nextProgress) => progressItemReferences.push(nextProgress.items),
    });

    expect(progressItemReferences).toHaveLength(2);
    expect(progressItemReferences[0]).toBe(progressItemReferences[1]);
    expect(progressItemReferences[0]).not.toBe(initialItems);
    expect(initialItems).toEqual([{ target: "prior", status: "error", errorCode: "PRIOR" }]);
    expect(execution.progress.items.map((item) => item.target)).toEqual(["prior", "1", "2", "3", "4", "5", "6", "7"]);
  });

  it.each([
    ["reordered", ["2", "1", "3"]],
    ["duplicate", ["1", "1", "3"]],
    ["foreign", ["1", "2", "99"]],
  ])("rejects a %s response target sequence before appending", async (_kind, responseTargets) => {
    const execution = await executeBulkLookup({
      mode: "code-to-stdid",
      targets: ["1", "2", "3"],
      signal: new AbortController().signal,
      requestChunk: async () => responseTargets.map((target) => ({ target, status: "ok", result: { stdCode: target, stdId: target.padStart(11, "0"), probes: 1 } })),
    });

    expect(execution.error).toEqual(new Error("Invalid bulk lookup response"));
    expect(execution.progress.items).toEqual([]);
    expect(execution.remainingTargets).toEqual(["1", "2", "3"]);
  });

  it("preserves prior chunks and retries the whole rejected chunk", async () => {
    let call = 0;
    const execution = await executeBulkLookup({
      mode: "stdid-to-code",
      targets: ["1", "2", "3", "4", "5", "6"],
      signal: new AbortController().signal,
      requestChunk: async (_mode, chunk) => {
        call += 1;
        if (call === 2) return [{ target: "99", status: "ok", result: { studentCode: "99000099" } }];
        return chunk.map((target) => ({ target, status: "ok", result: { studentCode: target.padStart(8, "0") } }));
      },
    });

    expect(execution.progress.items.map((item) => item.target)).toEqual(["1", "2", "3", "4", "5"]);
    expect(execution.remainingTargets).toEqual(["6"]);
    expect(execution.error).toEqual(new Error("Invalid bulk lookup response"));
  });

  it("stops before later chunks when aborted", async () => {
    const controller = new AbortController();
    let calls = 0;
    const execution = await executeBulkLookup({
      mode: "stdid-to-code",
      targets: ["1", "2", "3", "4", "5", "6"],
      signal: controller.signal,
      requestChunk: async (_mode, targets) => {
        calls += 1;
        controller.abort();
        return targets.map((target) => ({ target, status: "ok", result: { studentCode: "20000001" } }));
      },
    });

    expect(calls).toBe(1);
    expect(execution.aborted).toBe(true);
    expect(execution.progress.items).toEqual([]);
    expect(execution.remainingTargets).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  it.each([429, 503])("keeps prior results and coherent retry state after a later %s", async (status) => {
    const targets = ["1", "2", "3", "4", "5", "6"];
    const controller = new AbortController();
    const requestError = Object.assign(new Error("synthetic request failure"), { status });
    let calls = 0;
    const firstRun = await executeBulkLookup({
      mode: "stdid-to-code",
      targets,
      signal: controller.signal,
      requestChunk: async (_mode, chunk) => {
        calls += 1;
        if (calls === 2) throw requestError;
        return chunk.map((target) => ({ target, status: "ok", result: { studentCode: target.padStart(8, "0") } }));
      },
    });

    expect(firstRun.progress.items.map((item) => item.target)).toEqual(["1", "2", "3", "4", "5"]);
    expect(firstRun.remainingTargets).toEqual(["6"]);
    expect(firstRun.error).toBe(requestError);

    const retry = await executeBulkLookup({
      mode: "stdid-to-code",
      targets: firstRun.remainingTargets,
      signal: new AbortController().signal,
      initialProgress: firstRun.progress,
      requestChunk: async (_mode, chunk) => chunk.map((target) => ({ target, status: "ok", result: { studentCode: "20000006" } })),
    });
    expect(retry.progress.items.map((item) => item.target)).toEqual(targets);
    expect(retry.progress.processed).toBe(6);
    expect(retry.progress.total).toBe(6);
    expect(retry.remainingTargets).toEqual([]);
  });

  it("preserves mixed malformed, self, not-found, and successful outcomes in order", async () => {
    const targets = parseBulkTargets("bad\n1000\n1001\n1002", 4).targets;
    const items: VnuBulkLookupItem[] = [
      { target: "bad", status: "error", errorCode: "VNU_CROSS_LOOKUP_INVALID_TARGET" },
      { target: "1000", status: "error", errorCode: "VNU_CROSS_LOOKUP_SELF_TARGET" },
      { target: "1001", status: "error", errorCode: "VNU_CROSS_LOOKUP_NOT_FOUND" },
      { target: "1002", status: "ok", result: { studentCode: "20000002" } },
    ];
    const execution = await executeBulkLookup({
      mode: "stdid-to-code",
      targets,
      signal: new AbortController().signal,
      requestChunk: async () => items,
    });

    expect(execution.progress.items).toEqual(items);
    expect(execution.progress.items.map((item) => item.target)).toEqual(targets);
  });

  it("preserves acknowledged items and marks the failed chunk plus later targets retryable after refresh", async () => {
    const targets = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
    let calls = 0;
    const execution = await executeBulkLookup({
      mode: "stdid-to-code",
      targets,
      signal: new AbortController().signal,
      requestChunk: async (_mode, chunk) => {
        calls += 1;
        if (calls === 2) throw new VnuRequestNotReplayedError();
        return chunk.map((target) => ({ target, status: "ok", result: { studentCode: `SYNTHETIC-${target}` } }));
      },
    });

    expect(calls).toBe(2);
    expect(execution.progress.items.map((item) => item.target)).toEqual(targets.slice(0, 5));
    expect(execution.remainingTargets).toEqual(["foxtrot"]);
    expect(execution).toMatchObject({ aborted: false, restoredWithoutReplay: true, error: undefined });
  });

  it("manual retry preserves progress and sends only remaining targets", async () => {
    const requestedTargets: string[][] = [];
    const first = await executeBulkLookup({
      mode: "stdid-to-code",
      targets: ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"],
      signal: new AbortController().signal,
      requestChunk: async (_mode, chunk) => {
        requestedTargets.push(chunk);
        if (chunk[0] === "foxtrot") throw new VnuRequestNotReplayedError();
        return chunk.map((target) => ({ target, status: "error", errorCode: "SYNTHETIC" }));
      },
    });
    const retry = await executeBulkLookup({
      mode: "stdid-to-code",
      targets: first.remainingTargets,
      initialProgress: first.progress,
      signal: new AbortController().signal,
      requestChunk: async (_mode, chunk) => {
        requestedTargets.push(chunk);
        return chunk.map((target) => ({ target, status: "error", errorCode: "SYNTHETIC" }));
      },
    });

    expect(requestedTargets).toEqual([
      ["alpha", "bravo", "charlie", "delta", "echo"],
      ["foxtrot"],
      ["foxtrot"],
    ]);
    expect(retry.progress.items.map((item) => item.target)).toEqual(["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"]);
    expect(retry.remainingTargets).toEqual([]);
    expect(retry.restoredWithoutReplay).toBe(false);
  });

  it("keeps restored state false when cancellation wins a late no-replay rejection", async () => {
    const controller = new AbortController();
    const execution = await executeBulkLookup({
      mode: "stdid-to-code",
      targets: ["alpha"],
      signal: controller.signal,
      requestChunk: async () => {
        controller.abort(new DOMException("Synthetic cancellation", "AbortError"));
        throw new VnuRequestNotReplayedError();
      },
    });

    expect(execution).toMatchObject({
      aborted: true,
      restoredWithoutReplay: false,
      remainingTargets: ["alpha"],
      error: undefined,
    });
  });
});

describe("bulk lookup response parsing", () => {
  it("parses and strips successful results according to their requested mode", () => {
    expect(parseBulkLookupItems("stdid-to-code", [{ target: "99000000101", status: "ok", result: { studentCode: "99000101", studentName: "Synthetic 9901", className: "SYNTHETIC-99", unsafe: "discard" } }])).toEqual([
      { target: "99000000101", status: "ok", result: { studentCode: "99000101", studentName: "Synthetic 9901", className: "SYNTHETIC-99" } },
    ]);
    expect(parseBulkLookupItems("code-to-stdid", [{ target: "99000101", status: "ok", result: { stdCode: "99000101", stdId: "99000000101", probes: 2, unsafe: "discard" } }])).toEqual([
      { target: "99000101", status: "ok", result: { stdCode: "99000101", stdId: "99000000101", probes: 2 } },
    ]);
  });

  it("parses transcript structure needed by academic summaries and strips unknown fields", () => {
    expect(parseBulkLookupItems("stdid-to-transcript", [{
      target: "99000000101",
      status: "ok",
      result: {
        header: { studentCode: "99000101", studentName: "Synthetic 9901", className: "SYNTHETIC-99", unsafe: "discard" },
        totals: { totalCredits: 3, accumulatedCredits: 3, gpa4: 4, unsafe: "discard" },
        terms: [{ maHK: "252", unsafe: "discard", rows: [{ courseCode: "SYN9901", courseName: "Synthetic Course 9901", credits: 3, grade10: 9, letterGrade: "A", grade4: 4, classId: "990099", termOrdinal: "99", unsafe: "discard" }] }],
        unsafe: "discard",
      },
    }])).toEqual([{
      target: "99000000101",
      status: "ok",
      result: {
        header: { studentCode: "99000101", studentName: "Synthetic 9901", className: "SYNTHETIC-99" },
        totals: { totalCredits: 3, accumulatedCredits: 3, gpa4: 4 },
        terms: [{ maHK: "252", rows: [{ courseCode: "SYN9901", courseName: "Synthetic Course 9901", credits: 3, grade10: 9, letterGrade: "A", grade4: 4, classId: "990099", termOrdinal: "99" }] }],
      },
    }]);
  });

  it.each([
    ["stdid-to-code", { studentCode: 99000101 }],
    ["code-to-stdid", { stdCode: "99000101", stdId: "99000000101", probes: Number.POSITIVE_INFINITY }],
    ["stdid-to-transcript", { header: {}, totals: {}, terms: "invalid" }],
  ] as const)("rejects malformed %s successes before they reach progress", (mode, result) => {
    expect(() => parseBulkLookupItems(mode, [{ target: "99000000101", status: "ok", result }])).toThrowError("Invalid bulk lookup response");
  });

  it("rejects malformed envelopes and error items", () => {
    expect(() => parseBulkLookupItems("stdid-to-code", { items: [] })).toThrowError("Invalid bulk lookup response");
    expect(() => parseBulkLookupItems("stdid-to-code", [{ target: "99000000101", status: "error" }])).toThrowError("Invalid bulk lookup response");
  });
});
