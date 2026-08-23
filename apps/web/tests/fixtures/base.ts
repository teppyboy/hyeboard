import { expect, test as base, type Page } from "@playwright/test";
import { playwrightRuntimeConfig } from "../../src/lib/playwright-runtime-config.mjs";

type DemoAuth = { token: string; session?: { studentCode?: string } };

async function importDemoSession(page: Page): Promise<DemoAuth> {
  const response = await page.request.post(`${playwrightRuntimeConfig.baseUrl}/api/mock/auth/import-session`, { data: {} });
  if (!response.ok()) throw new Error(`Synthetic demo import failed with status ${response.status()}`);
  const payload = await response.json() as { data?: DemoAuth };
  if (!payload.data?.token) throw new Error("Synthetic demo import returned no token");
  return payload.data;
}

export async function authenticateDemoPage(page: Page, destination = "/"): Promise<void> {
  const auth = await importDemoSession(page);
  const account = { id: crypto.randomUUID(), universityId: "mock", token: auth.token, studentCode: auth.session?.studentCode, addedAt: new Date().toISOString() };
  await page.addInitScript((demoAccount) => {
    if (localStorage.getItem("hyeboard.playwrightFixtureReady") === "1") return;
    localStorage.setItem("hyeboard.accounts", JSON.stringify([demoAccount]));
    localStorage.setItem("hyeboard.activeAccountId", demoAccount.id);
    localStorage.setItem("hyeboard.universityId", "mock");
    localStorage.setItem("hyeboard.palette", "geist");
    localStorage.setItem("hyeboard.playwrightFixtureReady", "1");
  }, account);
  await page.goto(destination);
  await expect(page.getByRole("button", { name: "Open account menu" })).toBeVisible();
}

export const test = base.extend<{ authenticatedPage: Page }>({
  authenticatedPage: async ({ page }, use) => {
    await authenticateDemoPage(page);
    await use(page);
  },
});

export { expect };

export async function loginDemoThroughUi(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByRole("combobox", { name: "School" }).click();
  await page.getByRole("option", { name: "Mock" }).click();
  await page.getByRole("button", { name: "Open Demo Workspace" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: /Welcome back, Demo Student/i })).toBeVisible();
}

export async function clickVisibleNavigationLink(
  page: import("@playwright/test").Page,
  href: "/" | "/settings",
  isMobile: boolean,
): Promise<void> {
  if (isMobile) await page.getByRole("button", { name: "Open navigation menu" }).click();
  const link = page.locator(`a[href="${href}"]:visible`);
  await expect(link).toHaveCount(1);
  await link.click();
}

export async function expectInsideViewport(page: import("@playwright/test").Page, locator: import("@playwright/test").Locator): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);
}

export async function expectNoPageOverflow(page: import("@playwright/test").Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
}

export const REFERENCE_VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
] as const;
