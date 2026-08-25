import type { AdminPolicyView, FeaturePolicyAuditEntry, FeaturePolicyContent } from "@hyeboard/schemas";
import { expect, test } from "@playwright/test";

const policy = (...disabled: Array<"grades" | "tuition" | "exams">): FeaturePolicyContent => ({
  global: {
    capabilities: Object.fromEntries(disabled.map((key) => [key, { enabled: false }])),
    limits: {},
  },
  universities: {},
});

const view = (revision: number, content: FeaturePolicyContent): AdminPolicyView => ({
  snapshot: { revision, ...content },
  hardLimits: {},
  nativeUniversities: [],
  effectiveUniversities: [],
});

const entry = (revision: number, baseRevision: number, content: FeaturePolicyContent): FeaturePolicyAuditEntry => ({
  revision,
  baseRevision,
  actor: { method: "password", subject: "operator" },
  reason: `Revision ${revision}`,
  publishedAt: "2026-08-23T12:00:00.000Z",
  snapshot: { revision, ...content },
});

const response = (data: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(status < 400 ? { data, error: null } : { data: null, error: data }),
});

async function mockSession(page: import("@playwright/test").Page) {
  await page.route("**/api/admin/session", (route) => route.fulfill(response({
    authenticated: true,
    actor: { method: "password", subject: "operator" },
    csrfToken: "csrf",
    methods: ["password"],
  })));
}

test("clean draft rebases when a newer admin policy event refreshes the snapshot", async ({ page }) => {
  await mockSession(page);
  let current = view(4, policy());
  let releaseEvent!: () => void;
  const eventReady = new Promise<void>((resolve) => { releaseEvent = resolve; });
  await page.route("**/api/admin/policy", (route) => route.fulfill(response(current)));
  await page.route("**/api/admin/policy/events", async (route) => {
    await eventReady;
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: revision\ndata: 5\n\n" });
  });

  await page.goto("/admin");
  await expect(page.getByRole("switch", { name: "Grades: Available" })).toBeChecked();
  current = view(5, policy("grades"));
  releaseEvent();

  await expect(page.getByRole("switch", { name: "Grades: Available" })).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Review changes" })).toHaveCount(0);
});

test("dirty draft survives a newer admin policy event without silent merging", async ({ page }) => {
  await mockSession(page);
  let current = view(4, policy());
  let releaseEvent!: () => void;
  const eventReady = new Promise<void>((resolve) => { releaseEvent = resolve; });
  await page.route("**/api/admin/policy", (route) => route.fulfill(response(current)));
  await page.route("**/api/admin/policy/events", async (route) => {
    await eventReady;
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: revision\ndata: 5\n\n" });
  });

  await page.goto("/admin");
  await page.getByRole("switch", { name: "Tuition: Available" }).click();
  current = view(5, policy("grades"));
  releaseEvent();

  await expect(page.getByRole("switch", { name: "Tuition: Available" })).not.toBeChecked();
  await expect(page.getByRole("switch", { name: "Grades: Available" })).toBeChecked();
  await expect(page.getByRole("button", { name: "Review changes" })).toBeVisible();
});

test("policy scope tabs implement roving keyboard navigation", async ({ page }) => {
  await mockSession(page);
  const adminView = view(4, policy());
  adminView.nativeUniversities = [{
    id: "uet",
    name: "University of Engineering and Technology",
    shortName: "UET",
    capabilities: {
      profile: true, terms: true, timetable: true, courses: true,
      assignments: false, grades: true, exams: true, attendance: false,
      notifications: true, documents: true, tuition: true, news: true,
      trainingPoints: true, requests: true, classLookup: true, crossLookup: true,
    },
  }];
  await page.route("**/api/admin/policy", (route) => route.fulfill(response(adminView)));
  await page.route("**/api/admin/policy/events", (route) => route.abort());

  await page.goto("/admin");
  const globalTab = page.getByRole("tab", { name: "Global" });
  const uetTab = page.getByRole("tab", { name: "UET" });
  await globalTab.focus();
  await page.keyboard.press("ArrowRight");

  await expect(uetTab).toBeFocused();
  await expect(uetTab).toHaveAttribute("tabindex", "0");
  await expect(globalTab).toHaveAttribute("tabindex", "-1");
  await expect(page.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "admin-policy-tab-uet");

  await page.keyboard.press("Home");
  await expect(globalTab).toBeFocused();
});

