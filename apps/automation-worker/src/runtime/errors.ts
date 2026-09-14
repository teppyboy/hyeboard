export type CancellationReason = "requested" | "deadline" | "shutdown" | "lease-lost";

export class AutomationWorkerError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "AutomationWorkerError";
  }
}

export class ConfigurationError extends AutomationWorkerError {
  constructor(message: string) {
    super(message, "INVALID_CONFIGURATION");
    this.name = "ConfigurationError";
  }
}

export class CancellationError extends AutomationWorkerError {
  constructor(public readonly reason: CancellationReason) {
    super(`Automation cancelled: ${reason}`, "AUTOMATION_CANCELLED", false);
    this.name = "CancellationError";
  }
}

export class LeaseLostError extends AutomationWorkerError {
  constructor() {
    super("The job lease was lost.", "LEASE_LOST", true);
    this.name = "LeaseLostError";
  }
}

export function errorCode(error: unknown): string {
  if (error instanceof AutomationWorkerError) return error.code;
  return "AUTOMATION_EXECUTION_FAILED";
}

export function isRetryable(error: unknown): boolean {
  return error instanceof AutomationWorkerError && error.retryable;
}
