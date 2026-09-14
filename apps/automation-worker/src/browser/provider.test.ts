import { describe, expect, it } from "vitest";
import { createBrowserlessPuppeteerProvider } from "./provider";
import type { PuppeteerBrowser } from "../index";

const browser = {
  connected: true,
  newPage: async () => undefined,
  close: async () => undefined,
  disconnect: async () => undefined,
  on: () => undefined,
  off: () => undefined,
} as unknown as PuppeteerBrowser;

describe("Browserless launch options", () => {
  it("disables FedCM so the VNU Google popup remains observable", async () => {
    let endpoint = "";
    const provider = createBrowserlessPuppeteerProvider({
      endpoint: "wss://browserless.example.test/chromium",
      token: "browserless-test-token",
      connect: async ({ browserWSEndpoint }) => {
        endpoint = browserWSEndpoint;
        return browser;
      },
    });

    await provider.open();
    const launch = JSON.parse(new URL(endpoint).searchParams.get("launch")!);
    expect(launch.args).toContain("--disable-features=FedCm");
  });
});
