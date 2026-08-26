import { test, expect } from "./fixtures/base";

test("timetable renders a responsive grid on desktop", async ({ authenticatedPage: page }) => {
  await page.clock.setFixedTime(new Date("2026-08-24T08:00:00+07:00"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/timetable");

  await expect(page.getByTestId("desktop-timetable")).toBeVisible();
  await expect(page.getByTestId("mobile-timetable")).toBeHidden();
  await expect(page.getByRole("columnheader", { name: "Sun" })).toHaveCount(0);
  await expect(page.locator('[data-current-day="true"]')).toHaveCount(1);

  await expect(page.getByText("Web Application Development").first()).toBeVisible();
  await expect(page.getByText("G2-301").first()).toBeVisible();
  await expect(page.getByText("Period 4-6").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Open class page" }).first()).toHaveAttribute("href", "https://portal.uet.vnu.edu.vn/courses/5359");
});

test("timetable renders day groups on mobile without overflow @webkit", async ({ authenticatedPage: page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/timetable");

  await expect(page.getByTestId("desktop-timetable")).toBeHidden();
  await expect(page.getByTestId("mobile-timetable")).toBeVisible();
  await expect(page.getByRole("button", { name: "List" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Calendar" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  const mobileSurface = page.getByTestId("mobile-timetable");
  await expect(mobileSurface.getByText("Web Application Development").first()).toBeVisible();
  await expect(mobileSurface.getByText("G2-301").first()).toBeVisible();
  await expect(mobileSurface.getByRole("link", { name: "Open class page" }).first()).toHaveAttribute("href", "https://portal.uet.vnu.edu.vn/courses/5359");
});

test("timetable stays free of horizontal overflow on tablet @webkit", async ({ authenticatedPage: page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto("/timetable");

  await expect(page.getByTestId("mobile-timetable")).toBeVisible();
  await expect(page.getByRole("button", { name: "List" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Calendar" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("feature routes render UI instead of JSON dumps", async ({ authenticatedPage: page }) => {
  test.slow();
  const routes = [
    ["/timetable", "Timetable", "Web Application Development"],
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
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    // Some routes (e.g. Timetable) render the same data in both a desktop-only
    // and a mobile-only surface; `.and(":visible")` picks only the currently
    // rendered one instead of always latching onto the first DOM match, which
    // may be the CSS-hidden counterpart on narrow viewports.
    await expect(page.getByText(text).and(page.locator(":visible")).first()).toBeVisible();
    await expect(page.locator("pre")).toHaveCount(0);
    await expect(page.getByText("active", { exact: true })).toHaveCount(0);
  }

  await page.goto("/documents");
  await expect(page.getByText("Transcript request")).toBeVisible();
  await expect(page.getByRole("link", { name: "Academic calendar update" })).toHaveAttribute("href", "https://uet.edu.vn/academic-calendar-update/");
  await page.getByRole("button", { name: "Toggle News" }).click();
  await expect(page.getByRole("link", { name: "Academic calendar update" })).toBeHidden();

  await page.goto("/courses");
  const coursesSection = page.getByTestId("courses-section");
  await expect(coursesSection).toBeVisible();
  await expect(coursesSection.locator(".section-panel")).toHaveCount(0);
  await expect(page.getByTestId("status-badge").first()).toBeVisible();
  await expect(page.getByRole("link", { name: /Open course page/ }).first()).toHaveAttribute("href", /portal\.uet\.vnu\.edu\.vn\/courses/);

  await page.goto("/assignments");
  const assignmentsSection = page.getByTestId("assignments-section");
  await expect(assignmentsSection).toBeVisible();
  await expect(assignmentsSection.locator(".section-panel")).toHaveCount(0);

  await page.goto("/exams");
  await expect(page.getByRole("button", { name: "Calendar" })).toBeVisible();
  await page.getByRole("button", { name: "Calendar" }).click();
  await expect(page.getByText("Written", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("written", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/07:00 AM/)).toHaveCount(0);
});
