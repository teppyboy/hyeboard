import type { Bill } from "@hyeboard/schemas";
import { DataTable, FeatureFrame, Metric, StatusBadge } from "@/components/shared";
import { api } from "@/lib/api";
import { useLocale } from "@/lib/i18n";
import { formatTermLabel } from "@/lib/presentation";
import { formatCurrency, formatDateTime } from "@/lib/utils";
import { useFeatureQuery, useHyeboard } from "@/state";

export function TuitionPage() {
  const state = useHyeboard();
  const { t } = useLocale();
  const query = useFeatureQuery("tuition", () => api.tuition(state.universityId));
  return (
    <FeatureFrame title={t.tuition.title} description={t.tuition.description} query={query}>
      {(tuition) => {
        const byTerm = tuition.bills.reduce<Record<string, Bill[]>>((acc, b) => {
          const key = b.termCode ?? (b.status === "credit" ? t.tuition.creditsAdjustments : t.tuition.other);
          (acc[key] ??= []).push(b);
          return acc;
        }, {});
        return (
          <div className="space-y-6">
            <div className="grid gap-3 md:grid-cols-3">
              <Metric title={t.tuition.total} value={formatCurrency(tuition.totalAmount)} detail={t.tuition.chargesPosted} />
              <Metric title={t.tuition.paid} value={formatCurrency(tuition.paidAmount)} detail={t.tuition.paymentsReceived} />
              <Metric title={t.tuition.remaining} value={formatCurrency(tuition.remainingAmount)} detail={t.tuition.amountDue} />
            </div>
            {Object.entries(byTerm).sort(([a], [b]) => b.localeCompare(a)).map(([term, bills]) => (
              <div key={term} className="space-y-2">
                <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{formatTermLabel(term, state.universityId, t.terms)}</h2>
                <DataTable headers={t.tuition.headers} rows={bills.map((b) => [b.title, <StatusBadge key={b.id} value={b.status} />, b.paidAt ? formatDateTime(b.paidAt) : "-", formatCurrency(b.totalAmount), formatCurrency(b.paidAmount), formatCurrency(b.remainingAmount)])} />
              </div>
            ))}
          </div>
        );
      }}
    </FeatureFrame>
  );
}
