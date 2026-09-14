import {
  CancellationToken,
  createUetAutomationExecutor,
  type BrowserConnection,
  type AutomationExecutionContext,
  type UetAutomationCredential,
  LeaseLostError,
} from "../index";
import {
  createAccountId,
  createJobId,
  createUetImportJob,
} from "@hyeboard/automation-protocol";
import type {
  ImportedSession,
  UniversityAdapter,
} from "@hyeboard/university-adapters";
import { describe, expect, it, vi } from "vitest";

const browser: BrowserConnection = {
  browser: {
    newPage: async () => ({
      close: async () => undefined,
      setCookie: async () => undefined,
      goto: async () => undefined,
      url: () => "about:blank",
      waitForSelector: async () => ({ click: async () => undefined }),
      click: async () => undefined,
      type: async () => undefined,
      waitForNavigation: async () => undefined,
      bringToFront: async () => undefined,
      isClosed: () => false,
      evaluate: async <T>() => null as T,
      once: () => undefined,
      cookies: async () => [],
      waitForNetworkIdle: async () => undefined,
    }),
    close: async () => undefined,
    disconnect: async () => undefined,
    on: () => undefined,
    off: () => undefined,
  },
  metadata: {
    connectionId: "connection-1",
    provider: "browserless",
    endpointOrigin: "wss://browserless.example.test",
    ownership: {
      browser: "browserless",
      connection: "automation-worker",
      reconnectEndpoint: "automation-worker",
    },
    adapter: { driver: "puppeteer", connectionId: "connection-1" },
    reconnectable: true,
    connectedAt: "2036-01-02T03:04:05.000Z",
  },
  reconnect: async () => browser,
  assertOwned: async () => undefined,
  disconnect: async () => undefined,
};

const job = createUetImportJob({
  jobId: createJobId(() => new Uint8Array(16).fill(1)),
  accountId: createAccountId(() => new Uint8Array(16).fill(2)),
  fence: 1,
  credentialEnvelope: "aep1.synthetic.credentials",
  issuedAt: "2036-01-02T03:00:00.000Z",
  expiresAt: "2036-01-02T04:00:00.000Z",
  expectedStudentCode: "STUDENT-1",
});

const imported: ImportedSession = {
  universityId: "uet",
  studentCode: "STUDENT-1",
  expiresAt: "2036-01-03T03:00:00.000Z",
  session: {
    version: 1,
    universityId: "uet",
    studentCode: "STUDENT-1",
    expiresAt: "2036-01-03T03:00:00.000Z",
    uetGoogleCredential: {
      email: "student@vnu.edu.vn",
      password: "private-password",
    },
  },
};

function adapter(
  importSession: UniversityAdapter["importSession"],
): UniversityAdapter {
  return { importSession } as unknown as UniversityAdapter;
}

function context(
  credential: UetAutomationCredential,
  progress: (phase: string, percent: number) => Promise<void>,
): AutomationExecutionContext<UetAutomationCredential> {
  return {
    job,
    credential,
    browser,
    cancellation: new CancellationToken(
      Date.parse("2036-01-02T04:00:00.000Z"),
      undefined,
      () => Date.parse("2036-01-02T03:04:05.000Z"),
    ),
    progress,
  };
}

