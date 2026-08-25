import { test, expect, authenticateDemoPage, clickVisibleNavigationLink } from "./fixtures/base";
import { startMockedVnuSession, NEW_TAB_VNU_ACCOUNT_ID, NEW_TAB_SURVIVOR, seedNewTabDescriptorScenario, seedExpiringNewTabAccount, seedVnuReconnectScenario, reconnectCountsSnapshot } from "./fixtures/vnu";

test("VNU new tab without a grant expires to empty manual login", async ({ page, context }) => {
  await page.route("**/api/**", (route) => route.abort());
  await seedExpiringNewTabAccount(page);
  const expiryTab = await context.newPage();
  let refreshRequests = 0;
  await expiryTab.route("**/api/**", (route) => route.abort());
  await expiryTab.route("**/api/universities", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [{ id: "vnu", capabilities: { profile: true, terms: true, timetable: true } }], error: null }) }));
  await expiryTab.route("**/api/vnu/timetable**", (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ data: null, error: { code: "VNU_SESSION_EXPIRED", message: "Synthetic new-tab expiry" } }) }));
  await expiryTab.route("**/api/vnu/auth/refresh", (route) => {
    refreshRequests += 1;
    return route.abort();
  });
  await expiryTab.goto("/timetable");
  await expect(expiryTab).toHaveURL(/\/login$/);
  expect(refreshRequests).toBe(0);
  expect(await expiryTab.evaluate((accountId) => ({
    accounts: JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as unknown[],
    grant: sessionStorage.getItem(`hyeboard.vnu.refreshGrant.${accountId}`),
  }), NEW_TAB_VNU_ACCOUNT_ID)).toEqual({ accounts: [], grant: null });
  await expiryTab.getByRole("combobox", { name: "School" }).click();
  await expiryTab.getByRole("option", { name: "VNU (daotao)" }).click();
  await expect(expiryTab.getByLabel("Username")).toHaveValue("");
  await expect(expiryTab.getByLabel("Password", { exact: true })).toHaveValue("");
  await expiryTab.close();
});

for (const descriptorCase of [
  { label: "live", token: "synthetic-live-descriptor" },
  { label: "fully expired", token: "authenticated-fully-expired-descriptor-token" },
] as const) {
  for (const targetIsActive of [true, false] as const) {
    test(`VNU new tab removes ${targetIsActive ? "active" : "inactive"} ${descriptorCase.label} descriptor without a grant`, async ({ page, context }) => {
      await page.route("**/api/**", (route) => route.abort());
      await seedNewTabDescriptorScenario(page, descriptorCase.token, targetIsActive);
      const removalTab = await context.newPage();
      await removalTab.route("**/api/**", (route) => route.abort());
      let logoutRequest: { authorization?: string; body: string | null } | undefined;
      await removalTab.route("**/api/vnu/auth/logout", (route) => {
        logoutRequest = { authorization: route.request().headers().authorization, body: route.request().postData() };
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { authenticated: false }, error: null }) });
      });
      await removalTab.goto(targetIsActive ? "/settings" : "/");
      expect(await removalTab.evaluate((accountId) => sessionStorage.getItem(`hyeboard.vnu.refreshGrant.${accountId}`), NEW_TAB_VNU_ACCOUNT_ID)).toBeNull();
      if (targetIsActive) {
        await removalTab.getByRole("button", { name: "Sign out" }).click();
        await expect(removalTab).toHaveURL(/\/login$/);
      } else {
        await removalTab.getByRole("button", { name: "Open account menu" }).click();
        await removalTab.getByRole("button", { name: "Remove SYNTHETIC-NEW-TAB" }).click();
      }
      await expect.poll(() => removalTab.evaluate((accountId) => {
        const accounts = JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<{ id: string }>;
        return accounts.some((account) => account.id === accountId);
      }, NEW_TAB_VNU_ACCOUNT_ID)).toBe(false);
      expect(logoutRequest).toEqual({ authorization: `Bearer ${descriptorCase.token}`, body: JSON.stringify({}) });
      expect(await removalTab.evaluate(() => (JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<{ id: string }>).map((account) => account.id))).toEqual([NEW_TAB_SURVIVOR.id]);
      await removalTab.close();
    });
  }
}

