import type { CancellationReason } from "./errors";
import type { AutomationWorker } from "./worker";

export function installProcessSignalHandlers<TCredential, TResult>(
  worker: AutomationWorker<TCredential, TResult>,
  onError: (error: unknown) => void = () => undefined,
): () => void {
  let stopping: Promise<void> | undefined;
  const stop = (reason: CancellationReason) => {
    stopping ??= worker.stop(reason).catch(onError);
  };
  const onSigterm = () => stop("shutdown");
  const onSigint = () => stop("shutdown");
  process.once("SIGTERM", onSigterm);
  process.once("SIGINT", onSigint);
  return () => {
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
  };
}
