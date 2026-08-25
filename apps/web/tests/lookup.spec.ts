import { test, expect, authenticateDemoPage, expectNoPageOverflow } from "./fixtures/base";
import { SYNTHETIC_OWN_STUDENT_CODE, SYNTHETIC_TARGET_STUDENT_CODE, SYNTHETIC_ERROR_STUDENT_CODE, SYNTHETIC_OWN_INTERNAL_ID, SYNTHETIC_TARGET_INTERNAL_ID, SYNTHETIC_ERROR_INTERNAL_ID, SYNTHETIC_CLASS_ID, openMockedLookup, openMockedVnuLookup, openMockedVnuDocuments, fulfillBulkSuccess, type SyntheticBulkMode } from "./fixtures/lookup";
import { trackApiRequestCounts, expectExportFormats, expectAcademicCsvMatchesJson, expectClassCsvMatchesJson, expectResolverCsvMatchesJson, expectBulkCsvMatchesJson } from "./helpers/export";

test("Lookup nav item is absent for the mock demo account (vnu-only capability)", async ({ page }) => {
  await authenticateDemoPage(page);
  await expect(page.getByRole("link", { name: "Lookup" })).toHaveCount(0);

  const search = page.getByPlaceholder("Search pages...");
  await search.click();
  await search.fill("Lookup");
  await expect(page.getByText("No page matches that search.")).toBeVisible();

  // Direct-URL access must not leak the cross-lookup sections either: the mock
  // adapter sets crossLookup=false, and the sections are additionally gated
  // behind the page's profile query failing for a non-vnu session. The same
  // gating covers the phase-3 additions — the reverse class-ID resolver and
  // the cross-student resolvers must stay equally unreachable.
  await page.goto("/lookup");
  await expect(page.getByTestId("reverse-class-lookup")).toHaveCount(0);
  await expect(page.getByTestId("cross-student-code")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Resolve another student's code" })).toHaveCount(0);
  await expect(page.getByTestId("cross-student-id")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Resolve another student's internal ID" })).toHaveCount(0);
  await expect(page.getByTestId("cross-transcript")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Look up another student's transcript" })).toHaveCount(0);
  await expect(page.getByTestId("bulk-lookup")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Bulk cross-lookup" })).toHaveCount(0);
});

test("lookup groups use progressive modes, accessible labels, and responsive touch targets @webkit", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openMockedLookup(page);

  await expect(page.getByTestId("class-identifier-tools")).toBeVisible();
  await expect(page.getByTestId("student-record-tools")).toBeVisible();
  await expect(page.getByTestId("bulk-lookup")).toBeVisible();
  await expect(page.getByLabel("Course code")).toBeVisible();
  await expect(page.getByLabel("Class number (optional)")).toBeVisible();
  await expect(page.getByRole("group", { name: "Class lookup direction" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Student record tool" })).toBeVisible();
  await expect(page.locator("[data-export-surface]")).toHaveCount(0);

  await page.getByRole("button", { name: "Class ID to course" }).click();
  await expect(page.getByLabel("Internal class ID")).toBeVisible();
  await page.getByRole("button", { name: "Code → ID" }).click();
  await expect(page.getByLabel("Target student code")).toBeVisible();
  await page.getByRole("button", { name: "Transcript", exact: true }).click();
  await expect(page.getByRole("group", { name: "Transcript lookup identifier" })).toBeVisible();

  const principalControls = page.locator('[data-testid="class-identifier-tools"] button:visible, [data-testid="class-identifier-tools"] input:visible, [data-testid="student-record-tools"] button:visible, [data-testid="student-record-tools"] input:visible, [data-testid="bulk-lookup"] button:visible, [data-testid="bulk-lookup"] textarea:visible, [data-testid="bulk-lookup"] [role="combobox"]:visible');
  const controlCount = await principalControls.count();
  expect(controlCount).toBeGreaterThan(0);
  for (let index = 0; index < controlCount; index++) {
    const box = await principalControls.nth(index).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(43.9);
  }

  for (const viewport of [{ width: 375, height: 812 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    await expectNoPageOverflow(page);
  }
});

test("lookup never shows the previous account profile while the next account loads @task11", async ({ page }) => {
  await openMockedLookup(page);
  await expect(page.getByText(SYNTHETIC_OWN_INTERNAL_ID, { exact: true })).toBeVisible();

  await page.unroute("**/api/vnu/raw/profile");
  let releaseProfile!: () => void;
  const profileReleased = new Promise<void>((resolve) => { releaseProfile = resolve; });
  await page.route("**/api/vnu/raw/profile", async (route) => {
    expect(route.request().headers().authorization).toBe("Bearer second-account-token");
    await profileReleased;
    const html = '<input name="StdCode" value="88000000"><input name="StdName" value="Second Synthetic"><input name="hidStdID" value="88000000000">';
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { html } }) });
  });

  await page.evaluate(() => {
    const accounts = JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<Record<string, unknown>>;
    const second = { id: "second-account", universityId: "mock", token: "second-account-token", studentCode: "88000000", addedAt: new Date().toISOString() };
    localStorage.setItem("hyeboard.accounts", JSON.stringify([...accounts, second]));
    localStorage.setItem("hyeboard.activeAccountId", second.id);
    window.dispatchEvent(new CustomEvent("hyeboard:account-switched"));
  });

  await expect(page.getByText(SYNTHETIC_OWN_INTERNAL_ID, { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("lookup-own-ids")).toHaveCount(0);
  releaseProfile();
  await expect(page.getByText("88000000000", { exact: true })).toBeVisible();
});

test("lookup renders only own-session point-detail components", async ({ page }) => {
  await openMockedLookup(page);
  await page.getByLabel("Course code").fill("SYN9900");
  await page.getByLabel("Term").click();
  await page.getByRole("option").first().click();
  const result = page.getByTestId("lookup-results");
  await expect(result.getByText("Synthetic Export Systems")).toBeVisible();
  await result.getByRole("button", { name: "Grade breakdown", exact: true }).click();
  await expect(result.getByText("Giữa kỳ")).toBeVisible();
  await expect(result.getByText("Thi cuối kỳ")).toBeVisible();
  await expect(result.getByText("Weight 0.4 · Attempt 1")).toBeVisible();
  await expect(result.getByText("8.5", { exact: true })).toBeVisible();
  await expect(result.getByText("Tổng điểm")).toHaveCount(0);
  await expect(result.getByText("Portal footer total")).toHaveCount(0);
});

test("bulk hides when maximum is zero or missing while single cross lookup remains", async ({ page }) => {
  for (const maximum of [0, null] as const) {
    await openMockedLookup(page, maximum);
    await expect(page.getByTestId("student-record-tools")).toBeVisible();
    await expect(page.getByTestId("cross-student-code")).toBeVisible();
    await expect(page.getByTestId("bulk-lookup")).toHaveCount(0);
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("bulk enforces configured deduplicated maximum and dynamic copy", async ({ page }) => {
  await openMockedLookup(page, 2);
  const bulk = page.getByTestId("bulk-lookup");
  await expect(bulk.getByText("Process up to 2 identifiers in sequential batches. Each target reports its own result.")).toBeVisible();
  await bulk.getByLabel("Targets, one per line").fill("99000000101\n99000000101\n99000000102");
  await expect(bulk.getByText("Use no more than 2 unique identifiers at once.")).toHaveCount(0);
  await bulk.getByLabel("Targets, one per line").fill("99000000101\n99000000101\n99000000102\n99000000103");
  await expect(bulk.getByText("Use no more than 2 unique identifiers at once.")).toBeVisible();
  await expect(bulk.getByRole("button", { name: "Run bulk lookup" })).toBeDisabled();
});

test("bulk keeps complete exports ordered for all modes and fixed chunks", async ({ page }) => {
  const apiRequestCount = trackApiRequestCounts(page);
  const chunks: Record<SyntheticBulkMode, string[][]> = { "stdid-to-code": [], "code-to-stdid": [], "stdid-to-transcript": [] };
  await page.route("**/api/vnu/cross-lookup/bulk", async (route) => {
    const mode = (route.request().postDataJSON() as { mode: SyntheticBulkMode }).mode;
    await fulfillBulkSuccess(route, chunks[mode]);
  });
  await openMockedLookup(page);
  const bulk = page.getByTestId("bulk-lookup");
  const cases: Array<{ mode: SyntheticBulkMode; option: string; targets: string[]; surface: string; sizes: number[] }> = [
    { mode: "stdid-to-code", option: "Internal IDs to student codes", targets: Array.from({ length: 6 }, (_, index) => `9900000010${index + 1}`), surface: "bulk-id-to-code", sizes: [5, 1] },
    { mode: "code-to-stdid", option: "Student codes to internal IDs", targets: Array.from({ length: 4 }, (_, index) => `9900010${index + 1}`), surface: "bulk-code-to-id", sizes: [3, 1] },
    { mode: "stdid-to-transcript", option: "Internal IDs to transcripts", targets: Array.from({ length: 6 }, (_, index) => `9900000020${index + 1}`), surface: "bulk-id-to-transcript", sizes: [5, 1] },
  ];

  for (const testCase of cases) {
    await bulk.getByLabel("Lookup mode").click();
    await page.getByRole("option", { name: testCase.option }).click();
    await bulk.getByLabel("Targets, one per line").fill(testCase.targets.join("\n"));
    await bulk.getByRole("button", { name: "Run bulk lookup" }).click();
    await expect(bulk.getByText(`${testCase.targets.length} completed`)).toBeVisible();
    const document = await expectExportFormats(page, testCase.surface, apiRequestCount, {
      sourcePath: "/api/vnu/cross-lookup/bulk",
      assertCsv: expectBulkCsvMatchesJson,
    });
    expect(document.surface).toBe(testCase.surface);
    expect(document.run).toEqual({ status: "complete", mode: testCase.mode, processedCount: testCase.targets.length, totalCount: testCase.targets.length });
    const results = document.results as Array<{ target: string; status: string; result: Record<string, unknown> }>;
    expect(results.map((item) => item.target)).toEqual(testCase.targets);
    expect(results.every((item) => item.status === "ok")).toBe(true);
    expect(JSON.stringify(results)).not.toContain("ignoredField");
    if (testCase.mode === "stdid-to-code") expect(results[0]?.result).toEqual({ identity: { studentCode: "99000101", internalStudentId: testCase.targets[0], studentName: "Synthetic 9901", managingClass: "SYNTHETIC-99" } });
    if (testCase.mode === "code-to-stdid") expect(results[0]?.result).toEqual({ resolver: { resolvedStudentCode: testCase.targets[0], resolvedInternalStudentId: "99000000101", probes: 1 } });
    if (testCase.mode === "stdid-to-transcript") expect(results[0]?.result).toMatchObject({ identity: { internalStudentId: testCase.targets[0] }, reported: { cumulativeGpa4: 4 }, derivedTerms: [{ termCode: "252", estimateKind: "derived", courses: [{ courseCode: "SYN9901" }] }] });
  }

  for (const testCase of cases) expect(chunks[testCase.mode].map((chunk) => chunk.length)).toEqual(testCase.sizes);
});

test("bulk metadata separates input maximums from HTTP chunk sizes", async ({ page }) => {
  const chunks: Record<SyntheticBulkMode, string[][]> = { "stdid-to-code": [], "code-to-stdid": [], "stdid-to-transcript": [] };
  await page.route("**/api/vnu/cross-lookup/bulk", async (route) => {
    const mode = (route.request().postDataJSON() as { mode: SyntheticBulkMode }).mode;
    await fulfillBulkSuccess(route, chunks[mode]);
  });
  await openMockedLookup(page, 500, 32, {
    "stdid-to-code": 500,
    "stdid-to-transcript": 500,
    "code-to-stdid": 9,
  });
  const bulk = page.getByTestId("bulk-lookup");
  const directTargets = Array.from({ length: 33 }, (_, index) => `990000003${String(index + 1).padStart(2, "0")}`);

  await bulk.getByLabel("Targets, one per line").fill(directTargets.join("\n"));
  await expect(bulk.getByRole("button", { name: "Run bulk lookup" })).toBeEnabled();
  await bulk.getByRole("button", { name: "Run bulk lookup" }).click();
  await expect(bulk.getByText("33 completed")).toBeVisible();

  await bulk.getByLabel("Lookup mode").click();
  await page.getByRole("option", { name: "Student codes to internal IDs" }).click();
  const codeTargets = Array.from({ length: 9 }, (_, index) => `990001${String(index + 1).padStart(2, "0")}`);
  await bulk.getByLabel("Targets, one per line").fill(codeTargets.join("\n"));
  await expect(bulk.getByRole("button", { name: "Run bulk lookup" })).toBeEnabled();
  await bulk.getByRole("button", { name: "Run bulk lookup" }).click();
  await expect(bulk.getByText("9 completed")).toBeVisible();

  expect(chunks["stdid-to-code"].map((chunk) => chunk.length)).toEqual([32, 1]);
  expect(chunks["code-to-stdid"].map((chunk) => chunk.length)).toEqual([3, 3, 3]);
});

test("bulk exports prior five results after later 429 and while retrying", async ({ page }) => {
  const apiRequestCount = trackApiRequestCounts(page);
  let call = 0;
  let markRetryStarted!: () => void;
  const retryStarted = new Promise<void>((resolve) => { markRetryStarted = resolve; });
  let releaseRetry!: () => void;
  const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
  await page.route("**/api/vnu/cross-lookup/bulk", async (route) => {
    call += 1;
    if (call === 2) {
      await route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ data: null, error: { code: "VNU_RATE_LIMITED", message: "Synthetic 99 limit" } }) });
      return;
    }
    if (call === 3) {
      markRetryStarted();
      await retryGate;
    }
    await fulfillBulkSuccess(route, []);
  });
  await openMockedLookup(page);
  const bulk = page.getByTestId("bulk-lookup");
  const targets = Array.from({ length: 6 }, (_, index) => `9900000030${index + 1}`);
  await bulk.getByLabel("Targets, one per line").fill(targets.join("\n"));
  await bulk.getByRole("button", { name: "Run bulk lookup" }).click();
  await expect(bulk.getByRole("button", { name: "Retry remaining" })).toBeVisible();
  const partial = await expectExportFormats(page, "bulk-id-to-code", apiRequestCount, {
    sourcePath: "/api/vnu/cross-lookup/bulk",
    assertCsv: expectBulkCsvMatchesJson,
  });
  expect(partial.run).toEqual({ status: "partial", mode: "stdid-to-code", processedCount: 5, totalCount: 6 });
  expect((partial.results as Array<{ target: string }>).map((item) => item.target)).toEqual(targets.slice(0, 5));

  await bulk.getByRole("button", { name: "Retry remaining" }).click();
  await retryStarted;
  await expect(bulk.getByRole("button", { name: "Export" })).toBeVisible();
  releaseRetry();
  await expect(bulk.getByText("6 completed")).toBeVisible();
});

test("bulk keeps prior export during and after cancellation of second chunk", async ({ page }) => {
  const apiRequestCount = trackApiRequestCounts(page);
  let call = 0;
  let markSecondStarted!: () => void;
  const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
  let releaseSecond!: () => void;
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  let markSecondHandled!: () => void;
  const secondHandled = new Promise<void>((resolve) => { markSecondHandled = resolve; });
  await page.route("**/api/vnu/cross-lookup/bulk", async (route) => {
    call += 1;
    if (call === 2) {
      markSecondStarted();
      await secondGate;
    }
    try {
      await fulfillBulkSuccess(route, []);
    } finally {
      if (call === 2) markSecondHandled();
    }
  });
  await openMockedLookup(page);
  const bulk = page.getByTestId("bulk-lookup");
  const targets = Array.from({ length: 6 }, (_, index) => `9900000040${index + 1}`);
  await bulk.getByLabel("Targets, one per line").fill(targets.join("\n"));
  await bulk.getByRole("button", { name: "Run bulk lookup" }).click();
  await secondStarted;
  await expect(bulk.locator("#bulk-lookup-progress-label")).toHaveText("5 of 6 processed");
  await expect(bulk.getByRole("button", { name: "Export" })).toBeVisible();
  await bulk.getByRole("button", { name: "Cancel" }).click();
  await expect(bulk.getByRole("button", { name: "Retry remaining" })).toBeVisible();
  await expect(bulk.getByRole("button", { name: "Export" })).toBeVisible();
  await expect(bulk.getByText(targets[0]!, { exact: true })).toBeVisible();
  const partial = await expectExportFormats(page, "bulk-id-to-code", apiRequestCount, {
    sourcePath: "/api/vnu/cross-lookup/bulk",
    assertCsv: expectBulkCsvMatchesJson,
  });
  expect(partial.run).toEqual({ status: "partial", mode: "stdid-to-code", processedCount: 5, totalCount: 6 });
  expect(partial.results?.map((item) => item.target)).toEqual(targets.slice(0, 5));
  releaseSecond();
  await secondHandled;
});

test("bulk preserves partial export through VNU refresh and retries only remaining targets", async ({ page }) => {
  const apiRequestCount = trackApiRequestCounts(page);
  const initialToken = "synthetic-expiring-bulk-token";
  const rotatedToken = "synthetic-rotated-bulk-token";
  const targets = Array.from({ length: 6 }, (_, index) => `990000010${index + 1}`);
  let bulkPosts = 0;
  let refreshPosts = 0;
  const bulkAuthorizations: Array<string | null> = [];
  let markRefreshEntered!: () => void;
  const refreshEntered = new Promise<void>((resolve) => { markRefreshEntered = resolve; });
  let markSecondStarted!: () => void;
  const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
  let releaseRefresh!: () => void;
  const refreshReleased = new Promise<void>((resolve) => { releaseRefresh = resolve; });

  await page.route("**/api/vnu/cross-lookup/bulk", async (route) => {
    bulkPosts += 1;
    bulkAuthorizations.push(route.request().headers()["authorization"] ?? null);
    const body = route.request().postDataJSON() as { targets: string[] };
    if (bulkPosts === 2) markSecondStarted();
    if (bulkPosts === 2) {
      await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ data: null, error: { code: "VNU_SESSION_EXPIRED", message: "Synthetic expiry" } }) });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { items: body.targets.map((target) => ({ target, status: "ok", result: { studentCode: `CODE-${target}` } })) }, error: null }),
    });
  });
  await page.route("**/api/vnu/auth/refresh", async (route) => {
    refreshPosts += 1;
    markRefreshEntered();
    await refreshReleased;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
      token: rotatedToken,
      refreshGrant: "synthetic-rotated-bulk-grant",
      session: { universityId: "vnu", studentCode: "SYNTHETIC-STUDENT", expiresAt: "2099-01-01T00:00:00.000Z", authenticated: true },
    }, error: null }) });
  });

  await openMockedVnuLookup(page);
  await page.evaluate(({ token }) => {
    const accounts = JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<Record<string, unknown>>;
    const activeId = localStorage.getItem("hyeboard.activeAccountId");
    localStorage.setItem("hyeboard.accounts", JSON.stringify(accounts.map((account) => account.id === activeId ? { ...account, token } : account)));
    const activeAccount = accounts.find((account) => account.id === activeId);
    if (activeId) sessionStorage.setItem(`hyeboard.vnu.refreshGrant.${activeId}`, "synthetic-bulk-grant");
    if (!activeAccount) throw new Error("Synthetic active account missing");
  }, { token: initialToken });
  await page.reload();
  const bulk = page.getByTestId("bulk-lookup");
  await bulk.getByLabel("Targets, one per line").fill(targets.join("\n"));
  await bulk.getByRole("button", { name: "Run bulk lookup" }).click();
  await secondStarted;
  await refreshEntered;
  await expect(bulk.locator("#bulk-lookup-progress-label")).toHaveText("5 of 6 processed");
  await expect(bulk.getByText(targets[0]!, { exact: true })).toBeVisible();
  await expect(bulk.getByRole("button", { name: "Export" })).toBeVisible();
  expect(bulkPosts).toBe(2);
  const partialBeforeRefresh = await expectExportFormats(page, "bulk-id-to-code", apiRequestCount, {
    sourcePath: "/api/vnu/cross-lookup/bulk",
    assertCsv: expectBulkCsvMatchesJson,
  });
  expect(partialBeforeRefresh.run).toEqual({ status: "partial", mode: "stdid-to-code", processedCount: 5, totalCount: 6 });
  expect(partialBeforeRefresh.results?.map((item) => item.target)).toEqual(targets.slice(0, 5));
  releaseRefresh();

  await expect(bulk.getByRole("button", { name: "Retry remaining" })).toBeVisible();
  await expect(bulk.getByRole("button", { name: "Export" })).toBeVisible();
  expect(bulkPosts).toBe(2);
  expect(refreshPosts).toBe(1);
  expect(bulkAuthorizations).toEqual([`Bearer ${initialToken}`, `Bearer ${initialToken}`]);
  await expect(bulk.getByText("VNU reconnected. Review the saved results, then retry the remaining targets.")).toBeVisible();
  await bulk.getByRole("button", { name: "Retry remaining" }).click();
  await expect(bulk.getByText("6 completed")).toBeVisible();
  expect(bulkPosts).toBe(3);
  expect(bulkAuthorizations).toEqual([`Bearer ${initialToken}`, `Bearer ${initialToken}`, `Bearer ${rotatedToken}`]);
  expect(await page.evaluate(() => (JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<{ token: string }>)[0]?.token)).toBe(rotatedToken);
});

