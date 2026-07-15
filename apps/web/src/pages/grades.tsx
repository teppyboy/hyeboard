import type { Grade } from "@hyeboard/schemas";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Empty, FeatureFrame, SummaryStat, SummaryStrip } from "@/components/shared";
import { api } from "@/lib/api";
import { useLocale } from "@/lib/i18n";
import { formatTermLabel } from "@/lib/presentation";
import { cn } from "@/lib/utils";
import { useFeatureQuery, useHyeboard } from "@/state";

function gradeTermKey(grade: Grade, universityId: string, unknownTermLabel: string) {
  const code = grade.termCode ?? unknownTermLabel;
  if (usesUetTermRules(universityId) && /^\d+3$/.test(code)) return `${code.slice(0, -1)}2`;
  return code;
}

function usesUetTermRules(universityId: string) {
  return universityId === "uet" || universityId === "mock";
}

function summarizeGrades(grades: Grade[]) {
  const totalCredits = grades.reduce((sum, grade) => sum + (grade.credits ?? 0), 0);
  const weightedPoint4 = grades.reduce((sum, grade) => sum + ((grade.point4 ?? 0) * (grade.credits ?? 0)), 0);
  const weightedPoint10 = grades.reduce((sum, grade) => sum + ((grade.point10 ?? 0) * (grade.credits ?? 0)), 0);
  return {
    credits: totalCredits,
    point4: totalCredits ? weightedPoint4 / totalCredits : undefined,
    point10: totalCredits ? weightedPoint10 / totalCredits : undefined,
  };
}

type GradeSortKey = "name" | "credits" | "point10" | "point4";
type GradeSortState = { key: GradeSortKey; direction: "asc" | "desc" };

function sortGradeValue(grade: Grade, key: GradeSortKey): string | number {
  if (key === "name") return grade.courseName;
  if (key === "credits") return grade.credits ?? -1;
  if (key === "point10") return grade.point10 ?? -1;
  return grade.point4 ?? -1;
}

function sortGrades(grades: Grade[], sort: GradeSortState) {
  return [...grades].sort((a, b) => {
    const left = sortGradeValue(a, sort.key);
    const right = sortGradeValue(b, sort.key);
    const base = typeof left === "number" && typeof right === "number"
      ? left - right
      : String(left).localeCompare(String(right));
    const ordered = sort.direction === "asc" ? base : -base;
    return ordered || a.courseName.localeCompare(b.courseName);
  });
}

function GradeTable({ grades, sort, onSortChange, universityId }: { grades: Grade[]; sort: GradeSortState; onSortChange: (sort: GradeSortState) => void; universityId: string }) {
  const { t } = useLocale();
  const headers: Array<{ key: GradeSortKey; label: string; align?: "right" }> = [
    { key: "name", label: t.grades.course },
    { key: "credits", label: t.grades.credits, align: "right" },
    { key: "point10", label: t.grades.point10, align: "right" },
    { key: "point4", label: t.grades.point4, align: "right" },
  ];
  const changeSort = (key: GradeSortKey) => {
    const direction = sort.key === key && sort.direction === "asc" ? "desc" : "asc";
    onSortChange({ key, direction });
  };
  if (!grades.length) return <Empty text={t.grades.noGrades} />;
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-muted text-muted-foreground">
          <tr>
            {headers.map((header) => (
              <th
                key={header.key}
                className={cn("px-3 py-2 font-medium", header.align === "right" ? "text-right" : "text-left")}
                aria-sort={sort.key === header.key ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
              >
                <button type="button" onClick={() => changeSort(header.key)} className={cn("inline-flex items-center gap-1 hover:text-foreground", header.align === "right" && "justify-end")}> 
                  {header.label}
                  <span className="text-[10px]">{sort.key === header.key ? (sort.direction === "asc" ? "▲" : "▼") : ""}</span>
                </button>
              </th>
            ))}
            <th className="px-3 py-2 text-left font-medium">{t.grades.note}</th>
          </tr>
        </thead>
        <tbody>
          {grades.map((grade) => (
            <tr key={grade.id} className="table-row-motion border-t border-border">
              <td className="px-3 py-2">{grade.courseName}</td>
              <td className="px-3 py-2 text-right tabular-nums">{grade.credits ?? "-"}</td>
              <td className="px-3 py-2 text-right tabular-nums">{grade.point10 ?? "-"}</td>
              <td className="px-3 py-2 text-right tabular-nums">{grade.point4 ?? "-"}</td>
              <td className="px-3 py-2">{usesUetTermRules(universityId) && grade.termCode?.endsWith("3") ? <Badge className="border border-border bg-background text-foreground">{t.grades.summerTerm}</Badge> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function GradesPage() {
  const state = useHyeboard();
  const { t } = useLocale();
  const [sort, setSort] = useState<GradeSortState>({ key: "name", direction: "asc" });
  const query = useFeatureQuery("grades", () => api.grades(state.universityId));
  const gpa = state.dashboard.data?.gpa;
  return (
    <FeatureFrame title={t.grades.title} description={t.grades.description} query={query}>
      {(items) => {
        const byTerm = items.reduce<Record<string, Grade[]>>((acc, g) => {
          const key = gradeTermKey(g, state.universityId, t.grades.unknownTerm);
          (acc[key] ??= []).push(g);
          return acc;
        }, {});
        return (
          <div className="space-y-6">
            <SummaryStrip testId="grades-summary">
              <SummaryStat label={t.dashboard.gpa} value={gpa?.gpa?.toFixed(2) ?? "-"} detail={t.grades.gpaDetail} />
              <SummaryStat label={t.grades.cpa} value={gpa?.cpa?.toFixed(2) ?? "-"} detail={state.universityId === "vnu" ? t.grades.cpaDetailVnu : t.grades.cpaDetailOther} />
              <SummaryStat label={t.grades.credits} value={String(gpa?.totalAccumulatedCredits ?? "-")} detail={t.grades.creditsCompleted} />
            </SummaryStrip>
            {Object.entries(byTerm).sort(([a], [b]) => b.localeCompare(a)).map(([term, grades]) => {
              const summary = summarizeGrades(grades);
              const includesSummer = usesUetTermRules(state.universityId) && grades.some((grade) => grade.termCode && grade.termCode !== term && grade.termCode.endsWith("3"));
              const sortedGrades = sortGrades(grades, sort);
              const displayTerm = formatTermLabel(term, state.universityId, t.terms);
              return (
              <div key={term} className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-base font-semibold">{displayTerm}</h2>
                  {includesSummer ? <Badge className="border border-border bg-background text-foreground">{t.grades.includesSummer}</Badge> : null}
                </div>
                <SummaryStrip testId="term-summary">
                  <SummaryStat label={t.grades.termGpa} value={summary.point4?.toFixed(2) ?? "-"} />
                  <SummaryStat label={t.grades.average10} value={summary.point10?.toFixed(2) ?? "-"} />
                  <SummaryStat label={t.grades.credits} value={String(summary.credits || "-")} />
                </SummaryStrip>
                <GradeTable grades={sortedGrades} sort={sort} onSortChange={setSort} universityId={state.universityId} />
              </div>
            );})}
          </div>
        );
      }}
    </FeatureFrame>
  );
}
