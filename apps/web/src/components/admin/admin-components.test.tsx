import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocaleProvider } from "@/lib/i18n";
import { AdminAuthView } from "@/pages/admin-auth";
import { AdminLoginView } from "@/pages/admin-login";
import { AdminShell } from "./admin-layout";
import { Dialog, DialogTrigger } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import type { AdminPolicyView, FeaturePolicyContent } from "@hyeboard/schemas";
import {
  hasPolicyChanges,
  nextPolicyScopeIndex,
  policyDiff,
  PolicyEditor,
  updateCapabilityDraft,
  updateLimitDraft,
} from "./policy-editor";
import { PublishReviewContent } from "./publish-dialog";
import { PolicyHistory } from "./policy-history";

const emptyPolicy = (): FeaturePolicyContent => ({
  global: { capabilities: {}, limits: {} },
  universities: {},
});

const policyView = (): AdminPolicyView => ({
  snapshot: { revision: 4, ...emptyPolicy() },
  hardLimits: { "crossLookup.bulkMaxTargets": 100 },
  nativeUniversities: [{
    id: "uet",
    name: "University of Engineering and Technology",
    shortName: "UET",
    capabilities: {
      profile: true, terms: true, timetable: true, courses: true,
      assignments: false, grades: true, exams: true, attendance: false,
      notifications: true, documents: true, tuition: true, news: true,
      trainingPoints: true, requests: true, classLookup: true, crossLookup: true,
    },
    limits: { crossLookup: { bulkMaxTargets: 50 } },
  }],
  effectiveUniversities: [{
    id: "uet",
    name: "University of Engineering and Technology",
    shortName: "UET",
    capabilities: {
      profile: true, terms: true, timetable: true, courses: true,
      assignments: false, grades: true, exams: true, attendance: false,
      notifications: true, documents: true, tuition: true, news: true,
      trainingPoints: true, requests: true, classLookup: true, crossLookup: true,
    },
    limits: { crossLookup: { bulkMaxTargets: 50 } },
  }],
});

function localized(node: React.ReactNode): string {
  return renderToStaticMarkup(<LocaleProvider>{node}</LocaleProvider>);
}