test("VNU active reconnect status is one polite nonblocking region and committed refresh refetches", async ({ page }) => {
  const counts = await seedVnuReconnectScenario(page);
  const beforeCommit = reconnectCountsSnapshot(counts);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hyeboard:vnu-refresh-status", { detail: { accountId: "synthetic-vnu-active", state: "reconnecting" } })));
  const status = page.getByText("Reconnecting to VNU…", { exact: true });
  await expect(status).toHaveCount(1);
  await expect(status).toHaveAttribute("role", "status");
  await expect(status).toHaveAttribute("aria-live", "polite");
  await expect(status).toHaveText("Reconnecting to VNU…");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hyeboard:vnu-refresh-status", { detail: { accountId: "synthetic-vnu-active", state: "retryable" } })));
  const retryableStatus = page.getByText("VNU could not reconnect. Retry the affected request.", { exact: true });
  await expect(retryableStatus).toHaveCount(1);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hyeboard:vnu-refresh-status", { detail: { accountId: "synthetic-vnu-active", state: "idle" } })));
  await expect(retryableStatus).toHaveCount(0);
  const refetchedTimetable = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/vnu/timetable");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hyeboard:vnu-refresh-committed", { detail: { accountId: "synthetic-vnu-active" } })));
  await refetchedTimetable;
  expect(counts).toEqual({ ...beforeCommit, vnuTimetable: beforeCommit.vnuTimetable + 1 });
});

test("VNU inactive reconnect events cause no refetch after causal render and request lifecycles", async ({ page, isMobile }) => {
  const counts = await seedVnuReconnectScenario(page);
  const beforeEvents = reconnectCountsSnapshot(counts);
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("hyeboard:vnu-refresh-status", { detail: { accountId: "synthetic-vnu-inactive", state: "reconnecting" } }));
    window.dispatchEvent(new CustomEvent("hyeboard:vnu-refresh-status", { detail: { accountId: "synthetic-vnu-active", state: "reconnecting" } }));
  });
  await expect(page.getByText("Reconnecting to VNU…", { exact: true })).toBeVisible();
  expect(counts).toEqual(beforeEvents);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hyeboard:vnu-refresh-status", { detail: { accountId: "synthetic-vnu-active", state: "idle" } })));
  await expect(page.getByText("Reconnecting to VNU…", { exact: true })).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hyeboard:vnu-refresh-committed", { detail: { accountId: "synthetic-vnu-inactive" } })));
  await clickVisibleNavigationLink(page, "/settings", isMobile);
  await expect(page).toHaveURL(/\/settings$/);
  const returnedTimetable = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/vnu/timetable");
  await page.goto("/timetable");
  await returnedTimetable;
  expect(counts.vnuTimetable).toBe(beforeEvents.vnuTimetable + 1);
  expect(counts.uetTimetable).toBe(beforeEvents.uetTimetable);
});

