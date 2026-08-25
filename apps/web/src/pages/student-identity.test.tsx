import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocaleProvider } from "@/lib/i18n";

const { staleStudent, state } = vi.hoisted(() => {
  const staleStudent = {
    id: "old-student",
    fullName: "Previous Account Student",
    universityId: "uet",
    studentCode: "OLD-DASHBOARD-CODE",
    email: "old@example.edu",
    major: "Old Major",
    className: "OLD-CLASS",
    programName: "Old Program",
    currentSemester: "Old Semester",
  };
  return {
    staleStudent,
    state: {
      current: {
        activeUniversity: undefined as { capabilities: { profile: boolean; terms: boolean } } | undefined,
        dashboard: {
          data: {
            student: staleStudent,
            currentTerm: { id: "old-term", code: "old-term", name: "Previous Account Term" },
            todaySchedule: [],
            courses: [],
            assignments: [],
            grades: [],
            exams: [],
            notifications: [],
          },
          isLoading: false,
          isPending: false,
          error: null,
        },
        universityId: "uet",
        activeAccountId: "account-b" as string | null,
        removingAccountIds: new Set<string>() as ReadonlySet<string>,
        accountActionError: undefined as string | undefined,
        accountActionErrorSource: undefined as string | undefined,
        accountActionErrorAccountId: undefined as string | undefined,
        mode: "light" as "light" | "dark",
        palette: "geist" as "geist" | "uet" | "vnu",
        themeHue: 209,
        setMode: vi.fn(),
        setPalette: vi.fn(),
        setThemeHue: vi.fn(),
        logout: vi.fn(),
        clearAccountActionError: vi.fn(),
      },
    },
  };
});

vi.mock("@/state", () => ({ useHyeboard: () => state.current }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

import { DashboardPage } from "./dashboard";
import { SettingsPage } from "./settings";

function renderLocalized(node: ReactNode): string {
  return renderToStaticMarkup(<LocaleProvider>{node}</LocaleProvider>);
}

function expectNoCachedProfile(markup: string): void {
  for (const value of Object.values(staleStudent)) expect(markup).not.toContain(value);
}

describe("effective student identity", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => undefined });
    vi.stubGlobal("navigator", { language: "en" });
    vi.stubGlobal("__HYEB_GIT_COMMIT__", "test");
    state.current.activeUniversity = undefined;
  });

  afterEach(() => vi.unstubAllGlobals());

  it("keeps cached profile PII out of the dashboard during metadata gaps, then restores it when profile is true", () => {
    const gapMarkup = renderLocalized(<DashboardPage />);

    expectNoCachedProfile(gapMarkup);
    expect(gapMarkup).toContain("Welcome back, student");
    expect(gapMarkup).toContain("Demo");

    state.current.activeUniversity = { capabilities: { profile: true, terms: true } };
    const enabledMarkup = renderLocalized(<DashboardPage />);

    expect(enabledMarkup).toContain(staleStudent.fullName);
    expect(enabledMarkup).toContain(staleStudent.studentCode);
  });

  it("keeps cached profile PII out of Settings during metadata gaps, then restores it without disabling controls", () => {
    const gapMarkup = renderLocalized(<SettingsPage />);

    expectNoCachedProfile(gapMarkup);
    expect(gapMarkup).toContain("Session details are available after the dashboard loads.");
    expect(gapMarkup).toContain("Display");
    expect(gapMarkup).toContain("Sign out");

    state.current.activeUniversity = { capabilities: { profile: true, terms: true } };
    const enabledMarkup = renderLocalized(<SettingsPage />);

    expect(enabledMarkup).toContain(staleStudent.fullName);
    expect(enabledMarkup).toContain(staleStudent.studentCode);
  });

  it("keeps profile-disabled dashboard and Settings generic", () => {
    state.current.activeUniversity = { capabilities: { profile: false, terms: false } };

    const dashboardMarkup = renderLocalized(<DashboardPage />);
    const settingsMarkup = renderLocalized(<SettingsPage />);

    expectNoCachedProfile(dashboardMarkup);
    expectNoCachedProfile(settingsMarkup);
    expect(dashboardMarkup).toContain("Welcome back, student");
    expect(settingsMarkup).toContain("Session details are available after the dashboard loads.");
  });

  it.each([undefined, false])("keeps cached currentTerm out of the dashboard when terms is %s", (terms) => {
    state.current.activeUniversity = terms === undefined
      ? undefined
      : { capabilities: { profile: true, terms } };

    const markup = renderLocalized(<DashboardPage />);

    expect(markup).not.toContain("Previous Account Term");
    expect(markup).toContain("Current term");
  });

  it("restores currentTerm only when terms is true", () => {
    state.current.activeUniversity = { capabilities: { profile: true, terms: true } };

    expect(renderLocalized(<DashboardPage />)).toContain("Previous Account Term");
  });
});
