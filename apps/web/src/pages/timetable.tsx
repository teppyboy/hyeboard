import type { ClassSession } from "@hyeboard/schemas";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, FeatureFrame, ScheduleItem, safeExternalUrl } from "@/components/shared";
import { api } from "@/lib/api";
import { useLocale } from "@/lib/i18n";
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

function ViewToggle<T extends string>({ value, onChange, options = ["list", "calendar"] as T[] }: { value: T; onChange: (value: T) => void; options?: T[] }) {
  const { t } = useLocale();
  const optionLabel = (option: T) => (option === "list" ? t.common.list : option === "calendar" ? t.common.calendar : option);
  return (
    <div className="flex flex-wrap justify-end gap-2">
      {options.map((option) => <Button key={option} variant={value === option ? "default" : "outline"} size="sm" onClick={() => onChange(option)}>{optionLabel(option)}</Button>)}
    </div>
  );
}

function sessionsForBlock(items: ClassSession[], weekday: number, block: { start: number; end: number }) {
  return items
    .filter((item) => item.weekday === weekday && (item.periodStart ?? 0) >= block.start && (item.periodStart ?? 0) <= block.end)
    .sort((a, b) => (a.periodStart ?? 0) - (b.periodStart ?? 0) || a.courseName.localeCompare(b.courseName));
}

function CalendarSessionCard({ item }: { item: ClassSession }) {
  const { t } = useLocale();
  return (
    <div className="motion-surface rounded-lg border border-border bg-background p-2 text-xs">
      <p className="line-clamp-2 font-medium text-foreground">{item.courseName}</p>
      <p className="mt-1 text-muted-foreground">{item.courseCode} · {item.type ?? t.timetable.classSession}</p>
      <p className="text-muted-foreground">{item.room ?? t.timetable.roomNotListed}</p>
      {item.instructor ? <p className="truncate text-muted-foreground">{item.instructor}</p> : null}
      {safeExternalUrl(item.url) ? <a className="mt-1 inline-flex items-center gap-1 font-medium text-primary hover:underline" href={safeExternalUrl(item.url)} target="_blank" rel="noreferrer"><ExternalLink size={11} /> {t.timetable.openClassPage}</a> : null}
    </div>
  );
}

function TimetableCalendar({ items }: { items: ClassSession[] }) {
  const { t } = useLocale();
  return (
      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <div className="min-w-[980px]">
          <div className="grid grid-cols-[8.5rem_repeat(7,minmax(0,1fr))] border-b border-border bg-muted/60 text-xs font-medium text-muted-foreground">
            <div className="px-3 py-3">{t.timetable.periodHeader}</div>
            {weekdays.map((day) => <div key={day.value} className="border-l border-border px-3 py-3 text-center">{t.weekday[day.key]}</div>)}
          </div>
          {periodBlocks.map((block) => (
            <div key={block.start} className="grid min-h-36 grid-cols-[8.5rem_repeat(7,minmax(0,1fr))] border-b border-border last:border-b-0">
              <div className="bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
                <p className="font-semibold text-foreground">{t.timetable.periodRange(block.start, block.end)}</p>
                <p>{block.label}</p>
              </div>
              {weekdays.map((day) => {
                const sessions = sessionsForBlock(items, day.value, block);
                return (
                  <div key={day.value} className="space-y-2 border-l border-border p-2">
                    {sessions.map((item) => <CalendarSessionCard key={item.id} item={item} />)}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
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
      {(items) => items.length ? (
        <div className="space-y-4">
          <ViewToggle value={view} onChange={setView} />
          <div key={view} className="view-panel">{view === "calendar" ? <TimetableCalendar items={items} /> : <TimetableList items={items} />}</div>
        </div>
      ) : <Empty text={t.timetable.noClasses} />}
    </FeatureFrame>
  );
}
