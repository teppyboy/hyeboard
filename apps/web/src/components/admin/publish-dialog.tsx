import type { FeaturePolicyContent } from "@hyeboard/schemas";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { useLocale } from "@/lib/i18n";
import { policyDiff, type PolicyDiffItem } from "./policy-editor";

export type PublishDialogProps = {
  open: boolean;
  baseRevision: number;
  before: FeaturePolicyContent;
  after: FeaturePolicyContent;
  reason: string;
  onReasonChange: (reason: string) => void;
  onOpenChange: (open: boolean) => void;
  onPublish: () => void;
  pending?: boolean;
  failed?: boolean;
  conflictRevision?: number;
  conflictAfter?: FeaturePolicyContent;
  title?: string;
  description?: string;
  actionLabel?: string;
  reasonLabel?: string;
  reasonPlaceholder?: string;
};

export function PublishDialog({ open, onOpenChange, ...props }: PublishDialogProps) {
  const { t } = useLocale();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t.admin.actions.cancel}>
        <DialogTitle className="sr-only">{props.title ?? t.admin.publish.title}</DialogTitle>
        <PublishReviewContent {...props} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

export function PublishReviewContent({ baseRevision, before, after, reason, onReasonChange, onClose, onPublish, pending, failed, conflictRevision, conflictAfter, title, description, actionLabel, reasonLabel, reasonPlaceholder }: Omit<PublishDialogProps, "open" | "onOpenChange"> & { onClose: () => void }) {
  const { t } = useLocale();
  const diff = policyDiff(before, after);
  return <>
    <header className="space-y-1.5 pr-10"><h2 className="text-lg font-semibold">{title ?? t.admin.publish.title}</h2><p className="text-sm text-muted-foreground">{description ?? t.admin.publish.description}</p></header>
    <p className="text-sm font-medium">{t.admin.publish.baseRevision}: Revision {baseRevision}</p>
    {conflictRevision === undefined ? null : <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm" role="alert"><div><p>{t.admin.publish.conflict.replace("{revision}", String(conflictRevision))}</p><p className="mt-1 font-medium">{t.admin.publish.conflictPreserved}</p></div>{conflictAfter ? <div><p className="mb-1 font-medium">{t.admin.publish.intervening}</p><DiffList items={policyDiff(before, conflictAfter)} /></div> : null}</div>}
    <DiffList items={diff} />
    <label className="grid gap-2 text-sm font-medium" htmlFor="admin-publish-reason"><span>{reasonLabel ?? t.admin.publish.reason}</span><textarea id="admin-publish-reason" className="min-h-24 rounded-md border border-input bg-background px-3 py-2 text-sm font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value={reason} placeholder={reasonPlaceholder ?? t.admin.publish.reasonPlaceholder} maxLength={500} required disabled={pending} onChange={(event) => onReasonChange(event.target.value)} /></label>
    {failed ? <p className="text-sm text-destructive" role="alert">{t.admin.publish.failed}</p> : null}
    <DialogFooter><Button type="button" variant="outline" className="min-h-11" onClick={onClose} disabled={pending}>{t.admin.actions.cancel}</Button><Button type="button" className="min-h-11" onClick={onPublish} disabled={pending || conflictRevision !== undefined || !reason.trim() || !diff.length}>{pending ? t.admin.publish.publishing : actionLabel ?? t.admin.actions.publish}</Button></DialogFooter>
  </>;
}

export function DiffList({ items }: { items: PolicyDiffItem[] }) {
  const { t } = useLocale();
  if (!items.length) return <p className="rounded-md border border-border p-3 text-sm text-muted-foreground">{t.admin.publish.noChanges}</p>;
  const scopes = [...new Set(items.map(({ scope }) => scope))];
  return <div className="max-h-72 space-y-3 overflow-y-auto rounded-md border border-border p-3">{scopes.map((scope) => <section key={scope}><h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{scope === "global" ? t.admin.control.global : scope}</h3><ul className="divide-y divide-border">{items.filter((item) => item.scope === scope).map((item) => <li key={`${item.kind}:${item.key}`} className="grid gap-1 py-2 text-sm sm:grid-cols-[1fr_auto]"><span>{item.kind === "capability" ? t.admin.capabilities[item.key as keyof typeof t.admin.capabilities].label : t.admin.limits[item.key as keyof typeof t.admin.limits].label}</span><span className="font-mono text-xs">{formatDiffValue(item.before, item.scope, t)} → {formatDiffValue(item.after, item.scope, t)}</span></li>)}</ul></section>)}</div>;
}

function formatDiffValue(value: PolicyDiffItem["before"], scope: string, t: ReturnType<typeof useLocale>["t"]): string {
  if (value === true) return t.admin.publish.enabled;
  if (value === false) return t.admin.publish.disabled;
  if (value === null) return t.admin.publish.unlimited;
  if (value === undefined) return scope === "global" ? t.admin.publish.unset : t.admin.publish.inherit;
  return String(value);
}