test("VNU reconnect status is localized", async ({ page }) => {
  await seedVnuReconnectScenario(page, "vi");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hyeboard:vnu-refresh-status", { detail: { accountId: "synthetic-vnu-active", state: "reconnecting" } })));
  await expect(page.getByText("Đang kết nối lại với VNU…", { exact: true })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hyeboard:vnu-refresh-status", { detail: { accountId: "synthetic-vnu-active", state: "idle" } })));
  await expect(page.getByText("Đang kết nối lại với VNU…", { exact: true })).toHaveCount(0);
});

test("VNU committed event stays inactive after switching accounts", async ({ page, isMobile }) => {
  const counts = await seedVnuReconnectScenario(page);
  const switchedTimetable = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/uet/raw/timetable");
  await page.getByTestId("account-trigger").click();
  await page.getByTestId("account-switch-item").filter({ hasText: "(UET)" }).click();
  await switchedTimetable;
  const afterSwitch = reconnectCountsSnapshot(counts);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hyeboard:vnu-refresh-committed", { detail: { accountId: "synthetic-vnu-active" } })));
  await clickVisibleNavigationLink(page, "/settings", isMobile);
  await expect(page).toHaveURL(/\/settings$/);
  const returnedTimetable = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/uet/raw/timetable");
  await page.goto("/timetable");
  await returnedTimetable;
  expect(counts.vnuTimetable).toBe(afterSwitch.vnuTimetable);
  expect(counts.uetTimetable).toBe(afterSwitch.uetTimetable + 1);
});

test("VNU remove keeps exact account pending and on revoke failure, then clears only its grant", async ({ page }) => {
  await page.route("**/api/**", (route) => route.abort());
  let releaseFirstLogout!: () => void;
  const firstLogoutMayFinish = new Promise<void>((resolve) => { releaseFirstLogout = resolve; });
  let logoutAttempt = 0;
  const logoutRequests: Array<{ authorization?: string; body: string | null }> = [];
  await page.route("**/api/vnu/auth/logout", async (route) => {
    logoutAttempt += 1;
    logoutRequests.push({ authorization: route.request().headers().authorization, body: route.request().postData() });
    if (logoutAttempt === 1) {
      await firstLogoutMayFinish;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ data: null, error: { code: "VNU_REFRESH_UNAVAILABLE", message: "Synthetic unavailable" } }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { authenticated: false }, error: null }) });
  });
  await page.goto("/login");
  await page.evaluate(() => {
    localStorage.setItem("hyeboard.accounts", JSON.stringify([
      { id: "synthetic-mock-active", universityId: "mock", token: "synthetic-mock-token", studentCode: "SYNTHETIC-ACTIVE", addedAt: "2099-01-01T00:00:00.000Z" },
      { id: "synthetic-vnu-remove", universityId: "vnu", token: "synthetic-vnu-remove-token", studentCode: "SYNTHETIC-INACTIVE", addedAt: "2099-01-01T00:00:00.000Z" },
    ]));
    localStorage.setItem("hyeboard.activeAccountId", "synthetic-mock-active");
    sessionStorage.setItem("hyeboard.vnu.refreshGrant.synthetic-vnu-remove", "synthetic-vnu-remove-grant");
    sessionStorage.setItem("hyeboard.vnu.refreshGrant.synthetic-mock-active", "synthetic-active-grant");
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open account menu" }).click();
  const removeButton = page.getByRole("button", { name: "Remove SYNTHETIC-INACTIVE" });
  await removeButton.click();
  await expect(removeButton).toBeDisabled();
  releaseFirstLogout();
  await expect(page.locator('[role="alert"]')).toHaveCount(1);
  await expect(page.getByRole("alert")).toHaveText("Could not securely remove this VNU account. Try again.");
  await expect(removeButton).toBeEnabled();
  expect(await page.evaluate(() => ({
    accountIds: (JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<{ id: string }>).map((account) => account.id),
    grant: sessionStorage.getItem("hyeboard.vnu.refreshGrant.synthetic-vnu-remove"),
  }))).toEqual({ accountIds: ["synthetic-mock-active", "synthetic-vnu-remove"], grant: "synthetic-vnu-remove-grant" });

  await removeButton.click();
  await expect(removeButton).toHaveCount(0);
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
  expect(logoutRequests).toEqual([
    { authorization: "Bearer synthetic-vnu-remove-token", body: JSON.stringify({ refreshGrant: "synthetic-vnu-remove-grant" }) },
    { authorization: "Bearer synthetic-vnu-remove-token", body: JSON.stringify({ refreshGrant: "synthetic-vnu-remove-grant" }) },
  ]);
  expect(await page.evaluate(() => ({
    accountIds: (JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<{ id: string }>).map((account) => account.id),
    removedGrant: sessionStorage.getItem("hyeboard.vnu.refreshGrant.synthetic-vnu-remove"),
    activeGrant: sessionStorage.getItem("hyeboard.vnu.refreshGrant.synthetic-mock-active"),
  }))).toEqual({ accountIds: ["synthetic-mock-active"], removedGrant: null, activeGrant: "synthetic-active-grant" });
});

