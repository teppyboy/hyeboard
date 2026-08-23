import { test, expect } from "./fixtures/base";
import { startMockedVnuSession } from "./fixtures/vnu";

test("dashboard redirects to login without a session", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Sign in to Hyeboard" })).toBeVisible();
});

test("login shows university-specific sections", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("combobox", { name: "School" })).toContainText("VNU-UET");
  await expect(page.getByText("Connect university account")).toBeVisible();
  await expect(page.getByText("Use Demo Data")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign in with Google" })).toBeVisible();
  await page.getByRole("button", { name: "Having trouble? Use a manual token instead" }).click();
  await expect(page.getByText("Connect your university portal")).toBeVisible();
  await expect(page.getByText(/origin_mismatch/)).toBeVisible();
  await expect(page.getByText(/copy\(localStorage\.getItem/)).toBeVisible();
  await expect(page.getByPlaceholder("University portal access token")).toHaveAttribute("type", "password");
  await expect(page.getByRole("button", { name: "Open university portal" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open learning platform" })).toBeVisible();
  await expect(page.getByText("Optional: connect the learning platform")).toBeVisible();
  await expect(page.getByPlaceholder("Learning platform access token")).toHaveAttribute("type", "password");
  await expect(page.getByText("Advanced cookie options")).toBeVisible();
  await page.getByText("Advanced cookie options").click();
  await expect(page.getByPlaceholder("University portal cookie, if token import is unavailable")).toHaveAttribute("type", "password");
  await expect(page.getByPlaceholder("Student code, optional")).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "uet");

  await page.getByRole("combobox", { name: "School" }).click();
  await page.getByRole("option", { name: "Mock" }).click();
  await expect(page.getByRole("combobox", { name: "School" })).toContainText("Mock");
  await expect(page.getByText("Use Demo Data")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Demo Workspace" })).toBeVisible();
  await expect(page.getByPlaceholder("Student code, optional")).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "geist");
});

test("UET login leads with Google sign-in and reveals manual fallback on demand", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("combobox", { name: "School" }).click();
  await page.getByRole("option", { name: "VNU-UET" }).click();

  await expect(page.getByPlaceholder("Student code")).toBeVisible();
  await expect(page.getByPlaceholder("Google account password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with Google" })).toBeVisible();

  await expect(page.getByPlaceholder("University portal access token")).toHaveCount(0);
  await expect(page.getByPlaceholder("Learning platform access token")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open university portal" })).toHaveCount(0);

  await page.getByRole("button", { name: "Having trouble? Use a manual token instead" }).click();

  await expect(page.getByPlaceholder("University portal access token")).toBeVisible();
  await expect(page.getByPlaceholder("Learning platform access token")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open university portal" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open learning platform" })).toBeVisible();
});

test("VNU plaintext input never enters storage while UET relogin persistence remains", async ({ page }) => {
  await page.route("**/api/vnu/auth/import-session", (route) => route.fulfill({
    status: 401,
    contentType: "application/json",
    body: JSON.stringify({ data: null, error: { code: "INVALID_VNU_CREDENTIAL", message: "Synthetic invalid VNU credential" } }),
  }));
  await page.goto("/login");

  await page.getByRole("button", { name: "Having trouble? Use a manual token instead" }).click();
  await page.getByPlaceholder("Learning platform access token").fill("canvas-relogin-token");
  await page.reload();
  await page.getByRole("button", { name: "Having trouble? Use a manual token instead" }).click();
  await expect(page.getByPlaceholder("Learning platform access token")).toHaveValue("canvas-relogin-token");

  await page.getByRole("combobox", { name: "School" }).click();
  await page.getByRole("option", { name: "VNU (daotao)" }).click();
  await page.getByPlaceholder("Student code / username").fill("24000000");
  await page.getByPlaceholder("Password").fill("vnu-relogin-password");
  await page.getByRole("button", { name: "Import university session", exact: true }).click();
  await expect(page.getByText("Synthetic invalid VNU credential")).toBeVisible();
  expect(await page.evaluate(() => ({
    username: sessionStorage.getItem("hyeboard.relogin.vnu.username"),
    password: sessionStorage.getItem("hyeboard.relogin.vnu.password"),
    grantKeys: Object.keys(sessionStorage).filter((key) => key.startsWith("hyeboard.vnu.refreshGrant.")),
    local: JSON.stringify({ ...localStorage }),
  }))).toEqual({ username: null, password: null, grantKeys: [], local: expect.not.stringContaining("vnu-relogin-password") });
  await page.reload();

  await page.getByRole("combobox", { name: "School" }).click();
  await page.getByRole("option", { name: "VNU (daotao)" }).click();
  await expect(page.getByPlaceholder("Student code / username")).toHaveValue("");
  await expect(page.getByPlaceholder("Password")).toHaveValue("");
});

