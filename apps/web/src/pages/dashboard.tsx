import { BookOpen, ClipboardList, GraduationCap, WalletCards } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AssignmentItem, CourseRow, Empty, FeedItem, Metric, QueryErrorPanel, ScheduleItem } from "@/components/shared";
import { useLocale } from "@/lib/i18n";
import { formatCurrency, formatDateTime } from "@/lib/utils";
import { useHyeboard } from "@/state";

function DashboardSkeleton() { return <div className="space-y-4"><Skeleton className="h-40" /><div className="grid gap-4 md:grid-cols-4"><Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="h-28" /></div></div>; }

export function DashboardPage() {
  const { dashboard } = useHyeboard();
  const { t } = useLocale();
  const data = dashboard.data;
  if (dashboard.isLoading) return <DashboardSkeleton />;
  if (dashboard.error) return <QueryErrorPanel error={dashboard.error} />;
  return (
    <div className="space-y-6 animate-page">
      <section className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2"><Badge className="bg-primary/10 text-primary">{data?.currentTerm?.name ?? t.dashboard.currentTerm}</Badge><Badge className="border border-border bg-background text-foreground">{data?.student?.studentCode ?? t.common.demo}</Badge></div>
          <h1 className="text-3xl font-semibold tracking-[-0.03em] md:text-4xl">{t.dashboard.welcomeBack(data?.student?.fullName ?? t.dashboard.student)}</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">{t.dashboard.subtitle}</p>
        </div>
        <Card className="animate-card min-w-64">
          <CardHeader className="pb-2"><CardDescription>{t.dashboard.nextClass}</CardDescription><CardTitle className="text-2xl">{data?.nextClass?.courseCode ?? t.dashboard.allClear}</CardTitle></CardHeader>
          <CardContent><p className="text-sm text-muted-foreground">{data?.nextClass ? (data.nextClass.timeLabel ?? formatDateTime(data.nextClass.startTime)) : t.dashboard.noUpcomingClass}</p></CardContent>
        </Card>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric title={t.dashboard.gpa} value={data?.gpa?.gpa?.toFixed(2) ?? "-"} detail={`${t.grades.cpa} ${data?.gpa?.cpa?.toFixed(2) ?? "-"}`} icon={GraduationCap} tone="accent" />
        <Metric title={t.dashboard.credits} value={String(data?.gpa?.totalAccumulatedCredits ?? "-")} detail={data?.courseCount ? t.dashboard.completedEnrolled(data.courseCount.completed, data.courseCount.inTerm) : t.dashboard.thisTerm(data?.gpa?.totalCredits ?? 0)} icon={BookOpen} />
        <Metric title={t.dashboard.assignments} value={String(data?.assignments?.length ?? 0)} detail={t.dashboard.requireAttention(data?.assignments?.filter((item) => item.status === "missing").length ?? 0)} icon={ClipboardList} />
        <Metric title={t.dashboard.tuition} value={formatCurrency(data?.tuition?.remainingAmount)} detail={t.dashboard.outstandingBalance} icon={WalletCards} />
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <Card className="animate-card">
          <CardHeader><CardTitle>{t.dashboard.todaySchedule}</CardTitle><CardDescription>{t.dashboard.todayScheduleDesc}</CardDescription></CardHeader>
          <CardContent className="divide-y divide-border pt-0">{data?.todaySchedule?.length ? data.todaySchedule.map((item) => <ScheduleItem key={item.id} item={item} />) : <Empty text={t.dashboard.noClassesToday} />}</CardContent>
        </Card>
        <Card className="animate-card">
          <CardHeader><CardTitle>{t.dashboard.assignmentTimeline}</CardTitle><CardDescription>{t.dashboard.assignmentTimelineDesc}</CardDescription></CardHeader>
          <CardContent className="divide-y divide-border pt-0">{data?.assignments?.length ? data.assignments.slice(0, 5).map((item) => <AssignmentItem key={item.id} item={item} />) : <Empty text={t.dashboard.noAssignmentsAttention} />}</CardContent>
        </Card>
      </section>

      <section className="grid gap-4 xl:grid-cols-3">
        <Card className="animate-card xl:col-span-2">
          <CardHeader><CardTitle>{t.dashboard.activeCourses}</CardTitle><CardDescription>{t.dashboard.activeCoursesDesc}</CardDescription></CardHeader>
          <CardContent className="grid gap-3 pt-0 md:grid-cols-2">{data?.courses?.length ? data.courses.map((course) => <CourseRow key={course.id} course={course} />) : <Empty text={t.dashboard.noCoursesYet} />}</CardContent>
        </Card>
        <Card className="animate-card">
          <CardHeader><CardTitle>{t.dashboard.recentNotifications}</CardTitle><CardDescription>{t.dashboard.recentNotificationsDesc}</CardDescription></CardHeader>
          <CardContent className="divide-y divide-border pt-0">{data?.notifications?.length ? data.notifications.map((item) => <FeedItem key={item.id} title={item.title} detail={item.source ?? t.common.university} />) : <Empty text={t.dashboard.noRecentNotifications} />}</CardContent>
        </Card>
      </section>
    </div>
  );
}