test("bulk and safe VNU lookup cancel one shared refresh without late mutations", async ({ page }) => {
  const initialToken = "synthetic-cancel-bulk-token";
  const targets = Array.from({ length: 6 }, (_, index) => `990000020${index + 1}`);
  let bulkPosts = 0;
  let refreshPosts = 0;
  let markSecondStarted!: () => void;
  const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
  let markRefreshEntered!: () => void;
  const refreshEntered = new Promise<void>((resolve) => { markRefreshEntered = resolve; });
  let releaseLate!: () => void;
  const lateReleased = new Promise<void>((resolve) => { releaseLate = resolve; });
  let markRefreshHandled!: () => void;
  const refreshHandled = new Promise<void>((resolve) => { markRefreshHandled = resolve; });
  let refreshAborted = 0;
  let markRefreshAbort!: () => void;
  const refreshAbortObserved = new Promise<void>((resolve) => { markRefreshAbort = resolve; });
  const bulkAuthorizations: Array<string | null> = [];
  page.on("requestfailed", (request) => {
    if (!request.url().includes("/api/vnu/auth/refresh")) return;
    refreshAborted += 1;
    markRefreshAbort();
  });

  await openMockedVnuLookup(page);

  await page.route("**/api/vnu/cross-lookup/bulk", async (route) => {
    bulkPosts += 1;
    bulkAuthorizations.push(route.request().headers()["authorization"] ?? null);
    const body = route.request().postDataJSON() as { targets: string[] };
    if (bulkPosts === 2) {
      markSecondStarted();
      await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ data: null, error: { code: "VNU_SESSION_EXPIRED", message: "Synthetic expiry" } }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
      items: body.targets.map((target) => ({ target, status: "ok", result: { studentCode: `CODE-${target}` } })),
    }, error: null }) });
  });
  await page.route("**/api/vnu/class-lookup/catalog**", async (route) => {
    await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ data: null, error: { code: "VNU_SESSION_EXPIRED", message: "Synthetic expiry" } }) });
  });
  await page.route("**/api/vnu/auth/refresh", async (route) => {
    refreshPosts += 1;
    markRefreshEntered();
    await lateReleased;
    try {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
        token: "synthetic-late-cancel-token",
        refreshGrant: "synthetic-late-cancel-grant",
        session: { universityId: "vnu", studentCode: "SYNTHETIC-STUDENT", expiresAt: "2099-01-01T00:00:00.000Z", authenticated: true },
      }, error: null }) });
    } catch {
      // Browser cancellation intentionally makes the late response inert.
    } finally {
      markRefreshHandled();
    }
  });

  await page.evaluate(({ token }) => {
    const accounts = JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<Record<string, unknown>>;
    const activeId = localStorage.getItem("hyeboard.activeAccountId");
    localStorage.setItem("hyeboard.accounts", JSON.stringify(accounts.map((account) => account.id === activeId ? { ...account, token } : account)));
    if (activeId) sessionStorage.setItem(`hyeboard.vnu.refreshGrant.${activeId}`, "synthetic-cancel-grant");
  }, { token: initialToken });
  await page.reload();
  await page.evaluate(() => {
    const events = { committed: 0, statuses: [] as string[] };
    window.addEventListener("hyeboard:vnu-refresh-committed", () => { events.committed += 1; });
    window.addEventListener("hyeboard:vnu-refresh-status", (event) => {
      const state = (event as CustomEvent<{ state?: string }>).detail.state;
      if (state) events.statuses.push(state);
    });
    Object.defineProperty(window, "__vnuRefreshEvents", { value: events, configurable: true });
  });

  const bulk = page.getByTestId("bulk-lookup");
  await bulk.getByLabel("Targets, one per line").fill(targets.join("\n"));
  await bulk.getByRole("button", { name: "Run bulk lookup" }).click();
  await secondStarted;
  await refreshEntered;
  await expect(bulk.getByText(targets[0]!, { exact: true })).toBeVisible();
  await expect(bulk.getByRole("button", { name: "Export" })).toBeVisible();

  const term = page.getByRole("combobox", { name: "Term" });
  const safeExpiryResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/vnu/class-lookup/catalog" && response.status() === 401);
  await term.click();
  const termOptions = page.getByRole("listbox");
  await termOptions.getByRole("option", { name: "Semester 2, 2025–2026 (supplementary)", exact: true }).click();
  await safeExpiryResponse;
  await page.getByRole("button", { name: "Class ID to course" }).click();
  await expect(page.getByTestId("reverse-class-lookup")).toBeVisible();
  await bulk.getByRole("button", { name: "Cancel" }).click();
  await refreshAbortObserved;
  expect(refreshPosts).toBe(1);
  expect(refreshAborted).toBe(1);
  expect(bulkPosts).toBe(2);
  expect(bulkAuthorizations).toEqual([`Bearer ${initialToken}`, `Bearer ${initialToken}`]);
  const beforeLate = await page.evaluate(() => ({
    account: localStorage.getItem("hyeboard.accounts"),
    grants: Object.entries(sessionStorage).filter(([key]) => key.startsWith("hyeboard.vnu.refreshGrant.")),
    events: (window as unknown as { __vnuRefreshEvents: { committed: number; statuses: string[] } }).__vnuRefreshEvents,
  }));
  await expect(bulk.getByRole("button", { name: "Retry remaining" })).toBeVisible();
  await expect(bulk.getByRole("button", { name: "Export" })).toBeVisible();
  await expect(bulk.getByText(targets[0]!, { exact: true })).toBeVisible();

  releaseLate();
  await refreshHandled;
  const afterLate = await page.evaluate(() => ({
    account: localStorage.getItem("hyeboard.accounts"),
    grants: Object.entries(sessionStorage).filter(([key]) => key.startsWith("hyeboard.vnu.refreshGrant.")),
    events: (window as unknown as { __vnuRefreshEvents: { committed: number; statuses: string[] } }).__vnuRefreshEvents,
  }));
  expect(afterLate).toEqual(beforeLate);
  expect(bulkPosts).toBe(2);
  expect(refreshPosts).toBe(1);
  expect(refreshAborted).toBe(1);
  expect(bulkAuthorizations).toEqual([`Bearer ${initialToken}`, `Bearer ${initialToken}`]);
});

