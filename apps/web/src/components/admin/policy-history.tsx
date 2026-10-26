import type { FeaturePolicyAuditEntry, FeaturePolicySnapshot } from "@hyeboard/schemas";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/lib/i18n";
import { policyDiff } from "./policy-editor";
import { DiffList } from "./publish-dialog";

export type PolicyHistoryProps = {
  items: FeaturePolicyAuditEntry[];
  currentPolicy?: FeaturePolicySnapshot;
  selected?: FeaturePolicyAuditEntry;
  selectedBase?: FeaturePolicyAuditEntry;
  loading?: boolean;
  error?: boolean;
  loadMoreError?: boolean;
  hasMore?: boolean;
  loadingMore?: boolean;
  onRetry?: () => void;
  onLoadMore?: () => void;
  onSelect?: (revision: number) => void;
  onRollback?: (entry: FeaturePolicyAuditEntry) => void;
};

export function PolicyHistory({ items, currentPolicy, selected, selectedBase, loading, error, loadMoreError, hasMore, loadingMore, onRetry, onLoadMore, onSelect, onRollback }: PolicyHistoryProps) {
  const { locale, t } = useLocale();
  if (loading) return <HistoryState message={t.admin.history.loading} />;
  if (error) return <HistoryState message={t.admin.history.error} error retry={onRetry} />;
  if (!items.length) return <HistoryState message={t.admin.history.empty} description={t.admin.history.emptyDescription} />;
  const selectedDiff = selected ? policyDiff(
    selectedBase?.snapshot ?? items.find(({ revision }) => revision === selected.baseRevision)?.snapshot ?? { global: { capabilities: {}, limits: {} }, universities: {} },
    selected.snapshot,
  ) : [];
  return (
    <section className="space-y-5">
      <header><h1 className="text-2xl font-semibold tracking-tight">{t.admin.history.title}</h1><p className="mt-1 text-sm text-muted-foreground">{t.admin.history.description}</p></header>
      <div className="overflow-hidden rounded-lg border border-border">
        {items.map((entry) => <article key={entry.revision} className="grid gap-3 border-b border-border p-4 last:border-b-0 sm:grid-cols-[1fr_auto] sm:items-center"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold">{t.admin.history.revision} {entry.revision}</h2><span className="rounded bg-muted px-2 py-0.5 text-xs">{t.admin.auth[entry.actor.method]}</span></div><p className="mt-1 break-words text-sm text-muted-foreground">{entry.actor.label ?? entry.actor.subject} · <time dateTime={entry.publishedAt}>{new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(entry.publishedAt))}</time></p><p className="mt-2 break-words text-sm">{entry.reason}</p></div><Button type="button" variant="outline" className="min-h-11" onClick={() => onSelect?.(entry.revision)}>{t.admin.history.select}</Button></article>)}
      </div>
      {loadMoreError ? <div className="flex flex-wrap items-center gap-3" role="alert"><p className="text-sm text-destructive">{t.admin.history.loadMoreError}</p><Button type="button" variant="outline" className="min-h-11" onClick={onLoadMore}>{t.admin.actions.retry}</Button></div> : hasMore ? <div className="space-y-2"><p className="text-sm text-muted-foreground" role="status">{loadingMore ? t.admin.history.loadingMore : t.admin.history.loadMoreDescription}</p><Button type="button" variant="outline" className="min-h-11" disabled={loadingMore} onClick={onLoadMore}>{t.admin.actions.loadMore}</Button></div> : null}
      {selected ? <section className="space-y-3 rounded-lg border border-border p-4"><div><h2 className="text-lg font-semibold">{t.admin.history.detail}: {t.admin.history.revision} {selected.revision}</h2><dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2"><div><dt className="text-muted-foreground">{t.admin.history.actor}</dt><dd>{selected.actor.label ?? selected.actor.subject} · {t.admin.auth[selected.actor.method]}</dd></div><div><dt className="text-muted-foreground">{t.admin.history.published}</dt><dd>{new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(selected.publishedAt))}</dd></div><div className="sm:col-span-2"><dt className="text-muted-foreground">{t.admin.history.reason}</dt><dd>{selected.reason}</dd></div></dl></div><DiffList items={selectedDiff} />{currentPolicy && selected.revision !== currentPolicy.revision ? <Button type="button" className="min-h-11" onClick={() => onRollback?.(selected)}>{t.admin.actions.rollback}</Button> : null}</section> : null}
    </section>
  );
}

function HistoryState({ message, description, error, retry }: { message: string; description?: string; error?: boolean; retry?: () => void }) {
  const { t } = useLocale();
  return <section className="rounded-lg border border-border p-8 text-center"><p className={error ? "text-destructive" : "text-muted-foreground"} role={error ? "alert" : "status"}>{message}</p>{description ? <p className="mx-auto mt-2 max-w-prose text-sm text-muted-foreground">{description}</p> : null}{retry ? <Button type="button" variant="outline" className="mt-4 min-h-11" onClick={retry}>{t.admin.actions.retry}</Button> : null}</section>;
}