test("VNU plaintext is absent after session expiry and manual sign-in is empty", async ({ page }) => {
  const mockedSession = await startMockedVnuSession(page, {
    code: "VNU_SESSION_EXPIRED",
    status: 401,
    message: "Synthetic VNU session expired",
  });

  await mockedSession.allRawResponsesFulfilled;
  await expect(page).toHaveURL(/\/login$/);
  const storage = await page.evaluate(() => ({
    accounts: JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as unknown[],
    activeAccountId: localStorage.getItem("hyeboard.activeAccountId"),
  }));
  expect(storage.accounts).toHaveLength(0);
  expect(storage.activeAccountId).toBeNull();

  await page.getByRole("combobox", { name: "School" }).click();
  await page.getByRole("option", { name: "VNU (daotao)" }).click();
  await expect(page.getByLabel("Username")).toHaveValue("");
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");

  const credentialStorage = await page.evaluate(() => {
    const credentialEntries = Object.entries(sessionStorage).filter(([, value]) => value === "synthetic-vnu-user" || value === "synthetic-vnu-password");
    return {
      sessionCredentials: Object.fromEntries(credentialEntries),
      localStorageSerialized: JSON.stringify({ ...localStorage }),
    };
  });
  expect(credentialStorage.sessionCredentials).toEqual({});
  expect(credentialStorage.localStorageSerialized).not.toContain("synthetic-vnu-user");
  expect(credentialStorage.localStorageSerialized).not.toContain("synthetic-vnu-password");

  const newTab = await page.context().newPage();
  await newTab.goto("/login");
  await newTab.getByRole("combobox", { name: "School" }).click();
  await newTab.getByRole("option", { name: "VNU (daotao)" }).click();
  await expect(newTab.getByLabel("Username")).toHaveValue("");
  await expect(newTab.getByLabel("Password", { exact: true })).toHaveValue("");
  expect(await newTab.evaluate(() => ({
    username: sessionStorage.getItem("hyeboard.relogin.vnu.username"),
    password: sessionStorage.getItem("hyeboard.relogin.vnu.password"),
  }))).toEqual({ username: null, password: null });
  await newTab.close();
});

test("VNU grant import is account-scoped and deletes legacy plaintext", async ({ page }) => {
  await page.route("**/api/**", (route) => route.abort());
  await page.route("**/api/vnu/auth/import-session", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data: {
      token: "synthetic-scoped-access",
      refreshGrant: "synthetic-scoped-grant",
      session: { authenticated: true, universityId: "vnu", studentCode: "SYNTHETIC-SCOPED-STUDENT", expiresAt: "2099-01-01T00:00:00.000Z" },
    }, error: null }),
  }));
  await page.goto("/login");
  await page.evaluate(() => {
    sessionStorage.setItem("hyeboard.relogin.vnu.username", "legacy-synthetic-user");
    sessionStorage.setItem("hyeboard.relogin.vnu.password", "legacy-synthetic-password");
  });
  await page.getByRole("combobox", { name: "School" }).click();
  await page.getByRole("option", { name: "VNU (daotao)" }).click();
  await page.getByLabel("Username").fill("SYNTHETIC-SCOPED-USER");
  await page.getByLabel("Password", { exact: true }).fill("SYNTHETIC-SCOPED-PASSWORD");
  await page.getByRole("button", { name: "Import university session", exact: true }).click();

  await expect.poll(() => page.evaluate(() => {
    const account = (JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<{ id: string; studentCode?: string }>).find((item) => item.studentCode === "SYNTHETIC-SCOPED-STUDENT");
    return account ? {
      grant: sessionStorage.getItem(`hyeboard.vnu.refreshGrant.${account.id}`),
      username: sessionStorage.getItem("hyeboard.relogin.vnu.username"),
      password: sessionStorage.getItem("hyeboard.relogin.vnu.password"),
    } : null;
  })).toEqual({ grant: "synthetic-scoped-grant", username: null, password: null });
});

test("login always shows the correct accent color for the selected school, never a stale one", async ({ page }) => {
  // Simulate a browser that previously had a mock (geist) session persisted,
  // then landed back on /login for VNU-UET - the accent must not stay stale.
  await page.goto("/login");
  await page.evaluate(() => {
    localStorage.setItem("hyeboard.palette", "geist");
    localStorage.setItem("hyeboard.universityId", "uet");
  });
  await page.goto("/login");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "uet");
});

