import { HyeboardError } from "@hyeboard/core";

const LOCAL_RADIUS = 16;
const STUDENT_CODE_PATTERN = /^\d{8}$/;

export const VNU_STUDENT_ID_RESOLVER_MAX_PROBES = 1 + LOCAL_RADIUS * 2;
export const VNU_STUDENT_ID_RESOLVER_PLATFORM_CONCURRENCY = 6;

export type VnuStudentIdResolution = {
  stdId: string;
  stdCode: string;
  probes: number;
};

export type VnuStudentIdResolverOptions = {
  ownStdId: number;
  ownCode: number;
  targetCode: string;
  fetchStudentCode: (
    stdId: number,
    signal: AbortSignal,
  ) => Promise<string | undefined>;
  concurrency: number;
  platformConcurrencyLimit?: number;
  signal?: AbortSignal;
};

type ProbeOutcome =
  | { index: number; stdId: number; studentCode: string | undefined }
  | { index: number; stdId: number; error: unknown };

type ProbeCancellation = {
  index: number;
  stdId: number;
  cancelled: true;
  reason: unknown;
};
type ProbeDecision = ProbeOutcome | ProbeCancellation;

type ActiveProbe = {
  controller: AbortController;
  decision: Promise<ProbeDecision>;
  workSettlement: Promise<ProbeOutcome>;
  cancel: (reason: unknown) => void;
};

type ProbeSettlement = { decision: ProbeDecision; workOutcome: ProbeOutcome };

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isWinnerCleanupRejection(
  settlement: ProbeSettlement,
  winnerReason: unknown,
): boolean {
  if (!("error" in settlement.workOutcome)) return false;
  if (
    !("cancelled" in settlement.decision) ||
    settlement.decision.reason !== winnerReason
  )
    return false;
  return (
    settlement.workOutcome.error === winnerReason ||
    isAbortError(settlement.workOutcome.error)
  );
}

function notConverged(): HyeboardError {
  return new HyeboardError(
    "VNU_CROSS_LOOKUP_NOT_CONVERGED",
    "Could not resolve an internal student id within the bounded local window.",
    404,
  );
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ??
    new DOMException("This operation was aborted", "AbortError")
  );
}

function isValidStudentId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function parsePositiveSafeInteger(value: number, name: string): number {
  if (Number.isSafeInteger(value) && value > 0) return value;
  throw new Error(`${name} must be a positive safe integer`);
}

function configuredPoolWidth(
  concurrency: number,
  platformConcurrencyLimit: number,
  candidateCount: number,
): number {
  return Math.min(concurrency, platformConcurrencyLimit, candidateCount);
}

function resolved(
  stdId: number,
  targetCode: string,
  probes: number,
): VnuStudentIdResolution {
  return {
    stdId: String(stdId).padStart(11, "0"),
    stdCode: targetCode,
    probes,
  };
}

function localCandidates(
  projectedStdId: number,
  correction: number | undefined,
): number[] {
  const candidates = correction === undefined ? [] : [correction];
  for (let offset = 1; offset <= LOCAL_RADIUS; offset += 1) {
    candidates.push(projectedStdId - offset, projectedStdId + offset);
  }
  return candidates.filter(
    (candidate, index) =>
      isValidStudentId(candidate) &&
      candidate !== projectedStdId &&
      candidates.indexOf(candidate) === index,
  );
}

