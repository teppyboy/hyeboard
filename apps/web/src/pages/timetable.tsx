import type { ClassSession } from "@hyeboard/schemas";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, FeatureFrame, ScheduleItem, safeExternalUrl } from "@/components/shared";
import { api } from "@/lib/api";
import { useLocale } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useFeatureQuery, useHyeboard } from "@/state";

const weekdays = [
  { value: 1, key: "mon" },
  { value: 2, key: "tue" },
  { value: 3, key: "wed" },
  { value: 4, key: "thu" },
  { value: 5, key: "fri" },
  { value: 6, key: "sat" },
  { value: 7, key: "sun" },
] as const;

const periodBlocks = [
  { start: 1, end: 3, label: "07:00 - 09:40" },
  { start: 4, end: 6, label: "09:50 - 12:30" },
  { start: 7, end: 9, label: "13:30 - 16:10" },
  { start: 10, end: 12, label: "16:20 - 19:00" },
] as const;

type Weekday = (typeof weekdays)[number];

function currentIsoWeekday() {
  const day = new Date().getDay();
  return day === 0 ? 7 : day;
}

function ViewToggle<T extends string>({ value, onChange, options = ["list", "calendar"] as T[] }: { value: T; onChange: (value: T) => void; options?: T[] }) {
  const { t } = useLocale();
  const optionLabel = (option: T) => (option === "list" ? t.common.list : option === "calendar" ? t.common.calendar : option);
  return (
    <div className="flex flex-wrap justify-end gap-2">
      {options.map((option) => <Button key={option} variant={value === option ? "default" : "outline"} size="sm" className="max-lg:min-h-11" onClick={() => onChange(option)}>{optionLabel(option)}</Button>)}
    </div>
  );
}

function sessionsForBlock(items: ClassSession[], weekday: number, block: { start: number; end: number }) {
  return items
    .filter((item) => item.weekday === weekday && (item.periodStart ?? 0) >= block.start && (item.periodStart ?? 0) <= block.end)
    .sort((a, b) => (a.periodStart ?? 0) - (b.periodStart ?? 0) || a.courseName.localeCompare(b.courseName));
}

function TimetableSessionBlock({ item }: { item: ClassSession }) {
  const { t } = useLocale();
  const label = item.timeLabel ?? (item.periodStart != null ? t.timetable.periodRange(item.periodStart, item.periodEnd ?? item.periodStart) : undefined);
  const url = safeExternalUrl(item.url);
  return (
    <div className="timetable-session">
      <p className="line-clamp-2 font-medium text-foreground">{item.courseName}</p>
      <p className="mt-1 text-muted-foreground">{item.courseCode} · {item.type ?? t.timetable.classSession}</p>
      <p className="text-muted-foreground">{item.room ?? t.timetable.roomNotListed}</p>
      {item.instructor ? <p className="truncate text-muted-foreground">{item.instructor}</p> : null}
      {label ? <p className="mt-1 text-muted-foreground">{label}</p> : null}
      {url ? <a className="mt-1 inline-flex items-center gap-1 font-medium text-primary hover:underline" href={url} target="_blank" rel="noreferrer"><ExternalLink size={11} /> {t.timetable.openClassPage}</a> : null}
    </div>
  );
}

function DesktopTimetableGrid({ items, visibleWeekdays, currentWeekday }: { items: ClassSession[]; visibleWeekdays: readonly Weekday[]; currentWeekday: number }) {
  const { t } = useLocale();
  const columns = `8.5rem repeat(${visibleWeekdays.length}, minmax(0, 1fr))`;
  return (
    <div data-testid="desktop-timetable" className="hidden overflow-x-auto rounded-xl border border-border lg:block">
      <div className="min-w-[900px]">
        <div className="timetable-grid-row timetable-grid-header" style={{ gridTemplateColumns: columns }}>
          <div className="timetable-grid-cell">{t.timetable.periodHeader}</div>
          {visibleWeekdays.map((day) => (
            <div
              key={day.value}
              role="columnheader"
              data-current-day={day.value === currentWeekday ? "true" : undefined}
              className={cn("timetable-grid-cell timetable-header-cell", day.value === currentWeekday && "timetable-current-col")}
            >
              {t.weekday[day.key]}
            </div>
          ))}
        </div>
        {periodBlocks.map((block) => (
          <div key={block.start} className="timetable-grid-row" style={{ gridTemplateColumns: columns }}>
            <div className="timetable-grid-cell timetable-period-cell">
              <p className="font-semibold text-foreground">{t.timetable.periodRange(block.start, block.end)}</p>
              <p>{block.label}</p>
            </div>
            {visibleWeekdays.map((day) => {
              const sessions = sessionsForBlock(items, day.value, block);
              return (
                <div key={day.value} className={cn("timetable-grid-cell timetable-day-col", day.value === currentWeekday && "timetable-current-col")}>
                  {sessions.map((item) => <TimetableSessionBlock key={item.id} item={item} />)}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function MobileTimetableGroups({ items, visibleWeekdays, currentWeekday }: { items: ClassSession[]; visibleWeekdays: readonly Weekday[]; currentWeekday: number }) {
  const { t } = useLocale();
  const groups = visibleWeekdays
    .map((day) => ({
      day,
      sessions: items
        .filter((item) => item.weekday === day.value)
        .sort((a, b) => (a.periodStart ?? 0) - (b.periodStart ?? 0)),
    }))
    .filter((group) => group.sessions.length > 0);

  if (!groups.length) return <Empty text={t.timetable.noClasses} />;

  return (
    <div className="space-y-4">
      {groups.map(({ day, sessions }) => (
        <Card key={day.value} className={cn(day.value === currentWeekday && "timetable-current-day")}>
          <CardContent className="p-0">
            <div className="timetable-day-heading">{t.weekday[day.key]}</div>
            <div className="divide-y divide-border px-5">
              {sessions.map((item) => <ScheduleItem key={item.id} item={item} />)}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function TimetableList({ items }: { items: ClassSession[] }) {
  return <Card><CardContent className="divide-y divide-border p-5">{[...items].sort((a, b) => (a.weekday ?? 0) - (b.weekday ?? 0) || (a.periodStart ?? 0) - (b.periodStart ?? 0)).map((item) => <ScheduleItem key={item.id} item={item} />)}</CardContent></Card>;
}

export function TimetablePage() {
  const state = useHyeboard();
  const { t } = useLocale();
  const [view, setView] = useState<"calendar" | "list">("calendar");
  const query = useFeatureQuery("timetable", () => api.timetable(state.universityId, state.termCode));
  return (
    <FeatureFrame title={t.timetable.title} description={t.timetable.description} query={query}>
      {(items) => {
        if (!items.length) return <Empty text={t.timetable.noClasses} />;
        const visibleWeekdays = weekdays.filter((day) => day.value !== 7 || items.some((item) => item.weekday === 7));
        const currentWeekday = currentIsoWeekday();
        return (
          <div className="space-y-4">
            <ViewToggle value={view} onChange={setView} />
            <div key={view} className="view-panel">
              {view === "calendar" ? (
                <>
                  <DesktopTimetableGrid items={items} visibleWeekdays={visibleWeekdays} currentWeekday={currentWeekday} />
                  <div data-testid="mobile-timetable" className="lg:hidden">
                    <MobileTimetableGroups items={items} visibleWeekdays={visibleWeekdays} currentWeekday={currentWeekday} />
                  </div>
                </>
              ) : (
                <TimetableList items={items} />
              )}
            </div>
          </div>
        );
      }}
    </FeatureFrame>
  );
}
