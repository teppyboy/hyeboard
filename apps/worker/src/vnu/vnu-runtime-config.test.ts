import { describe, expect, it, vi } from "vitest";

import {
  normalizeSelfHostedInteger,
  parseVnuRuntimeConfig,
} from "./vnu-runtime-config";

describe("parseVnuRuntimeConfig", () => {
  it("uses documented missing defaults", () => {
    expect(parseVnuRuntimeConfig({})).toEqual({
      codeLookupConcurrency: 16,
      crossLookupBulkMaxTargets: 500,
      crossLookupDirectChunkMaxTargets: 32,
      codeLookupBulkTargetConcurrency: 3,
      crossLookupRequestTimeoutMs: 60_000,
      crossDetailMaxTargets: 50,
      crossDetailMaxRows: 200,
      crossDetailConcurrency: 6,
      crossDetailBudget: 300,
      crossDetailWindowSeconds: 600,
      crossDetailPermitTtlSeconds: 1200,
      crossDetailExportMode: "selected",
      crossDetailEnabled: true,
    });
  });

  it.each(["1", "16", "32", String(Number.MAX_SAFE_INTEGER)])(
    "accepts positive canonical concurrency %s",
    (value) => {
      expect(
        parseVnuRuntimeConfig({ codeLookupConcurrency: value })
          .codeLookupConcurrency,
      ).toBe(Number(value));
    },
  );

  it.each([
    "0",
    "",
    " 16",
    "16 ",
    "+16",
    "-1",
    "1.0",
    "1e2",
    "0x10",
    "01",
    String(Number.MAX_SAFE_INTEGER + 1),
  ])("falls concurrency %j back to one", (value) => {
    expect(
      parseVnuRuntimeConfig({ codeLookupConcurrency: value })
        .codeLookupConcurrency,
    ).toBe(1);
  });

  it.each(["0", "1", "50", String(Number.MAX_SAFE_INTEGER)])(
    "accepts canonical bulk maximum %s without a product ceiling",
    (value) => {
      expect(
        parseVnuRuntimeConfig({ crossLookupBulkMaxTargets: value })
          .crossLookupBulkMaxTargets,
      ).toBe(Number(value));
    },
  );

  it.each([
    "",
    " 50",
    "50 ",
    "+50",
    "-1",
    "1.5",
    "5e1",
    "0x32",
    "050",
    String(Number.MAX_SAFE_INTEGER + 1),
  ])("disables bulk for malformed value %j", (value) => {
    expect(
      parseVnuRuntimeConfig({ crossLookupBulkMaxTargets: value })
        .crossLookupBulkMaxTargets,
    ).toBe(0);
  });

  it("warns with only setting name and fallback", () => {
    const warn = vi.fn();
    parseVnuRuntimeConfig(
      {
        codeLookupConcurrency: "raw-secret-like-value",
        crossLookupBulkMaxTargets: "another-raw-value",
      },
      warn,
    );

    expect(warn.mock.calls).toEqual([
      ["VNU_CODE_LOOKUP_CONCURRENCY", 1],
      ["VNU_CROSS_LOOKUP_BULK_MAX_TARGETS", 0],
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(
      "raw-secret-like-value",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("another-raw-value");
  });

  it.each(["1", "32", "300"])("accepts direct chunk maximum %s", (value) => {
    expect(
      parseVnuRuntimeConfig({ crossLookupDirectChunkMaxTargets: value })
        .crossLookupDirectChunkMaxTargets,
    ).toBe(Number(value));
  });

  it.each(["0", "301", "-1", "1.5", "raw"])(
    "falls invalid direct chunk maximum %s back to 32",
    (value) => {
      expect(
        parseVnuRuntimeConfig({ crossLookupDirectChunkMaxTargets: value })
          .crossLookupDirectChunkMaxTargets,
      ).toBe(32);
    },
  );

  it.each(["1", "2", "3"])(
    "accepts bounded bulk target concurrency %s",
    (value) => {
      expect(
        parseVnuRuntimeConfig({ codeLookupBulkTargetConcurrency: value })
          .codeLookupBulkTargetConcurrency,
      ).toBe(Number(value));
    },
  );

  it.each(["0", "4", "-1", "raw"])(
    "falls invalid bulk target concurrency %s back to 3",
    (value) => {
      expect(
        parseVnuRuntimeConfig({ codeLookupBulkTargetConcurrency: value })
          .codeLookupBulkTargetConcurrency,
      ).toBe(3);
    },
  );

  it.each(["1", "60000", "120000"])("accepts sane timeout %s", (value) => {
    expect(
      parseVnuRuntimeConfig({ crossLookupRequestTimeoutMs: value })
        .crossLookupRequestTimeoutMs,
    ).toBe(Number(value));
  });

  it.each(["0", "120001", "raw"])(
    "falls invalid timeout %s back to 60000",
    (value) => {
      expect(
        parseVnuRuntimeConfig({ crossLookupRequestTimeoutMs: value })
          .crossLookupRequestTimeoutMs,
      ).toBe(60_000);
    },
  );
});

describe("parseVnuRuntimeConfig cross-detail", () => {
  it.each(["1", "50", "200", String(Number.MAX_SAFE_INTEGER)])(
    "accepts canonical cross-detail bound %s",
    (value) => {
      const config = parseVnuRuntimeConfig({
        crossDetailMaxTargets: value,
        crossDetailMaxRows: value,
        crossDetailBudget: value,
      });
      expect(config.crossDetailMaxTargets).toBe(Number(value));
      expect(config.crossDetailMaxRows).toBe(Number(value));
      expect(config.crossDetailBudget).toBe(Number(value));
      expect(config.crossDetailEnabled).toBe(Number(value) > 0);
    },
  );

  it.each([
    ["crossDetailMaxTargets", "crossDetailMaxTargets"],
    ["crossDetailMaxRows", "crossDetailMaxRows"],
    ["crossDetailBudget", "crossDetailBudget"],
    ["crossDetailConcurrency", "crossDetailConcurrency"],
    ["crossDetailWindowSeconds", "crossDetailWindowSeconds"],
    ["crossDetailPermitTtlSeconds", "crossDetailPermitTtlSeconds"],
  ] as const)(
    "disables the feature when %s is malformed",
    (inputKey, _outputKey) => {
      for (const malformed of [
        "",
        " 50",
        "50 ",
        "+50",
        "-1",
        "1.5",
        "5e1",
        "0x32",
        "050",
        "raw",
        String(Number.MAX_SAFE_INTEGER + 1),
      ]) {
        const config = parseVnuRuntimeConfig({ [inputKey]: malformed });
        expect(config.crossDetailEnabled).toBe(false);
      }
    },
  );

  it.each(["1", "6", "16"])(
    "accepts bounded cross-detail concurrency %s",
    (value) => {
      expect(
        parseVnuRuntimeConfig({ crossDetailConcurrency: value })
          .crossDetailConcurrency,
      ).toBe(Number(value));
    },
  );

  it.each(["0", "17", "1000"])(
    "disables cross-detail for out-of-range concurrency %s",
    (value) => {
      const config = parseVnuRuntimeConfig({ crossDetailConcurrency: value });
      expect(config.crossDetailConcurrency).toBe(0);
      expect(config.crossDetailEnabled).toBe(false);
    },
  );

  it.each(["1", "600", "86400"])(
    "accepts cross-detail window %s seconds",
    (value) => {
      expect(
        parseVnuRuntimeConfig({ crossDetailWindowSeconds: value })
          .crossDetailWindowSeconds,
      ).toBe(Number(value));
    },
  );

  it.each(["0", "86401"])(
    "disables cross-detail for out-of-range window %s",
    (value) => {
      const config = parseVnuRuntimeConfig({ crossDetailWindowSeconds: value });
      expect(config.crossDetailWindowSeconds).toBe(0);
      expect(config.crossDetailEnabled).toBe(false);
    },
  );

  it.each(["1", "60", "600", "1200"])(
    "accepts cross-detail permit TTL %s seconds",
    (value) => {
      expect(
        parseVnuRuntimeConfig({ crossDetailPermitTtlSeconds: value })
          .crossDetailPermitTtlSeconds,
      ).toBe(Number(value));
    },
  );

  it.each(["0", "1201"])(
    "disables cross-detail for out-of-range permit TTL %s",
    (value) => {
      const config = parseVnuRuntimeConfig({
        crossDetailPermitTtlSeconds: value,
      });
      expect(config.crossDetailPermitTtlSeconds).toBe(0);
      expect(config.crossDetailEnabled).toBe(false);
    },
  );

  it("accepts only the literal selected export mode", () => {
    expect(
      parseVnuRuntimeConfig({ crossDetailExportMode: "selected" })
        .crossDetailExportMode,
    ).toBe("selected");
    expect(
      parseVnuRuntimeConfig({ crossDetailExportMode: "selected" })
        .crossDetailEnabled,
    ).toBe(true);
    for (const malformed of [
      "all",
      "SELECTED",
      " selected",
      "selected ",
      "",
      "true",
      "1",
    ]) {
      const config = parseVnuRuntimeConfig({
        crossDetailExportMode: malformed,
      });
      expect(config.crossDetailExportMode).toBeUndefined();
      expect(config.crossDetailEnabled).toBe(false);
    }
  });

  it("disables the feature when any gate value is explicitly zero", () => {
    expect(
      parseVnuRuntimeConfig({ crossDetailMaxTargets: "0" }).crossDetailEnabled,
    ).toBe(false);
    expect(
      parseVnuRuntimeConfig({ crossDetailMaxRows: "0" }).crossDetailEnabled,
    ).toBe(false);
    expect(
      parseVnuRuntimeConfig({ crossDetailBudget: "0" }).crossDetailEnabled,
    ).toBe(false);
  });

  it("warns with only setting name and fallback for cross-detail values", () => {
    const warn = vi.fn();
    parseVnuRuntimeConfig(
      {
        crossDetailMaxTargets: "raw-secret-like-value",
        crossDetailExportMode: "another-raw-value",
      },
      warn,
    );

    expect(warn.mock.calls).toEqual([
      ["VNU_CROSS_DETAIL_MAX_TARGETS", 0],
      ["VNU_CROSS_DETAIL_EXPORT_MODE", 0],
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(
      "raw-secret-like-value",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("another-raw-value");
  });
});

describe("normalizeSelfHostedInteger", () => {
  it.each([
    [undefined, undefined],
    [0, "0"],
    [16, "16"],
    [Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)],
    ["16", "16"],
    [" 16", " 16"],
    [-1, ""],
    [1.5, ""],
    [Number.MAX_SAFE_INTEGER + 1, ""],
    [true, ""],
    [null, ""],
    [{}, ""],
  ])("normalizes file value %j to %j", (input, expected) => {
    expect(normalizeSelfHostedInteger(input)).toBe(expected);
  });
});
