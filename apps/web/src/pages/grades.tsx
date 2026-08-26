import type { Grade } from "@hyeboard/schemas";
import { useMemo, useState } from "react";
import type { GradeTableRow } from "@/lib/grade-view-model";
import { GradeTable } from "@/components/grades/grade-table";
import { SummerBadge } from "@/components/grades/summer-badge";
import { AcademicTermSection } from "@/components/grades/academic-term-section";
import { ExportMenu } from "@/components/export-menu";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty, FeatureFrame, SummaryStat, SummaryStrip } from "@/components/shared";
import { api } from "@/lib/api";
import { createGradesExport } from "@/lib/data-export";
import { ALL_GRADE_TERMS, createGradeExportTerm, decodeGradeTermKey, encodeGradeTermKey, isSummerGrade, selectVisibleGradeSummaries, sortGrades, type GradeSortState } from "@/lib/grade-view-model";
import { useLocale } from "@/lib/i18n";
import { formatTermLabel, letterForGrade, letterTone } from "@/lib/presentation";
import { effectiveDashboardStudent } from "@/lib/student-policy";
import { calculateTermAcademicSummaries, newestAcademicTermsFirst } from "@/lib/term-academic-summary";
import { cn } from "@/lib/utils";
import { useFeatureQuery, useHyeboard } from "@/state";

export function CompactAcademicMetric({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </span>
  );
}

function LetterBadge({ letter, large }: { letter: string | undefined; large?: boolean }) {
  if (!letter) return <span className="text-muted-foreground">-</span>;
  return (
    <Badge
      data-testid={large ? "letter-badge-detail" : "letter-badge"}
      data-tone={letterTone(letter)}
      className={cn("justify-center font-semibold tabular-nums", large ? "min-w-12 px-3 py-1 text-lg" : "min-w-9 text-sm")}
    >
      {letter}
    </Badge>
  );
}

function VnuGradeDetail({ classId, termOrdinal }: { classId: string; termOrdinal: string }) {
  const { t } = useLocale();
  const state = useHyeboard();
  const detailQuery = useFeatureQuery(
    "vnu-point-detail",
    ({ signal }) => api.vnuPointDetail({ id: classId, Term: termOrdinal }, signal),
    {
      capability: "grades",
      queryKey: ["vnu-point-detail", state.universityId, state.sessionNonce, classId, termOrdinal],
    },
  );
  if (detailQuery.isLoading) return <div className="px-4 py-3" role="status"><Skeleton className="h-12" /><span className="sr-only">{t.grades.componentDetailLoading}</span></div>;
  if (detailQuery.error) return <div className="px-4 py-3" role="alert"><p className="text-sm text-muted-foreground">{t.grades.componentDetailError}</p></div>;
  if (!detailQuery.data?.components.length) return <div className="px-4 py-3"><Empty text={t.grades.componentDetailEmpty} /></div>;
  return (
    <div className="divide-y divide-border bg-muted/30 px-4">
      {detailQuery.data.components.map((component) => (
        <div key={component.index} className="list-row">
          <div className="min-w-0">
            <p className="break-words text-sm font-medium">{component.nature || "-"}</p>
            <p className="text-xs text-muted-foreground">{[
              component.weight != null ? t.grades.componentWeight(component.weight) : undefined,
              component.attempt != null ? t.grades.componentAttempt(component.attempt) : undefined,
            ].filter(Boolean).join(" · ") || "-"}</p>
          </div>
          <Badge className="shrink-0 border border-border bg-background font-normal tabular-nums text-foreground">{component.score ?? "-"}</Badge>
        </div>
      ))}
    </div>
  );
}

