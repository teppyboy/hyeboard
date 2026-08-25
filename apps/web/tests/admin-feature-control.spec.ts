import type { AdminPolicyView, FeaturePolicyAuditEntry, FeaturePolicyContent, University } from "@hyeboard/schemas";
import type { Page } from "@playwright/test";
import { authenticateDemoPage, expect, expectNoPageOverflow, test } from "./fixtures/base";

const policy = (...disabled: Array<"assignments" | "exams" | "grades" | "tuition">): FeaturePolicyContent => ({
  global: {
    capabilities: Object.fromEntries(disabled.map((key) => [key, { enabled: false }])),
    limits: {},
  },
  universities: {},
});

const mockUniversity: University = {
  id: "mock",
  name: "Mock University",
  shortName: "Mock",
  capabilities: {
    profile: true,
    terms: true,
    timetable: true,
    courses: true,
    assignments: true,
    grades: true,
    exams: true,
    attendance: true,
    notifications: true,
    documents: true,
    tuition: true,
    news: true,
    trainingPoints: true,
    requests: true,
    classLookup: true,
    crossLookup: true,
  },
};

const view = (revision: number, content: FeaturePolicyContent): AdminPolicyView => ({
  snapshot: { revision, ...content },
  hardLimits: {},
  nativeUniversities: [mockUniversity],
  effectiveUniversities: [mockUniversity],
});

const entry = (revision: number, baseRevision: number, content: FeaturePolicyContent, reason: string): FeaturePolicyAuditEntry => ({
  revision,
  baseRevision,
  actor: { method: "password", subject: "operator" },
  reason,
  publishedAt: "2026-08-23T12:00:00.000Z",
  snapshot: { revision, ...content },
});

const response = (data: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(status < 400 ? { data, error: null } : { data: null, error: data }),
});

async function mockAuthenticatedAdmin(page: Page, current: () => AdminPolicyView) {
  await page.route("**/api/admin/session", (route) => route.fulfill(response({
    authenticated: true,
    actor: { method: "password", subject: "operator" },
    csrfToken: "csrf",
    methods: ["password", "github", "discord"],
  })));
  await page.route("**/api/admin/policy", (route) => route.fulfill(response(current())));
  await page.route("**/api/admin/policy/events", (route) => route.abort());
}

