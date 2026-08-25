import type { FeaturePolicyContent } from "@hyeboard/schemas";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useAdminSession } from "@/components/admin/admin-layout";
import { hasPolicyChanges, PolicyEditor, type PolicyScope } from "@/components/admin/policy-editor";
import { PublishDialog } from "@/components/admin/publish-dialog";
import { Button } from "@/components/ui/button";
import { AdminApiError, adminApi } from "@/lib/admin-api";
import { useLocale } from "@/lib/i18n";

function content(snapshot: { global: FeaturePolicyContent["global"]; universities: FeaturePolicyContent["universities"] }): FeaturePolicyContent {
  return { global: snapshot.global, universities: snapshot.universities };
}

export function rebasePolicyDraft(
  base: { revision: number; policy: FeaturePolicyContent } | undefined,
  draft: FeaturePolicyContent | undefined,
  snapshot: { revision: number; global: FeaturePolicyContent["global"]; universities: FeaturePolicyContent["universities"] },
): { base: { revision: number; policy: FeaturePolicyContent }; draft: FeaturePolicyContent } {
  const policy = content(snapshot);
  if (!base || !draft || !hasPolicyChanges(base.policy, draft)) return { base: { revision: snapshot.revision, policy }, draft: policy };
  return { base, draft };
}

export function AdminControlPage() {
  const { session } = useAdminSession();
  const { t } = useLocale();
  const queryClient = useQueryClient();
  const policyQuery = useQuery({ queryKey: ["admin", "policy"], queryFn: adminApi.policy, retry: false });
  const [draft, setDraft] = useState<FeaturePolicyContent>();
  const [draftBase, setDraftBase] = useState<{ revision: number; policy: FeaturePolicyContent }>();
  const [scope, setScope] = useState<PolicyScope>("global");
  const [search, setSearch] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [reason, setReason] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [conflictRevision, setConflictRevision] = useState<number>();

  useEffect(() => {
    if (!policyQuery.data) return;
    const rebased = rebasePolicyDraft(draftBase, draft, policyQuery.data.snapshot);
    if (rebased.base === draftBase && rebased.draft === draft) return;
    setDraft(rebased.draft);
    setDraftBase(rebased.base);
  }, [policyQuery.data]);
  useEffect(() => {
    if (!draft || !draftBase || !hasPolicyChanges(draftBase.policy, draft)) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [draft, draftBase]);

  if (policyQuery.isPending) return <ControlState message={t.admin.states.loading} />;
  if (policyQuery.isError) return <ControlState message={t.admin.states.error} retry={() => policyQuery.refetch()} />;
  if (!policyQuery.data || !draft || !draftBase) return <ControlState message={t.admin.states.empty} />;

  const published = content(policyQuery.data.snapshot);
  const publish = async () => {
    setPublishing(true);
    setFailed(false);
    try {
      const published = await adminApi.publish({ baseRevision: draftBase.revision, policy: draft, reason }, session.csrfToken);
      const policy = content(published.snapshot);
      queryClient.setQueryData(["admin", "policy"], (current: typeof policyQuery.data) => current && ({ ...current, snapshot: published.snapshot }));
      setDraft(policy);
      setDraftBase({ revision: published.revision, policy });
      setReason("");
      setConflictRevision(undefined);
      setReviewing(false);
      void queryClient.invalidateQueries({ queryKey: ["admin", "history"] });
    } catch (error) {
      setFailed(true);
      if (error instanceof AdminApiError && error.status === 409) {
        setConflictRevision(error.details?.currentRevision);
        await policyQuery.refetch();
      }
    } finally {
      setPublishing(false);
    }
  };

  return <>
    <PolicyEditor view={{ ...policyQuery.data, snapshot: { ...policyQuery.data.snapshot, revision: draftBase.revision, ...draftBase.policy } }} draft={draft} scope={scope} search={search} onScopeChange={setScope} onSearchChange={setSearch} onDraftChange={setDraft} onDiscard={() => { setDraft(published); setDraftBase({ revision: policyQuery.data.snapshot.revision, policy: published }); setConflictRevision(undefined); }} onReview={() => { setFailed(false); setReviewing(true); }} />
    <PublishDialog open={reviewing} baseRevision={draftBase.revision} before={draftBase.policy} after={draft} reason={reason} onReasonChange={setReason} onOpenChange={setReviewing} onPublish={publish} pending={publishing} failed={failed} conflictRevision={conflictRevision} conflictAfter={conflictRevision === undefined ? undefined : published} />
  </>;
}

function ControlState({ message, retry }: { message: string; retry?: () => unknown }) {
  const { t } = useLocale();
  return <section className="rounded-lg border border-border p-8 text-center"><p role="status">{message}</p>{retry ? <Button type="button" variant="outline" className="mt-4 min-h-11" onClick={retry}>{t.admin.actions.retry}</Button> : null}</section>;
}
