# University Dashboard Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure and redesign Hyeboard into a responsive, accessible institutional university portal while preserving every existing route, data flow, session behavior, theme, locale, and feature capability.

**Architecture:** First extract the monolithic app into state, router, layout, shared UI, and route-owned page modules without behavioral changes. Then add presentation-only status and term formatters, redesign the shell, Dashboard, and Timetable, and apply the same flat-list and human-readable-data language to remaining pages. Keep API values unchanged; localization and normalization happen only at render boundaries.

**Tech Stack:** React 19, TypeScript 6, Vite 8, TanStack Router and Query, Tailwind CSS v4, local Radix/shadcn-style primitives, Lucide, Vitest, Playwright.

**Design spec:** `docs/superpowers/specs/2026-07-13-university-dashboard-redesign.md`

---

## File Map

### New files

- `apps/web/src/router.tsx`: TanStack route tree, auth guard, router registration.
- `apps/web/src/state.tsx`: Hyeboard context, session/account/theme state, feature-query helper.
- `apps/web/src/components/layout.tsx`: desktop shell, grouped sidebar, mobile drawer, search, notifications, account menu.
- `apps/web/src/components/shared.tsx`: cross-page page header, section shell, summary strip, status badge, flat rows, tables, loading/empty/error states.
- `apps/web/src/pages/dashboard.tsx`: Dashboard rendering and dashboard-specific skeleton.
- `apps/web/src/pages/timetable.tsx`: calendar/list modes, desktop week grid, mobile day-grouped schedule.
- `apps/web/src/pages/courses.tsx`: course route and course list rendering.
- `apps/web/src/pages/assignments.tsx`: assignment route and assignment list rendering.
- `apps/web/src/pages/grades.tsx`: grade grouping, summaries, sorting, table.
- `apps/web/src/pages/exams.tsx`: exam term selection and list/calendar views.
- `apps/web/src/pages/tuition.tsx`: bill grouping, totals, table.
- `apps/web/src/pages/documents.tsx`: document/news/request queries, search, capability panels.
- `apps/web/src/pages/training-points.tsx`: training-point route and rows.
- `apps/web/src/pages/settings.tsx`: display, locale, account, and About settings.
- `apps/web/src/pages/login.tsx`: all existing login/import/CAPTCHA flows and visible field labels.
- `apps/web/src/lib/presentation.ts`: status and verified UET term formatting only.
- `apps/web/src/lib/presentation.test.ts`: formatter unit tests.

### Modified files

- `apps/web/src/main.tsx`: reduce to provider/bootstrap composition.
- `apps/web/src/lib/i18n.tsx`: add nav groups, statuses, terms, field labels, About/build copy.
- `apps/web/src/styles.css`: semantic status tokens and institutional shell/page/timetable styles; remove gradient login background and obsolete metric/card treatments.
- `apps/web/tests/smoke.spec.ts`: preserve behavior coverage and add shell, Dashboard, Timetable, localization, responsive, and accessibility assertions.

### Unchanged boundaries

- `apps/web/src/components/ui/*`: retain low-level primitives.
- `apps/web/src/lib/api.ts`: no API/session contract changes.
- `packages/schemas/*`: no schema changes.
- `packages/university-adapters/*`: no adapter or capability changes.

## Dependency Rules

```text
main.tsx -> router.tsx -> layout.tsx + pages/*
main.tsx -> state.tsx
layout.tsx + pages/* -> state.tsx + shared.tsx + lib/*
shared.tsx -> components/ui/* + lib/* + schemas
```

- `state.tsx`, `layout.tsx`, `shared.tsx`, and pages must never import `main.tsx` or `router.tsx`.
- `router.tsx` is the only module importing all route pages.
- Page-specific helpers stay with their page unless two real consumers exist.
- Provider order remains Query Client -> Locale -> Hyeboard -> Router.

---

### Task 1: Add Presentation Formatters and Translation Contracts

**Files:**
- Create: `apps/web/src/lib/presentation.ts`
- Create: `apps/web/src/lib/presentation.test.ts`
- Modify: `apps/web/src/lib/i18n.tsx`

- [ ] **Step 1: Write failing formatter tests**

Create `apps/web/src/lib/presentation.test.ts` with direct label objects so utility tests do not need React context:

```ts
import { describe, expect, it } from "vitest";
import { formatStatus, formatTermLabel } from "./presentation";

const statusLabels = {
  notStarted: "Not started",
  inProgress: "In progress",
  missing: "Missing",
  submitted: "Submitted",
  graded: "Graded",
  late: "Late",
  active: "Active",
  completed: "Completed",
  upcoming: "Upcoming",
  paid: "Paid",
  unpaid: "Unpaid",
  partial: "Partially paid",
  credit: "Credit",
  available: "Available",
};

const termLabels = {
  semester: (semester: number, academicYear: string) => `Semester ${semester}, ${academicYear}`,
  summer: (academicYear: string) => `Summer semester, ${academicYear}`,
};

describe("formatStatus", () => {
  it.each([
    ["not_started", "Not started", "neutral"],
    ["in_progress", "In progress", "warning"],
    ["missing", "Missing", "danger"],
    ["submitted", "Submitted", "success"],
    ["graded", "Graded", "success"],
    ["late", "Late", "warning"],
    ["active", "Active", "accent"],
    ["completed", "Completed", "success"],
    ["upcoming", "Upcoming", "neutral"],
    ["paid", "Paid", "success"],
    ["unpaid", "Unpaid", "danger"],
    ["partial", "Partially paid", "warning"],
    ["credit", "Credit", "neutral"],
    ["available", "Available", "neutral"],
  ] as const)("maps %s", (value, label, tone) => {
    expect(formatStatus(value, statusLabels)).toEqual({ label, tone });
  });

  it.each([
    ["awaiting_department_review", "Awaiting department review"],
    ["ON-HOLD", "On hold"],
    ["custom status", "Custom status"],
  ])("keeps unknown status readable", (value, label) => {
    expect(formatStatus(value, statusLabels)).toEqual({ label, tone: "neutral" });
  });

  it("uses a deterministic empty fallback", () => {
    expect(formatStatus(undefined, statusLabels)).toEqual({ label: "-", tone: "neutral" });
  });
});

describe("formatTermLabel", () => {
  it.each([
    ["20251", "uet", "Semester 1, 2025–2026"],
    ["20252", "uet", "Semester 2, 2025–2026"],
    ["20253", "uet", "Summer semester, 2025–2026"],
    ["20242", "mock", "Semester 2, 2024–2025"],
  ])("formats verified term %s", (value, universityId, expected) => {
    expect(formatTermLabel(value, universityId, termLabels)).toBe(expected);
  });

  it.each([
    ["20251", "vnu"],
    ["20254", "uet"],
    ["2025", "uet"],
    ["abc", "uet"],
    ["", "uet"],
  ])("preserves unverified term %s", (value, universityId) => {
    expect(formatTermLabel(value, universityId, termLabels)).toBe(value);
  });
});
```

