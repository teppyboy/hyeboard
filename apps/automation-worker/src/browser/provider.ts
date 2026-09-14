import { randomUUID } from "node:crypto";
import type {
  BrowserConnection as AdapterBrowserConnection,
  UetBrowserDriver,
} from "@hyeboard/university-adapters";
import { ConfigurationError } from "../runtime/errors";

export type PuppeteerBrowser = UetBrowserDriver & {
  disconnect(): Promise<void> | void;
};

export type BrowserConnectionMetadata = {
  connectionId: string;
  provider: "browserless";
  endpointOrigin: string;
  ownership: {
    browser: "browserless";
    connection: "automation-worker";
    reconnectEndpoint: "automation-worker";
  };
  adapter: {
    driver: "puppeteer";
    connectionId: string;
  };
  reconnectable: true;
  connectedAt: string;
};

export type BrowserConnection = {
  browser: PuppeteerBrowser;
  metadata: BrowserConnectionMetadata;
  reconnect(): Promise<BrowserConnection>;
  assertOwned(): Promise<void>;
  disconnect(): Promise<void>;
};

export type BrowserProvider = {
  open(signal?: AbortSignal): Promise<BrowserConnection>;
};

// Converts an owned worker connection into the adapter's Node-only bridge.
// The driver object is intentionally kept outside metadata; metadata is safe
// to inspect and contains no endpoint, token, or browser protocol handle.
export function createUetAdapterConnection(
  connection: BrowserConnection,
  assertOwned?: () => Promise<void>,
): AdapterBrowserConnection {
  if (
    connection.metadata.provider !== "browserless" ||
    connection.metadata.adapter.driver !== "puppeteer" ||
    connection.metadata.adapter.connectionId !==
      connection.metadata.connectionId
  ) {
    throw new ConfigurationError(
      "The browser connection is not a supported Puppeteer adapter bridge.",
    );
  }
  return {
    kind: "owned",
    driver: connection.browser,
    assertOwned: async () => {
      await connection.assertOwned();
      await assertOwned?.();
    },
  };
}

export type PuppeteerConnector = (options: {
  browserWSEndpoint: string;
}) => Promise<PuppeteerBrowser>;

export type BrowserlessProviderOptions = {
  endpoint: string;
  token: string;
  connect: PuppeteerConnector;
  id?: () => string;
  now?: () => number;
};

function endpointWithToken(endpoint: string, token: string): URL {
  const url = new URL(endpoint);
  if (url.searchParams.has("token"))
    throw new ConfigurationError(
      "Browserless endpoint must not already contain a token.",
    );
  url.searchParams.set("token", token);
  // StudentHub's current Google Identity Services page opts into FedCM.
  // FedCM does not expose the popup target that this worker must drive through
  // the VNU Keycloak hop, so keep the Browserless Chromium session on the
  // popup-compatible path until the automation uses a FedCM-native API.
  url.searchParams.set(
    "launch",
    JSON.stringify({ args: ["--disable-features=FedCm"] }),
  );
  return url;
}

export function createBrowserlessPuppeteerProvider(
  options: BrowserlessProviderOptions,
): BrowserProvider {
  const id = options.id ?? randomUUID;
  const now = options.now ?? Date.now;
  const endpoint = new URL(options.endpoint);
  const reconnectEndpoint = endpointWithToken(
    options.endpoint,
    options.token,
  ).toString();

  const open = async (signal?: AbortSignal): Promise<BrowserConnection> => {
    if (signal?.aborted) throw new Error("Browser connection was cancelled.");
    const browser = await options.connect({
      browserWSEndpoint: reconnectEndpoint,
    });
    let disconnected = false;
    const connectionId = id();
    const metadata: BrowserConnectionMetadata = {
      connectionId,
      provider: "browserless",
      endpointOrigin: endpoint.origin,
      ownership: {
        browser: "browserless",
        connection: "automation-worker",
        reconnectEndpoint: "automation-worker",
      },
      adapter: { driver: "puppeteer", connectionId },
      reconnectable: true,
      connectedAt: new Date(now()).toISOString(),
    };
    return {
      browser,
      metadata,
      reconnect: () => open(signal),
      assertOwned: async () => {
        if (disconnected || browser.connected === false)
          throw new ConfigurationError(
            "The owned browser connection is no longer active.",
          );
      },
      disconnect: async () => {
        if (disconnected) return;
        disconnected = true;
        await browser.disconnect();
      },
    };
  };
  return { open };
}

export function assertNoPatchrightInDistributedMode(
  mode: "distributed" | "local",
  providerName: string,
): void {
  if (mode === "distributed" && providerName.toLowerCase() === "patchright") {
    throw new ConfigurationError(
      "Patchright is not supported in distributed automation mode; use Browserless.",
    );
  }
}