test("VNU active Settings logout uses its grant and one alert while 503 retains state and route", async ({ page }) => {
  await page.route("**/api/**", (route) => route.abort());
  let releaseLogout!: () => void;
  const logoutMayFinish = new Promise<void>((resolve) => { releaseLogout = resolve; });
  let logoutRequest: { authorization?: string; body: string | null } | undefined;
  await page.route("**/api/vnu/auth/logout", async (route) => {
    logoutRequest = { authorization: route.request().headers().authorization, body: route.request().postData() };
    await logoutMayFinish;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ data: null, error: { code: "VNU_REFRESH_UNAVAILABLE", message: "Synthetic unavailable" } }) });
  });
  await page.goto("/login");
  await page.evaluate(() => {
    localStorage.setItem("hyeboard.accounts", JSON.stringify([{ id: "synthetic-vnu-settings", universityId: "vnu", token: "synthetic-vnu-settings-token", studentCode: "SYNTHETIC-SETTINGS", addedAt: "2099-01-01T00:00:00.000Z" }]));
    localStorage.setItem("hyeboard.activeAccountId", "synthetic-vnu-settings");
    localStorage.setItem("hyeboard.universityId", "vnu");
    sessionStorage.setItem("hyeboard.vnu.refreshGrant.synthetic-vnu-settings", "synthetic-vnu-settings-grant");
  });
  await page.goto("/settings");
  const signOut = page.getByRole("button", { name: "Sign out" });
  await signOut.click();
  await expect(signOut).toBeDisabled();
  releaseLogout();
  await expect(page.locator('[role="alert"]')).toHaveCount(1);
  await expect(page.getByRole("alert")).toHaveText("Could not securely remove this VNU account. Try again.");
  await expect(page).toHaveURL(/\/settings$/);
  await expect(signOut).toBeEnabled();
  expect(logoutRequest).toEqual({
    authorization: "Bearer synthetic-vnu-settings-token",
    body: JSON.stringify({ refreshGrant: "synthetic-vnu-settings-grant" }),
  });
  expect(await page.evaluate(() => ({
    accounts: (JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<{ id: string }>).map((account) => account.id),
    grant: sessionStorage.getItem("hyeboard.vnu.refreshGrant.synthetic-vnu-settings"),
  }))).toEqual({ accounts: ["synthetic-vnu-settings"], grant: "synthetic-vnu-settings-grant" });
  await page.getByRole("button", { name: "Open account menu" }).click();
  await expect(page.locator('[role="alert"]')).toHaveCount(1);
  await expect(page.getByRole("alert")).toHaveText("Could not securely remove this VNU account. Try again.");
});