test("bulk resets without stale resurrection while second chunk is gated", async ({ page }) => {
  let releaseSecond!: () => void;
  let markSecondStarted!: () => void;
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
  const chunks: string[][] = [];
  let failedRequests = 0;
  let markFailedRequest!: () => void;
  const failedRequest = new Promise<void>((resolve) => { markFailedRequest = resolve; });
  let markSecondHandled!: () => void;
  const secondHandled = new Promise<void>((resolve) => { markSecondHandled = resolve; });
  page.on("requestfailed", (request) => {
    if (!request.url().includes("/api/vnu/cross-lookup/bulk")) return;
    failedRequests += 1;
    markFailedRequest();
  });
  await page.route("**/api/vnu/cross-lookup/bulk", async (route) => {
    const body = route.request().postDataJSON() as { targets: string[] };
    chunks.push(body.targets);
    if (chunks.length === 2) {
      markSecondStarted();
      await secondGate;
    }
    try { await fulfillBulkSuccess(route, []); } catch { /* Request was invalidated by reset. */ }
    finally { if (chunks.length === 2) markSecondHandled(); }
  });
  await openMockedLookup(page);
  const bulk = page.getByTestId("bulk-lookup");
  const targets = Array.from({ length: 11 }, (_, index) => `990000005${String(index + 1).padStart(2, "0")}`);
  await bulk.getByLabel("Targets, one per line").fill(targets.join("\n"));
  await bulk.getByRole("button", { name: "Run bulk lookup" }).click();
  await secondStarted;
  await bulk.getByRole("button", { name: "Reset" }).click();
  await failedRequest;
  expect(failedRequests).toBe(1);
  await expect(bulk.getByRole("button", { name: "Export" })).toHaveCount(0);
  await expect(bulk.getByText(targets[0]!)).toHaveCount(0);
  await expect(bulk.locator("#bulk-lookup-progress-label")).toHaveCount(0);
  releaseSecond();
  await secondHandled;
  expect(chunks).toHaveLength(2);
  await expect(bulk.getByRole("button", { name: "Export" })).toHaveCount(0);
  await expect(bulk.getByText(targets[0]!)).toHaveCount(0);
});

