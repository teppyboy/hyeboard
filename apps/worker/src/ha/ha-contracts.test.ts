import { describe, expect, it, vi } from "vitest";

import { checkSessionEpoch, parseHaConfig } from "./ha-contracts";

describe("parseHaConfig", () => {
  it("uses memory mode and leaves epoch enforcement disabled by default", () => {
    expect(parseHaConfig()).toEqual({ mode: "memory", sessionEpoch: 0, enforceSessionEpoch: false });
  });

  it("uses environment values over structured file values", () => {
    expect(parseHaConfig({
      HYEB_HA_MODE: "distributed",
      HYEB_HA_SESSION_EPOCH: "7",
      HYEB_HA_ENFORCE_SESSION_EPOCH: "true",
    }, {
      ha: { mode: "cloudflare", session_epoch: 3, enforce_session_epoch: false, node_id: "file-node" },
    })).toEqual({
      mode: "distributed",
      nodeId: "file-node",
      sessionEpoch: 7,
      enforceSessionEpoch: true,
    });
  });

  it("accepts file values when environment values are absent", () => {
    expect(parseHaConfig({}, {
      ha: { mode: "cloudflare", node_id: "cf-node", session_epoch: 4, enforce_session_epoch: false },
    })).toEqual({ mode: "cloudflare", nodeId: "cf-node", sessionEpoch: 4, enforceSessionEpoch: false });
  });

  it("falls back without exposing malformed values and disables unsafe enforcement", () => {
    const warn = vi.fn();
    const config = parseHaConfig({
      HYEB_HA_MODE: "not-a-mode",
      HYEB_HA_SESSION_EPOCH: "01",
      HYEB_HA_ENFORCE_SESSION_EPOCH: "true",
    }, {}, warn);

    expect(config).toEqual({ mode: "memory", sessionEpoch: 0, enforceSessionEpoch: false });
    expect(warn.mock.calls).toEqual([
      ["HYEB_HA_MODE", "memory"],
      ["HYEB_HA_SESSION_EPOCH", 0],
      ["HYEB_HA_ENFORCE_SESSION_EPOCH", false],
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("not-a-mode");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("01");
  });

  it("requires distributed mode and an explicit valid epoch for enforcement", () => {
    expect(parseHaConfig({ HYEB_HA_ENFORCE_SESSION_EPOCH: "true" })).toMatchObject({ mode: "memory", enforceSessionEpoch: false });
    expect(parseHaConfig({ HYEB_HA_MODE: "distributed", HYEB_HA_ENFORCE_SESSION_EPOCH: "true" })).toMatchObject({ enforceSessionEpoch: false });
    expect(parseHaConfig({ HYEB_HA_MODE: "distributed", HYEB_HA_SESSION_EPOCH: "2", HYEB_HA_ENFORCE_SESSION_EPOCH: "true" })).toMatchObject({
      mode: "distributed",
      sessionEpoch: 2,
      enforceSessionEpoch: true,
    });
  });
});

describe("checkSessionEpoch", () => {
  const enforced = parseHaConfig({ HYEB_HA_MODE: "distributed", HYEB_HA_SESSION_EPOCH: "2", HYEB_HA_ENFORCE_SESSION_EPOCH: "true" });

  it("accepts legacy metadata-less tokens unless enforcement is explicitly enabled", () => {
    expect(checkSessionEpoch({}, parseHaConfig())).toEqual({ accepted: true, reason: "enforcement-disabled" });
    expect(checkSessionEpoch({}, enforced)).toEqual({ accepted: false, reason: "missing-session-metadata" });
  });

  it("accepts matching metadata and rejects stale epochs", () => {
    expect(checkSessionEpoch({ sessionId: "session-1", sessionEpoch: 2 }, enforced)).toEqual({ accepted: true, reason: "matching-epoch" });
    expect(checkSessionEpoch({ sessionId: "session-1", sessionEpoch: 1 }, enforced)).toEqual({ accepted: false, reason: "session-epoch-mismatch" });
  });
});
