import { CourseRow, Empty, FeatureFrame, SectionPanel } from "@/components/shared";
import { api } from "@/lib/api";
import { useLocale } from "@/lib/i18n";
import { useFeatureQuery, useHyeboard } from "@/state";

export function CoursesPage() {
  const state = useHyeboard();
  const { t } = useLocale();
  const query = useFeatureQuery("courses", () => api.courses(state.universityId));
  return (
    <FeatureFrame title={t.courses.title} description={t.courses.description} query={query}>
      {(items) => items.length
        ? <SectionPanel title={t.courses.listTitle} testId="courses-section">{items.map((course) => <CourseRow key={course.id} course={course} variant="row" />)}</SectionPanel>
        : <Empty text={t.courses.none} />}
    </FeatureFrame>
  );
}