describe("admin components", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => undefined });
    vi.stubGlobal("navigator", { language: "en" });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("renders only configured login methods with persistent labels and 44px controls", () => {
    const markup = localized(
      <AdminLoginView
        methods={["password", "github"]}
        password=""
        onPasswordChange={() => undefined}
        onPasswordSubmit={() => undefined}
      />,
    );

    expect(markup).toContain('<label for="admin-password"');
    expect(markup).toContain('type="password"');
    expect(markup).toContain("Continue with GitHub");
    expect(markup).not.toContain("Continue with Discord");
    expect(markup).toContain("min-h-11");
    expect(markup).not.toContain("hyeboard.token");
  });

  it("renders generic login loading, error, and unconfigured states", () => {
    expect(localized(<AdminLoginView methods={[]} password="" loading />)).toContain("Checking admin session");
    expect(localized(<AdminLoginView methods={[]} password="" error />)).toContain("Admin sign-in is unavailable");
    expect(localized(<AdminLoginView methods={[]} password="" />)).toContain("No admin sign-in method is configured");
  });

  it("renders semantic admin navigation without student account data", () => {
    const markup = localized(<AdminShell><p>Admin content</p></AdminShell>);

    expect(markup).toContain("<nav");
    expect(markup).toContain('href="/admin"');
    expect(markup).toContain('href="/admin/history"');
    expect(markup).toContain('href="/admin/auth"');
    expect(markup).toContain("Admin content");
    expect(markup).not.toContain("Student code");
    expect(markup).not.toContain("Accounts");
  });

  it("renders safe admin identity and a separate logout control", () => {
    const markup = localized(
      <AdminAuthView
        actor={{ method: "github", subject: "12345", label: "operator" }}
        onLogout={() => undefined}
      />,
    );

    expect(markup).toContain("operator");
    expect(markup).toContain("12345");
    expect(markup).toContain("GitHub");
    expect(markup).toContain('type="button"');
    expect(markup).toContain("Sign out of admin");
    expect(markup).toContain("min-h-11");
  });

  it("provides accessible local Switch and Radix Dialog primitives", () => {
    const switchMarkup = renderToStaticMarkup(<Switch checked aria-label="Available" />);
    const dialogMarkup = renderToStaticMarkup(<Dialog><DialogTrigger>Review</DialogTrigger></Dialog>);

    expect(switchMarkup).toContain('role="switch"');
    expect(switchMarkup).toContain('aria-checked="true"');
    expect(switchMarkup).toContain("focus-visible:ring-2");
    expect(switchMarkup).toContain("min-h-11");
    expect(dialogMarkup).toContain("Review");
  });

  it("updates drafts immutably with global kills, university disable-only overrides, and limit clearing", () => {
    const original = emptyPolicy();
    const killed = updateCapabilityDraft(original, "global", "grades", false);
    const disabled = updateCapabilityDraft(killed, "uet", "grades", false);
    const inherited = updateCapabilityDraft(disabled, "uet", "grades", true);
    const limited = updateLimitDraft(inherited, "global", "crossLookup.bulkMaxTargets", 25);
    const unlimited = updateLimitDraft(limited, "global", "crossLookup.bulkMaxTargets", null);
    const universityLimited = updateLimitDraft(unlimited, "uet", "crossLookup.bulkMaxTargets", 10);
    const cleared = updateLimitDraft(universityLimited, "uet", "crossLookup.bulkMaxTargets", null);

    expect(original).toEqual(emptyPolicy());
    expect(killed.global.capabilities.grades).toEqual({ enabled: false });
    expect(disabled.universities.uet?.capabilities.grades).toEqual({ enabled: false });
    expect(inherited.universities.uet).toBeUndefined();
    expect(unlimited.global.limits["crossLookup.bulkMaxTargets"]).toBeNull();
    expect(universityLimited.universities.uet?.limits["crossLookup.bulkMaxTargets"]).toBe(10);
    expect(cleared.universities.uet).toBeUndefined();
  });

  it("produces stable exact diffs and detects changes", () => {
    const before = emptyPolicy();
    const after = updateLimitDraft(
      updateCapabilityDraft(
        updateCapabilityDraft(before, "global", "grades", false),
        "uet",
        "crossLookup",
        false,
      ),
      "global",
      "crossLookup.bulkMaxTargets",
      null,
    );

    expect(hasPolicyChanges(before, after)).toBe(true);
    expect(policyDiff(before, after)).toEqual([
      { scope: "global", kind: "capability", key: "grades", before: true, after: false },
      { scope: "global", kind: "limit", key: "crossLookup.bulkMaxTargets", before: undefined, after: null },
      { scope: "uet", kind: "capability", key: "crossLookup", before: true, after: false },
    ]);
    expect(policyDiff(after, after)).toEqual([]);
  });

  it("supports roving tab keyboard navigation", () => {
    expect(nextPolicyScopeIndex("ArrowRight", 1, 3)).toBe(2);
    expect(nextPolicyScopeIndex("ArrowRight", 2, 3)).toBe(0);
    expect(nextPolicyScopeIndex("ArrowLeft", 0, 3)).toBe(2);
    expect(nextPolicyScopeIndex("Home", 2, 3)).toBe(0);
    expect(nextPolicyScopeIndex("End", 0, 3)).toBe(2);
    expect(nextPolicyScopeIndex("Enter", 0, 3)).toBeUndefined();
  });

  it("renders summary, tabs, searchable rows, registered limits, locks, provenance, and staged controls", () => {
    const markup = localized(
      <PolicyEditor
        view={policyView()}
        draft={updateLimitDraft(updateCapabilityDraft(emptyPolicy(), "global", "grades", false), "global", "crossLookup.bulkMaxTargets", 25)}
        scope="uet"
        search=""
        onScopeChange={() => undefined}
        onSearchChange={() => undefined}
        onDraftChange={() => undefined}
        onDiscard={() => undefined}
        onReview={() => undefined}
      />,
    );

    expect(markup).toContain("Capabilities");
    expect(markup).toContain("Enabled");
    expect(markup).toContain("Overrides");
    expect(markup).toContain("Staged changes");
    expect(markup).toContain("Global");
    expect(markup).toContain("UET");
    expect(markup).toContain('role="tab"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain('aria-controls="admin-policy-panel"');
    expect(markup).toContain('role="tabpanel"');
    expect(markup).toContain('aria-labelledby="admin-policy-tab-uet"');
    expect(markup).toContain('type="search"');
    expect(markup).toContain("Grades");
    expect(markup).toContain("Adapter does not support this capability");
    expect(markup).toContain("Inherited");
    expect(markup).toContain("Discard");
    expect(markup).toContain("Review changes");
  });

  it("renders exact publish diff, required reason, base revision, and stale conflict without discarding draft", () => {
    const before = emptyPolicy();
    const after = updateCapabilityDraft(before, "global", "grades", false);
    const markup = localized(
      <PublishReviewContent
        baseRevision={4}
        before={before}
        after={after}
        reason="incident"
        onReasonChange={() => undefined}
        onClose={() => undefined}
        onPublish={() => undefined}
        conflictRevision={5}
      />,
    );

    expect(markup).toContain("Revision 4");
    expect(markup).toContain("Grades");
    expect(markup).toContain("Enabled → Disabled");
    expect(markup).toContain('required=""');
    expect(markup).toContain("Revision 5 was published while this draft was open");
    expect(markup).toContain("Draft preserved. Review the intervening revision; changes were not merged.");
  });

  it("renders bounded history, detail states, and rollback review", () => {
    const entry = {
      revision: 4,
      baseRevision: 3,
      actor: { method: "github" as const, subject: "123", label: "operator" },
      reason: "Incident response",
      publishedAt: "2026-08-23T12:00:00.000Z",
      snapshot: { revision: 4, ...updateCapabilityDraft(emptyPolicy(), "global", "grades", false) },
    };
    const markup = localized(
      <PolicyHistory
        items={[entry]}
        currentPolicy={{ ...policyView().snapshot, revision: 5 }}
        selected={entry}
        hasMore
        onLoadMore={() => undefined}
        onSelect={() => undefined}
        onRollback={() => undefined}
      />,
    );

    expect(markup).toContain("Revision 4");
    expect(markup).toContain("operator");
    expect(markup).toContain("GitHub");
    expect(markup).toContain("Incident response");
    expect(markup).toContain("Load more");
    expect(localized(<PolicyHistory items={[entry]} hasMore loadingMore />)).toContain('disabled=""');
    expect(markup).toContain("Roll back");
    expect(markup).toContain("Enabled → Disabled");
    expect(localized(<PolicyHistory items={[]} loading />)).toContain("Loading policy history");
    const errorMarkup = localized(<PolicyHistory items={[]} error onRetry={() => undefined} />);
    expect(errorMarkup).toContain("Policy history could not be loaded");
    expect(errorMarkup).toContain("Try again");
    expect(localized(<PolicyHistory items={[]} />)).toContain("No policy revisions have been published");
    const loadMoreErrorMarkup = localized(<PolicyHistory items={[entry]} loadMoreError onLoadMore={() => undefined} />);
    expect(loadMoreErrorMarkup).toContain("Revision 4");
    expect(loadMoreErrorMarkup).toContain("More policy revisions could not be loaded");
    expect(loadMoreErrorMarkup).toContain("Try again");
  });
});