- [ ] **Step 2: Run tests and confirm missing-module failure**

Run: `pnpm --filter @hyeboard/web exec vitest run src/lib/presentation.test.ts`

Expected: FAIL because `./presentation` does not exist.

- [ ] **Step 3: Implement the presentation utility**

Create `apps/web/src/lib/presentation.ts`:

```ts
export type StatusTone = "neutral" | "accent" | "success" | "warning" | "danger";

export type StatusLabels = {
  notStarted: string;
  inProgress: string;
  missing: string;
  submitted: string;
  graded: string;
  late: string;
  active: string;
  completed: string;
  upcoming: string;
  paid: string;
  unpaid: string;
  partial: string;
  credit: string;
  available: string;
};

export type TermLabels = {
  semester: (semester: number, academicYear: string) => string;
  summer: (academicYear: string) => string;
};

const knownStatuses: Record<keyof StatusLabels, { value: string; tone: StatusTone }> = {
  notStarted: { value: "not_started", tone: "neutral" },
  inProgress: { value: "in_progress", tone: "warning" },
  missing: { value: "missing", tone: "danger" },
  submitted: { value: "submitted", tone: "success" },
  graded: { value: "graded", tone: "success" },
  late: { value: "late", tone: "warning" },
  active: { value: "active", tone: "accent" },
  completed: { value: "completed", tone: "success" },
  upcoming: { value: "upcoming", tone: "neutral" },
  paid: { value: "paid", tone: "success" },
  unpaid: { value: "unpaid", tone: "danger" },
  partial: { value: "partial", tone: "warning" },
  credit: { value: "credit", tone: "neutral" },
  available: { value: "available", tone: "neutral" },
};

export function formatStatus(value: string | null | undefined, labels: StatusLabels) {
  if (!value) return { label: "-", tone: "neutral" as const };

  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  for (const [key, status] of Object.entries(knownStatuses) as Array<
    [keyof StatusLabels, { value: string; tone: StatusTone }]
  >) {
    if (status.value === normalized) return { label: labels[key], tone: status.tone };
  }

  const readable = normalized.replace(/_+/g, " ");
  return {
    label: readable.charAt(0).toUpperCase() + readable.slice(1),
    tone: "neutral" as const,
  };
}

export function formatTermLabel(value: string, universityId: string, labels: TermLabels) {
  if (universityId !== "uet" && universityId !== "mock") return value;
  const match = /^(\d{4})([123])$/.exec(value);
  if (!match) return value;

  const startYear = Number(match[1]);
  const academicYear = `${startYear}–${startYear + 1}`;
  const semester = Number(match[2]);
  return semester === 3 ? labels.summer(academicYear) : labels.semester(semester, academicYear);
}
```

- [ ] **Step 4: Add matching English and Vietnamese dictionary branches**

Add these branches at the same object level as `nav`, `grades`, and `settings` in both dictionaries in `apps/web/src/lib/i18n.tsx`:

```ts
status: {
  notStarted: "Not started",
  inProgress: "In progress",
  missing: "Missing",
  submitted: "Submitted",
  graded: "Graded",
  late: "Late",
  active: "Active",
  completed: "Completed",
  upcoming: "Upcoming",
  paid: "Paid",
  unpaid: "Unpaid",
  partial: "Partially paid",
  credit: "Credit",
  available: "Available",
},
terms: {
  semester: (semester: number, academicYear: string) => `Semester ${semester}, ${academicYear}`,
  summer: (academicYear: string) => `Summer semester, ${academicYear}`,
},
```

Vietnamese branch:

```ts
status: {
  notStarted: "Chưa bắt đầu",
  inProgress: "Đang thực hiện",
  missing: "Còn thiếu",
  submitted: "Đã nộp",
  graded: "Đã chấm điểm",
  late: "Nộp muộn",
  active: "Đang hoạt động",
  completed: "Đã hoàn thành",
  upcoming: "Sắp tới",
  paid: "Đã thanh toán",
  unpaid: "Chưa thanh toán",
  partial: "Đã thanh toán một phần",
  credit: "Khoản tín dụng",
  available: "Khả dụng",
},
terms: {
  semester: (semester: number, academicYear: string) => `Học kỳ ${semester}, ${academicYear}`,
  summer: (academicYear: string) => `Học kỳ hè, ${academicYear}`,
},
```

- [ ] **Step 5: Run unit tests and typecheck**

Run:

```bash
pnpm --filter @hyeboard/web exec vitest run src/lib/presentation.test.ts
pnpm --filter @hyeboard/web typecheck
```