test("VNU reconnect cancelled by failed revoke leaves one alert and no stale reconnecting status", async ({ page, isMobile }) => {
  await page.route("**/api/**", (route) => route.abort());
  await page.route("**/api/universities", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [{ id: "vnu", capabilities: { profile: true, terms: true, timetable: true } }], error: null }) }));
  await page.route("**/api/vnu/timetable**", (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ data: null, error: { code: "VNU_SESSION_EXPIRED", message: "Synthetic expiry" } }) }));
  let markRefreshEntered!: () => void;
  const refreshEntered = new Promise<void>((resolve) => { markRefreshEntered = resolve; });
  let releaseOldRefresh!: () => void;
  const oldRefreshMayFinish = new Promise<void>((resolve) => { releaseOldRefresh = resolve; });
  let markOldRefreshRouteCompleted!: () => void;
  const oldRefreshRouteCompleted = new Promise<void>((resolve) => { markOldRefreshRouteCompleted = resolve; });
  let markOldRefreshBrowserSettled!: () => void;
  const oldRefreshBrowserSettled = new Promise<void>((resolve) => { markOldRefreshBrowserSettled = resolve; });
  let refreshRequests = 0;
  const markMatchingRefreshSettled = (request: import("@playwright/test").Request) => {
    if (new URL(request.url()).pathname === "/api/vnu/auth/refresh") markOldRefreshBrowserSettled();
  };
  page.on("requestfinished", markMatchingRefreshSettled);
  page.on("requestfailed", markMatchingRefreshSettled);
  await page.addInitScript(() => {
    const observations = { committed: 0, statuses: [] as string[] };
    window.addEventListener("hyeboard:vnu-refresh-committed", () => { observations.committed += 1; });
    window.addEventListener("hyeboard:vnu-refresh-status", (event) => {
      const state = (event as CustomEvent<{ state?: string }>).detail.state;
      if (state) observations.statuses.push(state);
    });
    Object.defineProperty(window, "__lateRefreshObservations", { value: observations, configurable: true });
  });
  await page.route("**/api/vnu/auth/refresh", async (route) => {
    refreshRequests += 1;
    markRefreshEntered();
    await oldRefreshMayFinish;
    try {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
        token: "synthetic-late-refresh-token",
        refreshGrant: "synthetic-late-refresh-grant",
        session: { authenticated: true, universityId: "vnu", studentCode: "SYNTHETIC-REFRESH-REVOKE", expiresAt: "2099-01-01T00:00:00.000Z" },
      }, error: null }) });
    } catch {
      // Cancellation may detach the request before the synthetic late response is sent.
    } finally {
      markOldRefreshRouteCompleted();
    }
  });
  let logoutRequests = 0;
  await page.route("**/api/vnu/auth/logout", (route) => {
    logoutRequests += 1;
    return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ data: null, error: { code: "VNU_REFRESH_UNAVAILABLE", message: "Synthetic logout unavailable" } }) });
  });
  await page.goto("/login");
  await page.evaluate(() => {
    localStorage.setItem("hyeboard.accounts", JSON.stringify([{ id: "synthetic-refresh-revoke", universityId: "vnu", token: "synthetic-refresh-revoke-token", studentCode: "SYNTHETIC-REFRESH-REVOKE", addedAt: "2099-01-01T00:00:00.000Z" }]));
    localStorage.setItem("hyeboard.activeAccountId", "synthetic-refresh-revoke");
    localStorage.setItem("hyeboard.universityId", "vnu");
    sessionStorage.setItem("hyeboard.vnu.refreshGrant.synthetic-refresh-revoke", "synthetic-refresh-revoke-grant");
  });
  await page.goto("/timetable");
  await refreshEntered;
  await expect(page.getByText("Reconnecting to VNU…", { exact: true })).toBeVisible();
  await clickVisibleNavigationLink(page, "/settings", isMobile);
  await expect(page).toHaveURL(/\/settings$/);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeEnabled();
  await expect(page.locator('[role="alert"]')).toHaveCount(1);
  await expect(page.getByText("Reconnecting to VNU…", { exact: true })).toHaveCount(0);
  await oldRefreshBrowserSettled;
  const stateBeforeLateResponse = await page.evaluate(() => ({
    accountIds: (JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<{ id: string }>).map((account) => account.id),
    token: (JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<{ token: string }>)[0]?.token,
    grant: sessionStorage.getItem("hyeboard.vnu.refreshGrant.synthetic-refresh-revoke"),
    observations: (window as unknown as { __lateRefreshObservations: { committed: number; statuses: string[] } }).__lateRefreshObservations,
  }));
  expect(stateBeforeLateResponse).toEqual({
    accountIds: ["synthetic-refresh-revoke"],
    token: "synthetic-refresh-revoke-token",
    grant: "synthetic-refresh-revoke-grant",
    observations: { committed: 0, statuses: ["reconnecting", "idle"] },
  });
  releaseOldRefresh();
  await oldRefreshRouteCompleted;
  const retryLogoutResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/vnu/auth/logout");
  await page.getByRole("button", { name: "Sign out" }).click();
  await retryLogoutResponse;
  await expect(page.getByRole("button", { name: "Sign out" })).toBeEnabled();
  await expect(page.getByText("Reconnecting to VNU…", { exact: true })).toHaveCount(0);
  await expect(page.locator('[role="alert"]')).toHaveCount(1);
  expect(await page.evaluate(() => ({
    accountIds: (JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<{ id: string }>).map((account) => account.id),
    token: (JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<{ token: string }>)[0]?.token,
    grant: sessionStorage.getItem("hyeboard.vnu.refreshGrant.synthetic-refresh-revoke"),
    observations: (window as unknown as { __lateRefreshObservations: { committed: number; statuses: string[] } }).__lateRefreshObservations,
  }))).toEqual(stateBeforeLateResponse);
  expect(refreshRequests).toBe(1);
  expect(logoutRequests).toBe(2);
});