test("bulk clears account results and aborts gated work on account freshness change", async ({ page }) => {
  let releaseSecond!: () => void;
  let markSecondStarted!: () => void;
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
  const chunks: string[][] = [];
  let failedRequests = 0;
  let markFailedRequest!: () => void;
  const failedRequest = new Promise<void>((resolve) => { markFailedRequest = resolve; });
  let markSecondHandled!: () => void;
  const secondHandled = new Promise<void>((resolve) => { markSecondHandled = resolve; });
  page.on("requestfailed", (request) => {
    if (!request.url().includes("/api/vnu/cross-lookup/bulk")) return;
    failedRequests += 1;
    markFailedRequest();
  });
  await page.route("**/api/vnu/cross-lookup/bulk", async (route) => {
    const body = route.request().postDataJSON() as { targets: string[] };
    chunks.push(body.targets);
    if (chunks.length === 2) {
      markSecondStarted();
      await secondGate;
    }
    try { await fulfillBulkSuccess(route, []); } catch { /* Request was invalidated by account switch. */ }
    finally { if (chunks.length === 2) markSecondHandled(); }
  });
  await openMockedLookup(page);
  const bulk = page.getByTestId("bulk-lookup");
  const targets = Array.from({ length: 11 }, (_, index) => `990000006${String(index + 1).padStart(2, "0")}`);
  await bulk.getByLabel("Targets, one per line").fill(targets.join("\n"));
  await bulk.getByRole("button", { name: "Run bulk lookup" }).click();
  await secondStarted;
  await page.evaluate(() => {
    const accounts = JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<Record<string, unknown>>;
    const current = accounts[0];
    if (!current) throw new Error("Synthetic account fixture missing");
    const next = { ...current, id: "synthetic-account-99", studentCode: "99009999", addedAt: "2099-12-31T00:00:00.000Z" };
    localStorage.setItem("hyeboard.accounts", JSON.stringify([...accounts, next]));
    localStorage.setItem("hyeboard.activeAccountId", "synthetic-account-99");
    window.dispatchEvent(new CustomEvent("hyeboard:account-switched"));
  });
  await failedRequest;
  expect(failedRequests).toBe(1);
  await expect(page.getByTestId("bulk-lookup").getByRole("button", { name: "Export" })).toHaveCount(0);
  await expect(page.getByTestId("bulk-lookup").getByText(targets[0]!)).toHaveCount(0);
  releaseSecond();
  await secondHandled;
  expect(chunks).toHaveLength(2);
  await expect(page.getByTestId("bulk-lookup").getByRole("button", { name: "Export" })).toHaveCount(0);
  await expect(page.getByTestId("bulk-lookup").getByText(targets[0]!)).toHaveCount(0);
});

