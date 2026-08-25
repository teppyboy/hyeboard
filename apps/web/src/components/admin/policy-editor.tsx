import {
  capabilityKeys,
  operationalLimitKeys,
  type AdminPolicyView,
  type CapabilityKey,
  type FeaturePolicyContent,
  type OperationalLimitKey,
} from "@hyeboard/schemas";
import { Search } from "lucide-react";
import type { KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useLocale } from "@/lib/i18n";

export type PolicyScope = "global" | string;
export type PolicyDiffItem = {
  scope: string;
  kind: "capability" | "limit";
  key: CapabilityKey | OperationalLimitKey;
  before: boolean | number | null | undefined;
  after: boolean | number | null | undefined;
};

function withoutEmptyUniversity(policy: FeaturePolicyContent, universityId: string): FeaturePolicyContent {
  const university = policy.universities[universityId];
  if (university && (Object.keys(university.capabilities).length || Object.keys(university.limits).length)) return policy;
  const universities = { ...policy.universities };
  delete universities[universityId];
  return { ...policy, universities };
}

export function updateCapabilityDraft(
  policy: FeaturePolicyContent,
  scope: PolicyScope,
  key: CapabilityKey,
  enabled: boolean,
): FeaturePolicyContent {
  if (scope === "global") {
    const capabilities = { ...policy.global.capabilities };
    if (enabled) delete capabilities[key];
    else capabilities[key] = { enabled: false };
    return { ...policy, global: { ...policy.global, capabilities } };
  }

  const current = policy.universities[scope] ?? { capabilities: {}, limits: {} };
  const capabilities = { ...current.capabilities };
  if (enabled) delete capabilities[key];
  else capabilities[key] = { enabled: false };
  return withoutEmptyUniversity({
    ...policy,
    universities: { ...policy.universities, [scope]: { ...current, capabilities } },
  }, scope);
}

export function updateLimitDraft(
  policy: FeaturePolicyContent,
  scope: PolicyScope,
  key: OperationalLimitKey,
  value: number | null,
): FeaturePolicyContent {
  if (scope === "global") return {
    ...policy,
    global: { ...policy.global, limits: { ...policy.global.limits, [key]: value } },
  };

  const current = policy.universities[scope] ?? { capabilities: {}, limits: {} };
  const limits = { ...current.limits };
  if (value === null) delete limits[key];
  else limits[key] = value;
  return withoutEmptyUniversity({
    ...policy,
    universities: { ...policy.universities, [scope]: { ...current, limits } },
  }, scope);
}

function capabilityValue(policy: FeaturePolicyContent, scope: string, key: CapabilityKey): boolean {
  return scope === "global"
    ? policy.global.capabilities[key]?.enabled !== false
    : policy.universities[scope]?.capabilities[key]?.enabled !== false;
}

function limitValue(policy: FeaturePolicyContent, scope: string, key: OperationalLimitKey): number | null | undefined {
  return scope === "global" ? policy.global.limits[key] : policy.universities[scope]?.limits[key];
}

export function policyDiff(before: FeaturePolicyContent, after: FeaturePolicyContent): PolicyDiffItem[] {
  const scopes = ["global", ...new Set([...Object.keys(before.universities), ...Object.keys(after.universities)].sort())];
  const result: PolicyDiffItem[] = [];
  for (const scope of scopes) {
    for (const key of capabilityKeys) {
      const previous = capabilityValue(before, scope, key);
      const next = capabilityValue(after, scope, key);
      if (previous !== next) result.push({ scope, kind: "capability", key, before: previous, after: next });
    }
    for (const key of operationalLimitKeys) {
      const previous = limitValue(before, scope, key);
      const next = limitValue(after, scope, key);
      if (previous !== next) result.push({ scope, kind: "limit", key, before: previous, after: next });
    }
  }
  return result;
}

export function hasPolicyChanges(before: FeaturePolicyContent, after: FeaturePolicyContent): boolean {
  return policyDiff(before, after).length > 0;
}

function nativeLimit(view: AdminPolicyView, universityId: string, key: OperationalLimitKey): number | undefined {
  const crossLookup = view.nativeUniversities.find(({ id }) => id === universityId)?.limits?.crossLookup;
  switch (key) {
    case "crossLookup.bulkMaxTargets": return crossLookup?.bulkMaxTargets;
    case "crossLookup.bulkDirectChunkMaxTargets": return crossLookup?.bulkDirectChunkMaxTargets;
    case "crossLookup.bulkModeMaxTargets.stdid-to-code": return crossLookup?.bulkModeMaxTargets?.["stdid-to-code"];
    case "crossLookup.bulkModeMaxTargets.stdid-to-transcript": return crossLookup?.bulkModeMaxTargets?.["stdid-to-transcript"];
    case "crossLookup.bulkModeMaxTargets.code-to-stdid": return crossLookup?.bulkModeMaxTargets?.["code-to-stdid"];
    case "crossLookup.crossDetail.maxTargets": return crossLookup?.crossDetail?.maxTargets;
    case "crossLookup.crossDetail.maxRows": return crossLookup?.crossDetail?.maxRows;
    case "crossLookup.crossDetail.concurrency": return crossLookup?.crossDetail?.concurrency;
  }
}

