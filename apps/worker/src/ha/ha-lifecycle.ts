import type {
  HaConfig,
  HaDependencyReadiness,
  HaLifecycle,
  HaReadiness,
  HaReadinessProbe,
  HaReadinessState,
  HaMode,
} from "./ha-contracts";

export const DEFAULT_HA_SHUTDOWN_TIMEOUT_MS = 10_000;

export type HaDependencyProbe = () =>
  | HaDependencyReadiness
  | Promise<HaDependencyReadiness>;

export type HaDependencyDefinition =
  | HaDependencyReadiness
  | HaDependencyProbe
  | { probe: HaDependencyProbe; initial?: HaDependencyReadiness };

export type HaLifecycleOptions = {
  config: HaConfig;
  dependencies?: Readonly<Record<string, HaDependencyDefinition>>;
  /** An optional aggregate check for dependencies that are owned elsewhere. */
  readinessProbe?: HaReadinessProbe;
  now?: () => Date;
  /** Alias for `now`, useful when a shared clock is already available. */
  clock?: () => Date;
  onDrain?: () => void | Promise<void>;
  onStop?: () => void | Promise<void>;
  shutdownTimeoutMs?: number;
};

export type HaLiveness = {
  alive: boolean;
  state: HaReadinessState;
  mode: HaMode;
  checkedAt: string;
  nodeId?: string;
};

export type HaHealthSnapshot = {
  liveness: HaLiveness;
  readiness: HaReadiness;
};

export type HaSafeDiagnostics = {
  alive: boolean;
  state: HaReadinessState;
  mode: HaMode;
  checkedAt: string;
  dependencies: Readonly<Record<string, HaDependencyReadiness>>;
};

export type HaShutdownOutcome<T> =
  | { completed: true; timedOut: false; value: T }
  | { completed: false; timedOut: true };

export type HaShutdownReport = {
  drain: "completed" | "timed-out";
  stop: "completed" | "timed-out";
};

export type HaLifecycleController = HaLifecycle & {
  liveness(): HaLiveness;
  snapshot(): Promise<HaHealthSnapshot>;
  diagnostics(): Promise<HaSafeDiagnostics>;
  setDependencyStatus(name: string, status: HaDependencyReadiness): void;
  setDependencyStatuses(
    statuses: Readonly<Record<string, HaDependencyReadiness>>,
  ): void;
  dependencyStatuses(): Readonly<Record<string, HaDependencyReadiness>>;
  shutdownReport(): HaShutdownReport | undefined;
};

const DEPENDENCY_STATUSES: ReadonlySet<HaDependencyReadiness> = new Set([
  "ready",
  "degraded",
  "unavailable",
]);

const READINESS_STATES: ReadonlySet<HaReadinessState> = new Set([
  "starting",
  "ready",
  "degraded",
  "draining",
  "stopped",
]);

const HA_MODES: ReadonlySet<HaMode> = new Set([
  "cloudflare",
  "distributed",
  "memory",
]);
const SAFE_DIAGNOSTIC_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

function isDependencyReadiness(value: unknown): value is HaDependencyReadiness {
  return (
    typeof value === "string" &&
    DEPENDENCY_STATUSES.has(value as HaDependencyReadiness)
  );
}

function isReadinessState(value: unknown): value is HaReadinessState {
  return (
    typeof value === "string" && READINESS_STATES.has(value as HaReadinessState)
  );
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_HA_SHUTDOWN_TIMEOUT_MS;
  if (!Number.isFinite(value) || value < 0)
    throw new RangeError(
      "shutdownTimeoutMs must be a finite non-negative number",
    );
  return Math.floor(value);
}

function timestamp(now: () => Date): string {
  const value = now();
  return Number.isNaN(value.getTime())
    ? new Date(0).toISOString()
    : value.toISOString();
}

/**
 * Run a cleanup operation without allowing it to extend the caller's shutdown
 * budget. A timeout does not cancel the operation; callers must make their
 * cleanup handlers cancellation-aware if cancellation is available.
 */