test("same-account session refresh clears lookup collections and blocks late bulk results @task14", async ({ page }) => {
  let releaseSecond!: () => void;
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  let markSecondStarted!: () => void;
  const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
  let markSecondHandled!: () => void;
  const secondHandled = new Promise<void>((resolve) => { markSecondHandled = resolve; });
  let bulkRequests = 0;
  await page.route("**/api/vnu/cross-lookup/bulk", async (route) => {
    bulkRequests += 1;
    if (bulkRequests === 2) {
      markSecondStarted();
      await secondGate;
    }
    try { await fulfillBulkSuccess(route, []); } catch { /* Old session generation aborted. */ }
    finally { if (bulkRequests === 2) markSecondHandled(); }
  });
  await page.route("**/api/vnu/cross-lookup/transcript**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
      header: { studentCode: SYNTHETIC_TARGET_STUDENT_CODE, studentName: "Synthetic Target", className: "SYNTHETIC-99" },
      totals: { totalCredits: 3, accumulatedCredits: 3, gpa4: 4 },
      terms: [{ maHK: "252", rows: [{ courseCode: "SYN9901", courseName: "Synthetic Foundations", credits: 3, grade10: 9, letterGrade: "A", grade4: 4 }] }],
    }, error: null }) });
  });
  await openMockedVnuLookup(page);

  await page.getByLabel("Course code").fill("SYN9900");
  await page.getByRole("button", { name: "Transcript", exact: true }).click();
  const transcript = page.getByTestId("cross-transcript");
  await transcript.getByLabel("Target internal student ID").fill(SYNTHETIC_TARGET_INTERNAL_ID);
  await transcript.getByRole("button", { name: "View transcript" }).click();
  await expect(transcript.getByText("Synthetic Target", { exact: true })).toBeVisible();

  const bulk = page.getByTestId("bulk-lookup");
  const targets = Array.from({ length: 6 }, (_, index) => `9900000080${index + 1}`);
  await bulk.getByLabel("Targets, one per line").fill(targets.join("\n"));
  await bulk.getByRole("button", { name: "Run bulk lookup" }).click();
  await secondStarted;
  await expect(bulk.getByText(targets[0]!, { exact: true })).toBeVisible();
  await expect(bulk.getByRole("button", { name: "Export" })).toBeVisible();

  await page.evaluate(() => {
    const accountId = localStorage.getItem("hyeboard.activeAccountId");
    if (!accountId) throw new Error("Synthetic active account missing");
    window.dispatchEvent(new CustomEvent("hyeboard:vnu-refresh-committed", { detail: { accountId } }));
  });

  const refreshedBulk = page.getByTestId("bulk-lookup");
  await expect(page.getByLabel("Course code")).toHaveValue("");
  await page.getByRole("button", { name: "Transcript", exact: true }).click();
  await expect(page.getByTestId("cross-transcript").getByLabel("Target internal student ID")).toHaveValue("");
  await expect(page.getByTestId("cross-transcript").getByText("Synthetic Target", { exact: true })).toHaveCount(0);
  await expect(refreshedBulk.getByLabel("Targets, one per line")).toHaveValue("");
  await expect(refreshedBulk.getByRole("button", { name: "Export" })).toHaveCount(0);
  await expect(refreshedBulk.locator("#bulk-lookup-progress-label")).toHaveCount(0);
  await expect(refreshedBulk.getByText(targets[0]!, { exact: true })).toHaveCount(0);

  releaseSecond();
  await secondHandled;
  expect(bulkRequests).toBe(2);
  await expect(refreshedBulk.getByLabel("Targets, one per line")).toHaveValue("");
  await expect(refreshedBulk.getByRole("button", { name: "Export" })).toHaveCount(0);
  await expect(refreshedBulk.getByText(targets[0]!, { exact: true })).toHaveCount(0);
});

for (const lifecycle of ["session refresh", "account switch", "unmount"] as const) test(`${lifecycle} aborts pending own and cross lookups without stale render @task14`, async ({ page }) => {
  let markOwnStarted!: () => void;
  let markCrossStarted!: () => void;
  let releaseOwn!: () => void;
  let releaseCross!: () => void;
  const ownStarted = new Promise<void>((resolve) => { markOwnStarted = resolve; });
  const crossStarted = new Promise<void>((resolve) => { markCrossStarted = resolve; });
  const ownGate = new Promise<void>((resolve) => { releaseOwn = resolve; });
  const crossGate = new Promise<void>((resolve) => { releaseCross = resolve; });
  await page.addInitScript(() => {
    const abortedPaths: string[] = [];
    Object.defineProperty(window, "__task14AbortedPaths", { value: abortedPaths, configurable: true });
    const originalFetch = window.fetch.bind(window);
    Object.defineProperty(window, "fetch", { configurable: true, value: (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
      init?.signal?.addEventListener("abort", () => abortedPaths.push(path), { once: true });
      return originalFetch(input, init);
    } });
  });
  await openMockedLookup(page);
  await page.unroute("**/api/vnu/class-lookup/catalog**");
  await page.unroute("**/api/vnu/cross-lookup/student-code**");
  await page.route("**/api/vnu/class-lookup/catalog**", async (route) => {
    markOwnStarted();
    await ownGate;
    try { await route.fulfill({ status: 200, contentType: "application/json", json: { data: { html: "<main>stale-own</main>" }, error: null } }); } catch { /* Cancelled request. */ }
  });
  await page.route("**/api/vnu/cross-lookup/student-code**", async (route) => {
    markCrossStarted();
    await crossGate;
    try { await route.fulfill({ status: 200, contentType: "application/json", json: { data: { studentCode: "STALE-CODE" }, error: null } }); } catch { /* Cancelled request. */ }
  });

  await page.getByLabel("Term").click();
  await page.getByRole("option").first().click();
  const codeSection = page.getByTestId("cross-student-code");
  await codeSection.getByLabel("Target internal student ID").fill(SYNTHETIC_TARGET_INTERNAL_ID);
  await codeSection.getByRole("button", { name: "Look up" }).click();
  await Promise.all([ownStarted, crossStarted]);

  if (lifecycle === "session refresh") {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("hyeboard:account-switched")));
  } else if (lifecycle === "account switch") {
    await page.evaluate(() => {
      const accounts = JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<Record<string, unknown>>;
      const next = { id: "task14-next-account", universityId: "mock", token: "task14-next-token", studentCode: "88000000", addedAt: new Date().toISOString() };
      localStorage.setItem("hyeboard.accounts", JSON.stringify([...accounts, next]));
      localStorage.setItem("hyeboard.activeAccountId", next.id);
      window.dispatchEvent(new CustomEvent("hyeboard:account-switched"));
    });
  } else {
    await page.getByRole("link", { name: "Settings" }).click();
  }

  await expect.poll(() => page.evaluate(() => (window as unknown as { __task14AbortedPaths: string[] }).__task14AbortedPaths)).toEqual(expect.arrayContaining([
    "/api/vnu/class-lookup/catalog",
    "/api/vnu/cross-lookup/student-code",
  ]));
  releaseOwn();
  releaseCross();
  await expect(page.getByText("STALE-CODE", { exact: true })).toHaveCount(0);
  await expect(page.getByText("stale-own", { exact: true })).toHaveCount(0);
});