function effectiveCapability(view: AdminPolicyView, draft: FeaturePolicyContent, scope: PolicyScope, key: CapabilityKey): boolean {
  const globallyEnabled = capabilityValue(draft, "global", key);
  if (scope === "global") return globallyEnabled;
  const supported = view.nativeUniversities.find(({ id }) => id === scope)?.capabilities[key] === true;
  return supported && globallyEnabled && capabilityValue(draft, scope, key);
}

export function nextPolicyScopeIndex(key: string, index: number, count: number): number | undefined {
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowRight") return (index + 1) % count;
  if (key === "ArrowLeft") return (index - 1 + count) % count;
}

export type PolicyEditorProps = {
  view: AdminPolicyView;
  draft: FeaturePolicyContent;
  scope: PolicyScope;
  search: string;
  onScopeChange: (scope: PolicyScope) => void;
  onSearchChange: (search: string) => void;
  onDraftChange: (draft: FeaturePolicyContent) => void;
  onDiscard: () => void;
  onReview: () => void;
};

export function PolicyEditor({ view, draft, scope, search, onScopeChange, onSearchChange, onDraftChange, onDiscard, onReview }: PolicyEditorProps) {
  const { t } = useLocale();
  const before: FeaturePolicyContent = { global: view.snapshot.global, universities: view.snapshot.universities };
  const diff = policyDiff(before, draft);
  const university = scope === "global" ? undefined : view.nativeUniversities.find(({ id }) => id === scope);
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const visibleCapabilities = capabilityKeys.filter((key) => {
    const copy = t.admin.capabilities[key];
    return !normalizedSearch || `${copy.label} ${copy.description} ${key}`.toLocaleLowerCase().includes(normalizedSearch);
  });
  const visibleLimits = operationalLimitKeys.filter((key) => {
    const copy = t.admin.limits[key];
    return !normalizedSearch || `${copy.label} ${copy.description} ${key}`.toLocaleLowerCase().includes(normalizedSearch);
  });
  const scopes = [{ id: "global", label: t.admin.control.global }, ...view.nativeUniversities.map(({ id, shortName }) => ({ id, label: shortName }))];
  const tabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = nextPolicyScopeIndex(event.key, index, scopes.length);
    if (next === undefined) return;
    event.preventDefault();
    onScopeChange(scopes[next]!.id);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };
  const enabledCount = capabilityKeys.filter((key) => effectiveCapability(view, draft, scope, key)).length;
  const overrideCount = scope === "global"
    ? Object.keys(draft.global.capabilities).length + Object.keys(draft.global.limits).length
    : Object.keys(draft.universities[scope]?.capabilities ?? {}).length + Object.keys(draft.universities[scope]?.limits ?? {}).length;

  return (
    <section className="space-y-5 pb-24">
      <header><h1 className="text-2xl font-semibold tracking-tight">{t.admin.control.title}</h1><p className="mt-1 text-sm text-muted-foreground">{t.admin.control.description}</p></header>
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4">
        {[
          [t.admin.control.summary.capabilities, capabilityKeys.length],
          [t.admin.control.summary.enabled, enabledCount],
          [t.admin.control.summary.overrides, overrideCount],
          [t.admin.control.summary.staged, diff.length],
        ].map(([label, value]) => <div key={label} className="bg-card p-3"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 text-xl font-semibold">{value}</dd></div>)}
      </dl>

      <div className="flex gap-1 overflow-x-auto border-b border-border" role="tablist" aria-label={t.admin.control.scopeLabel}>
        {scopes.map(({ id, label }, index) => <ScopeTab key={id} id={`admin-policy-tab-${id}`} panelId="admin-policy-panel" active={scope === id} label={label} onClick={() => onScopeChange(id)} onKeyDown={(event) => tabKeyDown(event, index)} />)}
      </div>

      <div id="admin-policy-panel" role="tabpanel" aria-labelledby={`admin-policy-tab-${scope}`} className="space-y-5">
      <div className="relative max-w-md"><Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={16} aria-hidden="true" /><label className="sr-only" htmlFor="admin-policy-search">{t.admin.control.search}</label><Input id="admin-policy-search" type="search" className="min-h-11 pl-9" value={search} placeholder={t.admin.control.search} onChange={(event) => onSearchChange(event.target.value)} /></div>

      {!visibleCapabilities.length && !visibleLimits.length ? <p className="rounded-lg border border-border p-6 text-center text-sm text-muted-foreground">{t.admin.control.noResults}</p> : null}
      {visibleCapabilities.length ? <div className="overflow-hidden rounded-lg border border-border" aria-label={t.admin.control.capabilityList}>
        {visibleCapabilities.map((key) => {
          const copy = t.admin.capabilities[key];
          const supported = scope === "global" || university?.capabilities[key] === true;
          const globallyLocked = scope !== "global" && draft.global.capabilities[key]?.enabled === false;
          const locked = !supported || globallyLocked;
          const lockReason = supported ? globallyLocked ? t.admin.control.globalDisabled : undefined : t.admin.control.unsupported;
          const checked = effectiveCapability(view, draft, scope, key);
          return <div key={key} className="flex min-h-16 items-center gap-3 border-b border-border px-3 py-2 last:border-b-0"><div className="min-w-0 flex-1"><p className="font-medium">{copy.label}</p><p className="text-sm text-muted-foreground">{copy.description}</p>{lockReason ? <p className="mt-1 text-xs font-medium text-destructive">{lockReason}</p> : null}</div><Switch checked={checked} disabled={locked} aria-label={`${copy.label}: ${t.admin.control.available}`} onCheckedChange={(enabled) => onDraftChange(updateCapabilityDraft(draft, scope, key, enabled))} /></div>;
        })}
      </div> : null}

      {visibleLimits.length ? <div className="overflow-hidden rounded-lg border border-border" aria-label={t.admin.control.limitList}>
        {visibleLimits.map((key) => {
          const copy = t.admin.limits[key];
          const ceiling = scope === "global" ? view.hardLimits[key] : nativeLimit(view, scope, key);
          const value = limitValue(draft, scope, key);
          const globalValue = draft.global.limits[key];
          const locked = ceiling === undefined;
          const provenance = scope === "global"
            ? value === null || value === undefined ? t.admin.control.noAdminCap : t.admin.control.explicit
            : value === undefined ? globalValue === null || globalValue === undefined ? t.admin.control.noAdminCap : t.admin.control.inherited : t.admin.control.universityOverride;
          return <div key={key} className="grid min-h-20 gap-2 border-b border-border px-3 py-3 last:border-b-0 sm:grid-cols-[1fr_180px] sm:items-center"><div><p className="font-medium">{copy.label}</p><p className="text-sm text-muted-foreground">{copy.description}</p><p className="mt-1 text-xs text-muted-foreground">{t.admin.control.provenance}: {provenance}{ceiling === undefined ? ` · ${t.admin.control.notConfigurable}` : ` · ${t.admin.control.ceiling} ${ceiling}`}</p></div><label className="grid gap-1 text-xs text-muted-foreground"><span>{t.admin.control.limitValue}</span><Input className="min-h-11" type="number" min={1} max={ceiling} disabled={locked} value={value ?? ""} placeholder={scope === "global" ? t.admin.control.unlimited : t.admin.control.inherit} onChange={(event) => onDraftChange(updateLimitDraft(draft, scope, key, event.target.value ? Number(event.target.value) : null))} /></label></div>;
        })}
      </div> : null}

      </div>
      {diff.length ? <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background p-3 shadow-lg lg:left-[240px]"><div className="mx-auto flex max-w-5xl items-center justify-between gap-3"><p className="text-sm font-medium">{diff.length} {t.admin.control.stagedCount}</p><div className="flex gap-2"><Button type="button" variant="outline" className="min-h-11" onClick={onDiscard}>{t.admin.actions.discard}</Button><Button type="button" className="min-h-11" onClick={onReview}>{t.admin.actions.review}</Button></div></div></div> : null}
    </section>
  );
}

function ScopeTab({ id, panelId, active, label, onClick, onKeyDown }: { id: string; panelId: string; active: boolean; label: string; onClick: () => void; onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void }) {
  return <button id={id} type="button" role="tab" aria-selected={active} aria-controls={panelId} tabIndex={active ? 0 : -1} className={`min-h-11 shrink-0 border-b-2 px-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${active ? "border-primary text-foreground" : "border-transparent text-muted-foreground"}`} onClick={onClick} onKeyDown={onKeyDown}>{label}</button>;
}