function GradeDetail({ grade, universityId }: { grade: Grade; universityId: string }) {
  const { t } = useLocale();
  const hasVnuDetailIdentity = universityId === "vnu" && Boolean(grade.classId && grade.termOrdinal);
  if (hasVnuDetailIdentity) return <VnuGradeDetail classId={grade.classId!} termOrdinal={grade.termOrdinal!} />;
  if (universityId === "vnu") return <div className="px-4 py-3"><Empty text={t.grades.componentDetailUnavailable} /></div>;
  const termLabel = grade.termCode ? formatTermLabel(grade.termCode, universityId, t.terms) : t.grades.unknownTerm;
  const stats: Array<{ label: string; value: string }> = [
    { label: t.grades.point10, value: grade.point10 != null ? String(grade.point10) : "-" },
    { label: t.grades.point4, value: grade.point4 != null ? String(grade.point4) : "-" },
    { label: t.grades.credits, value: grade.credits != null ? String(grade.credits) : "-" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-8 gap-y-3 border-t border-border bg-muted/30 px-4 py-3">
      <LetterBadge letter={letterForGrade(grade, universityId)} large />
      {stats.map((stat) => (
        <div key={stat.label}>
          <p className="text-xs text-muted-foreground">{stat.label}</p>
          <p className="text-sm font-medium tabular-nums">{stat.value}</p>
        </div>
      ))}
      <div>
        <p className="text-xs text-muted-foreground">{t.exams.term}</p>
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">{termLabel}</p>
          {isSummerGrade(grade, universityId) ? <SummerBadge /> : null}
        </div>
      </div>
      {/* Extension point: per-component score breakdown (midterm/final weights
          from the VNU point-detail API) slots in here as additional stat
          blocks once that data source lands. Never fabricate component
          scores in the meantime. */}
    </div>
  );
}

function GradesGradeTable({ grades, sort, onSortChange, universityId, emptyText }: { grades: Grade[]; sort: GradeSortState; onSortChange: (sort: GradeSortState) => void; universityId: string; emptyText: string }) {
  const rows: GradeTableRow[] = grades.map((grade) => ({
    id: grade.id,
    courseName: grade.courseName,
    credits: grade.credits,
    point10: grade.point10,
    letter: letterForGrade(grade, universityId),
    point4: grade.point4,
    isSummer: isSummerGrade(grade, universityId),
    detail: { kind: "available", render: () => <GradeDetail grade={grade} universityId={universityId} /> },
  }));
  return <GradeTable rows={rows} sort={sort} onSortChange={onSortChange} emptyText={emptyText} />;
}

export function GradesPage() {
  const state = useHyeboard();
  const { t } = useLocale();
  const defaultSort: GradeSortState = { key: "name", direction: "asc" };
  const [scopedSort, setScopedSort] = useState<{ accountId: string | null; sessionNonce: number; value: GradeSortState }>();
  const [scopedTerm, setScopedTerm] = useState<{ accountId: string | null; sessionNonce: number; value: string }>();
  const sort = scopedSort?.accountId === state.activeAccountId && scopedSort.sessionNonce === state.sessionNonce ? scopedSort.value : defaultSort;
  const selectedTerm = scopedTerm?.accountId === state.activeAccountId && scopedTerm.sessionNonce === state.sessionNonce ? scopedTerm.value : undefined;
  const setSort = (value: GradeSortState) => setScopedSort({ accountId: state.activeAccountId, sessionNonce: state.sessionNonce, value });
  const setSelectedTerm = (value: string) => setScopedTerm({ accountId: state.activeAccountId, sessionNonce: state.sessionNonce, value });
  const query = useFeatureQuery("grades", () => api.grades(state.universityId), { capability: "grades" });
  const gpa = state.dashboard.data?.gpa;
  const summaries = useMemo(
    () => newestAcademicTermsFirst(calculateTermAcademicSummaries(
      (query.data ?? []).map((grade) => ({
        termKey: encodeGradeTermKey(grade.termCode),
        credits: grade.credits,
        point4: grade.point4,
        course: grade,
        isSummer: isSummerGrade(grade, state.universityId),
      })),
      state.universityId,
    )),
    [query.data, state.universityId],
  );
  const termLabel = (rawTermCode: string | undefined) => rawTermCode
    ? formatTermLabel(rawTermCode, state.universityId, t.terms)
    : t.grades.unknownTerm;
  const { effectiveTerm, visibleSummaries } = selectVisibleGradeSummaries(summaries, selectedTerm);
  const visibleTermViews = visibleSummaries.map((summary) => {
    const rawTermCode = decodeGradeTermKey(summary.termKey);
    const label = termLabel(rawTermCode);
    const sortedCourses = sortGrades(summary.courses, sort);
    const exportTerm = createGradeExportTerm(summary, state.universityId, label, sortedCourses);
    return { summary, rawTermCode, label, sortedCourses, exportTerm };
  });
  const student = effectiveDashboardStudent(state.dashboard.data, state.activeUniversity?.capabilities);
  const exportIdentity = student ? {
    studentCode: student.studentCode,
    studentName: student.fullName,
    managingClass: student.className,
  } : undefined;
  const exportReported = gpa ? {
    cumulativeGpa4: gpa.gpa ?? undefined,
    totalCredits: gpa.totalCredits,
    accumulatedCredits: gpa.totalAccumulatedCredits,
  } : undefined;
  const exportsReady = !state.dashboard.isPending;
  const pageExportModel = summaries.length && exportsReady ? createGradesExport({
    surface: "grades-page",
    universityId: state.universityId,
    identity: exportIdentity,
    reported: exportReported,
    derivedTerms: visibleTermViews.map((view) => view.exportTerm),
  }) : undefined;

  return (
    <FeatureFrame
      title={t.grades.title}
      description={t.grades.description}
      query={query}
      actions={pageExportModel ? <div data-testid="grades-page-export"><ExportMenu model={pageExportModel} /></div> : undefined}
    >
      {() => (
          <div className="space-y-6">
            <SummaryStrip testId="grades-summary">
              <SummaryStat label={t.grades.reportedCumulativeGpa} value={gpa?.gpa?.toFixed(2) ?? "-"} detail={t.grades.gpaDetail} />
              <SummaryStat label={t.grades.reportedSecondaryGpa} value={gpa?.cpa?.toFixed(2) ?? "-"} detail={state.universityId === "vnu" ? t.grades.cpaDetailVnu : t.grades.cpaDetailOther} />
              <SummaryStat label={t.grades.credits} value={String(gpa?.totalAccumulatedCredits ?? "-")} detail={t.grades.creditsCompleted} />
            </SummaryStrip>
            {summaries.length ? (
              <Select value={effectiveTerm ?? ""} onValueChange={setSelectedTerm}>
                <SelectTrigger className="min-h-11 w-full sm:w-[260px]" aria-label={t.exams.term} data-testid="grades-term-select">
                  <SelectValue placeholder={t.exams.term} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_GRADE_TERMS}>{t.grades.allTerms}</SelectItem>
                  {summaries.map((summary) => (
                    <SelectItem key={summary.termKey} value={summary.termKey}>{termLabel(decodeGradeTermKey(summary.termKey))}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            {!summaries.length ? <Empty text={t.grades.noGrades} /> : null}
            {visibleTermViews.map(({ summary, label, sortedCourses, exportTerm }) => {
              const termExportModel = exportsReady ? createGradesExport({
                surface: "grades-term",
                universityId: state.universityId,
                identity: exportIdentity,
                reported: exportReported,
                derivedTerms: [exportTerm],
              }) : undefined;
              const headingId = `grade-term-${encodeURIComponent(summary.termKey)}`;
              return (
              <AcademicTermSection
                key={summary.termKey}
                id={headingId}
                label={label}
                headingLevel="h2"
                includesSummer={summary.includesSummer}
                includesSummerLabel={t.grades.includesSummer}
                derivedLabel={t.grades.derived}
                metrics={<>
                  <CompactAcademicMetric label={t.grades.termGpa} value={summary.termGpa4?.toFixed(2) ?? "-"} />
                  <CompactAcademicMetric label={t.grades.cpa} value={summary.cpa4?.toFixed(2) ?? "-"} />
                  <CompactAcademicMetric label={t.grades.includedCredits} value={t.grades.creditRatio(summary.includedCredits, summary.listedCredits)} />
                </>}
                action={termExportModel ? <ExportMenu model={termExportModel} /> : null}
              >
                <GradesGradeTable key={`${state.activeAccountId}:${state.sessionNonce}:${summary.termKey}`} grades={sortedCourses} sort={sort} onSortChange={setSort} universityId={state.universityId} emptyText={t.grades.noGrades} />
              </AcademicTermSection>
            );})}
          </div>
      )}
    </FeatureFrame>
  );
}