test("login fields expose persistent accessible labels on mobile @webkit", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/login");

  // UET branch: Google sign-in fields.
  await page.getByRole("combobox", { name: "School" }).click();
  await page.getByRole("option", { name: "VNU-UET" }).click();
  await expect(page.getByLabel("Student or parent code")).toBeVisible();
  await expect(page.getByLabel("Google account password")).toHaveAttribute("type", "password");

  // Manual fallback fields.
  await page.getByRole("button", { name: "Having trouble? Use a manual token instead" }).click();
  await expect(page.getByLabel("University portal access token")).toHaveAttribute("type", "password");
  await expect(page.getByLabel("Learning-platform access token")).toHaveAttribute("type", "password");
  await page.getByText("Advanced cookie options").click();
  await expect(page.getByLabel("University portal cookie")).toHaveAttribute("type", "password");
  await expect(page.getByLabel("Learning-platform cookie")).toHaveAttribute("type", "password");
  await expect(page.getByLabel("Learning-platform CSRF token")).toHaveAttribute("type", "password");

  // Parent/guardian login swaps the password field label.
  await page.getByLabel("Student or parent code").fill("PH000001");
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("type", "password");

  // VNU (daotao) branch: username/password fields.
  await page.getByRole("combobox", { name: "School" }).click();
  await page.getByRole("option", { name: "VNU (daotao)" }).click();
  await expect(page.getByLabel("Username")).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("type", "password");

  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
});

test("CAPTCHA verification field exposes a persistent accessible label @webkit", async ({ page }) => {
  // A real StudentHub CAPTCHA prompt arrives over an SSE connection that
  // stays open until the user answers (see uet-session-stream.ts). Playwright's
  // route.fulfill() always delivers a complete, closed body, which makes the
  // stream-reader treat the connection as closed and immediately dismiss the
  // modal. Overriding window.fetch with a ReadableStream that is never closed
  // reproduces the real "still waiting for an answer" condition instead.
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/api/uet/auth/import-session") && init?.method === "POST") {
        const stream = new ReadableStream({
          start(controller) {
            const chunk = `event: captcha_required\ndata: ${JSON.stringify({ challengeId: "smoke-1", image: "data:image/png;base64,QQ==" })}\n\n`;
            controller.enqueue(new TextEncoder().encode(chunk));
            // Intentionally never call controller.close() — the modal should
            // stay open until the user submits an answer, same as production.
          },
        });
        return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      return originalFetch(input, init);
    };
  });

  await page.goto("/login");
  await page.getByRole("combobox", { name: "School" }).click();
  await page.getByRole("option", { name: "VNU-UET" }).click();

  await page.getByLabel("Student or parent code").fill("PH000001");
  await page.getByLabel("Password", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await expect(page.getByLabel("Verification code")).toBeVisible();
});

test("session death triggers inline CAPTCHA re-auth instead of a login redirect @webkit", async ({ page }) => {
  // First import-session call (the login) succeeds immediately with a token
  // the real worker cannot decrypt, so the very first dashboard request dies
  // with a genuine INVALID_SESSION 401 from the backend. With credentials
  // stored by the successful login, that session death must open the inline
  // re-auth dialog in place instead of bouncing back to /login. The second
  // import-session call (the re-auth) relays a CAPTCHA and completes once
  // the answer is submitted.
  await page.addInitScript(() => {
    let importCalls = 0;
    let reauthStream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const encode = (event: string, data: unknown) => new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/api/uet/auth/import-session") && init?.method === "POST") {
        importCalls += 1;
        const isReauth = importCalls > 1;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            if (isReauth) {
              // Held open until the CAPTCHA answer arrives, like production.
              reauthStream = controller;
              controller.enqueue(encode("captcha_required", { challengeId: `smoke-reauth-${importCalls}`, image: "data:image/png;base64,QQ==" }));
            } else {
              controller.enqueue(encode("done", { token: "expired-token", session: { studentCode: "PH000001" } }));
              controller.close();
            }
          },
        });
        return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      if (url.includes("/api/uet/auth/solve-captcha")) {
        reauthStream?.enqueue(encode("done", { token: "fresh-token", session: { studentCode: "PH000001" } }));
        reauthStream?.close();
        return new Response(JSON.stringify({ data: { accepted: true } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return originalFetch(input, init);
    };
  });

  await page.goto("/login");
  await page.getByRole("combobox", { name: "School" }).click();
  await page.getByRole("option", { name: "VNU-UET" }).click();
  await page.getByLabel("Student or parent code").fill("PH000001");
  await page.getByLabel("Password", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  // The re-auth dialog appears on the app route - no redirect to /login.
  await expect(page.getByText("Session expired — verify to continue")).toBeVisible();
  await expect(page.getByLabel("Verification code")).toBeVisible();
  expect(new URL(page.url()).pathname).not.toBe("/login");

  await page.getByLabel("Verification code").fill("ABCD");
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(page.getByText("You're signed back in.")).toBeVisible();
});
