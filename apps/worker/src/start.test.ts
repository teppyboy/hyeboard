import { describe, expect, it } from "vitest";
import { selfHostedRuntimeConfig } from "./start";

describe("selfHostedRuntimeConfig PostgreSQL pool settings", () => {
  it("uses bounded PostgreSQL pool defaults", () => {
    expect(selfHostedRuntimeConfig({}, {})).toMatchObject({
      HYEB_POSTGRES_POOL_MAX: "5",
      HYEB_POSTGRES_CONNECT_TIMEOUT_MS: "5000",
    });
  });

  it.each([
    ["HYEB_POSTGRES_POOL_MAX", "0"],
    ["HYEB_POSTGRES_POOL_MAX", "-1"],
    ["HYEB_POSTGRES_POOL_MAX", "1.5"],
    ["HYEB_POSTGRES_POOL_MAX", "many"],
    ["HYEB_POSTGRES_CONNECT_TIMEOUT_MS", "0"],
    ["HYEB_POSTGRES_CONNECT_TIMEOUT_MS", "-1"],
    ["HYEB_POSTGRES_CONNECT_TIMEOUT_MS", "1.5"],
    ["HYEB_POSTGRES_CONNECT_TIMEOUT_MS", "soon"],
  ])("rejects invalid %s=%s", (name, value) => {
    expect(() => selfHostedRuntimeConfig({ [name]: value }, {})).toThrow(
      `${name} must be a positive integer.`,
    );
  });
});