test("committed publish uses its response even when an immediate policy refetch fails", async ({ page }) => {
  await mockSession(page);
  let policyReads = 0;
  await page.route("**/api/admin/policy", (route) => {
    policyReads += 1;
    return route.fulfill(policyReads === 1
      ? response(view(4, policy()))
      : response({ code: "INTERNAL_ERROR", message: "Synthetic refetch failure" }, 500));
  });
  await page.route("**/api/admin/policy/publish", (route) => route.fulfill(response(entry(5, 4, policy("grades")))));

  await page.goto("/admin");
  await page.getByRole("switch", { name: "Grades: Available" }).click();
  await page.getByRole("button", { name: "Review changes" }).click();
  await page.getByLabel("Reason").fill("Disable grades");
  await page.getByRole("button", { name: "Publish", exact: true }).click();

  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("Policy could not be published. Draft preserved.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review changes" })).toHaveCount(0);
  expect(policyReads).toBe(1);
});

test("committed rollback uses its response when the async history refresh fails", async ({ page }) => {
  await mockSession(page);
  let policyReads = 0;
  await page.route("**/api/admin/policy", (route) => {
    policyReads += 1;
    return route.fulfill(response(view(5, policy("grades"))));
  });
  let historyReads = 0;
  await page.route("**/api/admin/policy/history?**", (route) => {
    historyReads += 1;
    return route.fulfill(historyReads === 1
      ? response({ items: [entry(4, 0, policy())] })
      : response({ code: "INTERNAL_ERROR", message: "Synthetic history refresh failure" }, 500));
  });
  await page.route("**/api/admin/policy/history/4", (route) => route.fulfill(response(entry(4, 0, policy()))));
  let rollbackWrites = 0;
  await page.route("**/api/admin/policy/rollback", (route) => {
    rollbackWrites += 1;
    return route.fulfill(response(entry(6, 5, policy())));
  });

  await page.goto("/admin/history");
  await expect.poll(() => historyReads).toBe(1);
  await page.getByRole("button", { name: "View revision" }).click();
  await page.getByRole("button", { name: "Roll back" }).click();
  await page.getByLabel("Rollback reason").fill("Restore revision 4");
  await page.getByRole("button", { name: "Roll back" }).click();

  await expect.poll(() => historyReads).toBe(2);
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByRole("heading", { name: "Revision 6" })).toBeVisible();
  await expect(page.getByText("Policy history could not be loaded.")).toHaveCount(0);
  await expect.poll(() => rollbackWrites).toBe(1);
  expect(policyReads).toBe(1);
  await page.waitForTimeout(100);
  expect(historyReads).toBe(2);
  expect(rollbackWrites).toBe(1);
});