export function boundedShutdown<T>(
  operation: () => T | Promise<T>,
  timeoutMs = DEFAULT_HA_SHUTDOWN_TIMEOUT_MS,
): Promise<HaShutdownOutcome<T>> {
  const timeout = normalizeTimeout(timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const work = Promise.resolve()
    .then(operation)
    .then(
      (value): HaShutdownOutcome<T> => ({
        completed: true,
        timedOut: false,
        value,
      }),
    );
  const deadline = new Promise<HaShutdownOutcome<T>>((resolve) => {
    timer = setTimeout(
      () => resolve({ completed: false, timedOut: true }),
      timeout,
    );
  });

  return Promise.race([work, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export const withShutdownTimeout = boundedShutdown;

function safeDependencyStatuses(
  readiness: HaReadiness,
): Readonly<Record<string, HaDependencyReadiness>> {
  return Object.fromEntries(
    Object.entries(readiness.dependencies ?? {})
      .filter(
        ([name, status]) =>
          SAFE_DIAGNOSTIC_NAME.test(name) && isDependencyReadiness(status),
      )
      .sort(([left], [right]) => left.localeCompare(right)),
  ) as Readonly<Record<string, HaDependencyReadiness>>;
}

function safeTimestamp(value: string): string {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value
    ? value
    : new Date(0).toISOString();
}

/**
 * Project health snapshots to operator-safe fields. In particular, this does
 * not copy node IDs, reasons, probe errors, URLs, or arbitrary input fields.
 */
export function safeHaDiagnostics(
  snapshot: HaHealthSnapshot,
): HaSafeDiagnostics {
  const state = isReadinessState(snapshot.readiness.state)
    ? snapshot.readiness.state
    : "starting";
  const mode = HA_MODES.has(snapshot.readiness.mode)
    ? snapshot.readiness.mode
    : "memory";
  return {
    alive: snapshot.liveness.alive === true,
    state,
    mode,
    checkedAt: safeTimestamp(snapshot.readiness.checkedAt),
    dependencies: safeDependencyStatuses(snapshot.readiness),
  };
}

export const safeDiagnostics = safeHaDiagnostics;

function isDependencyDefinitionObject(
  value: HaDependencyDefinition,
): value is { probe: HaDependencyProbe; initial?: HaDependencyReadiness } {
  return typeof value === "object" && value !== null && "probe" in value;
}

function createOptions(
  config: HaConfig,
  dependencies?: Readonly<Record<string, HaDependencyDefinition>>,
): HaLifecycleOptions {
  return { config, dependencies };
}

export function createHaLifecycle(
  options: HaLifecycleOptions,
): HaLifecycleController;
export function createHaLifecycle(
  config: HaConfig,
  dependencies?: Readonly<Record<string, HaDependencyDefinition>>,
): HaLifecycleController;
export function createHaLifecycle(
  optionsOrConfig: HaLifecycleOptions | HaConfig,
  positionalDependencies?: Readonly<Record<string, HaDependencyDefinition>>,
): HaLifecycleController {
  const options =
    "config" in optionsOrConfig
      ? optionsOrConfig
      : createOptions(optionsOrConfig, positionalDependencies);
  const now = options.now ?? options.clock ?? (() => new Date());
  const shutdownTimeoutMs = normalizeTimeout(options.shutdownTimeoutMs);
  const dependencies = new Map<string, HaDependencyReadiness>();
  const probes = new Map<string, HaDependencyProbe>();

  for (const [name, definition] of Object.entries(options.dependencies ?? {})) {
    if (typeof definition === "function") {
      probes.set(name, definition);
      dependencies.set(name, "unavailable");
    } else if (isDependencyDefinitionObject(definition)) {
      probes.set(name, definition.probe);
      dependencies.set(name, definition.initial ?? "unavailable");
    } else {
      dependencies.set(name, definition);
    }
  }

  let state: HaReadinessState = "starting";
  let aggregateProbeState: HaReadinessState | undefined;
  let startPromise: Promise<void> | undefined;
  let drainPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let report: HaShutdownReport | undefined;

  function dependencySnapshot(): Readonly<
    Record<string, HaDependencyReadiness>
  > {
    return Object.fromEntries(
      [...dependencies.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ) as Readonly<Record<string, HaDependencyReadiness>>;
  }

  function nextOperationalState(): "ready" | "degraded" {
    if (aggregateProbeState !== undefined && aggregateProbeState !== "ready")
      return "degraded";
    for (const status of dependencies.values()) {
      if (status !== "ready") return "degraded";
    }
    return "ready";
  }

  function applyDependencyState(): void {
    if (state === "starting" || state === "ready" || state === "degraded") {
      state = nextOperationalState();
    }
  }

  async function refreshDependencies(): Promise<void> {
    if (options.readinessProbe !== undefined) {
      try {
        const result = await options.readinessProbe();
        aggregateProbeState = result.state;
        for (const [name, status] of Object.entries(
          result.dependencies ?? {},
        )) {
          if (isDependencyReadiness(status)) dependencies.set(name, status);
          else dependencies.set(name, "unavailable");
        }
      } catch {
        aggregateProbeState = "degraded";
      }
    }

    await Promise.all(
      [...probes.entries()].map(async ([name, probe]) => {
        try {
          const result = await probe();
          dependencies.set(
            name,
            isDependencyReadiness(result) ? result : "unavailable",
          );
        } catch {
          dependencies.set(name, "unavailable");
        }
      }),
    );
    applyDependencyState();
  }

  function readinessSnapshot(): HaReadiness {
    const readiness: HaReadiness = {
      state,
      mode: options.config.mode,
      checkedAt: timestamp(now),
      ...(options.config.nodeId === undefined
        ? {}
        : { nodeId: options.config.nodeId }),
      ...(state === "starting" ? { reason: "not-started" } : {}),
      ...(state === "degraded"
        ? {
            reason:
              aggregateProbeState === "degraded"
                ? "readiness-check-failed"
                : "dependency-not-ready",
          }
        : {}),
      ...(state === "draining" ? { reason: "draining" } : {}),
      ...(state === "stopped" ? { reason: "stopped" } : {}),
      ...(dependencies.size === 0
        ? {}
        : { dependencies: dependencySnapshot() }),
    };
    return readiness;
  }

  function livenessSnapshot(): HaLiveness {
    return {
      alive: state !== "stopped",
      state,
      mode: options.config.mode,
      checkedAt: timestamp(now),
      ...(options.config.nodeId === undefined
        ? {}
        : { nodeId: options.config.nodeId }),
    };
  }

  async function start(): Promise<void> {
    if (state !== "starting") return;
    if (startPromise !== undefined) return startPromise;
    startPromise = refreshDependencies().then(() => undefined);
    return startPromise;
  }

  function drain(): Promise<void> {
    if (state === "stopped") return Promise.resolve();
    if (drainPromise !== undefined) return drainPromise;
    state = "draining";
    drainPromise = Promise.resolve()
      .then(() => options.onDrain?.())
      .then(() => undefined);
    return drainPromise;
  }

  async function stop(): Promise<void> {
    if (state === "stopped") return;
    let firstError: unknown;
    const startedAt = Date.now();
    const drainResult = await boundedShutdown(
      () => drain(),
      shutdownTimeoutMs,
    ).catch((error: unknown) => {
      firstError = error;
      return undefined;
    });
    const elapsed = Math.max(0, Date.now() - startedAt);
    const remaining = drainResult?.timedOut
      ? 0
      : Math.max(0, shutdownTimeoutMs - elapsed);
    const stopResult = await boundedShutdown(
      () => options.onStop?.(),
      remaining,
    ).catch((error: unknown) => {
      firstError ??= error;
      return undefined;
    });

    report = {
      drain: drainResult?.timedOut ? "timed-out" : "completed",
      stop: stopResult?.timedOut ? "timed-out" : "completed",
    };
    state = "stopped";
    if (firstError !== undefined) throw firstError;
  }

  function setDependencyStatus(
    name: string,
    status: HaDependencyReadiness,
  ): void {
    if (!isDependencyReadiness(status))
      throw new TypeError("Invalid dependency readiness");
    dependencies.set(name, status);
    applyDependencyState();
  }

  function setDependencyStatuses(
    statuses: Readonly<Record<string, HaDependencyReadiness>>,
  ): void {
    for (const [name, status] of Object.entries(statuses))
      setDependencyStatus(name, status);
  }

  async function readiness(): Promise<HaReadiness> {
    if (state === "starting") {
      if (startPromise !== undefined) await startPromise;
    } else if (state === "ready" || state === "degraded") {
      await refreshDependencies();
    }
    return readinessSnapshot();
  }

  async function snapshot(): Promise<HaHealthSnapshot> {
    const readinessValue = await readiness();
    return { liveness: livenessSnapshot(), readiness: readinessValue };
  }

  async function diagnostics(): Promise<HaSafeDiagnostics> {
    return safeHaDiagnostics(await snapshot());
  }

  function stopOnce(): Promise<void> {
    if (stopPromise !== undefined) return stopPromise;
    stopPromise = stop();
    return stopPromise;
  }

  return {
    start,
    readiness,
    drain,
    stop: stopOnce,
    liveness: livenessSnapshot,
    snapshot,
    diagnostics,
    setDependencyStatus,
    setDependencyStatuses,
    dependencyStatuses: dependencySnapshot,
    shutdownReport: () => report,
  };
}

export const createLifecycle = createHaLifecycle;