Expected: formatter tests PASS and TypeScript reports no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/presentation.ts apps/web/src/lib/presentation.test.ts apps/web/src/lib/i18n.tsx
git commit -m "feat(web): add localized data formatters"
```

---

### Task 2: Extract Application State Without Behavior Changes

**Files:**
- Create: `apps/web/src/state.tsx`
- Modify: `apps/web/src/main.tsx`

- [ ] **Step 1: Record the state behavior baseline**

Run:

```bash
pnpm --filter @hyeboard/web typecheck
pnpm --filter @hyeboard/web exec playwright test tests/smoke.spec.ts --project=chromium --grep "demo login|account menu|theme"
```

Expected: current state/account/theme tests PASS before extraction.

- [ ] **Step 2: Move the complete state block into `state.tsx`**

Move these declarations from `main.tsx` together, preserving bodies and query keys:

```ts
export type Palette = "geist" | "uet" | "vnu";
export type Mode = "light" | "dark";
export type HyeboardState = ReturnType<typeof useHyeboardState>;
export function useHyeboard(): HyeboardState;
export function HyeboardProvider({ children }: { children: ReactNode });
export const RELOGIN_KEYS: {
  readonly uetCanvasToken: string;
  readonly vnuUsername: string;
  readonly vnuPassword: string;
};
export function sessionStored(key: string): string;
export function setSessionStored(key: string, value: string): void;
export function useFeatureQuery<T>(
  name: string,
  queryFn: () => Promise<T>,
  options?: { enabled?: boolean },
);
```

Also move private declarations `HyeboardContext`, `stored`, `clearReloginSecrets`, `THEME_OVERRIDE_PROPS`, `applyAccentHue`, `clearAccentOverride`, and `useHyeboardState`.

Inside `useHyeboardState`, replace the closed-over bootstrap client with React Query context:

```ts
const queryClient = useQueryClient();
```

Do not alter:

- query keys, including `sessionNonce`, `universityId`, and `termCode`;
- localStorage keys;
- account switching and logout ordering;
- theme dataset/style updates;
- session-clear behavior.

- [ ] **Step 3: Import state exports back into `main.tsx`**

Use explicit imports while the rest of the app remains monolithic:

```ts
import {
  HyeboardProvider,
  RELOGIN_KEYS,
  sessionStored,
  setSessionStored,
  useFeatureQuery,
  useHyeboard,
} from "@/state";
```

Keep `queryClient` construction in `main.tsx`; only `HyeboardProvider` moves.

- [ ] **Step 4: Verify extraction**

Run:

```bash
pnpm --filter @hyeboard/web typecheck
pnpm --filter @hyeboard/web exec playwright test tests/smoke.spec.ts --project=chromium --grep "demo login|account menu|theme"
```

Expected: no type errors; selected behavior tests PASS unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/state.tsx apps/web/src/main.tsx
git commit -m "refactor(web): extract application state"
```

---

### Task 3: Extract Shared Components and Route Pages

**Files:**
- Create: `apps/web/src/components/shared.tsx`
- Create: all `apps/web/src/pages/*.tsx` files listed in File Map
- Modify: `apps/web/src/main.tsx`

- [ ] **Step 1: Extract cross-page helpers and components**

Move these exact responsibilities to `components/shared.tsx` and export them:

```ts
export function universityLogoUrl(universityId: string): string | undefined;
export function safeExternalUrl(value?: string): string | undefined;
export function FeatureFrame<T>(props: FeatureFrameProps<T>): JSX.Element;
export function FeatureHeader(props: { title: string; description: string; actions?: ReactNode }): JSX.Element;
export function Metric(props: MetricProps): JSX.Element;
export function ScheduleItem(props: { item: ClassSession }): JSX.Element;
export function AssignmentItem(props: { item: Assignment }): JSX.Element;
export function CourseRow(props: { course: Course }): JSX.Element;
export function FeedItem(props: FeedItemProps): JSX.Element;
export function DataTable(props: { headers: string[]; rows: ReactNode[][]; emptyText?: string }): JSX.Element;
export function QueryErrorPanel(props: { error: Error }): JSX.Element;
export function Empty(props: { text: string }): JSX.Element;
export function PageSkeleton(): JSX.Element;
```

Keep `LoginNeeded`, `CanvasRequired`, and `NotSupported` private to the shared module. Rename `CourseCard` to `CourseRow` immediately, but preserve its current markup until the visual task. Keep `DashboardSkeleton` with Dashboard because it has one consumer.

- [ ] **Step 2: Extract low-coupling pages with page-local helpers**

Move declarations in this order and export only each page component:

1. `training-points.tsx`: `TrainingPointsPage`, `TrainingPointRow`.
2. `assignments.tsx`: `AssignmentsPage`.
3. `courses.tsx`: `CoursesPage`.
4. `tuition.tsx`: `TuitionPage`.
5. `exams.tsx`: `ExamsPage`, `examDateKey`, `examTime`, `formatDateOnly`, `ExamList`, `ExamCalendar`.
6. `grades.tsx`: `gradeTermKey`, `usesUetTermRules`, `summarizeGrades`, sort types/helpers, `GradesPage`, `GradeTable`.
7. `documents.tsx`: `DocumentsPage`, `UnsupportedPanel`, `MiniPanel`, `DocumentRow`, `RequestRow`.

After each pair of files, run `pnpm --filter @hyeboard/web typecheck`. Expected: PASS before moving the next group.

- [ ] **Step 3: Extract Timetable and Dashboard as complete declaration groups**

Move to `pages/timetable.tsx`:

- `weekdays`, `periodBlocks`;
- `TimetablePage`, `ViewToggle`, `sessionsForBlock`;
- `TimetableCalendar`, `TimetableList`, `CalendarSessionCard`.

Move to `pages/dashboard.tsx`:

- `DashboardPage`;
- `DashboardSkeleton`.

Do not redesign markup in this step. Update imports to use `@/state` and `@/components/shared`.

- [ ] **Step 4: Extract Login and Settings without refactoring handlers**

Move to `pages/login.tsx` as one block:

- `FlagIcon`;
- `AUTOMATION_FAILURE_CODES`;
- `humanizeUetLoginError`;
- complete `LoginPage`, including all nested async handlers, refs, abort listeners, CAPTCHA resolver state, and language toggle.

Move to `pages/settings.tsx`:

- `declare const __HYEB_GIT_COMMIT__: string`;
- `THEME_HUE_PRESETS`;
- `SettingsPage`.

Do not alter login request ordering, fallback behavior, or credential field types.

- [ ] **Step 5: Verify all extracted pages render**

Run:

```bash
pnpm --filter @hyeboard/web typecheck
pnpm --filter @hyeboard/web exec playwright test tests/smoke.spec.ts --project=chromium --grep "feature routes|school picker|demo login"
```

Expected: every route test still passes; no raw `<pre>` appears.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/shared.tsx apps/web/src/pages apps/web/src/main.tsx
git commit -m "refactor(web): extract route pages and shared UI"
```

---

### Task 4: Extract Layout and Router; Reduce Bootstrap

**Files:**
- Create: `apps/web/src/components/layout.tsx`
- Create: `apps/web/src/router.tsx`
- Modify: `apps/web/src/main.tsx`

- [ ] **Step 1: Extract the existing shell unchanged**

Move `nav`, `SidebarNav`, `SidebarFooter`, `BrandMark`, `RootLayout`, `NavSearch`, `NotificationsMenu`, `accountLabel`, `AccountMenu`, and `NavLink` into `components/layout.tsx`. Export only:

```ts
export function RootLayout(): JSX.Element;
```

Keep capability filtering, synthetic `documentsHub` visibility, session-clear redirect listener, drawer behavior, and all accessible labels unchanged.

- [ ] **Step 2: Extract route construction**

Move the complete route tree and module augmentation to `router.tsx`. Preserve paths and auth guard exactly:

```ts
export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
```

The app route `beforeLoad` must continue checking `getSessionToken()` and redirecting to `/login` before rendering `RootLayout`.

- [ ] **Step 3: Replace `main.tsx` with bootstrap-only composition**

Final `main.tsx`:

```tsx
import "./styles.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "@/components/ui/sonner";
import { LocaleProvider } from "@/lib/i18n";
import { router } from "@/router";
import { HyeboardProvider } from "@/state";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 60_000, retry: 1 } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <LocaleProvider>
        <HyeboardProvider>
          <RouterProvider router={router} />
          <Toaster />
        </HyeboardProvider>
      </LocaleProvider>
    </QueryClientProvider>
  </StrictMode>,
);
```

- [ ] **Step 4: Run complete pre-redesign regression suite**

Run:

```bash
pnpm --filter @hyeboard/web test
pnpm --filter @hyeboard/web exec playwright test
```

Expected: all existing unit and smoke tests PASS after file movement.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/main.tsx apps/web/src/router.tsx apps/web/src/components/layout.tsx
git commit -m "refactor(web): isolate layout and router"
```

---

### Task 5: Build Institutional Shell and Grouped Navigation

**Files:**
- Modify: `apps/web/src/components/layout.tsx`
- Modify: `apps/web/src/lib/i18n.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/tests/smoke.spec.ts`

- [ ] **Step 1: Add failing grouped-navigation tests**

Extend the authenticated desktop/mobile smoke coverage with semantic checks:

```ts
await expect(page.getByText("Overview", { exact: true })).toBeVisible();
await expect(page.getByText("Study", { exact: true })).toBeVisible();
await expect(page.getByText("Services", { exact: true })).toBeVisible();
await expect(page.getByText("System", { exact: true })).toBeVisible();
await expect(page.getByText(/Powered by Hyeboard/)).toHaveCount(0);
await expect(page.getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");
```

At viewport `390x844`, open the drawer and assert each visible navigation link has a bounding-box height of at least 44px, route navigation closes the drawer, and `Escape` returns focus to the menu trigger.

- [ ] **Step 2: Run shell tests and confirm failure**

Run: `pnpm --filter @hyeboard/web exec playwright test tests/smoke.spec.ts --project=chromium --grep "sidebar|mobile navigation"`

Expected: FAIL because group labels/ARIA state do not exist and commit text remains.

- [ ] **Step 3: Add localized group labels**

Extend both `nav` dictionaries:

```ts
groups: {
  overview: "Overview",
  study: "Study",
  services: "Services",
  system: "System",
},
```

Vietnamese:

```ts
groups: {
  overview: "Tổng quan",
  study: "Học tập",
  services: "Dịch vụ",
  system: "Hệ thống",
},
```

- [ ] **Step 4: Replace the flat nav model with grouped route data**

Use this shape in `layout.tsx`:

```ts
const navGroups = [
  { key: "overview", items: [{ key: "dashboard", to: "/", icon: LayoutDashboard }] },
  {
    key: "study",
    items: [
      { key: "timetable", to: "/timetable", icon: CalendarDays },
      { key: "courses", to: "/courses", icon: BookOpen },
      { key: "assignments", to: "/assignments", icon: ListChecks },
      { key: "grades", to: "/grades", icon: GraduationCap },
      { key: "exams", to: "/exams", icon: ClipboardCheck },
    ],
  },
  {
    key: "services",
    items: [
      { key: "tuition", to: "/tuition", icon: WalletCards },
      { key: "documents", to: "/documents", icon: Files },
      { key: "trainingPoints", to: "/training-points", icon: Award },
    ],
  },
  { key: "system", items: [{ key: "settings", to: "/settings", icon: Settings }] },
] as const;
```