test("external revision resets paginated history to the newest page", async ({ page }) => {
  await mockSession(page);
  let current = view(4, policy());
  let firstPage = { items: [entry(4, 3, policy())], nextBeforeRevision: 4 };
  let releaseEvent!: () => void;
  const eventReady = new Promise<void>((resolve) => { releaseEvent = resolve; });
  await page.route("**/api/admin/policy", (route) => route.fulfill(response(current)));
  await page.route("**/api/admin/policy/events", async (route) => {
    await eventReady;
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: revision\ndata: 5\n\n" });
  });
  await page.route("**/api/admin/policy/history?**", (route) => {
    const beforeRevision = new URL(route.request().url()).searchParams.get("beforeRevision");
    return route.fulfill(response(beforeRevision ? { items: [entry(3, 2, policy())] } : firstPage));
  });

  await page.goto("/admin/history");
  await expect(page.getByRole("heading", { name: "Revision 4" })).toBeVisible();
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByRole("heading", { name: "Revision 3" })).toBeVisible();

  current = view(5, policy("grades"));
  firstPage = { items: [entry(5, 4, policy("grades")), entry(4, 3, policy())], nextBeforeRevision: 4 };
  releaseEvent();

  await expect(page.getByRole("heading", { name: "Revision 5" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Revision 3" })).toHaveCount(0);
});

test("history retry recovers a failed revision detail", async ({ page }) => {
  await mockSession(page);
  await page.route("**/api/admin/policy", (route) => route.fulfill(response(view(5, policy("grades")))));
  await page.route("**/api/admin/policy/events", (route) => route.abort());
  await page.route("**/api/admin/policy/history?**", (route) => route.fulfill(response({ items: [entry(4, 0, policy())] })));
  let detailReads = 0;
  await page.route("**/api/admin/policy/history/4", (route) => {
    detailReads += 1;
    return route.fulfill(detailReads === 1
      ? response({ code: "INTERNAL_ERROR", message: "Synthetic detail failure" }, 500)
      : response(entry(4, 0, policy())));
  });

  await page.goto("/admin/history");
  await page.getByRole("button", { name: "View revision" }).click();
  await expect(page.getByText("Policy history could not be loaded.")).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();

  await expect(page.getByRole("heading", { name: "Revision 4" })).toHaveCount(2);
  expect(detailReads).toBe(2);
});

test("history retry recovers a failed base revision", async ({ page }) => {
  await mockSession(page);
  await page.route("**/api/admin/policy", (route) => route.fulfill(response(view(5, policy("grades")))));
  await page.route("**/api/admin/policy/events", (route) => route.abort());
  await page.route("**/api/admin/policy/history?**", (route) => route.fulfill(response({ items: [entry(4, 3, policy("grades"))] })));
  await page.route("**/api/admin/policy/history/4", (route) => route.fulfill(response(entry(4, 3, policy("grades")))));
  let baseReads = 0;
  await page.route("**/api/admin/policy/history/3", (route) => {
    baseReads += 1;
    return route.fulfill(baseReads === 1
      ? response({ code: "INTERNAL_ERROR", message: "Synthetic base failure" }, 500)
      : response(entry(3, 2, policy())));
  });

  await page.goto("/admin/history");
  await page.getByRole("button", { name: "View revision" }).click();
  await expect(page.getByText("Policy history could not be loaded.")).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();

  await expect(page.getByText("Grades")).toBeVisible();
  expect(baseReads).toBe(2);
});

test("rollback conflict preserves its attempted base and shows the intervening published diff", async ({ page }) => {
  await mockSession(page);
  let policyReads = 0;
  await page.route("**/api/admin/policy", (route) => {
    policyReads += 1;
    return route.fulfill(response(policyReads === 1
      ? view(5, policy("grades", "tuition"))
      : view(6, policy("grades", "tuition", "exams"))));
  });
  await page.route("**/api/admin/policy/history?**", (route) => route.fulfill(response({
    items: [entry(4, 0, policy("grades"))],
  })));
  await page.route("**/api/admin/policy/history/4", (route) => route.fulfill(response(entry(4, 0, policy("grades")))));
  await page.route("**/api/admin/policy/rollback", (route) => route.fulfill(response({
    code: "ADMIN_POLICY_CONFLICT",
    message: "Feature policy changed before rollback.",
    details: { currentRevision: 6 },
  }, 409)));

  await page.goto("/admin/history");
  await page.getByRole("button", { name: "View revision" }).click();
  await page.getByRole("button", { name: "Roll back" }).click();
  await page.getByLabel("Rollback reason").fill("Restore revision 4");
  await page.getByRole("button", { name: "Roll back" }).click();

  await expect(page.getByText("Revision 6 was published while this draft was open")).toBeVisible();
  await expect(page.getByText("Intervening published diff")).toBeVisible();
  await expect(page.getByText("Exams")).toBeVisible();
  await expect(page.getByText("Enabled → Disabled").last()).toBeVisible();
  await expect(page.getByText("Base revision: Revision 5")).toBeVisible();
});