export async function resolveVnuStudentId(
  options: VnuStudentIdResolverOptions,
): Promise<VnuStudentIdResolution> {
  const concurrency = parsePositiveSafeInteger(
    options.concurrency,
    "concurrency",
  );
  const platformConcurrencyLimit = parsePositiveSafeInteger(
    options.platformConcurrencyLimit ??
      VNU_STUDENT_ID_RESOLVER_PLATFORM_CONCURRENCY,
    "platformConcurrencyLimit",
  );
  const targetCode = options.targetCode;
  if (
    !isValidStudentId(options.ownStdId) ||
    !isValidStudentId(options.ownCode) ||
    !STUDENT_CODE_PATTERN.test(targetCode)
  ) {
    throw notConverged();
  }

  const numericTargetCode = Number(targetCode);
  const projectedStdId =
    options.ownStdId + (numericTargetCode - options.ownCode);
  if (!isValidStudentId(projectedStdId)) throw notConverged();
  if (options.signal?.aborted) throw abortReason(options.signal);

  const active = new Map<number, ActiveProbe>();
  let probes = 0;
  let callerCancellation: unknown;

  const abortActive = (reason: unknown): void => {
    for (const probe of active.values()) probe.cancel(reason);
  };
  const onCallerAbort = (): void => {
    callerCancellation = abortReason(options.signal!);
    abortActive(callerCancellation);
  };
  options.signal?.addEventListener("abort", onCallerAbort, { once: true });

  const startProbe = (index: number, stdId: number): ActiveProbe => {
    const controller = new AbortController();
    let resolveCancellation!: (cancellation: ProbeCancellation) => void;
    let cancellationIssued = false;
    probes += 1;
    let fetchWork: Promise<string | undefined>;
    try {
      fetchWork = options.fetchStudentCode(stdId, controller.signal);
    } catch (error) {
      fetchWork = Promise.reject(error);
    }
    const workSettlement = fetchWork.then<ProbeOutcome, ProbeOutcome>(
      (studentCode) => ({ index, stdId, studentCode }),
      (error: unknown) => ({ index, stdId, error }),
    );
    const cancellation = new Promise<ProbeCancellation>((resolve) => {
      resolveCancellation = resolve;
    });
    const decision = Promise.race<ProbeDecision>([
      workSettlement,
      cancellation,
    ]);
    const cancel = (reason: unknown): void => {
      if (cancellationIssued) return;
      cancellationIssued = true;
      resolveCancellation({ index, stdId, cancelled: true, reason });
      controller.abort(reason);
    };
    const probe = { controller, decision, workSettlement, cancel };
    active.set(index, probe);
    return probe;
  };

  const settleStarted = async (): Promise<ProbeSettlement[]> => {
    const settlements = await Promise.all(
      [...active.values()].map(async (probe) => {
        const [decision, workOutcome] = await Promise.all([
          probe.decision,
          probe.workSettlement,
        ]);
        return { decision, workOutcome };
      }),
    );
    active.clear();
    return settlements;
  };

  try {
    const firstProbe = startProbe(-1, projectedStdId);
    const firstOutcome = await firstProbe.decision;
    await firstProbe.workSettlement;
    active.delete(-1);
    if (callerCancellation !== undefined) throw callerCancellation;
    if ("cancelled" in firstOutcome) throw firstOutcome.reason;
    if ("error" in firstOutcome) throw callerCancellation ?? firstOutcome.error;
    if (firstOutcome.studentCode === targetCode)
      return resolved(projectedStdId, targetCode, probes);

    let correction: number | undefined;
    if (
      firstOutcome.studentCode &&
      STUDENT_CODE_PATTERN.test(firstOutcome.studentCode)
    ) {
      const correctionOffset =
        numericTargetCode - Number(firstOutcome.studentCode);
      const correctedStdId = projectedStdId + correctionOffset;
      if (
        Math.abs(correctionOffset) <= LOCAL_RADIUS &&
        isValidStudentId(correctedStdId) &&
        correctedStdId !== projectedStdId
      ) {
        correction = correctedStdId;
      }
    }

    const candidates = localCandidates(projectedStdId, correction);
    const poolWidth = configuredPoolWidth(
      concurrency,
      platformConcurrencyLimit,
      candidates.length,
    );
    const settled = new Map<number, string | undefined>();
    let nextIndex = 0;
    let earliestExactIndex: number | undefined;

    const fillPool = (): void => {
      while (
        active.size < poolWidth &&
        nextIndex < candidates.length &&
        (earliestExactIndex === undefined || nextIndex < earliestExactIndex)
      ) {
        startProbe(nextIndex, candidates[nextIndex]);
        nextIndex += 1;
      }
    };

    fillPool();
    while (active.size > 0) {
      const outcome = await Promise.race(
        [...active.values()].map((probe) => probe.decision),
      );

      if (callerCancellation !== undefined) {
        abortActive(callerCancellation);
        await settleStarted();
        throw callerCancellation;
      }

      if ("cancelled" in outcome) {
        abortActive(outcome.reason);
        await settleStarted();
        throw outcome.reason;
      }

      active.delete(outcome.index);

      if ("error" in outcome) {
        const fatal = callerCancellation ?? outcome.error;
        abortActive(fatal);
        await settleStarted();
        if (callerCancellation !== undefined) throw callerCancellation;
        throw fatal;
      }

      settled.set(outcome.index, outcome.studentCode);
      if (outcome.studentCode === targetCode) {
        earliestExactIndex = Math.min(
          earliestExactIndex ?? outcome.index,
          outcome.index,
        );
      }

      let prefixIndex = 0;
      while (settled.has(prefixIndex)) {
        if (settled.get(prefixIndex) === targetCode) {
          const winnerStdId = candidates[prefixIndex];
          const winnerReason = new DOMException(
            "Lower-priority probe cancelled",
            "AbortError",
          );
          abortActive(winnerReason);
          const siblingSettlements = await settleStarted();
          if (callerCancellation !== undefined) throw callerCancellation;
          const independentFailure = siblingSettlements.find(
            (settlement) =>
              "error" in settlement.workOutcome &&
              !isWinnerCleanupRejection(settlement, winnerReason),
          );
          if (independentFailure && "error" in independentFailure.workOutcome)
            throw independentFailure.workOutcome.error;
          return resolved(winnerStdId, targetCode, probes);
        }
        prefixIndex += 1;
      }
      fillPool();
    }

    throw callerCancellation ?? notConverged();
  } catch (error) {
    abortActive(error);
    await settleStarted();
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", onCallerAbort);
  }
}
