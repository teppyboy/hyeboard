export function createLinkedAbortController(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
  callerAbortReason: Error,
  timeoutReason: Error,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(callerAbortReason);

  if (callerSignal?.aborted) onCallerAbort();
  else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

  const timeoutId = controller.signal.aborted
    ? undefined
    : setTimeout(() => controller.abort(timeoutReason), timeoutMs);

  return {
    signal: controller.signal,
    dispose: () => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}