Apply capability filtering per item. Build search results by flattening visible group items, not by iterating `t.nav`, because `t.nav.groups` is now nested.

- [ ] **Step 5: Implement the compact shell**

Render group labels only when expanded, remove `SidebarFooter`, retain university identity, and set active links through TanStack Router's active props with `aria-current="page"`. Keep search functionality but reduce its desktop width; preserve keyboard focus and no-results state. Use 44px minimum targets in the mobile drawer.

Add focused classes/tokens in `styles.css`:

```css
.nav-group-label { font-size: 0.6875rem; font-weight: 600; color: var(--muted-foreground); }
.mobile-nav-link { min-height: 2.75rem; }
.app-header { min-height: 3.5rem; border-bottom: 1px solid var(--border); }
```

Use existing semantic variables instead of hardcoded colors.

- [ ] **Step 6: Verify shell behavior**

Run:

```bash
pnpm --filter @hyeboard/web typecheck
pnpm --filter @hyeboard/web exec playwright test tests/smoke.spec.ts --grep "sidebar|mobile navigation|search|notifications|account menu"
```

Expected: grouped-nav, collapse, drawer, search, notification, and account tests PASS on both configured projects.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/layout.tsx apps/web/src/lib/i18n.tsx apps/web/src/styles.css apps/web/tests/smoke.spec.ts
git commit -m "feat(web): redesign institutional app shell"
```

---

### Task 6: Add Shared Summary, Section, and Status Components

**Files:**
- Modify: `apps/web/src/components/shared.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/tests/smoke.spec.ts`

- [ ] **Step 1: Add failing semantic status assertions**

After demo login, assert readable labels and absence of known raw values:

```ts
await expect(page.getByText("In progress", { exact: true })).toBeVisible();
await expect(page.getByText("Not started", { exact: true })).toBeVisible();
await expect(page.getByText("in_progress", { exact: true })).toHaveCount(0);
await expect(page.getByText("not_started", { exact: true })).toHaveCount(0);
```

Expected initial result: FAIL because shared rows still render raw enum strings.

- [ ] **Step 2: Add semantic status tokens**

Add `--success`, `--success-foreground`, `--success-muted`, `--warning`, `--warning-foreground`, and `--warning-muted` to base and dark theme blocks. Expose them in Tailwind's theme map. Keep destructive and active-theme accent tokens as existing sources for danger and accent tones.

- [ ] **Step 3: Implement reusable composed primitives**

Add these exports to `shared.tsx`:

```tsx
export function StatusBadge({ value }: { value?: string | null }) {
  const { t } = useLocale();
  const status = formatStatus(value, t.status);
  return <Badge data-testid="status-badge" data-tone={status.tone}>{status.label}</Badge>;
}

export function SummaryStrip({ children }: { children: ReactNode }) {
  return <div data-testid="summary-strip" className="summary-strip">{children}</div>;
}

export function SummaryStat({ label, value, detail }: { label: string; value: ReactNode; detail?: string }) {
  return (
    <div className="summary-stat">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {detail ? <div className="mt-1 text-xs text-muted-foreground">{detail}</div> : null}
    </div>
  );
}

export function SectionPanel({ title, description, children, testId }: SectionPanelProps) {
  return (
    <section data-testid={testId} className="section-panel">
      <header className="section-panel-header">
        <h2 className="text-base font-semibold">{title}</h2>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </header>
      <div className="divide-y divide-border">{children}</div>
    </section>
  );
}
```

Define `SectionPanelProps` locally with `title`, optional `description`, `children`, and optional `testId`.

- [ ] **Step 4: Apply `StatusBadge` at every known status call site**

Replace direct status text in:

- `AssignmentItem`;
- `CourseRow`;
- `pages/tuition.tsx` bill rows;
- `pages/documents.tsx` request rows.

Do not mutate query data. Unknown strings continue through `formatStatus`.

- [ ] **Step 5: Verify status presentation**

Run:

```bash
pnpm --filter @hyeboard/web test
pnpm --filter @hyeboard/web exec playwright test tests/smoke.spec.ts --project=chromium --grep "status|feature routes"
```

Expected: unit tests and readable-status smoke assertions PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/shared.tsx apps/web/src/pages apps/web/src/styles.css apps/web/tests/smoke.spec.ts
git commit -m "feat(web): add semantic dashboard primitives"
```

---

### Task 7: Redesign Dashboard Around Academic Priorities

**Files:**
- Modify: `apps/web/src/pages/dashboard.tsx`
- Modify: `apps/web/src/components/shared.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/tests/smoke.spec.ts`

- [ ] **Step 1: Write failing Dashboard structure tests**

After demo login, assert:

```ts
await expect(page.getByTestId("dashboard-summary")).toBeVisible();
await expect(page.getByTestId("dashboard-schedule")).toBeVisible();
await expect(page.getByTestId("dashboard-assignments")).toBeVisible();
await expect(page.getByTestId("dashboard-courses")).toBeVisible();
await expect(page.getByTestId("dashboard-notifications")).toBeVisible();
await expect(page.locator(".stat-card")).toHaveCount(0);
```

At `390x844`, assert `document.documentElement.scrollWidth <= document.documentElement.clientWidth` and the summary contains two columns rather than a horizontal scroller.

- [ ] **Step 2: Run Dashboard tests and confirm failure**

Run: `pnpm --filter @hyeboard/web exec playwright test tests/smoke.spec.ts --project=chromium --grep "dashboard"`

Expected: FAIL because the old metric cards and section layout remain.

- [ ] **Step 3: Build the compact contextual header**

Combine greeting, date, active term, student identity, and next class inside one page header. Treat term/student as subdued text, not pills. Keep next-class content conditional and preserve the explicit all-clear fallback.