test("admin redirect and password login keep student storage separate and expose server OAuth endpoints", async ({ page }) => {
  let authenticated = false;
  let loginBody: unknown;
  await page.addInitScript(() => {
    localStorage.setItem("hyeboard.accounts", JSON.stringify([{ id: "student", universityId: "mock", token: "student-token", addedAt: "2026-08-23T00:00:00.000Z" }]));
    localStorage.setItem("hyeboard.activeAccountId", "student");
    sessionStorage.setItem("hyeboard.relogin.vnu.username", "student-secret-marker");
  });
  await page.route("**/api/admin/session", (route) => route.fulfill(response(authenticated ? {
    authenticated: true,
    actor: { method: "password", subject: "operator" },
    csrfToken: "csrf",
    methods: ["password", "github", "discord"],
  } : { authenticated: false, methods: ["password", "github", "discord"] })));
  await page.route("**/api/admin/login/password", async (route) => {
    loginBody = route.request().postDataJSON();
    authenticated = true;
    await route.fulfill(response({
      authenticated: true,
      actor: { method: "password", subject: "operator" },
      csrfToken: "csrf",
      methods: ["password", "github", "discord"],
    }));
  });
  await page.route("**/api/admin/policy", (route) => route.fulfill(response(view(1, policy()))));
  await page.route("**/api/admin/policy/events", (route) => route.abort());

  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login$/);
  await expect(page.getByRole("heading", { name: "Admin sign-in" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Continue with GitHub" })).toHaveAttribute("href", "/api/admin/oauth/github/start?returnPath=%2Fadmin");
  await expect(page.getByRole("link", { name: "Continue with Discord" })).toHaveAttribute("href", "/api/admin/oauth/discord/start?returnPath=%2Fadmin");

  await page.getByLabel("Password").fill("synthetic-admin-password");
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await expect(page).toHaveURL(/\/admin\/?$/);
  await expect(page.getByRole("heading", { name: "Feature control" })).toBeVisible();
  expect(loginBody).toEqual({ password: "synthetic-admin-password" });
  expect(await page.evaluate(() => ({
    accounts: localStorage.getItem("hyeboard.accounts"),
    activeAccountId: localStorage.getItem("hyeboard.activeAccountId"),
    studentSecret: sessionStorage.getItem("hyeboard.relogin.vnu.username"),
    adminStorageKeys: [...Object.keys(localStorage), ...Object.keys(sessionStorage)].filter((key) => key.toLowerCase().includes("admin")),
  }))).toEqual({
    accounts: JSON.stringify([{ id: "student", universityId: "mock", token: "student-token", addedAt: "2026-08-23T00:00:00.000Z" }]),
    activeAccountId: "student",
    studentSecret: "student-secret-marker",
    adminStorageKeys: [],
  });
});

test("admin publishes an exact diff and preserves a stale draft on conflict", async ({ page }) => {
  let current = view(1, policy());
  const writes: unknown[] = [];
  await mockAuthenticatedAdmin(page, () => current);
  await page.route("**/api/admin/policy/publish", async (route) => {
    const body = route.request().postDataJSON() as { baseRevision: number; policy: FeaturePolicyContent; reason: string };
    writes.push(body);
    if (writes.length === 1) {
      current = view(2, body.policy);
      return route.fulfill(response(entry(2, 1, body.policy, body.reason)));
    }
    current = view(3, policy("exams", "grades"));
    return route.fulfill(response({
      code: "ADMIN_POLICY_CONFLICT",
      message: "Feature policy changed before publication.",
      details: { currentRevision: 3 },
    }, 409));
  });

  await page.goto("/admin");
  await page.getByRole("switch", { name: "Grades: Available" }).click();
  await page.getByRole("button", { name: "Review changes" }).click();
  await expect(page.getByRole("dialog").getByText("Grades")).toBeVisible();
  await expect(page.getByText("Enabled → Disabled")).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeDisabled();
  await page.getByLabel("Reason").fill("Disable grades during maintenance");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByRole("button", { name: "Review changes" })).toHaveCount(0);

  await page.getByRole("switch", { name: "Tuition: Available" }).click();
  await page.getByRole("button", { name: "Review changes" }).click();
  await page.getByLabel("Reason").fill("Disable tuition temporarily");
  await page.getByRole("button", { name: "Publish", exact: true }).click();

  await expect(page.getByText("Revision 3 was published while this draft was open")).toBeVisible();
  await expect(page.getByText("Draft preserved. Review the intervening revision; changes were not merged.")).toBeVisible();
  await expect(page.getByText("Intervening published diff")).toBeVisible();
  const stagedTuition = page.getByRole("dialog").getByRole("listitem").filter({ hasText: "Tuition" });
  await expect(stagedTuition).toBeVisible();
  await expect(stagedTuition).toContainText("Enabled → Disabled");
  await expect(page.getByLabel("Reason")).toHaveValue("Disable tuition temporarily");
  expect(writes).toEqual([
    { baseRevision: 1, policy: policy("grades"), reason: "Disable grades during maintenance" },
    { baseRevision: 2, policy: policy("grades", "tuition"), reason: "Disable tuition temporarily" },
  ]);
});

test("admin history rolls revision 1 back as revision 3", async ({ page }) => {
  let current = view(2, policy("grades"));
  const revision1 = entry(1, 0, policy(), "Initial policy");
  let rollbackBody: unknown;
  let published: FeaturePolicyAuditEntry | undefined;
  await mockAuthenticatedAdmin(page, () => current);
  await page.route("**/api/admin/policy/history?**", (route) => route.fulfill(response({ items: published ? [published, entry(2, 1, policy("grades"), "Disable grades"), revision1] : [entry(2, 1, policy("grades"), "Disable grades"), revision1] })));
  await page.route("**/api/admin/policy/history/1", (route) => route.fulfill(response(revision1)));
  await page.route("**/api/admin/policy/rollback", async (route) => {
    rollbackBody = route.request().postDataJSON();
    published = entry(3, 2, policy(), "Restore revision 1");
    current = view(3, policy());
    await route.fulfill(response(published));
  });

  await page.goto("/admin/history");
  await page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Revision 1" }) }).getByRole("button", { name: "View revision" }).click();
  await expect(page.getByRole("heading", { name: "Revision detail: Revision 1" })).toBeVisible();
  await page.getByRole("button", { name: "Roll back" }).click();
  await page.getByLabel("Rollback reason").fill("Restore revision 1");
  await page.getByRole("button", { name: "Roll back" }).click();

  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByRole("heading", { name: "Revision 3" })).toBeVisible();
  expect(rollbackBody).toEqual({ baseRevision: 2, targetRevision: 1, reason: "Restore revision 1" });
});