test("bulk bounds rendered rows and pages through every result", async ({ page }) => {
  await page.route("**/api/vnu/cross-lookup/bulk", async (route) => fulfillBulkSuccess(route, []));
  await openMockedLookup(page, 101);
  const bulk = page.getByTestId("bulk-lookup");
  const targets = Array.from({ length: 101 }, (_, index) => `9900001${String(index + 1).padStart(4, "0")}`);
  await bulk.getByLabel("Targets, one per line").fill(targets.join("\n"));
  await bulk.getByRole("button", { name: "Run bulk lookup" }).click();
  await expect(bulk.getByText("101 completed")).toBeVisible();
  const resultsList = bulk.getByTestId("bulk-results-list");
  await expect(resultsList.locator(":scope > .list-row")).toHaveCount(50);
  await expect(resultsList.getByText(targets[0]!)).toBeVisible();
  await expect(resultsList.getByText(targets[50]!)).toHaveCount(0);
  await expect(bulk.getByText("Showing 1–50 of 101 results")).toBeVisible();
  await expect(bulk.getByRole("button", { name: "Previous page" })).toBeDisabled();

  await bulk.getByRole("button", { name: "Next page" }).click();
  await expect(resultsList.locator(":scope > .list-row")).toHaveCount(50);
  await expect(resultsList.getByText(targets[0]!)).toHaveCount(0);
  await expect(resultsList.getByText(targets[50]!)).toBeVisible();
  await expect(bulk.getByText("Showing 51–100 of 101 results")).toBeVisible();

  await bulk.getByRole("button", { name: "Next page" }).click();
  await expect(resultsList.locator(":scope > .list-row")).toHaveCount(1);
  await expect(resultsList.getByText(targets[100]!)).toBeVisible();
  await expect(bulk.getByText("Showing 101–101 of 101 results")).toBeVisible();
  await expect(bulk.getByRole("button", { name: "Next page" })).toBeDisabled();

  await bulk.getByRole("button", { name: "Previous page" }).click();
  await expect(resultsList.locator(":scope > .list-row")).toHaveCount(50);
  await expect(resultsList.getByText(targets[50]!)).toBeVisible();
  await bulk.getByRole("button", { name: "Previous page" }).click();
  await expect(resultsList.getByText(targets[0]!)).toBeVisible();
  await expect(resultsList.getByText(targets[50]!)).toHaveCount(0);
});

test("bulk rejects malformed success without exporting unsafe result fields", async ({ page }) => {
  const apiRequestCount = trackApiRequestCounts(page);
  let call = 0;
  await page.route("**/api/vnu/cross-lookup/bulk", async (route) => {
    call += 1;
    if (call === 1) {
      await fulfillBulkSuccess(route, []);
      return;
    }
    const body = route.request().postDataJSON() as { targets: string[] };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { items: body.targets.map((target) => ({ target, status: "ok", result: { studentCode: 99000199, unsafe: "must-not-export" } })) }, error: null }),
    });
  });
  await openMockedLookup(page);
  const bulk = page.getByTestId("bulk-lookup");
  const targets = Array.from({ length: 6 }, (_, index) => `9900000070${index + 1}`);
  await bulk.getByLabel("Targets, one per line").fill(targets.join("\n"));
  await bulk.getByRole("button", { name: "Run bulk lookup" }).click();
  await expect(bulk.getByText("The lookup returned an invalid result. Retry the remaining targets.")).toBeVisible();
  const partial = await expectExportFormats(page, "bulk-id-to-code", apiRequestCount, {
    sourcePath: "/api/vnu/cross-lookup/bulk",
    assertCsv: expectBulkCsvMatchesJson,
  });
  expect(partial.run).toEqual({ status: "partial", mode: "stdid-to-code", processedCount: 5, totalCount: 6 });
  expect(JSON.stringify(partial)).not.toContain("unsafe");
});

