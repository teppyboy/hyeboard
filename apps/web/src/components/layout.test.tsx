import type { Notification } from "@hyeboard/schemas";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocaleProvider } from "@/lib/i18n";

const staleStudent = { fullName: "Previous Account Student", studentCode: "OLD-DASHBOARD-CODE" };
const state = vi.hoisted(() => ({
  current: {
    activeUniversity: undefined as { shortName: string; capabilities: { notifications: boolean; profile: boolean } } | undefined,
    universities: {
      data: undefined as Array<{ id: string; capabilities: { profile: boolean } }> | undefined,
      error: null as Error | null,
      fetchStatus: "idle" as "idle" | "fetching" | "paused",
    },
    dashboard: { data: undefined as { notifications: Notification[]; student?: typeof staleStudent } | undefined },
    universityId: "uet",
    accounts: [] as Array<{ id: string; universityId: string; token: string; studentCode?: string; addedAt: string }>,
    activeAccountId: "account-a" as string | null,
    removingAccountIds: new Set<string>() as ReadonlySet<string>,
    accountActionError: undefined as string | undefined,
    accountActionErrorAccountId: undefined as string | undefined,
    accountActionErrorSource: undefined as string | undefined,
    logout: vi.fn(),
    removeStoredAccount: vi.fn(),
    switchToAccount: vi.fn(),
    clearAccountActionError: vi.fn(),
  },
}));

vi.mock("@/state", () => ({ useHyeboard: () => state.current }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  Outlet: () => null,
  useNavigate: () => vi.fn(),
  useRouterState: ({ select }: { select: (value: { location: { pathname: string } }) => unknown }) => select({ location: { pathname: "/" } }),
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div role="menu">{children}</div>,
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({ asChild, children, disabled }: { asChild?: boolean; children: ReactNode; disabled?: boolean }) => asChild ? <>{children}</> : <button type="button" role="menuitem" disabled={disabled}>{children}</button>,
}));

import { AccountMenu, NotificationsMenu } from "./layout";

const staleNotifications: Notification[] = [
  { id: "old-1", title: "Previous account private notice", createdAt: "2026-03-01T00:00:00.000Z", unread: true },
  { id: "old-2", title: "Previous account second notice", createdAt: "2026-03-02T00:00:00.000Z", unread: true },
];

function renderLocalized(node: ReactNode): string {
  return renderToStaticMarkup(<LocaleProvider>{node}</LocaleProvider>);
}

function renderNotifications(): string {
  return renderLocalized(<NotificationsMenu />);
}

function renderAccount(): string {
  return renderLocalized(<AccountMenu />);
}

function expectAccountControls(markup: string): void {
  expect(markup).toContain('aria-label="Open account menu"');
  expect(markup).toContain('href="/settings"');
  expect(markup).toContain("Settings");
  expect(markup).toContain("Add account");
  expect(markup).toContain('role="menuitem"');
  expect(markup).toContain("Sign out");
}

describe("NotificationsMenu capability gating", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => undefined });
    vi.stubGlobal("navigator", { language: "en" });
    state.current.dashboard.data = { notifications: staleNotifications };
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each([undefined, false])("hides cached notification data when effective capability is %s", (notifications) => {
    state.current.activeUniversity = notifications === undefined
      ? undefined
      : { shortName: "UET", capabilities: { notifications, profile: true } };

    const markup = renderNotifications();

    expect(markup).toBe("");
  });

  it("keeps previous-account notifications closed during metadata refetch, then reappears when enabled", () => {
    state.current.activeUniversity = undefined;
    const switchingMarkup = renderNotifications();

    state.current.activeUniversity = { shortName: "UET", capabilities: { notifications: true, profile: true } };
    const enabledMarkup = renderNotifications();

    expect(switchingMarkup).toBe("");
    expect(enabledMarkup).toContain("notifications-trigger");
    expect(enabledMarkup).toContain(">2</span>");
  });
});

