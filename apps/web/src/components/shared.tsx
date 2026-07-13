import type { Assignment, ClassSession, Course } from "@hyeboard/schemas";
import { Link } from "@tanstack/react-router";
import { CheckCircle2, ExternalLink, type LayoutDashboard } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import { useLocale } from "@/lib/i18n";
import { cn, formatDateTime } from "@/lib/utils";

const VNU_UET_LOGO_URL = "https://2489013871.e.cdneverest.net/uet.edu.vn/2017/02/cropped-logo2_new-1-180x180.png";
const VNU_LOGO_URL = "https://raw.githubusercontent.com/gawgua/vnu-dashboard/master/public/vnu_logo.png";

export function universityLogoUrl(universityId: string): string | undefined {
  if (universityId === "uet") return VNU_UET_LOGO_URL;
  if (universityId === "vnu") return VNU_LOGO_URL;
  return undefined;
}

export function safeExternalUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

type FeatureFrameProps<T> = { title: string; description: string; query: { data?: T; error: Error | null; isLoading: boolean }; children: (data: T) => ReactNode };

export function FeatureFrame<T>({ title, description, query, children }: FeatureFrameProps<T>) {
  const { t } = useLocale();
  if (query.isLoading) return <PageSkeleton />;
  if (query.error) return <QueryErrorPanel error={query.error} />;
  return <div className="animate-page space-y-4"><FeatureHeader title={title} description={description} />{query.data ? children(query.data) : <Empty text={t.common.noData} />}</div>;
}

export function FeatureHeader({ title, description, actions }: { title: string; description: string; actions?: ReactNode }) {
  return <div><h1 className="text-2xl font-semibold tracking-tight md:text-3xl">{title}</h1><p className="mt-1 text-sm text-muted-foreground">{description}</p>{actions}</div>;
}

type MetricProps = { title: string; value: string; detail: string; icon?: typeof LayoutDashboard; tone?: "default" | "accent" };