describe("UET automation executor", () => {
  it("maps encrypted Google credentials, browser bridge, signal, result, and progress", async () => {
    const progressEvents: Array<[string, number]> = [];
    const signal = vi.fn();
    const importSession = vi.fn(async (input, importContext) => {
      expect(input).toMatchObject({
        uetGoogleEmail: "student@vnu.edu.vn",
        uetGooglePassword: "private-password",
        uetGoogleCookies: [{ name: "SID", value: "private-cookie" }],
      });
      signal(input.signal);
      expect(importContext?.signal).toBe(input.signal);
      importContext?.onProgress?.("Signing in with Google...");
      return imported;
    });
    const adapterConnection = {
      kind: "self-hosted" as const,
      browserWSEndpoint: "wss://fake-driver/session",
    };
    const executor = createUetAutomationExecutor({
      adapter: adapter(importSession),
      adapterConnection: (connection) => {
        expect(connection).toBe(browser);
        return adapterConnection;
      },
    });

    await expect(
      executor.execute(
        context(
          {
            uetGoogleEmail: "student@vnu.edu.vn",
            uetGooglePassword: "private-password",
            uetGoogleCookies: [
              {
                name: "SID",
                value: "private-cookie",
                domain: ".google.com",
                path: "/",
              },
            ],
          },
          async (phase, percent) => {
            progressEvents.push([phase, percent]);
          },
        ),
      ),
    ).resolves.toBe(imported);

    expect(importSession).toHaveBeenCalledOnce();
    expect(signal).toHaveBeenCalledOnce();
    expect(progressEvents).toEqual([
      ["queue", 0],
      ["login", 10],
      ["login", 35],
      ["finalize", 100],
    ]);
    expect(JSON.stringify(progressEvents)).not.toContain("private-password");
  });

  it("hands the provider-owned Puppeteer driver to the adapter by default", async () => {
    const importSession = vi.fn(async (_input, importContext) => {
      expect(importContext?.browserConnection).toMatchObject({
        kind: "owned",
        driver: browser.browser,
      });
      return imported;
    });
    const executor = createUetAutomationExecutor({
      adapter: adapter(importSession),
    });

    await expect(
      executor.execute(
        context(
          {
            uetGoogleEmail: "student@vnu.edu.vn",
            uetGooglePassword: "private-password",
          },
          async () => undefined,
        ),
      ),
    ).resolves.toBe(imported);
    expect(importSession).toHaveBeenCalledOnce();
  });

  it("rejects a stale provider-owned browser before the adapter can run", async () => {
    const staleBrowser: BrowserConnection = {
      ...browser,
      assertOwned: async () => {
        throw new LeaseLostError();
      },
    };
    const importSession = vi.fn(async () => imported);
    const executor = createUetAutomationExecutor({
      adapter: adapter(importSession),
    });
    const staleContext = {
      ...context(
        {
          uetGoogleEmail: "student@vnu.edu.vn",
          uetGooglePassword: "private-password",
        },
        async () => undefined,
      ),
      browser: staleBrowser,
    };

    await expect(executor.execute(staleContext)).rejects.toMatchObject({
      code: "LEASE_LOST",
    });
    expect(importSession).not.toHaveBeenCalled();
  });

  it("uses the typed CAPTCHA hook and propagates cancellation", async () => {
    const captcha = vi.fn(
      async ({ image, signal }: { image: string; signal: AbortSignal }) => {
        expect(image).toBe("data:image/png;base64,FAKE");
        expect(signal.aborted).toBe(false);
        return "typed-answer";
      },
    );
    const importSession = vi.fn(async (_input, importContext) => {
      const answer = await importContext!.onCaptchaNeeded!(
        "data:image/png;base64,FAKE",
        importContext.signal,
      );
      expect(answer).toBe("typed-answer");
      return imported;
    });
    const executor = createUetAutomationExecutor({
      adapter: adapter(importSession),
      adapterConnection: () => ({
        kind: "self-hosted",
        browserWSEndpoint: "wss://fake-driver/session",
      }),
      onCaptchaNeeded: captcha,
    });

    await executor.execute(
      context(
        {
          uetGoogleEmail: "student@vnu.edu.vn",
          uetGooglePassword: "private-password",
        },
        async () => undefined,
      ),
    );
    expect(captcha).toHaveBeenCalledOnce();
  });

  it("reports a truthful unsupported error when CAPTCHA answering is not wired", async () => {
    const importSession = vi.fn(async (_input, importContext) => {
      await importContext!.onCaptchaNeeded!(
        "data:image/png;base64,FAKE",
        importContext.signal,
      );
      return imported;
    });
    const executor = createUetAutomationExecutor({
      adapter: adapter(importSession),
      adapterConnection: () => ({
        kind: "self-hosted",
        browserWSEndpoint: "wss://fake-driver/session",
      }),
    });

    await expect(
      executor.execute(
        context(
          {
            uetGoogleEmail: "student@vnu.edu.vn",
            uetGooglePassword: "private-password",
          },
          async () => undefined,
        ),
      ),
    ).rejects.toMatchObject({
      code: "UET_CAPTCHA_UNSUPPORTED",
    });
  });

  it("stops before the adapter when the job deadline has already expired", async () => {
    const importSession = vi.fn(async () => imported);
    const executor = createUetAutomationExecutor({
      adapter: adapter(importSession),
      adapterConnection: () => ({
        kind: "self-hosted",
        browserWSEndpoint: "wss://fake-driver/session",
      }),
    });
    const expired = {
      ...context(
        {
          uetGoogleEmail: "student@vnu.edu.vn",
          uetGooglePassword: "private-password",
        },
        async () => undefined,
      ),
      cancellation: new CancellationToken(
        Date.parse("2036-01-02T03:00:00.000Z"),
        undefined,
        () => Date.parse("2036-01-02T03:04:05.000Z"),
      ),
    };

    await expect(executor.execute(expired)).rejects.toMatchObject({
      code: "AUTOMATION_CANCELLED",
    });
    expect(importSession).not.toHaveBeenCalled();
  });

  it("fails closed on an identity mismatch", async () => {
    const baseContext = context(
      {
        uetGoogleEmail: "student@vnu.edu.vn",
        uetGooglePassword: "private-password",
      },
      async () => undefined,
    );

    const mismatch = { ...imported, studentCode: "STUDENT-2" };
    const executor = createUetAutomationExecutor({
      adapter: adapter(async () => mismatch),
      adapterConnection: () => ({
        kind: "self-hosted",
        browserWSEndpoint: "wss://fake-driver/session",
      }),
    });
    await expect(executor.execute(baseContext)).rejects.toMatchObject({
      code: "UET_IDENTITY_MISMATCH",
    });
  });

  it("rejects Cloudflare adapter connections in this Node-only package", async () => {
    const executor = createUetAutomationExecutor({
      adapter: adapter(async () => imported),
      adapterConnection: () => ({ kind: "cloudflare", binding: { fetch } }),
    });
    await expect(
      executor.execute(
        context(
          {
            uetGoogleEmail: "student@vnu.edu.vn",
            uetGooglePassword: "private-password",
          },
          async () => undefined,
        ),
      ),
    ).rejects.toMatchObject({
      code: "UET_BROWSER_BRIDGE_UNSUPPORTED",
    });
  });
});