test("lookup successful single results export both formats without refetch and clear stale actions", async ({ page }) => {
  const apiRequestCount = trackApiRequestCounts(page);
  await openMockedLookup(page);

  await page.getByLabel("Course code").fill("SYN9900");
  await page.getByLabel("Term").click();
  await page.getByRole("option", { name: "Semester 2, 2025–2026 (supplementary)" }).click();
  const forwardRow = page.getByTestId("lookup-results").locator(".list-row").filter({ hasText: "Synthetic Export Systems" });
  await expect(forwardRow).toBeVisible();
  const forwardDocument = await expectExportFormats(page, "class-forward", apiRequestCount, {
    sourcePath: "/api/vnu/class-lookup/catalog",
    assertCsv: expectClassCsvMatchesJson,
  });
  expect(forwardDocument).toMatchObject({
    surface: "class-forward",
    universityId: "mock",
    results: [{ classResult: { classCode: "SYN9900", classNumber: "99", classId: SYNTHETIC_CLASS_ID, courseName: "Synthetic Export Systems" } }],
  });

  await page.getByRole("button", { name: "Class ID to course" }).click();
  const reverseSection = page.getByTestId("reverse-class-lookup");
  await reverseSection.getByLabel("Term").click();
  await page.getByRole("option", { name: "Semester 2, 2025–2026 (supplementary)" }).click();
  await reverseSection.getByLabel("Internal class ID").fill(SYNTHETIC_CLASS_ID);
  const reverseDocument = await expectExportFormats(page, "class-reverse", apiRequestCount, {
    sourcePath: "/api/vnu/class-lookup/catalog",
    assertCsv: expectClassCsvMatchesJson,
  });
  expect(reverseDocument).toMatchObject({
    surface: "class-reverse",
    universityId: "mock",
    results: [{ classResult: { classCode: "SYN9900", classNumber: "99", classId: SYNTHETIC_CLASS_ID, courseName: "Synthetic Export Systems" } }],
  });

  const codeSection = page.getByTestId("cross-student-code");
  const codeInput = codeSection.getByLabel("Target internal student ID");
  await codeInput.fill(SYNTHETIC_TARGET_INTERNAL_ID);
  await codeSection.getByRole("button", { name: "Look up" }).click();
  await expect(codeSection.getByText(SYNTHETIC_TARGET_STUDENT_CODE)).toBeVisible();
  const codeDocument = await expectExportFormats(page, "student-id-to-code", apiRequestCount, {
    sourcePath: "/api/vnu/cross-lookup/student-code",
    assertCsv: expectResolverCsvMatchesJson,
  });
  expect(codeDocument).toMatchObject({
    surface: "student-id-to-code",
    query: { mode: "stdId", value: SYNTHETIC_TARGET_INTERNAL_ID },
    results: [{ identity: { studentCode: SYNTHETIC_TARGET_STUDENT_CODE, internalStudentId: SYNTHETIC_TARGET_INTERNAL_ID, studentName: "Synthetic Target" } }],
  });
  await codeInput.fill(SYNTHETIC_ERROR_INTERNAL_ID);
  await expect(codeSection.getByRole("button", { name: "Export" })).toHaveCount(0);

  await page.getByRole("button", { name: "Code → ID" }).click();
  const idSection = page.getByTestId("cross-student-id");
  const idInput = idSection.getByLabel("Target student code");
  await idInput.fill(SYNTHETIC_TARGET_STUDENT_CODE);
  await idSection.getByRole("button", { name: "Look up" }).click();
  await expect(idSection.getByText(SYNTHETIC_TARGET_INTERNAL_ID)).toBeVisible();
  const idDocument = await expectExportFormats(page, "student-code-to-id", apiRequestCount, {
    sourcePath: "/api/vnu/cross-lookup/student-id",
    assertCsv: expectResolverCsvMatchesJson,
  });
  expect(idDocument).toMatchObject({ surface: "student-code-to-id", results: [{ resolver: { resolvedStudentCode: SYNTHETIC_TARGET_STUDENT_CODE, resolvedInternalStudentId: SYNTHETIC_TARGET_INTERNAL_ID, probes: 2 } }] });
  await idInput.fill(SYNTHETIC_ERROR_STUDENT_CODE);
  await expect(idSection.getByRole("button", { name: "Export" })).toHaveCount(0);

  await page.getByRole("button", { name: "Transcript", exact: true }).click();
  const transcriptSection = page.getByTestId("cross-transcript");
  const transcriptInput = transcriptSection.getByLabel("Target internal student ID");
  await transcriptInput.fill(SYNTHETIC_TARGET_INTERNAL_ID);
  await transcriptSection.getByRole("button", { name: "View transcript" }).click();
  await expect(transcriptSection.getByText("Portal cumulative GPA (4.0)", { exact: true })).toBeVisible();
  await expect(transcriptSection.getByText("3.91", { exact: true })).toBeVisible();
  const derivedHeader = transcriptSection.getByTestId("academic-term-header").first();
  await expect(derivedHeader.getByText("Derived", { exact: true })).toBeVisible();
  await expect(derivedHeader.getByText("Term GPA").locator("..")).toContainText("4.00");
  await expect(derivedHeader.getByText("CPA", { exact: true }).locator("..")).toContainText("3.50");
  await expect(derivedHeader.getByText("Included credits").locator("..")).toContainText("3 / 5 listed");
  const gradeTable = transcriptSection.locator("table").first();
  await expect(gradeTable.getByRole("columnheader", { name: "Course" })).toBeVisible();
  await expect(gradeTable.getByRole("columnheader", { name: "Grade" })).toBeVisible();
  await expect(gradeTable.getByRole("columnheader", { name: "Credits" })).toBeVisible();
  await expect(gradeTable.getByRole("columnheader", { name: "Point 10" })).toBeVisible();
  await expect(gradeTable.getByRole("columnheader", { name: "Point 4" })).toBeVisible();
  const headerButtons = gradeTable.locator("thead th");
  await expect(headerButtons.nth(0).locator("button")).toContainText("Course");
  await expect(headerButtons.nth(2).locator("button")).toHaveText("Credits");
  await expect(headerButtons.nth(3).locator("button")).toHaveText("Point 10");
  await expect(headerButtons.nth(4).locator("button")).toHaveText("Point 4");
  await expect(headerButtons.nth(4)).toHaveClass(/max-sm:hidden/);
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(gradeTable.getByRole("columnheader", { name: "Point 4" })).not.toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(gradeTable.getByRole("columnheader", { name: "Point 4" })).toBeVisible();
  await expect(transcriptSection.getByRole("button", { name: "Export" })).toHaveCount(1);
  const transcriptDocument = await expectExportFormats(page, "cross-transcript", apiRequestCount, {
    sourcePath: "/api/vnu/cross-lookup/transcript",
    assertCsv: expectAcademicCsvMatchesJson,
  });
  expect(transcriptDocument).toMatchObject({
    surface: "cross-transcript",
    query: { mode: "stdId", value: SYNTHETIC_TARGET_INTERNAL_ID },
    identity: { studentCode: SYNTHETIC_TARGET_STUDENT_CODE, internalStudentId: SYNTHETIC_TARGET_INTERNAL_ID, studentName: "Synthetic Target", managingClass: "SYNTHETIC-99" },
    reported: { cumulativeGpa4: 3.91 },
  });
  const transcriptTerms = transcriptDocument.derivedTerms as Array<Record<string, unknown>>;
  expect(transcriptTerms.map((term) => term.termCode)).toEqual(["252", "251"]);
  expect(transcriptTerms[0]).toMatchObject({ termCode: "252", estimateKind: "derived", listedCredits: 5, includedCredits: 3, termGpa4: 4, derivedCpa4: 3.5 });
  expect((transcriptTerms[0]?.courses as Array<{ courseCode: string }>).map((course) => course.courseCode)).toEqual(["SYN9902", "SYN9903"]);
  expect(transcriptTerms[1]).toMatchObject({ termCode: "251", estimateKind: "derived", listedCredits: 3, includedCredits: 3, termGpa4: 3, derivedCpa4: 3 });
  await transcriptInput.fill(SYNTHETIC_ERROR_INTERNAL_ID);
  await expect(transcriptSection.getByRole("button", { name: "Export" })).toHaveCount(0);

  await transcriptSection.getByRole("button", { name: "Student code" }).click();
  const transcriptCodeInput = transcriptSection.getByLabel("Target student code");
  await transcriptCodeInput.fill(SYNTHETIC_TARGET_STUDENT_CODE);
  await transcriptSection.getByRole("button", { name: "View transcript" }).click();
  await expect(transcriptSection.getByRole("button", { name: "Export" })).toHaveCount(1);
  const transcriptCodeDocument = await expectExportFormats(page, "cross-transcript", apiRequestCount, {
    sourcePath: "/api/vnu/cross-lookup/transcript",
    assertCsv: expectAcademicCsvMatchesJson,
  });
  expect(transcriptCodeDocument).toMatchObject({
    query: { mode: "stdCode", value: SYNTHETIC_TARGET_STUDENT_CODE },
    identity: { studentCode: SYNTHETIC_TARGET_STUDENT_CODE, studentName: "Synthetic Target", managingClass: "SYNTHETIC-99" },
  });
  expect(transcriptCodeDocument.identity).not.toHaveProperty("internalStudentId");
  await expectNoPageOverflow(page);
});

test("VNU class lookup matches compact and spaced codes and exports preserved display", async ({ page }) => {
  const apiRequestCount = trackApiRequestCounts(page);
  const examRequests = await openMockedVnuLookup(page);
  await page.getByLabel("Course code").fill("INT3103");
  await page.getByLabel("Term").click();
  await page.getByRole("option", { name: "Semester 2, 2025–2026 (supplementary)" }).click();
  const row = page.getByTestId("lookup-results").locator(".list-row").filter({ hasText: "Synthetic Search Systems" });
  await expect(row).toContainText("INT 3103 · CN7");
  const requestsAfterCompactSearch = examRequests();
  await page.getByLabel("Course code").fill(" INT 3103 ");
  await expect(row).toContainText("INT 3103 · CN7");
  expect(examRequests()).toBe(requestsAfterCompactSearch);

  const exported = await expectExportFormats(page, "class-forward", apiRequestCount, {
    sourcePath: "/api/vnu/class-lookup/catalog",
    assertCsv: expectClassCsvMatchesJson,
  });
  expect(exported).toMatchObject({
    surface: "class-forward",
    universityId: "vnu",
    results: [{ classResult: { classCode: "INT 3103", classNumber: "CN7", classId: "SYNTHETIC-VNU-CLASS-ID" } }],
  });
});

test("lookup single-result errors remove stale export actions", async ({ page }) => {
  await openMockedLookup(page);
  const section = page.getByTestId("cross-student-code");
  const input = section.getByLabel("Target internal student ID");

  await input.fill(SYNTHETIC_TARGET_INTERNAL_ID);
  await section.getByRole("button", { name: "Look up" }).click();
  await expect(section.getByRole("button", { name: "Export" })).toBeVisible();

  await input.fill(SYNTHETIC_ERROR_INTERNAL_ID);
  await expect(section.getByRole("button", { name: "Export" })).toHaveCount(0);
  await section.getByRole("button", { name: "Look up" }).click();
  await expect(section.getByText("The portal did not render a student code for this internal ID. The ID may not exist.")).toBeVisible();
  await expect(section.getByRole("button", { name: "Export" })).toHaveCount(0);
});