test("student policy revision removes disabled UI without clearing the student session", async ({ page }) => {
  let universityReads = 0;
  let releaseRevision!: () => void;
  const revisionReleased = new Promise<void>((resolve) => { releaseRevision = resolve; });
  await page.route("**/api/universities", (route) => {
    universityReads += 1;
    const university = universityReads === 1 ? mockUniversity : {
      ...mockUniversity,
      capabilities: { ...mockUniversity.capabilities, assignments: false, grades: false },
    };
    return route.fulfill(response([university]));
  });
  await page.route("**/api/policy/events", async (route) => {
    await revisionReleased;
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: revision\ndata: 2\n\n" });
  });
  await authenticateDemoPage(page);
  const storedAccount = await page.evaluate(() => ({
    accounts: localStorage.getItem("hyeboard.accounts"),
    activeAccountId: localStorage.getItem("hyeboard.activeAccountId"),
  }));
  await expect(page.getByRole("link", { name: "Grades" })).toBeVisible();
  await expect(page.getByTestId("dashboard-assignments")).toBeVisible();

  releaseRevision();

  await expect.poll(() => universityReads).toBeGreaterThan(1);
  await expect(page.getByRole("link", { name: "Grades" })).toHaveCount(0);
  await expect(page.getByTestId("dashboard-assignments")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open account menu" })).toBeVisible();
  expect(await page.evaluate(() => ({
    accounts: localStorage.getItem("hyeboard.accounts"),
    activeAccountId: localStorage.getItem("hyeboard.activeAccountId"),
  }))).toEqual(storedAccount);
});

for (const { name, viewport, mobile } of [
  { name: "desktop", viewport: { width: 1440, height: 900 }, mobile: false },
  { name: "mobile @webkit", viewport: { width: 390, height: 844 }, mobile: true },
]) {
  test(`admin control is accessible without page overflow on ${name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mockAuthenticatedAdmin(page, () => view(1, policy()));
    await page.goto("/admin");

    await expectNoPageOverflow(page);
    await expect(page.getByRole("navigation", { name: "Admin navigation" })).toBeVisible();
    await expect(page.getByRole("searchbox", { name: "Search capabilities and limits" })).toBeVisible();
    const grades = page.getByRole("switch", { name: "Grades: Available" });
    await grades.focus();
    await page.keyboard.press("Space");
    await expect(grades).not.toBeChecked();
    const review = page.getByRole("button", { name: "Review changes" });
    await review.focus();
    await page.keyboard.press("Enter");

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("h2", { hasText: "Review policy changes" }).last()).toBeVisible();
    await expect(page.getByLabel("Reason")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Publish", exact: true })).toBeVisible();
    await expectNoPageOverflow(page);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    if (mobile) {
      for (const locator of [grades, review, page.getByRole("link", { name: "Feature control" })]) {
        const box = await locator.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.width).toBeGreaterThanOrEqual(43.9);
        expect(box!.height).toBeGreaterThanOrEqual(43.9);
      }
    }
  });
}
