import { CourseRow, FeatureFrame } from "@/components/shared";
import { api } from "@/lib/api";
import { useLocale } from "@/lib/i18n";
import { useFeatureQuery, useHyeboard } from "@/state";

export function CoursesPage() {
  const state = useHyeboard();
  const { t } = useLocale();
  const query = useFeatureQuery("courses", () => api.courses(state.universityId));
  return <FeatureFrame title={t.courses.title} description={t.courses.description} query={query}>{(items) => <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{items.map((course) => <CourseRow key={course.id} course={course} />)}</div>}</FeatureFrame>;
}