export function Metric({ title, value, detail, icon: Icon, tone = "default" }: MetricProps) {
  return (
    <div className={cn("stat-card", tone === "accent" && "accent")}>
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">{title}</p>
        {Icon ? <Icon className={cn("h-4 w-4", tone === "accent" ? "text-primary" : "text-muted-foreground")} /> : null}
      </div>
      <p className={cn("mt-2 text-3xl font-semibold tracking-tight", tone === "accent" && "text-primary")}>{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

export function ScheduleItem({ item }: { item: ClassSession }) {
  const { t } = useLocale();
  const label = item.timeLabel ?? (item.periodStart != null
    ? `${t.timetable.periodHeader} ${item.periodStart}${item.periodEnd && item.periodEnd !== item.periodStart ? `–${item.periodEnd}` : ""}`
    : formatDateTime(item.startTime));
  return (
    <div className="list-row">
      <div className="min-w-0">
        <p className="truncate font-medium">{item.courseName}</p>
        <p className="truncate text-xs text-muted-foreground">{item.courseCode} · {item.room ?? t.timetable.noRoom} · {item.instructor ?? t.timetable.instructorTbd}</p>
        {safeExternalUrl(item.url) ? <a className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline" href={safeExternalUrl(item.url)} target="_blank" rel="noreferrer"><ExternalLink size={12} /> {t.timetable.openClassPage}</a> : null}
      </div>
      <Badge className="shrink-0 border border-border bg-background font-normal text-foreground">{label}</Badge>
    </div>
  );
}

export function AssignmentItem({ item }: { item: Assignment }) {
  const { t } = useLocale();
  return (
    <div className="list-row">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{item.title}</p>
        <p className="truncate text-xs text-muted-foreground">{item.courseName ?? item.courseCode ?? t.assignments.learningPlatform} · {formatDateTime(item.dueAt)}</p>
      </div>
      <Badge className={cn("shrink-0", item.status === "missing" ? "bg-destructive text-destructive-foreground" : "border border-border bg-background font-normal text-foreground")}>{item.status}</Badge>
    </div>
  );
}

export function CourseRow({ course }: { course: Course }) {
  const { t } = useLocale();
  const className = "motion-surface block rounded-lg border border-border p-4 hover:bg-muted/40";
  const url = safeExternalUrl(course.url);
  const content = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0"><p className="truncate text-sm font-semibold">{course.code}</p><p className="truncate text-sm text-muted-foreground">{course.name}</p></div>
        <Badge className="shrink-0 border border-border bg-background font-normal text-foreground">{course.status ?? t.courses.statusActive}</Badge>
      </div>
      {course.nextDeadline ? <p className="mt-2 text-xs text-muted-foreground">{t.courses.nextDeadline(formatDateTime(course.nextDeadline))}</p> : null}
      {url ? <p className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary"><ExternalLink size={12} /> {t.courses.openCoursePage}</p> : null}
    </>
  );
  return url ? (
    <a className={className} href={url} target="_blank" rel="noreferrer">{content}</a>
  ) : (
    <div className={className}>{content}</div>
  );
}

type FeedItemProps = { title: string; detail: string; url?: string };

export function FeedItem({ title, detail, url }: FeedItemProps) {
  const safeUrl = safeExternalUrl(url);
  const titleNode = safeUrl ? <a href={safeUrl} target="_blank" rel="noreferrer" className="hover:underline">{title}</a> : title;
  return (
    <div className="list-row">
      <div className="flex min-w-0 items-start gap-3">
        <CheckCircle2 className="mt-0.5 shrink-0 text-primary" size={16} />
        <div className="min-w-0"><p className="truncate text-sm font-medium">{titleNode}</p><p className="truncate text-xs text-muted-foreground">{detail}</p></div>
      </div>
    </div>
  );
}

export function DataTable({ headers, rows, emptyText }: { headers: string[]; rows: ReactNode[][]; emptyText?: string }) {
  const { t } = useLocale();
  if (!rows.length) return <Empty text={emptyText ?? t.common.noRows} />;
  return <div className="overflow-hidden rounded-xl border border-border"><table className="w-full border-collapse text-sm"><thead className="bg-muted text-muted-foreground"><tr>{headers.map((header) => <th key={header} className="px-3 py-2 text-left font-medium">{header}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index} className="border-t border-border">{row.map((cell, cellIndex) => <td key={cellIndex} className="px-3 py-2">{cell}</td>)}</tr>)}</tbody></table></div>;
}

function LoginNeeded({ message }: { message: string }) {
  const { t } = useLocale();
  return <Card><CardHeader><CardTitle>{t.common.loginNeeded}</CardTitle><CardDescription>{message}</CardDescription></CardHeader><CardContent className="flex flex-wrap gap-2"><Link to="/login"><Button>{t.common.openLogin}</Button></Link></CardContent></Card>;
}

function CanvasRequired({ message }: { message: string }) {
  const { t } = useLocale();
  return (
    <Card>
      <CardHeader><CardTitle>{t.canvasRequired.title}</CardTitle><CardDescription>{message}</CardDescription></CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2">
        <Link to="/login"><Button variant="outline">{t.canvasRequired.addToken}</Button></Link>
        <p className="text-xs text-muted-foreground">{t.canvasRequired.note}</p>
      </CardContent>
    </Card>
  );
}

function NotSupported({ message }: { message: string }) {
  const { t } = useLocale();
  return <Card><CardHeader><CardTitle>{t.notSupported.title}</CardTitle><CardDescription>{message}</CardDescription></CardHeader><CardContent className="flex flex-wrap gap-2"><Link to="/"><Button variant="outline">{t.common.return}</Button></Link></CardContent></Card>;
}

export function QueryErrorPanel({ error }: { error: Error }) {
  if (error instanceof ApiError && error.code === "UNSUPPORTED_FEATURE") return <NotSupported message={error.message} />;
  return error instanceof ApiError && error.code?.startsWith("CANVAS_")
    ? <CanvasRequired message={error.message} />
    : <LoginNeeded message={error.message} />;
}

export function Empty({ text }: { text: string }) { return <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">{text}</div>; }
export function PageSkeleton() { return <div className="space-y-4"><Skeleton className="h-12" /><Skeleton className="h-40" /><Skeleton className="h-40" /></div>; }
