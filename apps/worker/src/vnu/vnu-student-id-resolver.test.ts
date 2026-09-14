import { HyeboardError } from "@hyeboard/core";
import { describe, expect, it, vi } from "vitest";
import {
  resolveVnuStudentId,
  VNU_STUDENT_ID_RESOLVER_MAX_PROBES,
  VNU_STUDENT_ID_RESOLVER_PLATFORM_CONCURRENCY,
} from "./vnu-student-id-resolver";

const SYNTHETIC_STUDENT_CODE = 99_000_001;
const SYNTHETIC_INTERNAL_ID = 99_000_000_001;
const TARGET_CODE_NUMBER = SYNTHETIC_STUDENT_CODE + 89;
const TARGET_CODE = String(TARGET_CODE_NUMBER);
const PROJECTED_STD_ID = SYNTHETIC_INTERNAL_ID + 89;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function options(
  overrides: Partial<Parameters<typeof resolveVnuStudentId>[0]> = {},
) {
  return {
    ownStdId: SYNTHETIC_INTERNAL_ID,
    ownCode: SYNTHETIC_STUDENT_CODE,
    targetCode: TARGET_CODE,
    concurrency: 4,
    fetchStudentCode: async () => undefined,
    ...overrides,
  };
}

function expectNotConverged(promise: Promise<unknown>) {
  return expect(promise).rejects.toMatchObject({
    code: "VNU_CROSS_LOOKUP_NOT_CONVERGED",
    status: 404,
  });
}