describe("AccountMenu profile capability gating", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => undefined });
    vi.stubGlobal("navigator", { language: "en" });
    state.current.activeUniversity = undefined;
    state.current.universities = { data: undefined, error: null, fetchStatus: "idle" };
    state.current.dashboard.data = { notifications: [], student: staleStudent };
    state.current.accounts = [];
    state.current.activeAccountId = "account-a";
  });

  afterEach(() => vi.unstubAllGlobals());

  it("shows the cached dashboard identity only when effective profile capability is true", () => {
    state.current.activeUniversity = { shortName: "UET", capabilities: { notifications: true, profile: true } };

    const markup = renderAccount();

    expect(markup).toContain(staleStudent.fullName);
    expect(markup).toContain(staleStudent.studentCode);
    expectAccountControls(markup);
  });

  it("hides cached identity when effective profile capability is false", () => {
    state.current.activeUniversity = { shortName: "UET", capabilities: { notifications: true, profile: false } };

    const markup = renderAccount();

    expect(markup).toContain("Account");
    expect(markup).toContain("University");
    expect(markup).not.toContain(staleStudent.fullName);
    expect(markup).not.toContain(staleStudent.studentCode);
    expectAccountControls(markup);
  });

  it("hides cached identity while effective university metadata is missing or failed", () => {
    state.current.activeUniversity = undefined;

    const markup = renderAccount();

    expect(markup).toContain("Account");
    expect(markup).toContain("University");
    expect(markup).not.toContain(staleStudent.fullName);
    expect(markup).not.toContain(staleStudent.studentCode);
    expectAccountControls(markup);
  });

  it("uses each stored account's capability when active UET supports profile and VNU does not", () => {
    state.current.accounts = [
      { id: "account-a", universityId: "uet", token: "opaque-a", studentCode: "STORED-UET-CODE", addedAt: "2026-03-01T00:00:00.000Z" },
      { id: "account-b", universityId: "vnu", token: "opaque-b", studentCode: "STORED-VNU-CODE", addedAt: "2026-03-02T00:00:00.000Z" },
    ];
    state.current.activeUniversity = { shortName: "UET", capabilities: { notifications: true, profile: true } };
    state.current.universities.data = [
      { id: "uet", capabilities: { profile: true } },
      { id: "vnu", capabilities: { profile: false } },
    ];

    const markup = renderAccount();

    expect(markup).toContain("STORED-UET-CODE");
    expect(markup).not.toContain("STORED-VNU-CODE");
    expect(markup).toContain("VNU");
    expectAccountControls(markup);
  });

  it("uses each stored account's capability when active VNU does not support profile and UET does", () => {
    state.current.accounts = [
      { id: "account-a", universityId: "uet", token: "opaque-a", studentCode: "STORED-UET-CODE", addedAt: "2026-03-01T00:00:00.000Z" },
      { id: "account-b", universityId: "vnu", token: "opaque-b", studentCode: "STORED-VNU-CODE", addedAt: "2026-03-02T00:00:00.000Z" },
    ];
    state.current.activeAccountId = "account-b";
    state.current.activeUniversity = { shortName: "VNU", capabilities: { notifications: true, profile: false } };
    state.current.universities.data = [
      { id: "uet", capabilities: { profile: true } },
      { id: "vnu", capabilities: { profile: false } },
    ];

    const markup = renderAccount();

    expect(markup).toContain("STORED-UET-CODE");
    expect(markup).not.toContain("STORED-VNU-CODE");
    expectAccountControls(markup);
  });

  it.each([
    { caseName: "missing", data: undefined, error: null },
    { caseName: "failed", data: [{ id: "uet", capabilities: { profile: true } }, { id: "vnu", capabilities: { profile: true } }], error: new Error("metadata failed") },
  ])("hides all stored-account codes when university metadata is $caseName", ({ data, error }) => {
    state.current.accounts = [
      { id: "account-a", universityId: "uet", token: "opaque-a", studentCode: "STORED-UET-CODE", addedAt: "2026-03-01T00:00:00.000Z" },
      { id: "account-b", universityId: "vnu", token: "opaque-b", studentCode: "STORED-VNU-CODE", addedAt: "2026-03-02T00:00:00.000Z" },
    ];
    state.current.activeUniversity = { shortName: "UET", capabilities: { notifications: true, profile: true } };
    state.current.universities = { data, error, fetchStatus: "idle" };

    const markup = renderAccount();

    expect(markup).not.toContain("STORED-UET-CODE");
    expect(markup).not.toContain("STORED-VNU-CODE");
    expect(markup).toContain("UET");
    expect(markup).toContain("VNU");
    expectAccountControls(markup);
  });

  it("keeps a stored descriptor available to removal controls while metadata is still loading", () => {
    state.current.accounts = [
      { id: "account-a", universityId: "mock", token: "opaque-a", studentCode: "STORED-MOCK-CODE", addedAt: "2026-03-01T00:00:00.000Z" },
      { id: "account-b", universityId: "vnu", token: "opaque-b", studentCode: "STORED-VNU-CODE", addedAt: "2026-03-02T00:00:00.000Z" },
    ];
    state.current.universities = { data: undefined, error: null, fetchStatus: "fetching" };

    const markup = renderAccount();

    expect(markup).toContain('aria-label="Remove STORED-VNU-CODE"');
  });

  it("shows both stored-account codes when both universities support profile", () => {
    state.current.accounts = [
      { id: "account-a", universityId: "uet", token: "opaque-a", studentCode: "STORED-UET-CODE", addedAt: "2026-03-01T00:00:00.000Z" },
      { id: "account-b", universityId: "vnu", token: "opaque-b", studentCode: "STORED-VNU-CODE", addedAt: "2026-03-02T00:00:00.000Z" },
    ];
    state.current.activeUniversity = { shortName: "UET", capabilities: { notifications: true, profile: true } };
    state.current.universities.data = [
      { id: "uet", capabilities: { profile: true } },
      { id: "vnu", capabilities: { profile: true } },
    ];

    const markup = renderAccount();

    expect(markup).toContain("STORED-UET-CODE");
    expect(markup).toContain("STORED-VNU-CODE");
    expectAccountControls(markup);
  });
});
