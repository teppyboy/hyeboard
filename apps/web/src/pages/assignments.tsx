import { Card, CardContent } from "@/components/ui/card";
import { AssignmentItem, Empty, FeatureFrame } from "@/components/shared";
import { api } from "@/lib/api";
import { useLocale } from "@/lib/i18n";
import { useFeatureQuery, useHyeboard } from "@/state";

export function AssignmentsPage() {
  const state = useHyeboard();
  const { t } = useLocale();
  const query = useFeatureQuery("assignments", () => api.assignments(state.universityId));
  return <FeatureFrame title={t.assignments.title} description={t.assignments.description} query={query}>{(items) => items.length ? <Card><CardContent className="divide-y divide-border p-5">{items.map((item) => <AssignmentItem key={item.id} item={item} />)}</CardContent></Card> : <Empty text={t.assignments.noneDue} />}</FeatureFrame>;
}
