import type { TrainingPoint } from "@hyeboard/schemas";
import { Empty, FeatureFrame, FeedItem, SectionPanel } from "@/components/shared";
import { api } from "@/lib/api";
import { useLocale } from "@/lib/i18n";
import { useFeatureQuery, useHyeboard } from "@/state";

function TrainingPointRow({ item }: { item: TrainingPoint }) {
  const { t } = useLocale();
  const score = item.score == null ? t.common.pending : `${item.score}/${item.maxScore ?? 100}`;
  return <FeedItem title={item.title} detail={score} />;
}

export function TrainingPointsPage() {
  const state = useHyeboard();
  const { t } = useLocale();
  const query = useFeatureQuery("training-points", () => api.trainingPoints(state.universityId));
  return (
    <FeatureFrame title={t.trainingPoints.title} description={t.trainingPoints.description} query={query}>
      {(items) => items.length
        ? <SectionPanel title={t.trainingPoints.listTitle} testId="training-points-section">{items.map((item) => <TrainingPointRow key={item.id} item={item} />)}</SectionPanel>
        : <Empty text={t.trainingPoints.none} />}
    </FeatureFrame>
  );
}
