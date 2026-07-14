import { Skeleton } from "@/components/ui/skeleton";
import { AssignmentItem, CourseRow, Empty, FeedItem, QueryErrorPanel, ScheduleItem, SectionPanel, SummaryStat, SummaryStrip } from "@/components/shared";
import { useLocale } from "@/lib/i18n";
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
  const { dashboard } = useHyeboard();
  const { t, locale } = useLocale();
  const data = dashboard.data;
  if (dashboard.isLoading) return <DashboardSkeleton />;
  if (dashboard.error) return <QueryErrorPanel error={dashboard.error} />;

  const today = new Intl.DateTimeFormat(locale, { weekday: "long", month: "long", day: "numeric" }).format(new Date());
  const missingCount = data?.assignments?.filter((item) => item.status === "missing").length ?? 0;
  const nextClassLabel = data?.nextClass
    ? `${t.dashboard.nextClass}: ${data.nextClass.courseCode} · ${data.nextClass.timeLabel ?? formatDateTime(data.nextClass.startTime)}`
    : `${t.dashboard.allClear} · ${t.dashboard.noUpcomingClass}`;

  return (
    <div className="space-y-6 animate-page">
      <header className="space-y-1">
        <p className="text-sm text-muted-foreground">
          {today} · {data?.currentTerm?.name ?? t.dashboard.currentTerm} · {data?.student?.studentCode ?? t.common.demo}
        </p>
        <h1 className="text-2xl font-semibold tracking-[-0.02em] md:text-3xl">{t.dashboard.welcomeBack(data?.student?.fullName ?? t.dashboard.student)}</h1>
        <p className="text-sm text-muted-foreground">{nextClassLabel}</p>
      </header>

      <SummaryStrip testId="dashboard-summary">
        <SummaryStat label={t.dashboard.gpa} value={data?.gpa?.gpa?.toFixed(2) ?? "-"} detail={`${t.grades.cpa} ${data?.gpa?.cpa?.toFixed(2) ?? "-"}`} />
        <SummaryStat
          label={t.dashboard.credits}
          value={String(data?.gpa?.totalAccumulatedCredits ?? "-")}
          detail={data?.courseCount ? t.dashboard.completedEnrolled(data.courseCount.completed, data.courseCount.inTerm) : t.dashboard.thisTerm(data?.gpa?.totalCredits ?? 0)}
        />
        <SummaryStat label={t.dashboard.assignments} value={String(data?.assignments?.length ?? 0)} detail={t.dashboard.requireAttention(missingCount)} />
        <SummaryStat label={t.dashboard.tuition} value={formatCurrency(data?.tuition?.remainingAmount)} detail={t.dashboard.outstandingBalance} />
      </SummaryStrip>

      <div className="grid gap-4 xl:grid-cols-2">
        <SectionPanel testId="dashboard-schedule" title={t.dashboard.todaySchedule} description={t.dashboard.todayScheduleDesc}>
          {data?.todaySchedule?.length ? data.todaySchedule.map((item) => <ScheduleItem key={item.id} item={item} />) : <Empty text={t.dashboard.noClassesToday} />}
        </SectionPanel>
        <SectionPanel testId="dashboard-assignments" title={t.dashboard.assignmentTimeline} description={t.dashboard.assignmentTimelineDesc}>
          {data?.assignments?.length ? data.assignments.slice(0, 5).map((item) => <AssignmentItem key={item.id} item={item} />) : <Empty text={t.dashboard.noAssignmentsAttention} />}
        </SectionPanel>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <SectionPanel testId="dashboard-courses" title={t.dashboard.activeCourses} description={t.dashboard.activeCoursesDesc}>
          {data?.courses?.length ? data.courses.map((course) => <CourseRow key={course.id} course={course} variant="row" />) : <Empty text={t.dashboard.noCoursesYet} />}
        </SectionPanel>
        <SectionPanel testId="dashboard-notifications" title={t.dashboard.recentNotifications} description={t.dashboard.recentNotificationsDesc}>
          {data?.notifications?.length ? data.notifications.map((item) => <FeedItem key={item.id} title={item.title} detail={item.source ?? t.common.university} />) : <Empty text={t.dashboard.noRecentNotifications} />}
        </SectionPanel>
      </div>
    </div>
  );
}
