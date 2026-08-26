import type { FeaturePolicyAuditEntry, FeaturePolicyContent } from "@hyeboard/schemas";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useAdminSession } from "@/components/admin/admin-layout";
import { PolicyHistory } from "@/components/admin/policy-history";
import { PublishDialog } from "@/components/admin/publish-dialog";
import { AdminApiError, adminApi } from "@/lib/admin-api";
import { useLocale } from "@/lib/i18n";

const PAGE_SIZE = 20;
const content = (value: { global: FeaturePolicyContent["global"]; universities: FeaturePolicyContent["universities"] }): FeaturePolicyContent => ({ global: value.global, universities: value.universities });

type AdminPolicyCache = { snapshot: FeaturePolicyAuditEntry["snapshot"] };
type AdminHistoryCache = { items: FeaturePolicyAuditEntry[]; nextBeforeRevision?: number };

export function historyPageState(beforeRevision: number | undefined, isError: boolean) {
  return {
    initialError: beforeRevision === undefined && isError,
    loadMoreError: beforeRevision !== undefined && isError,
  };
}

export function seedRollbackCaches(queryClient: Pick<ReturnType<typeof useQueryClient>, "setQueryData" | "invalidateQueries">, published: FeaturePolicyAuditEntry) {
  queryClient.setQueryData<AdminPolicyCache>(["admin", "policy"], (current) => current && ({ ...current, snapshot: published.snapshot }));
  queryClient.setQueryData<AdminHistoryCache>(["admin", "history", undefined], (current) => current && ({ ...current, items: [published, ...current.items.filter(({ revision }) => revision !== published.revision)] }));
  queryClient.setQueryData(["admin", "history", "revision", published.revision], published);
  void queryClient.invalidateQueries({ queryKey: ["admin", "history", undefined], exact: true }).catch(() => undefined);
}

export function AdminHistoryPage() {
  const { session, policyRevision } = useAdminSession();
  const { t } = useLocale();
  const queryClient = useQueryClient();
  const policyQuery = useQuery({ queryKey: ["admin", "policy"], queryFn: adminApi.policy, retry: false });
  const [beforeRevision, setBeforeRevision] = useState<number>();
  const historyQuery = useQuery({ queryKey: ["admin", "history", beforeRevision], queryFn: () => adminApi.history({ limit: PAGE_SIZE, beforeRevision }), retry: false });
  const [items, setItems] = useState<FeaturePolicyAuditEntry[]>([]);
  const [selectedRevision, setSelectedRevision] = useState<number>();
  const detailQuery = useQuery({ queryKey: ["admin", "history", "revision", selectedRevision], queryFn: () => adminApi.revision(selectedRevision!), enabled: selectedRevision !== undefined, retry: false });
  const baseRevision = detailQuery.data?.baseRevision;
  const baseQuery = useQuery({ queryKey: ["admin", "history", "revision", baseRevision], queryFn: () => adminApi.revision(baseRevision!), enabled: baseRevision !== undefined && baseRevision > 0, retry: false });
  const [rollbackEntry, setRollbackEntry] = useState<FeaturePolicyAuditEntry>();
  const [rollbackBase, setRollbackBase] = useState<{ revision: number; policy: FeaturePolicyContent }>();
  const [reason, setReason] = useState("");
  const [rollingBack, setRollingBack] = useState(false);
  const [rollbackFailed, setRollbackFailed] = useState(false);
  const [conflictRevision, setConflictRevision] = useState<number>();

  useEffect(() => {
    if (policyRevision === undefined) return;
    setItems([]);
    setBeforeRevision(undefined);
  }, [policyRevision]);

  const pageItems = historyQuery.data?.items ?? [];
  const visibleItems = beforeRevision === undefined ? pageItems : [...items, ...pageItems.filter(({ revision }) => !items.some((item) => item.revision === revision))];
  const { initialError, loadMoreError } = historyPageState(beforeRevision, historyQuery.isError);
  const initialHistoryError = initialError && !pageItems.length;
  const loadMore = () => {
    if (!historyQuery.data?.nextBeforeRevision) return;
    setItems(visibleItems);
    setBeforeRevision(historyQuery.data.nextBeforeRevision);
  };
  const retry = () => Promise.all([
    historyQuery.isError ? historyQuery.refetch() : undefined,
    policyQuery.isError ? policyQuery.refetch() : undefined,
    detailQuery.isError ? detailQuery.refetch() : undefined,
    baseQuery.isError ? baseQuery.refetch() : undefined,
  ]);
  const rollback = async () => {
    if (!rollbackEntry || !rollbackBase) return;
    setRollingBack(true);
    setRollbackFailed(false);
    try {
      const published = await adminApi.rollback({ baseRevision: rollbackBase.revision, targetRevision: rollbackEntry.revision, reason }, session.csrfToken);
      seedRollbackCaches(queryClient, published);
      setRollbackEntry(undefined);
      setRollbackBase(undefined);
      setReason("");
      setItems([]);
      setBeforeRevision(undefined);
      setConflictRevision(undefined);
    } catch (error) {
      setRollbackFailed(true);
      if (error instanceof AdminApiError && error.status === 409) {
        setConflictRevision(error.details?.currentRevision);
        await policyQuery.refetch();
      }
    } finally {
      setRollingBack(false);
    }
  };

  return <>
    <PolicyHistory items={visibleItems} currentPolicy={policyQuery.data?.snapshot} selected={detailQuery.data} selectedBase={baseQuery.data} loading={(historyQuery.isPending && !items.length) || policyQuery.isPending} error={initialHistoryError || policyQuery.isError || detailQuery.isError || baseQuery.isError} loadMoreError={loadMoreError} hasMore={loadMoreError || historyQuery.data?.nextBeforeRevision !== undefined} loadingMore={historyQuery.isFetching && beforeRevision !== undefined} onRetry={retry} onLoadMore={loadMoreError ? () => historyQuery.refetch() : loadMore} onSelect={setSelectedRevision} onRollback={(entry) => { setRollbackFailed(false); setConflictRevision(undefined); setRollbackEntry(entry); if (policyQuery.data) setRollbackBase({ revision: policyQuery.data.snapshot.revision, policy: content(policyQuery.data.snapshot) }); }} />
    {rollbackEntry && rollbackBase ? <PublishDialog open baseRevision={rollbackBase.revision} before={rollbackBase.policy} after={content(rollbackEntry.snapshot)} reason={reason} onReasonChange={setReason} onOpenChange={(open) => { if (!open) { setRollbackEntry(undefined); setRollbackBase(undefined); } }} onPublish={rollback} pending={rollingBack} failed={rollbackFailed} conflictRevision={conflictRevision} conflictAfter={conflictRevision === undefined ? undefined : policyQuery.data && content(policyQuery.data.snapshot)} title={t.admin.history.rollbackTitle} description={t.admin.history.rollbackDescription} actionLabel={t.admin.actions.rollback} reasonLabel={t.admin.history.rollbackReason} reasonPlaceholder={t.admin.history.rollbackPlaceholder} /> : null}
  </>;
}