describe("resolveVnuStudentId", () => {
  it("uses the projection header correction first for a +89 code delta", async () => {
    const calls: number[] = [];
    const result = await resolveVnuStudentId(
      options({
        concurrency: 1,
        fetchStudentCode: async (stdId) => {
          calls.push(stdId);
          return stdId === PROJECTED_STD_ID
            ? String(TARGET_CODE_NUMBER - 2)
            : TARGET_CODE;
        },
      }),
    );

    expect(calls).toEqual([PROJECTED_STD_ID, PROJECTED_STD_ID + 2]);
    expect(result).toEqual({
      stdId: String(PROJECTED_STD_ID + 2),
      stdCode: TARGET_CODE,
      probes: 2,
    });
  });

  it("returns an exact projected id after one probe", async () => {
    const fetchStudentCode = vi.fn(async () => TARGET_CODE);
    await expect(
      resolveVnuStudentId(options({ fetchStudentCode })),
    ).resolves.toEqual({
      stdId: String(PROJECTED_STD_ID),
      stdCode: TARGET_CODE,
      probes: 1,
    });
    expect(fetchStudentCode).toHaveBeenCalledOnce();
  });

  it("prioritizes one valid first-header correction and removes its default duplicate", async () => {
    const calls: number[] = [];
    await expectNotConverged(
      resolveVnuStudentId(
        options({
          fetchStudentCode: async (stdId) => {
            calls.push(stdId);
            return stdId === PROJECTED_STD_ID
              ? String(TARGET_CODE_NUMBER - 3)
              : undefined;
          },
        }),
      ),
    );

    expect(calls.slice(0, 5)).toEqual([
      PROJECTED_STD_ID,
      PROJECTED_STD_ID + 3,
      PROJECTED_STD_ID - 1,
      PROJECTED_STD_ID + 1,
      PROJECTED_STD_ID - 2,
    ]);
    expect(calls.filter((id) => id === PROJECTED_STD_ID + 3)).toHaveLength(1);
  });

  it("treats headerless and malformed local holes as misses", async () => {
    const calls: number[] = [];
    const result = await resolveVnuStudentId(
      options({
        concurrency: 1,
        fetchStudentCode: async (stdId) => {
          calls.push(stdId);
          if (stdId === PROJECTED_STD_ID) return undefined;
          if (stdId === PROJECTED_STD_ID - 1) return "malformed";
          if (stdId === PROJECTED_STD_ID + 1) return TARGET_CODE;
          return undefined;
        },
      }),
    );

    expect(calls).toEqual([
      PROJECTED_STD_ID,
      PROJECTED_STD_ID - 1,
      PROJECTED_STD_ID + 1,
    ]);
    expect(result.probes).toBe(3);
  });

  it("requires exact eight-character equality instead of numeric equivalence", async () => {
    const fetchStudentCode = vi.fn(async () => `0${TARGET_CODE}`);
    await expectNotConverged(
      resolveVnuStudentId(options({ fetchStudentCode })),
    );
    expect(fetchStudentCode).toHaveBeenCalledTimes(33);
  });

  it("exhausts exactly 33 unique candidates across the closed local window", async () => {
    const calls: number[] = [];
    await expectNotConverged(
      resolveVnuStudentId(
        options({
          concurrency: 6,
          fetchStudentCode: async (stdId) => {
            calls.push(stdId);
            return undefined;
          },
        }),
      ),
    );

    expect(VNU_STUDENT_ID_RESOLVER_MAX_PROBES).toBe(33);
    expect(calls).toHaveLength(33);
    expect(new Set(calls).size).toBe(33);
    expect(new Set(calls)).toEqual(
      new Set(
        Array.from({ length: 33 }, (_, index) => PROJECTED_STD_ID - 16 + index),
      ),
    );
  });

  it("skips unsafe window candidates", async () => {
    const calls: number[] = [];
    await expectNotConverged(
      resolveVnuStudentId(
        options({
          ownStdId: 8,
          ownCode: SYNTHETIC_STUDENT_CODE,
          targetCode: String(SYNTHETIC_STUDENT_CODE),
          concurrency: 6,
          fetchStudentCode: async (stdId) => {
            calls.push(stdId);
            return undefined;
          },
        }),
      ),
    );
    expect(calls.every((id) => Number.isSafeInteger(id) && id > 0)).toBe(true);
    expect(calls).toHaveLength(24);
  });

  it.each([
    [Number.MAX_SAFE_INTEGER, 0, String(SYNTHETIC_STUDENT_CODE + 1)],
    [1, SYNTHETIC_STUDENT_CODE, String(SYNTHETIC_STUDENT_CODE - 1)],
    [1.5, SYNTHETIC_STUDENT_CODE, TARGET_CODE],
    [-1, SYNTHETIC_STUDENT_CODE, TARGET_CODE],
    [SYNTHETIC_INTERNAL_ID, 0, TARGET_CODE],
  ])(
    "rejects an invalid projection without requests",
    async (ownStdId, ownCode, targetCode) => {
      const fetchStudentCode = vi.fn(async () => TARGET_CODE);
      await expectNotConverged(
        resolveVnuStudentId(
          options({ ownStdId, ownCode, targetCode, fetchStudentCode }),
        ),
      );
      expect(fetchStudentCode).not.toHaveBeenCalled();
    },
  );

  it("waits for the settled prefix and chooses the earlier-priority exact candidate", async () => {
    const earlier = deferred<string | undefined>();
    const later = deferred<string | undefined>();
    const calls: number[] = [];
    const completions: number[] = [];
    let laterStarted = false;
    const resolution = resolveVnuStudentId(
      options({
        concurrency: 2,
        fetchStudentCode: async (stdId) => {
          calls.push(stdId);
          if (stdId === PROJECTED_STD_ID) return undefined;
          if (stdId === PROJECTED_STD_ID - 1) {
            const studentCode = await earlier.promise;
            completions.push(stdId);
            return studentCode;
          }
          if (stdId === PROJECTED_STD_ID + 1) {
            laterStarted = true;
            const studentCode = await later.promise;
            completions.push(stdId);
            return studentCode;
          }
          return undefined;
        },
      }),
    );
    await vi.waitFor(() => expect(laterStarted).toBe(true));
    expect(calls).toEqual([
      PROJECTED_STD_ID,
      PROJECTED_STD_ID - 1,
      PROJECTED_STD_ID + 1,
    ]);
    later.resolve(TARGET_CODE);
    await vi.waitFor(() => expect(completions).toContain(PROJECTED_STD_ID + 1));
    expect(completions).not.toContain(PROJECTED_STD_ID - 1);
    earlier.resolve(TARGET_CODE);

    await expect(resolution).resolves.toMatchObject({
      stdId: String(PROJECTED_STD_ID - 1),
      probes: 3,
    });
  });

  it.each([1, 16, 32, 7, Number.MAX_SAFE_INTEGER])(
    "bounds configured concurrency %s",
    async (concurrency) => {
      let active = 0;
      let maxActive = 0;
      const gates: Array<Deferred<string | undefined>> = [];
      const resolution = resolveVnuStudentId(
        options({
          concurrency,
          fetchStudentCode: async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            const gate = deferred<string | undefined>();
            gates.push(gate);
            const value = await gate.promise;
            active -= 1;
            return value;
          },
        }),
      );

      await vi.waitFor(() => expect(gates).toHaveLength(1));
      gates.shift()!.resolve(undefined);
      const expectedWidth = Math.min(
        concurrency,
        VNU_STUDENT_ID_RESOLVER_PLATFORM_CONCURRENCY,
        32,
      );
      await vi.waitFor(() => expect(gates).toHaveLength(expectedWidth));
      while (gates.length > 0) gates.shift()!.resolve(TARGET_CODE);
      await resolution;
      expect(maxActive).toBe(expectedWidth);
    },
  );

  it.each([
    [6, 2, 2],
    [3, 5, 3],
    [16, 16, 16],
  ])(
    "uses configured concurrency %s and injected platform limit %s",
    async (concurrency, platformConcurrencyLimit, expectedWidth) => {
      let active = 0;
      let maxActive = 0;
      const gates: Array<Deferred<string | undefined>> = [];
      const resolution = resolveVnuStudentId(
        options({
          concurrency,
          platformConcurrencyLimit,
          fetchStudentCode: async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            const gate = deferred<string | undefined>();
            gates.push(gate);
            const value = await gate.promise;
            active -= 1;
            return value;
          },
        }),
      );

      await vi.waitFor(() => expect(gates).toHaveLength(1));
      gates.shift()!.resolve(undefined);
      await vi.waitFor(() => expect(gates).toHaveLength(expectedWidth));
      while (gates.length > 0) gates.shift()!.resolve(TARGET_CODE);
      await resolution;
      expect(maxActive).toBe(expectedWidth);
    },
  );

  it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid configured concurrency %s",
    async (concurrency) => {
      const fetchStudentCode = vi.fn(async () => TARGET_CODE);
      await expect(
        resolveVnuStudentId(options({ concurrency, fetchStudentCode })),
      ).rejects.toThrow("concurrency must be a positive safe integer");
      expect(fetchStudentCode).not.toHaveBeenCalled();
    },
  );

  it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid platform concurrency %s",
    async (platformConcurrencyLimit) => {
      const fetchStudentCode = vi.fn(async () => TARGET_CODE);
      await expect(
        resolveVnuStudentId(
          options({ platformConcurrencyLimit, fetchStudentCode }),
        ),
      ).rejects.toThrow(
        "platformConcurrencyLimit must be a positive safe integer",
      );
      expect(fetchStudentCode).not.toHaveBeenCalled();
    },
  );

  it("aborts lower-priority active siblings and counts all started probes", async () => {
    const siblingSignals: AbortSignal[] = [];
    const result = await resolveVnuStudentId(
      options({
        concurrency: 3,
        fetchStudentCode: async (stdId, signal) => {
          if (stdId === PROJECTED_STD_ID) return undefined;
          if (stdId === PROJECTED_STD_ID - 1) return TARGET_CODE;
          siblingSignals.push(signal);
          return new Promise((_, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            }),
          );
        },
      }),
    );

    expect(result.probes).toBe(4);
    expect(siblingSignals).toHaveLength(2);
    expect(siblingSignals.every((signal) => signal.aborted)).toBe(true);
  });

  it("keeps a deterministic winner when an aborted sibling rejects with a fresh AbortError", async () => {
    const result = await resolveVnuStudentId(
      options({
        concurrency: 2,
        fetchStudentCode: async (stdId, signal) => {
          if (stdId === PROJECTED_STD_ID) return undefined;
          if (stdId === PROJECTED_STD_ID - 1) return TARGET_CODE;
          return new Promise((_, reject) =>
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            ),
          );
        },
      }),
    );

    expect(result).toMatchObject({
      stdId: String(PROJECTED_STD_ID - 1),
      probes: 3,
    });
  });

  it("propagates a sibling fatal that settled before winner cleanup cancellation", async () => {
    const winner = deferred<string | undefined>();
    const siblingFailure = deferred<string | undefined>();
    const fatal = new HyeboardError("VNU_REQUEST_FAILED", "fatal sibling", 502);
    const started: number[] = [];
    const resolution = resolveVnuStudentId(
      options({
        concurrency: 2,
        fetchStudentCode: async (stdId) => {
          if (stdId === PROJECTED_STD_ID) return undefined;
          started.push(stdId);
          if (stdId === PROJECTED_STD_ID - 1) return winner.promise;
          return siblingFailure.promise;
        },
      }),
    );

    await vi.waitFor(() =>
      expect(started).toEqual([PROJECTED_STD_ID - 1, PROJECTED_STD_ID + 1]),
    );
    winner.resolve(TARGET_CODE);
    siblingFailure.reject(fatal);

    await expect(resolution).rejects.toBe(fatal);
  });

  it("propagates a sibling fatal whose work settles after winner cleanup cancellation", async () => {
    const winner = deferred<string | undefined>();
    const siblingWork = deferred<string | undefined>();
    const fatal = new HyeboardError(
      "VNU_RATE_LIMITED",
      "racing systemic failure",
      429,
    );
    let siblingSignal: AbortSignal | undefined;
    const resolution = resolveVnuStudentId(
      options({
        concurrency: 2,
        fetchStudentCode: async (stdId, signal) => {
          if (stdId === PROJECTED_STD_ID) return undefined;
          if (stdId === PROJECTED_STD_ID - 1) return winner.promise;
          siblingSignal = signal;
          return siblingWork.promise;
        },
      }),
    );

    await vi.waitFor(() => expect(siblingSignal).toBeDefined());
    winner.resolve(TARGET_CODE);
    await vi.waitFor(() => expect(siblingSignal?.aborted).toBe(true));
    siblingWork.reject(fatal);

    await expect(resolution).rejects.toBe(fatal);
  });

  it("preserves caller cancellation while winner sibling cleanup is settling", async () => {
    const controller = new AbortController();
    const callerReason = { cancelled: "during-cleanup" };
    const siblingSettlement = deferred<string | undefined>();
    let siblingSignal: AbortSignal | undefined;
    const resolution = resolveVnuStudentId(
      options({
        concurrency: 2,
        signal: controller.signal,
        fetchStudentCode: async (stdId, signal) => {
          if (stdId === PROJECTED_STD_ID) return undefined;
          if (stdId === PROJECTED_STD_ID - 1) return TARGET_CODE;
          siblingSignal = signal;
          return siblingSettlement.promise;
        },
      }),
    );

    await vi.waitFor(() => expect(siblingSignal?.aborted).toBe(true));
    controller.abort(callerReason);
    siblingSettlement.resolve(undefined);

    await expect(resolution).rejects.toBe(callerReason);
  });

  it("preserves the caller cancellation reason", async () => {
    const controller = new AbortController();
    const reason = { cancelled: "caller" };
    const resolution = resolveVnuStudentId(
      options({
        signal: controller.signal,
        fetchStudentCode: async (_stdId, signal) =>
          new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
      }),
    );
    controller.abort(reason);
    await expect(resolution).rejects.toBe(reason);
  });

  it("aborts siblings and propagates the exact fatal object", async () => {
    const fatal = new HyeboardError("VNU_REQUEST_FAILED", "fatal", 502);
    let siblingSignal: AbortSignal | undefined;
    const resolution = resolveVnuStudentId(
      options({
        concurrency: 2,
        fetchStudentCode: async (stdId, signal) => {
          if (stdId === PROJECTED_STD_ID) return undefined;
          if (stdId === PROJECTED_STD_ID - 1) throw fatal;
          siblingSignal = signal;
          return new Promise((_, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            }),
          );
        },
      }),
    );

    await expect(resolution).rejects.toBe(fatal);
    expect(siblingSignal?.aborted).toBe(true);
  });

  it("preserves caller cancellation while fatal sibling cleanup is settling", async () => {
    const controller = new AbortController();
    const callerReason = { cancelled: "during-fatal-cleanup" };
    const fatal = new HyeboardError("VNU_REQUEST_FAILED", "fatal", 502);
    const siblingSettlement = deferred<string | undefined>();
    let siblingSignal: AbortSignal | undefined;
    const resolution = resolveVnuStudentId(
      options({
        concurrency: 2,
        signal: controller.signal,
        fetchStudentCode: async (stdId, signal) => {
          if (stdId === PROJECTED_STD_ID) return undefined;
          if (stdId === PROJECTED_STD_ID - 1) throw fatal;
          siblingSignal = signal;
          return siblingSettlement.promise;
        },
      }),
    );

    await vi.waitFor(() => expect(siblingSignal?.aborted).toBe(true));
    controller.abort(callerReason);
    siblingSettlement.resolve(undefined);

    await expect(resolution).rejects.toBe(callerReason);
  });

  it.each([
    "VNU_PROFILE_INCOMPLETE",
    "VNU_SESSION_EXPIRED",
    "VNU_RATE_LIMITED",
    "VNU_UPSTREAM_UNAVAILABLE",
    "VNU_REQUEST_FAILED",
  ])("propagates fatal code %s", async (code) => {
    const fatal = new HyeboardError(code, "fatal", 502);
    await expect(
      resolveVnuStudentId(
        options({
          fetchStudentCode: async () => {
            throw fatal;
          },
        }),
      ),
    ).rejects.toBe(fatal);
  });
});