Use `Intl.DateTimeFormat(locale, { weekday: "long", month: "long", day: "numeric" })` with the active locale rather than adding another hardcoded English date.

- [ ] **Step 4: Replace metric cards with one summary strip**

Render four `SummaryStat` children within `SummaryStrip`, using existing dashboard values only:

- GPA/CPA;
- completed/enrolled credits;
- assignments requiring attention;
- outstanding tuition.

Use `data-testid="dashboard-summary"`. On mobile, grid to two columns; on desktop, four divided columns. Do not infer progress percentages.

- [ ] **Step 5: Replace nested cards with flat academic sections**

Use `SectionPanel` for schedule, assignments, courses, and notifications. Render existing row components directly under each divided section. Preserve safe external links and explicit `Empty` for every zero-length collection.

Use the five stable test IDs from Step 1. Remove dashboard uses of `Metric`, `motion-surface`, and cards nested under parent cards.

- [ ] **Step 6: Match loading geometry**

Update `DashboardSkeleton` to render one page-header skeleton, one summary-strip skeleton, and four flat section skeletons. It must not reintroduce four independent metric-card silhouettes.

- [ ] **Step 7: Verify Dashboard desktop and mobile**

Run:

```bash
pnpm --filter @hyeboard/web typecheck
pnpm --filter @hyeboard/web exec playwright test tests/smoke.spec.ts --grep "dashboard|demo login"
```

Expected: content-binding, safe-link, responsive summary, and no-nested-card assertions PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/pages/dashboard.tsx apps/web/src/components/shared.tsx apps/web/src/styles.css apps/web/tests/smoke.spec.ts
git commit -m "feat(web): redesign academic dashboard"
```

---

### Task 8: Redesign Timetable for Desktop and Mobile

**Files:**
- Modify: `apps/web/src/pages/timetable.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/tests/smoke.spec.ts`

- [ ] **Step 1: Add failing viewport-specific timetable tests**

Desktop `1440x900`:

```ts
await expect(page.getByTestId("desktop-timetable")).toBeVisible();
await expect(page.getByTestId("mobile-timetable")).toBeHidden();
await expect(page.getByRole("columnheader", { name: "Sun" })).toHaveCount(0);
await expect(page.locator('[data-current-day="true"]')).toHaveCount(1);
```

Mobile `390x844`:

```ts
await expect(page.getByTestId("desktop-timetable")).toBeHidden();
await expect(page.getByTestId("mobile-timetable")).toBeVisible();
await expect(page.getByRole("button", { name: "List" })).toBeVisible();
await expect(page.getByRole("button", { name: "Calendar" })).toBeVisible();
expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
```

Use the demo fixture's known Tuesday session to assert course, room, period/time, and safe link remain visible.

- [ ] **Step 2: Run timetable tests and confirm failure**

Run: `pnpm --filter @hyeboard/web exec playwright test tests/smoke.spec.ts --project=chromium --grep "timetable"`

Expected: FAIL because viewport-specific surfaces and current-day metadata do not exist.

- [ ] **Step 3: Derive visible days without changing session data**

Inside `timetable.tsx`, compute:

```ts
const visibleWeekdays = weekdays.filter(
  (day) => day.value !== 7 || items.some((item) => item.weekday === 7),
);
const currentWeekday = new Date().getDay() === 0 ? 7 : new Date().getDay();
```

Sunday disappears only when it has no real session. Keep verified `periodBlocks` unchanged.

- [ ] **Step 4: Implement the denser desktop grid**

Render `data-testid="desktop-timetable"` at `lg` and above. Use semantic row/column headers, `data-current-day`, flat accent-tinted session blocks, and one sanitized external URL lookup per session. Keep course code, title, room, instructor, period, and time visible.

- [ ] **Step 5: Implement mobile day groups**

Render `data-testid="mobile-timetable"` below `lg`. Group sessions by `visibleWeekdays`, omit empty days unless needed to explain an entirely empty week, and render each day's sessions chronologically as flat rows. Calendar mode shows day groups; list mode remains a chronological flat list. Neither mode may render a seven-column grid below `lg`.

- [ ] **Step 6: Add responsive timetable CSS**

Add layout classes using CSS grid and semantic tokens. Session hover may change background/border but must not add shadow/glow or translate the block. Current-day treatment uses a restrained muted/accent background with AA text contrast.

- [ ] **Step 7: Verify all reference widths**

Run:

```bash
pnpm --filter @hyeboard/web typecheck
pnpm --filter @hyeboard/web exec playwright test tests/smoke.spec.ts --grep "timetable"
```

Additionally run a Playwright check at `768x1024`; expected: mobile day-group surface, usable controls, no page-level horizontal overflow.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/pages/timetable.tsx apps/web/src/styles.css apps/web/tests/smoke.spec.ts
git commit -m "feat(web): add responsive academic timetable"
```

---

### Task 9: Redesign Grades and Humanize Terms

**Files:**
- Modify: `apps/web/src/pages/grades.tsx`
- Modify: `apps/web/src/pages/exams.tsx`
- Modify: `apps/web/src/pages/tuition.tsx`
- Modify: `apps/web/tests/smoke.spec.ts`

- [ ] **Step 1: Write failing term-label and compact-summary tests**

For the demo Grades page:

```ts
await expect(page.getByRole("heading", { name: "Semester 2, 2024–2025" })).toBeVisible();
await expect(page.getByText("20242", { exact: true })).toHaveCount(0);
await expect(page.getByTestId("term-summary").first()).toBeVisible();
await expect(page.getByTestId("term-summary").first().locator(".stat-card")).toHaveCount(0);
```

Keep existing sort behavior assertions and summer-term badge assertion.

- [ ] **Step 2: Run grade tests and confirm failure**

