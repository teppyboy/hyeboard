import { expect, test } from "@playwright/test";

async function loginDemo(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByRole("combobox", { name: "School" }).click();
  await page.getByRole("option", { name: "Mock" }).click();
  await page.getByRole("button", { name: "Open Demo Workspace" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: /Welcome back, Demo Student/i })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/login");
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
});

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

test("login keeps relogin fields after session expiry", async ({ page }) => {
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
  await page.evaluate(() => sessionStorage.removeItem("hyeboard.sessionToken"));
  await page.reload();

  await page.getByRole("combobox", { name: "School" }).click();
  await page.getByRole("option", { name: "VNU (daotao)" }).click();
  await expect(page.getByPlaceholder("Student code / username")).toHaveValue("24000000");
  await expect(page.getByPlaceholder("Password")).toHaveValue("vnu-relogin-password");
});

test("login always shows the correct accent color for the selected school, never a stale one", async ({ page }) => {
  // Simulate a browser that previously had a mock (geist) session persisted,
  // then landed back on /login for VNU-UET - the accent must not stay stale.
  await page.evaluate(() => {
    localStorage.setItem("hyeboard.palette", "geist");
    localStorage.setItem("hyeboard.universityId", "uet");
  });
  await page.goto("/login");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "uet");
});

test("account menu opens and signs out", async ({ page }) => {
  await loginDemo(page);
  const accountButton = page.getByRole("button", { name: "Open account menu" });
  await accountButton.click();
  await expect(page.getByTestId("account-trigger")).toHaveCSS("transform", /matrix\(0\.94/);
  await expect(page.getByRole("menuitem", { name: /Settings/i })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Add account/i })).toBeVisible();
  await page.getByRole("menuitem", { name: /Sign out/i }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("friendly demo login opens dashboard", async ({ page }) => {
  await loginDemo(page);
  await expect(page.getByText("React Router Lab")).toBeVisible();
  await expect(page.getByTestId("brand-icon")).toHaveAttribute("data-university", "mock");
  await expect(page.getByTestId("brand-icon").locator("img")).toHaveCount(0);
  await expect(page.getByText("Web Application Development").first()).toBeVisible();
  await expect(page.getByText("09:50 - 12:30").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Open class page" })).toHaveAttribute("href", "https://portal.uet.vnu.edu.vn/courses/5359");
});

test("light and dark mode toggle changes rendered theme", async ({ page }) => {
  await loginDemo(page);
  await page.goto("/settings");
  await expect(page.locator("html")).toHaveAttribute("data-mode", "light");
  await page.getByRole("button", { name: "Toggle light and dark mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");
  await page.getByRole("button", { name: "Toggle light and dark mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-mode", "light");
});

test("settings can switch between neutral and university theme styles", async ({ page }) => {
  await loginDemo(page);
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

test("sidebar collapses and expands via toggle button", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop-only sidebar, hidden below the lg breakpoint on mobile");
  await loginDemo(page);
  await expect(page.getByText("Demo", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Powered by Hyeboard \(/)).toBeVisible();
  await expect(page.getByText("Student command center")).toHaveCount(0);
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(page.getByText("Demo", { exact: true })).toBeHidden();
  await expect(page.getByText(/Powered by Hyeboard \(/)).toBeHidden();
  await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
  await page.waitForTimeout(350);
  const logoBox = await page.locator("aside [data-testid='brand-icon']").boundingBox();
  const expandBox = await page.getByRole("button", { name: "Expand sidebar" }).boundingBox();
  expect(logoBox).not.toBeNull();
  expect(expandBox).not.toBeNull();
  expect(logoBox!.y + logoBox!.height).toBeLessThanOrEqual(expandBox!.y);
  expect(Math.abs((logoBox!.x + logoBox!.width / 2) - (expandBox!.x + expandBox!.width / 2))).toBeLessThanOrEqual(1);
  await expect(page.locator(".app-shell")).toHaveCSS("transition-property", /grid-template-columns/);
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await expect(page.getByText("Demo", { exact: true }).first()).toBeVisible();
});

test("mobile nav drawer opens and closes on navigation", async ({ page }) => {
  await page.setViewportSize({ width: 500, height: 900 });
  await loginDemo(page);
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

test("header search filters and navigates to a page", async ({ page }) => {
  await loginDemo(page);
  const search = page.getByPlaceholder("Search pages...");
  await search.click();
  await search.fill("Grades");
  await expect(page.getByRole("button", { name: "Grades" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/grades$/);
});

test("notifications menu shows dashboard notifications", async ({ page }) => {
  await loginDemo(page);
  const notificationsButton = page.getByRole("button", { name: "Notifications" });
  await notificationsButton.click();
  await expect(page.getByTestId("notifications-trigger")).toHaveCSS("transform", /matrix\(0\.94/);
  await expect(page.getByText("No notifications right now.").or(page.getByRole("menuitem").first())).toBeVisible();
});

test("grades merge summer term into term two and show term GPA", async ({ page }) => {
  await loginDemo(page);
  await page.goto("/grades");
  await expect(page.getByText("20242")).toBeVisible();
  await expect(page.getByText("Includes summer term")).toBeVisible();
  await expect(page.getByText("Signals and Systems")).toBeVisible();
  await expect(page.getByText("Term GPA").first()).toBeVisible();
  await expect(page.getByText("3.40")).toBeVisible();
  await page.getByRole("button", { name: "Point 10" }).first().click();
  await expect(page.getByRole("columnheader", { name: /Point 10/ }).first()).toHaveAttribute("aria-sort", "ascending");
  await page.getByRole("button", { name: "Point 10" }).first().click();
  await expect(page.getByRole("columnheader", { name: /Point 10/ }).first()).toHaveAttribute("aria-sort", "descending");
});

test("feature routes render UI instead of JSON dumps", async ({ page }) => {
  await loginDemo(page);
  const routes = [
    ["/timetable", "Timetable", "Period 4-6"],
    ["/courses", "Courses", "Data Structures and Algorithms"],
    ["/assignments", "Assignments", "Graph traversal quiz"],
    ["/grades", "Grades", "Academic transcript"],
    ["/exams", "Exams", "Data Structures and Algorithms"],
    ["/tuition", "Tuition", "Early payment credit"],
    ["/documents", "Documents & Services", "Course outline.pdf"],
    ["/training-points", "Training Points", "Semester training points"],
  ] as const;

  for (const [path, heading, text] of routes) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    await expect(page.getByText(text).first()).toBeVisible();
    await expect(page.locator("pre")).toHaveCount(0);
  }

  await page.goto("/documents");
  await expect(page.getByText("Transcript request")).toBeVisible();
  await expect(page.getByRole("link", { name: "Academic calendar update" })).toHaveAttribute("href", "https://uet.edu.vn/academic-calendar-update/");
  await page.getByRole("button", { name: "Toggle News" }).click();
  await expect(page.getByRole("link", { name: "Academic calendar update" })).toBeHidden();

  await page.goto("/courses");
  await expect(page.locator(".bg-primary.transition-all")).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Open course page/ }).first()).toHaveAttribute("href", /portal\.uet\.vnu\.edu\.vn\/courses/);

  await page.goto("/exams");
  await expect(page.getByRole("button", { name: "Calendar" })).toBeVisible();
  await page.getByRole("button", { name: "Calendar" }).click();
  await expect(page.getByText("written")).toBeVisible();
  await expect(page.getByText(/07:00 AM/)).toHaveCount(0);
});
