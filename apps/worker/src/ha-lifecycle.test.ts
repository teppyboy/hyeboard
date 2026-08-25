import { describe, expect, it, vi } from "vitest";

import { boundedShutdown, createHaLifecycle, safeHaDiagnostics } from "./ha-lifecycle";
import type { HaConfig } from "./ha-contracts";

const config: HaConfig = {
  mode: "distributed",
  nodeId: "api-1",
  sessionEpoch: 0,
  enforceSessionEpoch: false,
};

describe("createHaLifecycle", () => {
  it("moves from starting through degraded to ready as dependencies recover", async () => {
    let now = new Date("2026-08-19T00:00:00.000Z");
    const lifecycle = createHaLifecycle({
      config,
      now: () => now,
      dependencies: {
        postgres: () => "ready",
        redis: "degraded",
      },
    });

    await expect(lifecycle.readiness()).resolves.toMatchObject({ state: "starting" });
    await lifecycle.start();
    await expect(lifecycle.readiness()).resolves.toMatchObject({
      state: "degraded",
      dependencies: { postgres: "ready", redis: "degraded" },
    });

    now = new Date("2026-08-19T00:00:01.000Z");
    lifecycle.setDependencyStatus("redis", "ready");
    await expect(lifecycle.readiness()).resolves.toMatchObject({ state: "ready" });
    expect(lifecycle.liveness()).toMatchObject({ alive: true, state: "ready" });
  });

  it("stays degraded while policy authority or propagation is unavailable", async () => {
    const lifecycle = createHaLifecycle({
      config,
      dependencies: { policyStore: "ready", policyEvents: "unavailable" },
    });

    await lifecycle.start();
    await expect(lifecycle.readiness()).resolves.toMatchObject({
      state: "degraded",
      dependencies: { policyStore: "ready", policyEvents: "unavailable" },
    });
    lifecycle.setDependencyStatuses({ policyStore: "unavailable", policyEvents: "ready" });
    await expect(lifecycle.readiness()).resolves.toMatchObject({ state: "degraded" });
    lifecycle.setDependencyStatus("policyStore", "ready");
    await expect(lifecycle.readiness()).resolves.toMatchObject({ state: "ready" });
  });

  it("does not advertise distributed dependencies in memory mode", async () => {
    const lifecycle = createHaLifecycle({
      config: { ...config, mode: "memory" },
    });

    await lifecycle.start();
    await expect(lifecycle.readiness()).resolves.toEqual(expect.not.objectContaining({ dependencies: expect.anything() }));
  });

  it("turns thrown dependency probes into unavailable without leaking the error", async () => {
    const lifecycle = createHaLifecycle({
      config,
      dependencies: {
        postgres: async () => {
          throw new Error("postgres://user:password@example.invalid/secret");
        },
      },
    });

    await lifecycle.start();
    const readiness = await lifecycle.readiness();
    expect(readiness).toMatchObject({ state: "degraded", dependencies: { postgres: "unavailable" } });
    expect(JSON.stringify(readiness)).not.toContain("password");
    expect(JSON.stringify(readiness)).not.toContain("example.invalid");
  });

  it("drains and stops idempotently", async () => {
    const onDrain = vi.fn();
    const onStop = vi.fn();
    const lifecycle = createHaLifecycle({ config, onDrain, onStop });

    const firstDrain = lifecycle.drain();
    const secondDrain = lifecycle.drain();
    expect(firstDrain).toBe(secondDrain);
    await firstDrain;
    expect((await lifecycle.readiness()).state).toBe("draining");

    const firstStop = lifecycle.stop();
    const secondStop = lifecycle.stop();
    expect(firstStop).toBe(secondStop);
    await firstStop;
    expect(onDrain).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect((await lifecycle.readiness()).state).toBe("stopped");
    expect(lifecycle.liveness().alive).toBe(false);

    await lifecycle.drain();
    await lifecycle.stop();
    expect(onDrain).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("bounds a hanging shutdown and records the result", async () => {
    const never = new Promise<void>(() => undefined);
    await expect(boundedShutdown(() => never, 1)).resolves.toEqual({ completed: false, timedOut: true });

    const lifecycle = createHaLifecycle({
      config,
      shutdownTimeoutMs: 1,
      onDrain: () => never,
    });
    await lifecycle.stop();
    expect(lifecycle.shutdownReport()).toEqual({ drain: "timed-out", stop: "completed" });
    expect((await lifecycle.readiness()).state).toBe("stopped");
  });
});

describe("safeHaDiagnostics", () => {
  it("only emits allowlisted health fields", () => {
    const diagnostics = safeHaDiagnostics({
      liveness: {
        alive: true,
        state: "ready",
        mode: "distributed",
        checkedAt: "2026-08-19T00:00:00.000Z",
        nodeId: "bearer-secret-token",
      },
      readiness: {
        state: "ready",
        mode: "distributed",
        checkedAt: "2026-08-19T00:00:00.000Z",
        nodeId: "bearer-secret-token",
        reason: "https://db.example.invalid/password=secret",
        dependencies: {
          postgres: "ready",
          "https://redis.example.invalid": "ready",
        },
      },
    });

    expect(diagnostics).toEqual({
      alive: true,
      state: "ready",
      mode: "distributed",
      checkedAt: "2026-08-19T00:00:00.000Z",
      dependencies: { postgres: "ready" },
    });
    expect(JSON.stringify(diagnostics)).not.toContain("bearer-secret-token");
    expect(JSON.stringify(diagnostics)).not.toContain("example.invalid");
  });
});