test("VNU remove failure cannot resurrect Settings ownership after route navigation", async ({ page, isMobile }) => {
  await page.route("**/api/**", (route) => route.abort());
  let markLogoutEntered!: () => void;
  const logoutEntered = new Promise<void>((resolve) => { markLogoutEntered = resolve; });
  let releaseLogout!: () => void;
  const logoutMayFinish = new Promise<void>((resolve) => { releaseLogout = resolve; });
  await page.route("**/api/vnu/auth/logout", async (route) => {
    markLogoutEntered();
    await logoutMayFinish;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ data: null, error: { code: "VNU_REFRESH_UNAVAILABLE", message: "Synthetic delayed unavailable" } }) });
  });
  await page.goto("/login");
  await page.evaluate(() => {
    localStorage.setItem("hyeboard.accounts", JSON.stringify([{ id: "synthetic-vnu-delayed-settings", universityId: "vnu", token: "synthetic-delayed-settings-token", studentCode: "SYNTHETIC-DELAYED", addedAt: "2099-01-01T00:00:00.000Z" }]));
    localStorage.setItem("hyeboard.activeAccountId", "synthetic-vnu-delayed-settings");
    localStorage.setItem("hyeboard.universityId", "vnu");
    sessionStorage.setItem("hyeboard.vnu.refreshGrant.synthetic-vnu-delayed-settings", "synthetic-delayed-settings-grant");
  });
  await page.goto("/settings");
  await page.getByRole("button", { name: "Sign out" }).click();
  await logoutEntered;
  await clickVisibleNavigationLink(page, "/", isMobile);
  await expect(page).toHaveURL(/\/$/);
  const logoutResponse = page.waitForResponse((response) => response.url().includes("/api/vnu/auth/logout"));
  releaseLogout();
  await logoutResponse;
  await clickVisibleNavigationLink(page, "/settings", isMobile);
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("button", { name: "Sign out" })).toBeEnabled();
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
});

test("VNU remove failure cannot resurrect a closed account-menu owner", async ({ page }) => {
  await page.route("**/api/**", (route) => route.abort());
  let markLogoutEntered!: () => void;
  const logoutEntered = new Promise<void>((resolve) => { markLogoutEntered = resolve; });
  let releaseLogout!: () => void;
  const logoutMayFinish = new Promise<void>((resolve) => { releaseLogout = resolve; });
  await page.route("**/api/vnu/auth/logout", async (route) => {
    markLogoutEntered();
    await logoutMayFinish;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ data: null, error: { code: "VNU_REFRESH_UNAVAILABLE", message: "Synthetic delayed unavailable" } }) });
  });
  await page.goto("/login");
  await page.evaluate(() => {
    localStorage.setItem("hyeboard.accounts", JSON.stringify([
      { id: "synthetic-menu-survivor", universityId: "mock", token: "synthetic-menu-survivor-token", studentCode: "SYNTHETIC-SURVIVOR", addedAt: "2099-01-01T00:00:00.000Z" },
      { id: "synthetic-menu-delayed", universityId: "vnu", token: "synthetic-menu-delayed-token", studentCode: "SYNTHETIC-DELAYED", addedAt: "2099-01-01T00:00:00.000Z" },
    ]));
    localStorage.setItem("hyeboard.activeAccountId", "synthetic-menu-survivor");
    localStorage.setItem("hyeboard.universityId", "mock");
    sessionStorage.setItem("hyeboard.vnu.refreshGrant.synthetic-menu-delayed", "synthetic-menu-delayed-grant");
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByRole("button", { name: "Remove SYNTHETIC-DELAYED" }).click();
  await logoutEntered;
  await page.keyboard.press("Escape");
  const logoutResponse = page.waitForResponse((response) => response.url().includes("/api/vnu/auth/logout"));
  releaseLogout();
  await logoutResponse;
  await page.getByRole("button", { name: "Open account menu" }).click();
  await expect(page.getByRole("button", { name: "Remove SYNTHETIC-DELAYED" })).toBeEnabled();
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
});

