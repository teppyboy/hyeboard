import { test, expect, authenticateDemoPage, loginDemoThroughUi, expectNoPageOverflow, REFERENCE_VIEWPORTS } from "./fixtures/base";
import { openMockedLookup } from "./fixtures/lookup";

for (const viewport of REFERENCE_VIEWPORTS.slice(2)) {
  test(`login, dashboard, timetable, and grades have no horizontal overflow at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/login");
    await expectNoPageOverflow(page);
    await authenticateDemoPage(page);
    await expectNoPageOverflow(page);
    for (const route of ["/timetable", "/grades", "/exams", "/tuition"]) {
      await page.goto(route);
      await expectNoPageOverflow(page);
    }
  });
}

test("account switch clears the previous term before feature requests", async ({ page }) => {
  await authenticateDemoPage(page);
  const firstAccount = await page.evaluate(() => {
    const accounts = JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<{ id: string; token: string }>;
    return accounts[0]!;
  });
  const imported = await page.request.post("/api/mock/auth/import-session", { data: { studentCode: "SECOND-MOCK" } });
  const secondAuth = await imported.json() as { data: { token: string } };
  const secondAccount = { id: crypto.randomUUID(), universityId: "mock", token: secondAuth.data.token, studentCode: "SECOND-MOCK", addedAt: new Date().toISOString() };
  await page.evaluate((account) => {
    const accounts = JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as unknown[];
    localStorage.setItem("hyeboard.accounts", JSON.stringify([...accounts, account]));
  }, secondAccount);

  const dashboardTerms: Array<{ account: "first" | "second"; term: string | null }> = [];
  const timetableTerms: Array<{ account: "first" | "second"; term: string | null }> = [];
  const examTerms: Array<{ account: "first" | "second"; term: string | null }> = [];
  const requestAccount = (authorization?: string) => authorization === `Bearer ${secondAccount.token}`
    ? "second"
    : authorization === `Bearer ${firstAccount.token}` ? "first" : undefined;
  await page.route("**/api/mock/dashboard**", async (route) => {
    const account = requestAccount(route.request().headers().authorization);
    if (!account) return route.continue();
    dashboardTerms.push({ account, term: new URL(route.request().url()).searchParams.get("termCode") });
    if (account === "first") return route.continue();
    const response = await route.fetch();
    const payload = await response.json() as { data: { currentTerm?: { id: string; code: string; name: string } } };
    await route.fulfill({ response, json: { ...payload, data: { ...payload.data, currentTerm: { id: "new-term", code: "NEW-TERM", name: "New account term" } } } });
  });
  await page.route("**/api/mock/timetable**", async (route) => {
    const account = requestAccount(route.request().headers().authorization);
    if (account) timetableTerms.push({ account, term: new URL(route.request().url()).searchParams.get("termCode") });
    await route.continue();
  });
  await page.route("**/api/mock/exams**", async (route) => {
    const account = requestAccount(route.request().headers().authorization);
    if (account) examTerms.push({ account, term: new URL(route.request().url()).searchParams.get("termCode") });
    await route.continue();
  });

  await page.reload();
  await expect(page.getByRole("button", { name: "Open account menu" })).toBeVisible();
  await page.goto("/exams");
  await page.getByRole("combobox", { name: "Term" }).click();
  await page.getByRole("option", { name: "2024-2025 II" }).click();
  await expect.poll(() => examTerms).toContainEqual({ account: "first", term: "20242" });

  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByTestId("account-switch-item").filter({ hasText: "SECOND-MOCK" }).click();

  await expect.poll(() => dashboardTerms).toContainEqual({ account: "second", term: null });
  await expect.poll(() => examTerms).toContainEqual({ account: "second", term: "NEW-TERM" });
  expect(dashboardTerms).not.toContainEqual({ account: "second", term: "20251" });
  expect(examTerms).not.toContainEqual({ account: "second", term: "20242" });

  await page.goto("/timetable");
  await expect.poll(() => timetableTerms).toContainEqual({ account: "second", term: "NEW-TERM" });
  expect(timetableTerms).not.toContainEqual({ account: "second", term: "20251" });
  await page.goto("/exams");
  await page.getByRole("combobox", { name: "Term" }).click();
  await page.getByRole("option", { name: "2024-2025 II" }).click();
  await expect.poll(() => examTerms).toContainEqual({ account: "second", term: "20242" });

  const beforeRemoval = examTerms.length;
  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByRole("button", { name: "Remove SECOND-MOCK" }).click();
  await expect.poll(() => dashboardTerms).toContainEqual({ account: "first", term: null });
  await expect.poll(() => examTerms.slice(beforeRemoval)).toContainEqual({ account: "first", term: "20251" });
  expect(examTerms.slice(beforeRemoval)).not.toContainEqual({ account: "first", term: "20242" });
  expect(examTerms.slice(beforeRemoval)).not.toContainEqual({ account: "first", term: "NEW-TERM" });

  await page.goto("/timetable");
  await expect.poll(() => timetableTerms).toContainEqual({ account: "first", term: "20251" });
  expect(timetableTerms).not.toContainEqual({ account: "first", term: "NEW-TERM" });
  await page.unrouteAll({ behavior: "wait" });
});

test("page-local document and grade controls reset across account switch and removal auto-switch", async ({ page }) => {
  await authenticateDemoPage(page);
  const firstAccount = await page.evaluate(() => {
    const accounts = JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<{ id: string; token: string }>;
    return accounts[0]!;
  });
  const imported = await page.request.post("/api/mock/auth/import-session", { data: { studentCode: "SECOND-MOCK" } });
  const secondAuth = await imported.json() as { data: { token: string } };
  const secondAccount = { id: crypto.randomUUID(), universityId: "mock", token: secondAuth.data.token, studentCode: "SECOND-MOCK", addedAt: new Date().toISOString() };
  await page.evaluate((account) => {
    const accounts = JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as unknown[];
    localStorage.setItem("hyeboard.accounts", JSON.stringify([...accounts, account]));
  }, secondAccount);
  await page.route("**/api/mock/documents", async (route) => {
    const second = route.request().headers().authorization === `Bearer ${secondAccount.token}`;
    await route.fulfill({ status: 200, contentType: "application/json", json: { data: [{ id: second ? "doc-b" : "doc-a", name: second ? "Account B handbook.pdf" : "Account A private outline.pdf" }], error: null } });
  });
  await page.route("**/api/mock/grades", async (route) => {
    const second = route.request().headers().authorization === `Bearer ${secondAccount.token}`;
    await route.fulfill({ status: 200, contentType: "application/json", json: { data: second ? [
      { id: "b-old", courseCode: "B101", courseName: "Account B older grade", termCode: "20242", credits: 3, point10: 8, point4: 3.5 },
      { id: "b-new", courseCode: "B102", courseName: "Account B newest grade", termCode: "20251", credits: 3, point10: 9, point4: 4 },
    ] : [
      { id: "a-old", courseCode: "A101", courseName: "Account A older grade", termCode: "20242", credits: 3, point10: 8, point4: 3.5 },
      { id: "a-new", courseCode: "A102", courseName: "Account A newest grade", termCode: "20251", credits: 3, point10: 9, point4: 4 },
    ], error: null } });
  });

  await page.goto("/grades");
  await expect(page.getByText("Account A newest grade")).toBeVisible();
  await page.getByRole("combobox", { name: "Term" }).click();
  await page.getByRole("option", { name: "Semester 2, 2024–2025" }).click();
  await expect(page.getByText("Account A older grade")).toBeVisible();

  await page.goto("/documents");
  const search = page.getByLabel("Search documents");
  await expect(page.getByText("Account A private outline.pdf")).toBeVisible();
  await search.fill("private");

  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByTestId("account-switch-item").filter({ hasText: "SECOND-MOCK" }).click();
  await expect(search).toHaveValue("");
  await expect(page.getByText("Account B handbook.pdf")).toBeVisible();
  await expect(page.getByText("Account A private outline.pdf")).toHaveCount(0);
  await page.goto("/grades");
  await expect(page.getByText("Account B newest grade")).toBeVisible();
  await expect(page.getByText("Account B older grade")).toHaveCount(0);
  await page.goto("/documents");

  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByRole("button", { name: "Remove SECOND-MOCK" }).click();
  await expect(search).toHaveValue("");
  await expect(page.getByText("Account A private outline.pdf")).toBeVisible();
  await expect(page.getByText("Account B handbook.pdf")).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("hyeboard.activeAccountId"))).toBe(firstAccount.id);
  await page.unrouteAll({ behavior: "wait" });
});

test("account menu opens and signs out", async ({ authenticatedPage: page }) => {
  const accountButton = page.getByRole("button", { name: "Open account menu" });
  await accountButton.click();
  await expect(page.getByTestId("account-trigger")).toHaveCSS("transform", /matrix\(0\.94/);
  await expect(page.getByRole("menuitem", { name: /Settings/i })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Add account/i })).toBeVisible();
  await page.getByRole("menuitem", { name: /Sign out/i }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("friendly demo login opens dashboard", async ({ page }) => {
  await loginDemoThroughUi(page);
  await expect(page.getByText("React Router Lab")).toBeVisible();
  await expect(page.getByTestId("brand-icon")).toHaveAttribute("data-university", "mock");
  await expect(page.getByTestId("brand-icon").locator("img")).toHaveCount(0);
  await expect(page.getByText("Web Application Development").first()).toBeVisible();
  await expect(page.getByText("09:50 - 12:30").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Open class page" })).toHaveAttribute("href", "https://portal.uet.vnu.edu.vn/courses/5359");

  await expect(page.getByTestId("dashboard-summary")).toBeVisible();
  await expect(page.getByTestId("dashboard-schedule")).toBeVisible();
  await expect(page.getByTestId("dashboard-assignments")).toBeVisible();
  await expect(page.getByTestId("dashboard-courses")).toBeVisible();
  await expect(page.getByTestId("dashboard-notifications")).toBeVisible();
  await expect(page.locator(".stat-card")).toHaveCount(0);
});

test("missing effective metadata hides capability navigation and search but keeps Settings", async ({ page }) => {
  await page.route("**/api/universities", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [], error: null }) }));
  await authenticateDemoPage(page);

  await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Grades" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Documents & Services" })).toHaveCount(0);

  const search = page.getByRole("textbox", { name: "Search pages" });
  await search.fill("Grades");
  await expect(page.getByRole("button", { name: "Grades" })).toHaveCount(0);
  await search.fill("Settings");
  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
});

test("policy metadata refetch hides capability UI while pending", async ({ page }) => {
  let universityReads = 0;
  let releaseRevision!: () => void;
  let releaseRefetch!: () => void;
  let markRefetchStarted!: () => void;
  const revisionReleased = new Promise<void>((resolve) => { releaseRevision = resolve; });
  const refetchReleased = new Promise<void>((resolve) => { releaseRefetch = resolve; });
  const refetchStarted = new Promise<void>((resolve) => { markRefetchStarted = resolve; });
  await page.route("**/api/universities", async (route) => {
    universityReads += 1;
    if (universityReads > 1) {
      markRefetchStarted();
      await refetchReleased;
    }
    await route.continue();
  });
  await page.route("**/api/policy/events", async (route) => {
    await revisionReleased;
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: revision\ndata: 1\n\n" });
  });
  await authenticateDemoPage(page);
  await expect(page.getByRole("link", { name: "Grades" })).toBeVisible();

  releaseRevision();
  await refetchStarted;
  await expect(page.getByRole("link", { name: "Grades" })).toHaveCount(0);
  await expect(page.getByTestId("dashboard-summary")).toHaveCount(0);
  await expect(page.getByTestId("dashboard-schedule")).toHaveCount(0);
  releaseRefetch();
});

test("failed policy metadata refetch keeps capability UI and feature data unavailable", async ({ page }) => {
  let universityReads = 0;
  let releaseRevision!: () => void;
  const revisionReleased = new Promise<void>((resolve) => { releaseRevision = resolve; });
  await page.route("**/api/universities", async (route) => {
    universityReads += 1;
    if (universityReads === 1) return route.continue();
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ data: null, error: { code: "INTERNAL_ERROR", message: "Synthetic metadata failure" } }) });
  });
  await page.route("**/api/policy/events", async (route) => {
    await revisionReleased;
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: revision\ndata: 1\n\n" });
  });
  await authenticateDemoPage(page, "/courses");
  await expect(page.getByRole("link", { name: "Grades" })).toBeVisible();
  await expect(page.getByText("Data Structures and Algorithms")).toBeVisible();

  releaseRevision();
  await expect.poll(() => universityReads).toBe(3);
  await expect(page.getByRole("link", { name: "Grades" })).toHaveCount(0);
  await expect(page.getByText("Data Structures and Algorithms")).toHaveCount(0);
  await expect(page.getByText("Feature availability is unavailable. Try again shortly.")).toBeVisible();
});

test("direct feature routes hide cached collections across account switches and metadata gaps while requests continue", async ({ page }) => {
  let universityReads = 0;
  let courseReads = 0;
  let releaseRevision!: () => void;
  let releaseRefetch!: () => void;
  let markRefetchStarted!: () => void;
  const revisionReleased = new Promise<void>((resolve) => { releaseRevision = resolve; });
  const refetchReleased = new Promise<void>((resolve) => { releaseRefetch = resolve; });
  const refetchStarted = new Promise<void>((resolve) => { markRefetchStarted = resolve; });
  await page.route("**/api/universities", async (route) => {
    universityReads += 1;
    if (universityReads > 1) {
      markRefetchStarted();
      await refetchReleased;
    }
    await route.continue();
  });
  await page.route("**/api/mock/courses", async (route) => {
    courseReads += 1;
    await route.continue();
  });
  await page.route("**/api/policy/events", async (route) => {
    await revisionReleased;
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: revision\ndata: 1\n\n" });
  });
  await authenticateDemoPage(page, "/courses");
  await expect(page.getByText("Data Structures and Algorithms")).toBeVisible();

  releaseRevision();
  await refetchStarted;
  await page.evaluate(() => {
    const accounts = JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<Record<string, unknown>>;
    const switched = accounts.map((account) => ({ ...account, id: crypto.randomUUID() }));
    localStorage.setItem("hyeboard.accounts", JSON.stringify(switched));
    localStorage.setItem("hyeboard.activeAccountId", String(switched[0]?.id));
    window.dispatchEvent(new CustomEvent("hyeboard:account-switched"));
  });
  await expect.poll(() => courseReads).toBeGreaterThan(1);
  await expect(page.getByText("Data Structures and Algorithms")).toHaveCount(0);
  await expect(page.locator(".animate-pulse").first()).toBeVisible();
  releaseRefetch();
  await expect(page.getByText("Data Structures and Algorithms")).toBeVisible();
});

test("effective dashboard capabilities remove disabled stats and panels", async ({ page }) => {
  await page.route("**/api/universities", async (route) => {
    const response = await route.fetch();
    const payload = await response.json() as { data: Array<{ id: string; capabilities: Record<string, boolean> }>; error: null };
    const data = payload.data.map((university) => university.id === "mock" ? {
      ...university,
      capabilities: { ...university.capabilities, assignments: false, grades: false },
    } : university);
    await route.fulfill({ response, json: { ...payload, data } });
  });
  await authenticateDemoPage(page);

  const summary = page.getByTestId("dashboard-summary");
  await expect(summary.getByText("GPA", { exact: true })).toHaveCount(0);
  await expect(summary.getByText("Assignments", { exact: true })).toHaveCount(0);
  await expect(summary.getByText("Credits", { exact: true })).toBeVisible();
  await expect(summary.getByText("Tuition", { exact: true })).toBeVisible();
  await expect(page.getByTestId("dashboard-assignments")).toHaveCount(0);
  await expect(page.getByTestId("dashboard-schedule")).toBeVisible();
  await expect(page.getByTestId("dashboard-courses")).toBeVisible();
  await expect(page.getByTestId("dashboard-notifications")).toBeVisible();
});

test("document subfeatures honor effective flags and skip disabled requests", async ({ page }) => {
  let newsRequests = 0;
  let serviceRequests = 0;
  await page.route("**/api/universities", async (route) => {
    const response = await route.fetch();
    const payload = await response.json() as { data: Array<{ id: string; capabilities: Record<string, boolean> }>; error: null };
    const data = payload.data.map((university) => university.id === "mock" ? {
      ...university,
      capabilities: { ...university.capabilities, news: false, requests: false },
    } : university);
    await route.fulfill({ response, json: { ...payload, data } });
  });
  await page.route("**/api/mock/news", (route) => { newsRequests += 1; return route.continue(); });
  await page.route("**/api/mock/requests", (route) => { serviceRequests += 1; return route.continue(); });
  await authenticateDemoPage(page, "/documents");

  await expect(page.getByRole("heading", { name: "Documents", exact: true })).toBeVisible();
  await expect(page.getByText("Course outline.pdf")).toBeVisible();
  await expect(page.getByRole("heading", { name: "News", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Requests", exact: true })).toBeVisible();
  await expect(page.getByText("This section is not supported for the selected university.")).toHaveCount(2);
  expect(newsRequests).toBe(0);
  expect(serviceRequests).toBe(0);
});

test("lookup requires effective flags and resolved limits", async ({ page }) => {
  await page.route("**/api/universities", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data: [{
      id: "vnu",
      name: "Synthetic VNU",
      shortName: "VNU",
      capabilities: {
        profile: true, terms: true, timetable: false, courses: false, assignments: false,
        grades: true, exams: true, attendance: false, notifications: false, documents: false,
        tuition: false, news: false, trainingPoints: false, requests: false, classLookup: false,
        crossLookup: true,
      },
    }], error: null }),
  }));
  await authenticateDemoPage(page);
  await page.evaluate(() => {
    const accounts = JSON.parse(localStorage.getItem("hyeboard.accounts") ?? "[]") as Array<Record<string, unknown>>;
    localStorage.setItem("hyeboard.accounts", JSON.stringify(accounts.map((account) => ({ ...account, universityId: "vnu" }))));
    localStorage.setItem("hyeboard.universityId", "vnu");
    window.dispatchEvent(new CustomEvent("hyeboard:account-switched"));
  });
  await page.goto("/lookup");

  await expect(page.getByRole("heading", { name: "Lookup", exact: true })).toBeVisible();
  await expect(page.getByTestId("class-identifier-tools")).toHaveCount(0);
  await expect(page.getByTestId("student-record-tools")).toHaveCount(0);
  await expect(page.getByTestId("bulk-lookup")).toHaveCount(0);
});

test("dashboard summary strip stays contained on mobile @webkit", async ({ authenticatedPage: page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);

  const stats = page.getByTestId("dashboard-summary").locator(".summary-stat");
  await expect(stats).toHaveCount(4);
  const first = await stats.nth(0).boundingBox();
  const second = await stats.nth(1).boundingBox();
  const third = await stats.nth(2).boundingBox();
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(third).not.toBeNull();
  expect(Math.abs(first!.y - second!.y)).toBeLessThan(5);
  expect(third!.y).toBeGreaterThan(first!.y);

  await page.goto("/grades");
  const gradesStats = page.getByTestId("grades-summary").locator(".summary-stat");
  await expect(gradesStats).toHaveCount(3);
  const wrappedStatBorderLeft = await gradesStats
    .nth(2)
    .evaluate((element) => getComputedStyle(element).borderLeftWidth);
  expect(wrappedStatBorderLeft).toBe("0px");
});

test("status labels render as readable text", async ({ authenticatedPage: page }) => {
  await expect(page.getByText("In progress", { exact: true })).toBeVisible();
  await expect(page.getByText("Not started", { exact: true })).toBeVisible();
  await expect(page.getByText("in_progress", { exact: true })).toHaveCount(0);
  await expect(page.getByText("not_started", { exact: true })).toHaveCount(0);
});

test("light and dark mode toggle changes rendered theme", async ({ authenticatedPage: page }) => {
  await page.goto("/settings");
  await expect(page.locator("html")).toHaveAttribute("data-mode", "light");
  await page.getByRole("button", { name: "Toggle light and dark mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");
  await page.getByRole("button", { name: "Toggle light and dark mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-mode", "light");
});

test("settings can switch between neutral and university theme styles", async ({ authenticatedPage: page }) => {
  await page.goto("/settings");
  await expect(page.getByRole("group", { name: "Theme style" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Neutral" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Colored" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Theme color" })).toHaveCount(0);

  await page.getByRole("button", { name: "Colored" }).click();
  const group = page.getByRole("group", { name: "Theme color" });
  await expect(group).toBeVisible();
  const greenSwatch = page.getByRole("button", { name: "Green" });
  await greenSwatch.click();
  await expect(greenSwatch).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("html")).toHaveCSS("--primary", "152 88% 28%");
  await page.getByRole("button", { name: "Neutral" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "geist");
  await expect(page.getByRole("group", { name: "Theme color" })).toHaveCount(0);
});

test("sidebar collapses and expands via toggle button", async ({ authenticatedPage: page, isMobile }) => {
  test.skip(isMobile, "desktop-only sidebar, hidden below the lg breakpoint on mobile");
  await expect(page.getByText("Demo", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Overview", { exact: true })).toBeVisible();
  await expect(page.getByText("Study", { exact: true })).toBeVisible();
  await expect(page.getByText("Utilities", { exact: true })).toBeVisible();
  await expect(page.getByText("System", { exact: true })).toBeVisible();
  await expect(page.getByText(/Powered by Hyeboard/)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("Student command center")).toHaveCount(0);
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(page.getByText("Demo", { exact: true })).toBeHidden();
  await expect(page.getByText(/Powered by Hyeboard/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Utility/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Lookup" })).toHaveCount(0);
  await expect.poll(async () => {
    const logoBox = await page.locator("aside [data-testid='brand-icon']").boundingBox();
    const expandBox = await page.getByRole("button", { name: "Expand sidebar" }).boundingBox();
    if (!logoBox || !expandBox) return false;
    const verticallySeparated = logoBox.y + logoBox.height <= expandBox.y;
    const horizontallyCentered = Math.abs((logoBox.x + logoBox.width / 2) - (expandBox.x + expandBox.width / 2)) <= 1;
    return verticallySeparated && horizontallyCentered;
  }).toBe(true);
  await expect(page.locator(".app-shell")).toHaveCSS("transition-property", /grid-template-columns/);
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await expect(page.getByText("Demo", { exact: true }).first()).toBeVisible();
});

test("Utility accordion forces open on Lookup and persists on desktop", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop-only sidebar, hidden below the lg breakpoint on mobile");
  await page.addInitScript(() => {
    if (localStorage.getItem("hyeboard.utilityOpen") === null) localStorage.setItem("hyeboard.utilityOpen", "false");
  });
  await openMockedLookup(page);

  const utility = page.getByRole("button", { name: "Collapse Utility" });
  const controls = await utility.getAttribute("aria-controls");
  expect(controls).not.toBeNull();
  const lookup = page.locator(`#${controls}`).getByRole("link", { name: "Lookup" });
  await expect(page.locator(`#${controls}`)).toBeVisible();
  await expect(lookup).toHaveAttribute("aria-current", "page");

  await page.goto("/");
  await expect(page.getByRole("button", { name: "Expand Utility" })).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "Expand Utility" }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: "Collapse Utility" })).toHaveAttribute("aria-expanded", "true");
});