Run: `pnpm --filter @hyeboard/web exec playwright test tests/smoke.spec.ts --project=chromium --grep "grades"`

Expected: FAIL because raw term codes and metric-card trios remain.

- [ ] **Step 3: Separate grouping keys from display labels**

Keep `gradeTermKey` returning stable raw grouping keys. At render time only:

```ts
const displayTerm = formatTermLabel(termCode, universityId, t.terms);
```

Do not use localized labels as `Map` keys or sorting keys. Preserve existing UET/mock summer grouping and unknown-term behavior.

- [ ] **Step 4: Replace per-term metric cards with compact summaries**

Render term GPA, ten-point average, and credits in one inline `data-testid="term-summary"` row above each table. Use normal-case labels, tabular numbers, separators, and mobile wrapping. Keep overall academic summary concise and non-repetitive.

- [ ] **Step 5: Apply term labels where verified elsewhere**

Use `formatTermLabel` for raw term codes displayed by Tuition group headings and Exam selectors. Preserve upstream human-readable term names and non-UET codes verbatim.

- [ ] **Step 6: Verify English and Vietnamese**

Run the grade smoke test in English, switch locale to Vietnamese, and assert `Học kỳ 2, 2024–2025`. Confirm sorting still changes row order and summer indicators remain visible.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/pages/grades.tsx apps/web/src/pages/exams.tsx apps/web/src/pages/tuition.tsx apps/web/tests/smoke.spec.ts
git commit -m "feat(web): humanize academic terms and grades"
```

---

### Task 10: Apply Flat Information Design to Remaining Pages

**Files:**
- Modify: `apps/web/src/pages/courses.tsx`
- Modify: `apps/web/src/pages/assignments.tsx`
- Modify: `apps/web/src/pages/exams.tsx`
- Modify: `apps/web/src/pages/tuition.tsx`
- Modify: `apps/web/src/pages/documents.tsx`
- Modify: `apps/web/src/pages/training-points.tsx`
- Modify: `apps/web/src/components/shared.tsx`
- Modify: `apps/web/tests/smoke.spec.ts`

- [ ] **Step 1: Strengthen route tests around semantics, not Tailwind classes**

For every feature route, assert page heading plus one bound data value or explicit empty/unsupported state. Replace selectors such as `.bg-primary.transition-all` with semantic assertions:

```ts
await expect(page.locator("pre")).toHaveCount(0);
await expect(page.getByTestId("status-badge").first()).toBeVisible();
await expect(page.getByText("active", { exact: true })).toHaveCount(0);
```

Add a flat-list contract through route section test IDs and assert no nested section panel/card inside another section panel.

- [ ] **Step 2: Convert Courses and Assignments**

Render one bordered section with divided `CourseRow`/`AssignmentItem` rows. Add a Courses empty state, currently missing. Emphasize course identity and next deadline; preserve links and all API-provided details.

- [ ] **Step 3: Convert Exams and Tuition**

Keep table/list/calendar and term selection behavior. Improve column hierarchy, use `StatusBadge` for bill status, humanize verified exam method/type values in a dedicated localized mapping when known, and preserve `"-"` for unavailable time. Do not fabricate exam times or payment actions.

- [ ] **Step 4: Convert Documents and Training Points**

Keep document search and capability-dependent panels. Use flat rows, explicit empty/unsupported states, accessible collapse controls, and readable request statuses. Preserve safe links and query enablement conditions.

- [ ] **Step 5: Verify all feature routes**

Run:

```bash
pnpm --filter @hyeboard/web typecheck
pnpm --filter @hyeboard/web exec playwright test tests/smoke.spec.ts --grep "feature routes|status"
```

Expected: every route renders real bound UI, no raw known snake-case status, no `<pre>`, and no nested-card regression.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages apps/web/src/components/shared.tsx apps/web/tests/smoke.spec.ts
git commit -m "feat(web): unify academic feature pages"
```

---

### Task 11: Add Persistent Login Labels and Settings About Information

**Files:**
- Modify: `apps/web/src/pages/login.tsx`
- Modify: `apps/web/src/pages/settings.tsx`
- Modify: `apps/web/src/lib/i18n.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/tests/smoke.spec.ts`

- [ ] **Step 1: Add failing accessible-label and About tests**

At `390x844`, cover each currently reachable login branch and use label selectors instead of placeholders:

```ts
await expect(page.getByLabel("Student or parent code")).toBeVisible();
await expect(page.getByLabel("Google account password")).toHaveAttribute("type", "password");
```

Expand manual login and assert token/cookie controls by label. For CAPTCHA coverage, assert the verification input label when the existing mocked flow opens it. After demo login, open Settings and assert `About`, `Version`, and commit/build text.

- [ ] **Step 2: Add exact translation keys in both dictionaries**

English login keys:

```ts
studentCodeLabel: "Student or parent code",
googlePasswordLabel: "Google account password",
usernameLabel: "Username",
passwordLabel: "Password",
portalTokenLabel: "University portal access token",
learningTokenLabel: "Learning-platform access token",
portalCookieLabel: "University portal cookie",
learningCookieLabel: "Learning-platform cookie",
learningCsrfLabel: "Learning-platform CSRF token",
verificationCodeLabel: "Verification code",
```

Vietnamese login keys:

```ts
studentCodeLabel: "Mã sinh viên hoặc mã phụ huynh",
googlePasswordLabel: "Mật khẩu tài khoản Google",
usernameLabel: "Tên đăng nhập",
passwordLabel: "Mật khẩu",
portalTokenLabel: "Mã truy cập cổng thông tin trường",
learningTokenLabel: "Mã truy cập nền tảng học tập",
portalCookieLabel: "Cookie cổng thông tin trường",
learningCookieLabel: "Cookie nền tảng học tập",
learningCsrfLabel: "Mã CSRF nền tảng học tập",
verificationCodeLabel: "Mã xác minh",
```