test("VNU remove older failure stays inert after a newer account action succeeds", async ({ page }) => {
  await page.route("**/api/**", (route) => route.abort());
  let markOlderEntered!: () => void;
  const olderEntered = new Promise<void>((resolve) => { markOlderEntered = resolve; });
  let releaseOlder!: () => void;
  const olderMayFinish = new Promise<void>((resolve) => { releaseOlder = resolve; });
  await page.route("**/api/vnu/auth/logout", async (route) => {
    const authorization = route.request().headers().authorization;
    if (authorization === "Bearer synthetic-older-token") {
      markOlderEntered();
      await olderMayFinish;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ data: null, error: { code: "VNU_REFRESH_UNAVAILABLE", message: "Synthetic older unavailable" } }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { authenticated: false }, error: null }) });
  });
  await page.goto("/login");
  await page.evaluate(() => {
    localStorage.setItem("hyeboard.accounts", JSON.stringify([
      { id: "synthetic-action-survivor", universityId: "mock", token: "synthetic-action-survivor-token", studentCode: "SYNTHETIC-SURVIVOR", addedAt: "2099-01-01T00:00:00.000Z" },
      { id: "synthetic-action-older", universityId: "vnu", token: "synthetic-older-token", studentCode: "SYNTHETIC-OLDER", addedAt: "2099-01-01T00:00:00.000Z" },
      { id: "synthetic-action-newer", universityId: "vnu", token: "synthetic-newer-token", studentCode: "SYNTHETIC-NEWER", addedAt: "2099-01-01T00:00:00.000Z" },
    ]));
    localStorage.setItem("hyeboard.activeAccountId", "synthetic-action-survivor");
    localStorage.setItem("hyeboard.universityId", "mock");
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByRole("button", { name: "Remove SYNTHETIC-OLDER" }).click();
  await olderEntered;
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByRole("button", { name: "Remove SYNTHETIC-NEWER" }).click();
  await expect(page.getByRole("button", { name: "Remove SYNTHETIC-NEWER" })).toHaveCount(0);
  const olderResponse = page.waitForResponse((response) => response.request().headers().authorization === "Bearer synthetic-older-token");
  releaseOlder();
  await olderResponse;
  await expect(page.getByRole("button", { name: "Remove SYNTHETIC-OLDER" })).toBeEnabled();
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
  expect(await page.evaluate(() => (JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<{ id: string }>).map((account) => account.id))).toEqual([
    "synthetic-action-survivor",
    "synthetic-action-older",
  ]);
});

test("VNU remove pending failure stays inert after account switch", async ({ page }) => {
  await page.route("**/api/**", (route) => route.abort());
  await page.route("**/api/universities", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data: [
      { id: "mock", capabilities: { profile: true } },
      { id: "vnu", capabilities: { profile: true } },
    ], error: null }),
  }));
  let markLogoutEntered!: () => void;
  const logoutEntered = new Promise<void>((resolve) => { markLogoutEntered = resolve; });
  let releaseLogout!: () => void;
  const logoutMayFinish = new Promise<void>((resolve) => { releaseLogout = resolve; });
  await page.route("**/api/vnu/auth/logout", async (route) => {
    markLogoutEntered();
    await logoutMayFinish;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ data: null, error: { code: "VNU_REFRESH_UNAVAILABLE", message: "Synthetic switched unavailable" } }) });
  });
  await page.goto("/login");
  await page.evaluate(() => {
    localStorage.setItem("hyeboard.accounts", JSON.stringify([
      { id: "synthetic-switch-pending", universityId: "vnu", token: "synthetic-switch-pending-token", studentCode: "SYNTHETIC-PENDING", addedAt: "2099-01-01T00:00:00.000Z" },
      { id: "synthetic-switch-survivor", universityId: "mock", token: "synthetic-switch-survivor-token", studentCode: "SYNTHETIC-SURVIVOR", addedAt: "2099-01-01T00:00:00.000Z" },
    ]));
    localStorage.setItem("hyeboard.activeAccountId", "synthetic-switch-pending");
    localStorage.setItem("hyeboard.universityId", "vnu");
  });
  await page.goto("/settings");
  await page.getByRole("button", { name: "Sign out" }).click();
  await logoutEntered;
  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByTestId("account-switch-item").filter({ hasText: "SYNTHETIC-SURVIVOR" }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("hyeboard.activeAccountId"))).toBe("synthetic-switch-survivor");
  const logoutResponse = page.waitForResponse((response) => response.url().includes("/api/vnu/auth/logout"));
  releaseLogout();
  await logoutResponse;
  await expect(page.getByRole("button", { name: "Sign out" })).toBeEnabled();
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
});

