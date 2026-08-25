import { useMemo } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AssignmentItem,
  CourseRow,
  Empty,
  FeedItem,
  QueryErrorPanel,
  ScheduleItem,
  SectionPanel,
  SummaryStat,
  SummaryStrip,
} from "@/components/shared";
import { useLocale } from "@/lib/i18n";
import { dashboardSections } from "@/lib/student-policy";
import { formatCurrency, formatDateTime } from "@/lib/utils";
import { useHyeboard } from "@/state";

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-20" />
      <Skeleton className="h-24" />
      <div className="grid gap-4 xl:grid-cols-2">
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
      </div>
    </div>
  );
}

export function DashboardPage() {
  const state = useHyeboard();
  const { dashboard } = state;
  const { t, locale } = useLocale();
  const data = dashboard.data;
  const capabilities = state.activeUniversity?.capabilities;
  const sections = dashboardSections(data, capabilities);
  const today = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        weekday: "long",
        month: "long",
        day: "numeric",
      }).format(new Date()),
    [locale],
  );
  if (state.policyMetadataPending === true) return <DashboardSkeleton />;
  if (!state.activeUniversity && state.policyMetadataPending !== undefined) return <Empty text={t.common.metadataUnavailable} />;
  if (dashboard.isLoading) return <DashboardSkeleton />;
  if (dashboard.error) return <QueryErrorPanel error={dashboard.error} />;
  const missingCount = data?.assignments?.filter((item) => item.status === "missing").length ?? 0;
  const nextClassLabel = sections.panels.timetable
    ? data?.nextClass
      ? `${t.dashboard.nextClass}: ${data.nextClass.courseCode} · ${data.nextClass.timeLabel ?? formatDateTime(data.nextClass.startTime)}`
      : `${t.dashboard.allClear} · ${t.dashboard.noUpcomingClass}`
    : undefined;
  const showSummary = Object.values(sections.stats).some(Boolean);

  return (
    <div className="space-y-6 animate-page">
      <header className="space-y-1">
        <p className="text-sm text-muted-foreground">
          {today} · {sections.identity.currentTerm?.name ?? t.dashboard.currentTerm} · {sections.identity.student?.studentCode ?? t.common.demo}
        </p>
        <h1 className="text-2xl font-semibold tracking-[-0.02em] md:text-3xl">
          {t.dashboard.welcomeBack(sections.identity.student?.fullName ?? t.dashboard.student)}
        </h1>
        {nextClassLabel ? <p className="text-sm text-muted-foreground">{nextClassLabel}</p> : null}
      </header>

      {showSummary ? (
        <SummaryStrip testId="dashboard-summary">
          {sections.stats.grades ? <SummaryStat label={t.dashboard.gpa} value={data?.gpa?.gpa?.toFixed(2) ?? "-"} detail={`${t.grades.cpa} ${data?.gpa?.cpa?.toFixed(2) ?? "-"}`} /> : null}
          {sections.stats.courses ? <SummaryStat label={t.dashboard.credits} value={String(data?.gpa?.totalAccumulatedCredits ?? "-")} detail={data?.courseCount ? t.dashboard.completedEnrolled(data.courseCount.completed, data.courseCount.inTerm) : t.dashboard.thisTerm(data?.gpa?.totalCredits ?? 0)} /> : null}
          {sections.stats.assignments ? <SummaryStat label={t.dashboard.assignments} value={String(data?.assignments?.length ?? 0)} detail={t.dashboard.requireAttention(missingCount)} /> : null}
          {sections.stats.tuition ? <SummaryStat label={t.dashboard.tuition} value={formatCurrency(data?.tuition?.remainingAmount)} detail={t.dashboard.outstandingBalance} /> : null}
        </SummaryStrip>
      ) : null}

      {sections.panels.timetable || sections.panels.assignments ? (
        <div className="grid gap-4 xl:grid-cols-2">
          {sections.panels.timetable ? (
            <SectionPanel testId="dashboard-schedule" title={t.dashboard.todaySchedule} description={t.dashboard.todayScheduleDesc}>
              {data?.todaySchedule?.length ? data.todaySchedule.map((item) => <ScheduleItem key={item.id} item={item} />) : <Empty text={t.dashboard.noClassesToday} />}
            </SectionPanel>
          ) : null}
          {sections.panels.assignments ? (
            <SectionPanel testId="dashboard-assignments" title={t.dashboard.assignmentTimeline} description={t.dashboard.assignmentTimelineDesc}>
              {data?.assignments?.length ? data.assignments.slice(0, 5).map((item) => <AssignmentItem key={item.id} item={item} />) : <Empty text={t.dashboard.noAssignmentsAttention} />}
            </SectionPanel>
          ) : null}
        </div>
      ) : null}

      {sections.panels.courses || sections.panels.notifications ? (
        <div className="grid gap-4 xl:grid-cols-2">
          {sections.panels.courses ? (
            <SectionPanel testId="dashboard-courses" title={t.dashboard.activeCourses} description={t.dashboard.activeCoursesDesc}>
              {data?.courses?.length ? data.courses.map((course) => <CourseRow key={course.id} course={course} variant="row" />) : <Empty text={t.dashboard.noCoursesYet} />}
            </SectionPanel>
          ) : null}
          {sections.panels.notifications ? (
            <SectionPanel testId="dashboard-notifications" title={t.dashboard.recentNotifications} description={t.dashboard.recentNotificationsDesc}>
              {data?.notifications?.length ? data.notifications.map((item) => <FeedItem key={item.id} title={item.title} detail={item.source ?? t.common.university} />) : <Empty text={t.dashboard.noRecentNotifications} />}
            </SectionPanel>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
