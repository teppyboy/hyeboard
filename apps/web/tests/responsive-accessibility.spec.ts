import { test, expect, authenticateDemoPage, expectNoPageOverflow, REFERENCE_VIEWPORTS } from "./fixtures/base";

for (const viewport of REFERENCE_VIEWPORTS.slice(0, 2)) {
  test(`login, dashboard, timetable, and grades have no horizontal overflow at ${viewport.width}x${viewport.height} @webkit`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/login");
    await expectNoPageOverflow(page);
    await authenticateDemoPage(page);
    await expectNoPageOverflow(page);
    for (const [route, heading] of [
      ["/timetable", "Timetable"],
      ["/grades", "Grades"],
      ["/exams", "Exams"],
      ["/tuition", "Tuition"],
    ] as const) {
      await page.goto(route);
      await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
      await expectNoPageOverflow(page);
    }
  });
}

test("view toggles and key settings actions meet mobile touch target size @webkit", async ({ authenticatedPage: page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  // WebKit at a 3x device pixel ratio can report a CSS 44px target as
  // 43.99998 due to subpixel snapping, so allow a hairline rounding tolerance.
  const MIN_TOUCH_TARGET = 43.9;
  const expectTouchTarget = async (locator: import("@playwright/test").Locator) => {
    await expect(locator).toBeVisible();
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
  };

  await page.goto("/timetable");
  for (const name of ["List", "Calendar"]) {
    await expectTouchTarget(page.getByRole("button", { name, exact: true }));
  }

  await page.goto("/exams");
  for (const name of ["List", "Calendar"]) {
    await expectTouchTarget(page.getByRole("button", { name, exact: true }));
  }
  await expectTouchTarget(page.getByRole("combobox", { name: "Term" }));

  await page.goto("/grades");
  await expectTouchTarget(page.getByTestId("grades-term-select"));

  await page.goto("/settings");
  await expectTouchTarget(page.getByRole("button", { name: "Toggle light and dark mode" }));

  for (const name of ["Neutral", "Colored"]) {
    await expectTouchTarget(page.getByRole("button", { name, exact: true }));
  }

  await expectTouchTarget(page.getByRole("combobox", { name: "Language" }));
  await expectTouchTarget(page.getByRole("button", { name: "Sign out" }));
});

test("exam and tuition tables keep every column reachable on mobile via internal scroll @webkit", async ({ authenticatedPage: page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  for (const route of ["/exams", "/tuition"]) {
    await page.goto(route);
    await expectNoPageOverflow(page);
    const wrapper = page.getByTestId("data-table").first();
    await expect(wrapper).toBeVisible();
    // The table is wider than the phone viewport, so the wrapper must scroll
    // internally (not clip): scrolling to the end reveals the last column.
    await expect.poll(() => wrapper.evaluate((el) => ({
      overflowX: getComputedStyle(el).overflowX,
      isScrollable: el.scrollWidth > el.clientWidth,
    }))).toEqual({ overflowX: "auto", isScrollable: true });
    const lastHeader = wrapper.locator("th").last();
    await wrapper.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await expect(lastHeader).toBeInViewport();
  }
});

test("focus-visible ring remains rendered for interactive controls in light and dark mode", async ({ authenticatedPage: page }) => {
  await page.goto("/settings");
  // A preceding keyboard event keeps the browser's focus-visible input-modality
  // heuristic on "keyboard" so a later programmatic .focus() still renders the
  // focus ring, matching how a real keyboard user would tab to the control.
  await page.keyboard.press("Tab");
  const toggle = page.getByRole("button", { name: "Toggle light and dark mode" });
  await toggle.focus();
  await expect(toggle).toBeFocused();
  const lightShadow = await toggle.evaluate((el) => getComputedStyle(el).boxShadow);
  expect(lightShadow).not.toBe("none");

  await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");
  await page.keyboard.press("Tab");
  const signOut = page.getByRole("button", { name: "Sign out" });
  await signOut.focus();
  await expect(signOut).toBeFocused();
  const darkShadow = await signOut.evaluate((el) => getComputedStyle(el).boxShadow);
  expect(darkShadow).not.toBe("none");
});