test("concurrent VNU expiry leaves a switched inactive origin inert", async ({ page }) => {
  await authenticateDemoPage(page);
  const survivingAccount = await page.evaluate(() => {
    const accounts = JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<{ id: string; universityId: string; token: string; studentCode: string }>;
    return accounts.find((account) => account.universityId === "mock");
  });
  expect(survivingAccount).toBeDefined();

  const mockedSession = await startMockedVnuSession(page, {
    code: "VNU_SESSION_EXPIRED",
    status: 401,
    message: "Synthetic concurrent VNU session expiry",
  }, { deferRawResponses: true });
  const harmlessExtraRawRequest = page.evaluate(() => fetch("/api/vnu/raw/syllabus").then((response) => response.status));
  await mockedSession.allRawRequestsStarted;

  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByTestId("account-switch-item").filter({ hasText: "(MOCK)" }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("hyeboard.activeAccountId"))).toBe(survivingAccount?.id);

  const releasedDashboardPaths = ["/api/vnu/dashboard"];
  const dashboardRequestSettlements = releasedDashboardPaths.map((path) => Promise.race([
    page.waitForEvent("requestfinished", { predicate: (request) => new URL(request.url()).pathname === path }),
    page.waitForEvent("requestfailed", { predicate: (request) => new URL(request.url()).pathname === path }),
  ]));
  mockedSession.releaseRawRequests();
  await Promise.all([
    mockedSession.allRawResponsesFulfilled,
    expect(harmlessExtraRawRequest).resolves.toBe(401),
    ...dashboardRequestSettlements,
  ]);
  await page.getByRole("button", { name: "Open account menu" }).click();
  const activeSurvivor = page.locator('[data-testid="account-switch-item"]:visible').filter({ hasText: survivingAccount?.studentCode });
  await expect(activeSurvivor).toHaveCount(1);
  await expect(activeSurvivor.locator("svg.text-primary")).toHaveCount(1);
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
  await expect.poll(() => page.evaluate((expectedAccount) => {
    const accounts = JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<{ id: string; universityId: string; token: string }>;
    return {
      accountCount: accounts.length,
      survivingIdMatches: accounts[0]?.id === expectedAccount?.id,
      survivingTokenMatches: accounts[0]?.token === expectedAccount?.token,
      survivingUniversityMatches: accounts[0]?.universityId === expectedAccount?.universityId,
      activeAccountMatches: localStorage.getItem("hyeboard.activeAccountId") === expectedAccount?.id,
    };
  }, survivingAccount)).toEqual({
    accountCount: 2,
    survivingIdMatches: true,
    survivingTokenMatches: true,
    survivingUniversityMatches: true,
    activeAccountMatches: true,
  });
  await expect(page).not.toHaveURL(/\/login$/);
});

for (const error of [
  { status: 401, message: "Synthetic code-less VNU failure" },
  { code: "VNU_UNKNOWN_FAILURE", status: 401, message: "Synthetic unknown VNU failure" },
  { code: "VNU_REQUEST_FAILED", status: 401, message: "Synthetic VNU request failed" },
  { code: "VNU_RATE_LIMITED", status: 429, message: "Synthetic VNU rate limit" },
  { code: "VNU_UPSTREAM_UNAVAILABLE", status: 502, message: "Synthetic VNU upstream unavailable" },
  { code: "VNU_CROSS_LOOKUP_NOT_FOUND", status: 404, message: "Synthetic VNU lookup not found" },
]) {
  test(`${error.code ?? "VNU code-less 401"} remains inline and keeps the active account`, async ({ page }) => {
    await startMockedVnuSession(page, error);
    await expect(page).not.toHaveURL(/\/login$/);
    await expect(page.getByText(error.message).first()).toBeVisible();
    const storage = await page.evaluate(() => ({
      accounts: JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as unknown[],
      activeAccountId: localStorage.getItem("hyeboard.activeAccountId"),
    }));
    expect(storage.accounts).toHaveLength(1);
    expect(storage.activeAccountId).not.toBeNull();
  });
}
