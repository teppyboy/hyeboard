import type { ExamSession } from "@hyeboard/schemas";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataTable, Empty, FeatureFrame } from "@/components/shared";
import { api } from "@/lib/api";
import { useLocale } from "@/lib/i18n";
import { useHyeboard } from "@/state";

function examDateKey(exam: ExamSession) {
  return (exam.startTime ?? exam.examDate).slice(0, 10);
}

function examTime(exam: ExamSession) {
  return exam.startTime ? new Date(exam.startTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "-";
}

function formatDateOnly(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

function ExamList({ items }: { items: ExamSession[] }) {
  const { t } = useLocale();
  const sorted = [...items].sort((a, b) => (a.startTime ?? a.examDate).localeCompare(b.startTime ?? b.examDate));
  return <DataTable headers={t.exams.headers} rows={sorted.map((exam) => [exam.courseName, exam.examType ?? t.exams.examType, exam.examMethod ?? "-", formatDateOnly(exam.examDate), examTime(exam), exam.examSession ? String(exam.examSession) : "-", exam.room ?? "-", exam.examNumber ?? "-"])} />;
}

function ExamCalendar({ items }: { items: ExamSession[] }) {
  const { t } = useLocale();
  const groups = items.reduce<Record<string, ExamSession[]>>((acc, exam) => {
    const key = examDateKey(exam);
    (acc[key] ??= []).push(exam);
    return acc;
  }, {});
  const days = Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {days.map(([day, exams]) => (
        <Card key={day}>
          <CardHeader className="pb-3"><CardTitle className="text-base">{formatDateOnly(day)}</CardTitle><CardDescription>{t.exams.scheduledExams(exams.length)}</CardDescription></CardHeader>
          <CardContent className="divide-y divide-border pt-0">
            {exams.sort((a, b) => (a.startTime ?? "").localeCompare(b.startTime ?? "")).map((exam) => (
              <div key={exam.id} className="list-row">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{exam.courseName}</p>
                  <p className="truncate text-xs text-muted-foreground">{exam.courseCode} · {exam.examMethod ?? exam.examType ?? t.exams.examType} · {exam.room ?? t.timetable.roomNotListed}</p>
                </div>
                <Badge className="shrink-0 border border-border bg-background font-normal text-foreground">{examTime(exam)}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function ExamsPage() {
  const state = useHyeboard();
  const { t } = useLocale();
  const [view, setView] = useState<"list" | "calendar">("list");
  const [selectedTerm, setSelectedTerm] = useState<string | undefined>(undefined);
  const terms = useQuery({
    queryKey: ["terms", state.universityId, state.sessionNonce],
    queryFn: async () => { await state.ensureSession(); return api.terms(state.universityId); },
  });
  const effectiveTerm = selectedTerm ?? state.termCode;
  const query = useQuery({
    queryKey: ["exams", state.universityId, effectiveTerm, state.sessionNonce],
    queryFn: async () => { await state.ensureSession(); return api.exams(state.universityId, effectiveTerm); },
  });
  return (
    <FeatureFrame title={t.exams.title} description={t.exams.description} query={query}>
      {(items) => (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            {terms.data?.length ? (
              <Select value={effectiveTerm ?? ""} onValueChange={(value) => setSelectedTerm(value)}>
                <SelectTrigger className="h-9 w-[220px]" aria-label={t.exams.term}><SelectValue placeholder={t.exams.term} /></SelectTrigger>
                <SelectContent>
                  {terms.data.map((term) => <SelectItem key={term.code} value={term.code}>{term.name}</SelectItem>)}
                </SelectContent>
              </Select>
            ) : <span />}
            <div className="flex gap-2">
              <Button variant={view === "list" ? "default" : "outline"} size="sm" onClick={() => setView("list")}>{t.common.list}</Button>
              <Button variant={view === "calendar" ? "default" : "outline"} size="sm" onClick={() => setView("calendar")}>{t.common.calendar}</Button>
            </div>
          </div>
          <div key={view} className="view-panel">{items.length ? (view === "list" ? <ExamList items={items} /> : <ExamCalendar items={items} />) : <Empty text={t.exams.noExams} />}</div>
        </div>
      )}
    </FeatureFrame>
  );
}