test("cross-student forms reject malformed identifiers client-side before any request", async ({ page }) => {
  await openMockedLookup(page);

  // StdID -> code section: a malformed internal id shows the localized
  // validation message, marks the input invalid, and keeps submit disabled
  // (same contract as the transcript form; the worker still rejects too).
  const codeInput = page.getByLabel("Target internal student ID");
  await codeInput.fill("12ab");
  await expect(codeInput).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("Enter 1 to 11 digits for the internal student ID.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Look up" })).toBeDisabled();
  await codeInput.fill(SYNTHETIC_OWN_INTERNAL_ID);
  await expect(codeInput).toHaveAttribute("aria-invalid", "false");
  await expect(page.getByText("That is your own internal ID — your own ID mapping is shown above.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Look up" })).toBeDisabled();

  // Code -> StdID section: same contract for the 8-digit code form.
  await page.getByRole("button", { name: "Code → ID" }).click();
  const idInput = page.getByLabel("Target student code");
  await idInput.fill("1234567");
  await expect(idInput).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("Enter an 8-digit student code.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Look up" })).toBeDisabled();
  await idInput.fill(SYNTHETIC_OWN_STUDENT_CODE);
  await expect(page.getByText("That is your own student code — your own ID mapping is shown above.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Look up" })).toBeDisabled();
});

test("VNU spaced course codes match compact document searches without refetch", async ({ page }) => {
  const syllabusRequests = await openMockedVnuDocuments(page);
  const search = page.getByLabel("Search documents");
  const document = page.getByText("INT 3103 — Synthetic Syllabus");

  await search.fill("INT3103");
  await expect(document).toBeVisible();
  const requestsAfterCompactSearch = syllabusRequests();
  await search.fill("INT 3103");
  await expect(document).toBeVisible();
  await search.fill("Synthetic Syllabus");
  await expect(document).toBeVisible();
  expect(syllabusRequests()).toBe(requestsAfterCompactSearch);
});

test("cross-detail sends only an opaque permit and never persists detail state", async ({ page }) => {
  await openMockedLookup(page, 50, 5, undefined, 2, true);
  const submittedBodies: unknown[] = [];
  await page.route("**/api/vnu/cross-lookup/detail", async (route) => {
    submittedBodies.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { permit: "synthetic-detail-permit", html: `<p>Điểm chi tiết môn học - Học kỳ 2. Mã học kỳ 252</p><table><tr><td>STT</td><td>Bản chất kỳ thi</td><td>TS</td><td>Lần thi</td><td>Điểm</td><td>Ghi chú</td></tr><tr><td>1</td><td>Synthetic component</td><td>0.5</td><td>1</td><td>9</td><td></td></tr></table>` } , error: null }) });
  });

  await page.getByRole("button", { name: "Transcript", exact: true }).click();
  const section = page.getByTestId("cross-transcript");
  await section.getByLabel("Target internal student ID").fill(SYNTHETIC_TARGET_INTERNAL_ID);
  await section.getByRole("button", { name: "View transcript" }).click();
  await section.getByRole("button", { name: "Toggle details for Synthetic Foundations" }).click();
  await expect(section.getByTestId("grade-detail").nth(2)).toHaveAttribute("data-open", "true");
  await expect(section.getByText("Synthetic component")).toBeVisible();

  expect(submittedBodies).toEqual([{ allowCrossLookup: true, permit: "synthetic-detail-permit" }]);
  const stored = await page.evaluate(() => ({ local: Object.values(localStorage), session: Object.values(sessionStorage) }));
  expect(JSON.stringify(stored)).not.toContain("synthetic-detail-permit");
  expect(JSON.stringify(stored)).not.toContain("Synthetic component");
});

test("cross-detail UI stays unavailable without its published capability", async ({ page }) => {
  await openMockedLookup(page, 50, 5, undefined, undefined, true);
  await page.getByRole("button", { name: "Transcript", exact: true }).click();
  const section = page.getByTestId("cross-transcript");
  await section.getByLabel("Target internal student ID").fill(SYNTHETIC_TARGET_INTERNAL_ID);
  await section.getByRole("button", { name: "View transcript" }).click();

  await section.getByRole("button", { name: "Toggle details for Synthetic Foundations" }).click();
  await expect(section.getByTestId("grade-detail").nth(2)).toHaveAttribute("data-open", "true");
  await expect(section.getByText("Assessment detail is unavailable because this grade has no verified class identity.")).toBeVisible();
});

test("cross-detail local state clears on account changes and route unmount", async ({ page }) => {
  await openMockedLookup(page, 50, 5, undefined, 2, true);
  await page.route("**/api/vnu/cross-lookup/detail", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { permit: "synthetic-detail-permit", html: `<p>Điểm chi tiết môn học - Học kỳ 2. Mã học kỳ 252</p><table><tr><td>STT</td><td>Bản chất kỳ thi</td><td>TS</td><td>Lần thi</td><td>Điểm</td><td>Ghi chú</td></tr><tr><td>1</td><td>Synthetic transient detail</td><td>0.5</td><td>1</td><td>9</td><td></td></tr></table>` } , error: null }) });
  });
  await page.getByRole("button", { name: "Transcript", exact: true }).click();
  const section = page.getByTestId("cross-transcript");
  await section.getByLabel("Target internal student ID").fill(SYNTHETIC_TARGET_INTERNAL_ID);
  await section.getByRole("button", { name: "View transcript" }).click();
  await section.getByRole("button", { name: "Toggle details for Synthetic Foundations" }).click();
  await expect(section.getByTestId("grade-detail").nth(2)).toHaveAttribute("data-open", "true");
  await expect(section.getByText("Synthetic transient detail")).toBeVisible();

  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hyeboard:account-switched")));
  await expect(section.getByText("Synthetic transient detail")).toHaveCount(0);
  await page.goto("/dashboard");
  const stored = await page.evaluate(() => ({ local: Object.values(localStorage), session: Object.values(sessionStorage) }));
  expect(JSON.stringify(stored)).not.toContain("synthetic-detail-permit");
  expect(JSON.stringify(stored)).not.toContain("Synthetic transient detail");
});

test("cross-transcript grade-detail supports expanding multiple rows simultaneously", async ({ page }) => {
  await openMockedLookup(page, 50, 5, undefined, 2, true);
  await page.route("**/api/vnu/cross-lookup/detail", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { permit: "synthetic-detail-permit", html: `<p>Điểm chi tiết môn học - Học kỳ 2. Mã học kỳ 252</p><table><tr><td>STT</td><td>Bản chất kỳ thi</td><td>TS</td><td>Lần thi</td><td>Điểm</td><td>Ghi chú</td></tr><tr><td>1</td><td>Multi-open detail</td><td>0.5</td><td>1</td><td>8</td><td></td></tr></table>` } , error: null }) });
  });
  await page.getByRole("button", { name: "Transcript", exact: true }).click();
  const section = page.getByTestId("cross-transcript");
  await section.getByLabel("Target internal student ID").fill(SYNTHETIC_TARGET_INTERNAL_ID);
  await section.getByRole("button", { name: "View transcript" }).click();
  await expect(section.getByTestId("academic-term-header")).toHaveCount(2);

  const resBtn = section.getByRole("button", { name: "Toggle details for Synthetic Resolution" });
  await expect(resBtn).toHaveAttribute("aria-expanded", "false");
  await resBtn.click();
  await expect(resBtn).toHaveAttribute("aria-expanded", "true");
  await expect(section.locator('[data-testid="grade-detail"][data-open="true"]')).toHaveCount(1);

  await section.getByRole("button", { name: "Toggle details for Synthetic Foundations" }).click();
  await expect(section.locator('[data-testid="grade-detail"][data-open="true"]')).toHaveCount(2);
  await expect(section.getByText("Multi-open detail")).toBeVisible();

  await section.getByRole("button", { name: "Toggle details for Synthetic Resolution" }).click();
  await expect(section.locator('[data-testid="grade-detail"][data-open="true"]')).toHaveCount(1);
  await expect(section.getByText("Multi-open detail")).toBeVisible();
});
