import type { Assignment, ClassSession, Course } from "@hyeboard/schemas";
import { Link } from "@tanstack/react-router";
import { CheckCircle2, ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import { useLocale } from "@/lib/i18n";
import { formatStatus } from "@/lib/presentation";
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

export function StatusBadge({ value }: { value?: string | null }) {
  const { t } = useLocale();
  const status = formatStatus(value ?? undefined, t.status);
  return <Badge data-testid="status-badge" data-tone={status.tone}>{status.label}</Badge>;
}

export function SummaryStrip({ children, testId = "summary-strip" }: { children: ReactNode; testId?: string }) {
  return <div data-testid={testId} className="summary-strip">{children}</div>;
}

export function SummaryStat({ label, value, detail }: { label: string; value: ReactNode; detail?: string }) {
  return (
    <div className="summary-stat">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {detail ? <div className="mt-1 text-xs text-muted-foreground">{detail}</div> : null}
    </div>
  );
}

type SectionPanelProps = { title: ReactNode; description?: string; children: ReactNode; testId?: string };

export function SectionPanel({ title, description, children, testId }: SectionPanelProps) {
  return (
    <section data-testid={testId} className="section-panel">
      <header className="section-panel-header">
        <h2 className="text-base font-semibold">{title}</h2>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </header>
      <div className="divide-y divide-border">{children}</div>
    </section>
  );
}

export function ScheduleItem({ item }: { item: ClassSession }) {
  const { t } = useLocale();
  const label = item.timeLabel ?? (item.periodStart != null
    ? (item.periodEnd && item.periodEnd !== item.periodStart
      ? t.timetable.periodRange(item.periodStart, item.periodEnd)
      : t.timetable.periodSingle(item.periodStart))
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
      <StatusBadge value={item.status} />
    </div>
  );
}

type CourseRowProps = { course: Course; variant?: "card" | "row" };

export function CourseRow({ course, variant = "card" }: CourseRowProps) {
  const { t } = useLocale();
  const url = safeExternalUrl(course.url);

  if (variant === "row") {
    return (
      <div className="list-row">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{course.code}</p>
          <p className="truncate text-xs text-muted-foreground">{course.name}</p>
          {course.nextDeadline ? <p className="mt-1 truncate text-xs text-muted-foreground">{t.courses.nextDeadline(formatDateTime(course.nextDeadline))}</p> : null}
          {url ? <a className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline" href={url} target="_blank" rel="noreferrer"><ExternalLink size={12} /> {t.courses.openCoursePage}</a> : null}
        </div>
        <StatusBadge value={course.status ?? "active"} />
      </div>
    );
  }

  const className = "motion-surface block rounded-lg border border-border p-4 hover:bg-muted/40";
  const content = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0"><p className="truncate text-sm font-semibold">{course.code}</p><p className="truncate text-sm text-muted-foreground">{course.name}</p></div>
        <StatusBadge value={course.status ?? "active"} />
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

type FeedItemProps = { title: string; detail: ReactNode; url?: string };

export function FeedItem({ title, detail, url }: FeedItemProps) {
  const safeUrl = safeExternalUrl(url);
  const titleNode = safeUrl ? <a href={safeUrl} target="_blank" rel="noreferrer" className="hover:underline">{title}</a> : title;
  return (
    <div className="list-row">
      <div className="flex min-w-0 items-start gap-3">
        <CheckCircle2 className="mt-0.5 shrink-0 text-primary" size={16} />
        <div className="min-w-0"><p className="truncate text-sm font-medium">{titleNode}</p><div className="truncate text-xs text-muted-foreground">{detail}</div></div>
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