test("collapsed desktop sidebar hides lookup-capable Utility navigation", async ({ page }) => {
  await openMockedLookup(page);

  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(page.getByRole("button", { name: /Utility/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Lookup" })).toHaveCount(0);

  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await expect(page.getByRole("button", { name: "Collapse Utility" })).toBeVisible();
});

test("Utility accordion opens Lookup in the mobile navigation drawer", async ({ page }) => {
  await openMockedLookup(page);
  await page.setViewportSize({ width: 500, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open navigation menu" }).click();
  const drawer = page.getByRole("dialog");
  await drawer.getByRole("button", { name: /Utility/ }).click();
  await expect(drawer.getByRole("link", { name: "Lookup" })).toBeVisible();
  await drawer.getByRole("link", { name: "Lookup" }).click();
  await expect(page).toHaveURL(/\/lookup$/);
});

test("mobile nav drawer opens and closes on navigation @webkit", async ({ authenticatedPage: page }) => {
  await page.setViewportSize({ width: 500, height: 900 });
  await page.goto("/settings");
  await page.getByRole("button", { name: "Toggle light and dark mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");
  await expect(page.getByRole("heading", { name: "Navigation" })).toBeHidden();
  await page.getByRole("button", { name: "Open navigation menu" }).click();
  await expect(page.getByRole("heading", { name: "Navigation" })).toBeVisible();
  await expect(page.getByRole("dialog").getByText("Demo", { exact: true })).not.toHaveCSS("color", "rgb(0, 0, 0)");
  await page.getByRole("link", { name: "Timetable" }).click();
  await expect(page).toHaveURL(/\/timetable$/);
  await expect(page.getByRole("heading", { name: "Navigation" })).toBeHidden();
});

test("mobile nav drawer links meet touch target size and restore focus on escape @webkit", async ({ authenticatedPage: page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const trigger = page.getByRole("button", { name: "Open navigation menu" });
  await trigger.click();
  await expect(page.getByRole("heading", { name: "Navigation" })).toBeVisible();

  const links = page.getByRole("dialog").getByRole("link");
  const count = await links.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const box = await links.nth(i).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }

  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Navigation" })).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await expect(page.getByRole("heading", { name: "Navigation" })).toBeVisible();
  await page.getByRole("link", { name: "Timetable" }).click();
  await expect(page).toHaveURL(/\/timetable$/);
  await expect(page.getByRole("heading", { name: "Navigation" })).toBeHidden();
});

test("header search filters and navigates to a page", async ({ authenticatedPage: page }) => {
  const search = page.getByPlaceholder("Search pages...");
  await search.click();
  await search.fill("Grades");
  await expect(page.getByRole("button", { name: "Grades" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/grades$/);
});

test("notifications menu shows dashboard notifications", async ({ authenticatedPage: page }) => {
  const notificationsButton = page.getByRole("button", { name: "Notifications" });
  await notificationsButton.click();
  await expect(page.getByTestId("notifications-trigger")).toHaveCSS("transform", /matrix\(0\.94/);
  await expect(page.getByText("No notifications right now.").or(page.getByRole("menuitem").first())).toBeVisible();
});

test("settings About section shows version and commit information", async ({ authenticatedPage: page }) => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "About" })).toBeVisible();
  await expect(page.getByText("Version")).toBeVisible();
  await expect(page.getByText(/^Commit /)).toBeVisible();
});

test("dashboard, timetable, grades, and login each expose exactly one page heading", async ({ page }) => {
  await page.goto("/login");
  await expect(page.locator("h1")).toHaveCount(1);

  await authenticateDemoPage(page);
  await expect(page.locator("h1")).toHaveCount(1);

  await page.goto("/timetable");
  await expect(page.locator("h1")).toHaveCount(1);

  await page.goto("/grades");
  await expect(page.locator("h1")).toHaveCount(1);
});

test("sidebar nav links have accessible names and move aria-current on navigation", async ({ authenticatedPage: page, isMobile }) => {
  test.skip(isMobile, "desktop-only sidebar, hidden below the lg breakpoint on mobile");
  const dashboardLink = page.getByRole("link", { name: "Dashboard" });
  const timetableLink = page.getByRole("link", { name: "Timetable" });
  const gradesLink = page.getByRole("link", { name: "Grades" });
  await expect(dashboardLink).toHaveAttribute("aria-current", "page");
  await expect(timetableLink).not.toHaveAttribute("aria-current", "page");
  await expect(gradesLink).not.toHaveAttribute("aria-current", "page");

  await timetableLink.click();
  await expect(page).toHaveURL(/\/timetable$/);
  await expect(timetableLink).toHaveAttribute("aria-current", "page");
  await expect(dashboardLink).not.toHaveAttribute("aria-current", "page");
});

test("header search field exposes an accessible name beyond its placeholder", async ({ authenticatedPage: page }) => {
  await expect(page.getByRole("textbox", { name: "Search pages" })).toBeVisible();
});
