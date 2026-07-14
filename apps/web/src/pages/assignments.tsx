import { AssignmentItem, Empty, FeatureFrame, SectionPanel } from "@/components/shared";
import { api } from "@/lib/api";
import { useLocale } from "@/lib/i18n";
import { useFeatureQuery, useHyeboard } from "@/state";

export function AssignmentsPage() {
  const state = useHyeboard();
  const { t } = useLocale();
  const query = useFeatureQuery("assignments", () => api.assignments(state.universityId));
  return (
    <FeatureFrame title={t.assignments.title} description={t.assignments.description} query={query}>
      {(items) => items.length
        ? <SectionPanel title={t.assignments.listTitle} testId="assignments-section">{items.map((item) => <AssignmentItem key={item.id} item={item} />)}</SectionPanel>
        : <Empty text={t.assignments.noneDue} />}
    </FeatureFrame>
  );
}