Settings keys:

```ts
about: "About",
aboutDesc: "Hyeboard application information.",
version: "Version",
commit: (commit: string) => `Commit ${commit}`,
```

Vietnamese:

```ts
about: "Giới thiệu",
aboutDesc: "Thông tin ứng dụng Hyeboard.",
version: "Phiên bản",
commit: (commit: string) => `Bản dựng ${commit}`,
```

- [ ] **Step 3: Associate every input with a persistent label**

For each username/password/token/cookie/CAPTCHA field, render:

```tsx
<div className="grid gap-2">
  <label htmlFor={id} className="text-sm font-medium">{label}</label>
  <Input id={id} name={id} type={type} placeholder={example} {...fieldProps} />
</div>
```

Use stable unique IDs. Preserve all password/token/cookie `type="password"` attributes and Enter-submit behavior. Placeholders become optional examples only.

- [ ] **Step 4: Remove the login gradient and preserve responsive flow**

Replace `.login-screen` gradient with a flat themed background and subtle border-based hierarchy. Keep the bottom-right locale toggle, all flow choices, manual instructions, and CAPTCHA controls. Ensure labels and buttons fit without clipping at 390px.

- [ ] **Step 5: Add the Settings About section**

Render a secondary, non-interactive section showing `t.settings.version` and `t.settings.commit(__HYEB_GIT_COMMIT__)`. Do not display package version `0.0.0`; the injected commit is the only trustworthy build identifier.

- [ ] **Step 6: Verify all login and settings behavior**

Run:

```bash
pnpm --filter @hyeboard/web typecheck
pnpm --filter @hyeboard/web exec playwright test tests/smoke.spec.ts --grep "login|school picker|theme|language|settings"
```

Expected: labels persist after filling, credential types remain safe, all login branches behave unchanged, language/theme controls work, About is visible, and no horizontal overflow exists at 390px.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/pages/login.tsx apps/web/src/pages/settings.tsx apps/web/src/lib/i18n.tsx apps/web/src/styles.css apps/web/tests/smoke.spec.ts
git commit -m "feat(web): clarify login and settings UI"
```

---

### Task 12: Responsive, Accessibility, Visual, and Full Regression Gate

**Files:**
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/tests/smoke.spec.ts`
- Modify: any redesign file proven defective by this verification only

- [ ] **Step 1: Add reference-viewport overflow checks**

Create a reusable smoke helper:

```ts
async function expectNoPageOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
}
```

Apply it to Dashboard, Timetable, Grades, and Login at `390x844`, `768x1024`, and `1440x900`.

- [ ] **Step 2: Add keyboard and accessibility checks**

Verify:

- semantic heading order begins with one page `h1`;
- drawer opens by keyboard, closes with `Escape`, and restores focus;
- nav links have accessible names and active `aria-current`;
- every form control has a non-placeholder accessible name;
- primary mobile targets measure at least 44x44 CSS pixels;
- focus indicators remain visible in light and dark modes.

- [ ] **Step 3: Run web unit and smoke suites**

Run:

```bash
pnpm --filter @hyeboard/web test
pnpm --filter @hyeboard/web exec playwright test
```

Expected: all configured Chromium and Mobile Safari tests PASS; one existing intentional skip may remain only if still documented by the test.

- [ ] **Step 4: Perform screenshot review matrix**

Capture Dashboard, Timetable, Grades, and Login at:

- `390x844`;
- `768x1024`;
- `1440x900`.

Review English and Vietnamese, light and dark, neutral Demo and colored UET theme. For every capture confirm:

- no page-level horizontal overflow or clipped labels;
- no nested cards, gradients, glows, side stripes, or repeated uppercase metric eyebrows;
- readable status/term text;
- current/active states use semantic color and remain legible;
- mobile controls remain reachable and touch-sized;
- skeleton, empty, unsupported, and error states match final geometry.

Do not commit screenshots or Playwright artifacts.

- [ ] **Step 5: Inspect browser runtime health**

For each reference page, assert no console errors and no failed same-origin API/static requests beyond intentionally mocked upstream errors. Confirm both List/Calendar switches, sidebar collapse, drawer, search, notifications, account menu, sign-out, locale toggle, and theme controls through real browser interaction.

- [ ] **Step 6: Run repository completion gate**

From repository root:

```bash
pnpm build
pnpm test
pnpm --filter @hyeboard/web exec playwright test
```

Expected: all three commands exit `0`.

- [ ] **Step 7: Review final diff and commit fixes**

Run:

```bash
git status --short
git diff --check
git diff --stat
```

Confirm `AGENTS.md` and `apps/worker/eng.traineddata` remain untouched by redesign commits unless separately requested. Stage only redesign/test files fixed during this task.

```bash
git add apps/web/src apps/web/tests/smoke.spec.ts
git commit -m "test(web): verify dashboard redesign"
```

Skip this final commit if verification required no source or test changes; never create an empty commit.

---

## Execution Notes

- Use a dedicated worktree before implementation because the current workspace contains unrelated `AGENTS.md` and `apps/worker/eng.traineddata` changes.
- Do not parallelize agents that edit `apps/web/src/lib/i18n.tsx`, `apps/web/src/styles.css`, or `apps/web/tests/smoke.spec.ts`; those files are integration choke points.
- Safe parallel work begins only after Task 4: separate page agents may research or edit distinct page files, while one integration owner controls shared CSS, translations, and smoke tests.
- Run `pnpm --filter @hyeboard/web typecheck` after every extraction group. Structural errors become harder to diagnose after visual changes.
- Before any production deploy after frontend edits, run `pnpm build:web` immediately before `pnpm deploy`; deploy alone uploads stale `apps/web/dist`.
