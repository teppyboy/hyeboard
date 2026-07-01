import { expect, test } from "@playwright/test";

async function loginDemo(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByRole("combobox", { name: "School" }).click();
  await page.getByRole("option", { name: "Mock" }).click();
  await page.getByRole("button", { name: "Continue with Mock Data" }).click();
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
  await expect(page.getByText("Login with VNU-UET")).toBeVisible();
  await expect(page.getByText("Login with Mock")).toHaveCount(0);
  await expect(page.getByText("1. Get your StudentHub access token")).toBeVisible();
  await expect(page.getByText(/copy\(localStorage\.getItem/)).toBeVisible();
  await expect(page.getByText("accessToken")).toBeVisible();
  await expect(page.getByPlaceholder("StudentHub access token")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue on Canvas" })).toBeVisible();
  await expect(page.getByText("2. Get a Canvas access token")).toBeVisible();
  await expect(page.getByPlaceholder("Canvas access token")).toBeVisible();
  await expect(page.getByPlaceholder("Student code, optional")).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "uet");

  await page.getByRole("combobox", { name: "School" }).click();
  await page.getByRole("option", { name: "Mock" }).click();
  await expect(page.getByRole("combobox", { name: "School" })).toContainText("Mock");
  await expect(page.getByText("Login with Mock")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with Mock Data" })).toBeVisible();
  await expect(page.getByPlaceholder("Student code, optional")).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "geist");
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
  await expect(page.getByRole("menuitem", { name: /Switch account/i })).toBeVisible();
  await page.getByRole("menuitem", { name: /Sign out/i }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("friendly demo login opens dashboard", async ({ page }) => {
  await loginDemo(page);
  await expect(page.getByText("React Router Lab")).toBeVisible();
  await expect(page.getByText("Web Application Development").first()).toBeVisible();
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

test("settings shows a theme color picker only for the VNU-UET palette", async ({ page }) => {
  await loginDemo(page);
  await page.goto("/settings");
  await expect(page.getByRole("group", { name: "Theme color" })).toHaveCount(0);

  await page.evaluate(() => localStorage.setItem("hyeboard.palette", "uet"));
  await page.reload();
  const group = page.getByRole("group", { name: "Theme color" });
  await expect(group).toBeVisible();
  const greenSwatch = page.getByRole("button", { name: "Green" });
  await greenSwatch.click();
  await expect(greenSwatch).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("html")).toHaveCSS("--primary", "152 88% 28%");
});

test("sidebar collapses and expands via toggle button", async ({ page }) => {
  await loginDemo(page);
  await expect(page.getByText("Demo", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(page.getByText("Demo", { exact: true })).toBeHidden();
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
  await expect(page.getByRole("heading", { name: "Navigation" })).toBeHidden();
  await page.getByRole("button", { name: "Open navigation menu" }).click();
  await expect(page.getByRole("heading", { name: "Navigation" })).toBeVisible();
  await page.getByRole("link", { name: "Timetable" }).click();
  await expect(page).toHaveURL(/\/timetable$/);
  await expect(page.getByRole("heading", { name: "Navigation" })).toBeHidden();
});

test("header search filters and navigates to a page", async ({ page }) => {
  await loginDemo(page);
  const search = page.getByPlaceholder("Jump to timetable, grades, exams...");
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
  await expect(page.getByText("No notifications yet.").or(page.getByRole("menuitem").first())).toBeVisible();
});

test("grades merge summer term into term two and show term GPA", async ({ page }) => {
  await loginDemo(page);
  await page.goto("/grades");
  await expect(page.getByText("20242")).toBeVisible();
  await expect(page.getByText("Includes summer term")).toBeVisible();
  await expect(page.getByText("Signals and Systems")).toBeVisible();
  await expect(page.getByText("Term GPA").first()).toBeVisible();
  await expect(page.getByText("3.40")).toBeVisible();
});

test("feature routes render UI instead of JSON dumps", async ({ page }) => {
  await loginDemo(page);
  const routes = [
    ["/timetable", "Timetable", "Linear Algebra"],
    ["/courses", "Courses", "Data Structures and Algorithms"],
    ["/assignments", "Assignments", "Graph traversal quiz"],
    ["/grades", "Grades", "Transcript and GPA summary"],
    ["/exams", "Exams", "Exam schedule"],
    ["/tuition", "Tuition", "Bills, payment progress"],
    ["/documents", "Documents & Services", "Course outline.pdf"],
  ] as const;

  for (const [path, heading, text] of routes) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    await expect(page.getByText(text).first()).toBeVisible();
    await expect(page.locator("pre")).toHaveCount(0);
  }
});
