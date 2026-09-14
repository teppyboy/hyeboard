import { describe, expect, it, vi } from "vitest";

import { createApp } from "../app";
import { createGracefulShutdown, selfHostedHaConfig } from "../start";
import { createHaLifecycle } from "./ha-lifecycle";

describe("self-hosted HA integration", () => {
  it("parses the structured HA mode while environment values take precedence", () => {
    expect(
      selfHostedHaConfig(
        { HYEB_HA_MODE: "distributed", HYEB_HA_SESSION_EPOCH: "4" },
        {
          HYEB_HA_MODE: "memory",
          HYEB_HA_SESSION_EPOCH: "2",
        },
      ),
    ).toEqual({
      mode: "distributed",
      sessionEpoch: 4,
      enforceSessionEpoch: false,
    });
  });

  it("reports live and ready independently from the legacy health contract", async () => {
    const app = createApp(undefined);

    const health = await app.handle(new Request("http://localhost/api/health"));
    const live = await app.handle(new Request("http://localhost/api/live"));
    const ready = await app.handle(new Request("http://localhost/api/ready"));

    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      data: { status: "ok", service: "hyeboard" },
      error: null,
    });
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({
      data: { alive: true, mode: "memory" },
      error: null,
    });
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      data: { alive: true, state: "ready", mode: "memory", dependencies: {} },
      error: null,
    });
  });

  it("keeps readiness unavailable while a distributed dependency is not initialized", async () => {
    const lifecycle = createHaLifecycle({
      config: {
        mode: "distributed",
        sessionEpoch: 0,
        enforceSessionEpoch: false,
      },
      dependencies: { postgres: "unavailable", redis: "ready" },
    });
    const ready = await createApp(undefined, { lifecycle }).handle(
      new Request("http://localhost/api/ready"),
    );
    const live = await createApp(undefined, { lifecycle }).handle(
      new Request("http://localhost/api/live"),
    );

    expect(ready.status).toBe(503);
    await expect(ready.json()).resolves.toMatchObject({
      data: {
        state: "degraded",
        dependencies: { postgres: "unavailable", redis: "ready" },
      },
    });
    expect(live.status).toBe(200);
  });

  it("runs graceful shutdown only once", async () => {
    const lifecycle = createHaLifecycle({
      config: { mode: "memory", sessionEpoch: 0, enforceSessionEpoch: false },
      onStop: vi.fn(),
    });
    const exit = vi.fn();
    const shutdown = createGracefulShutdown({ lifecycle, exit });

    await Promise.all([shutdown(), shutdown()]);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(lifecycle.shutdownReport()).toEqual({
      drain: "completed",
      stop: "completed",
    });
  });
});
