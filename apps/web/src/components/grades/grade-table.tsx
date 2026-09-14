import type {
  GradeSortKey,
  GradeSortState,
} from "@/lib/grades/grade-view-model";
import type { GradeTableRow } from "@/lib/grades/grade-view-model";
import { sortGradeTableRows } from "@/lib/grades/grade-view-model";
import { ChevronDown } from "lucide-react";
import { Fragment, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Empty } from "@/components/shared";
import { cn } from "@/lib/utils";
import { useLocale } from "@/lib/i18n";
import { SummerBadge } from "@/components/grades/summer-badge";

export type GradeTableProps = {
  rows: readonly GradeTableRow[];
  sort: GradeSortState;
  onSortChange: (sort: GradeSortState) => void;
  emptyText: string;
};

export function GradeTable({
  rows,
  sort,
  onSortChange,
  emptyText,
}: GradeTableProps) {
  const { t } = useLocale();
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const sorted = sortGradeTableRows(rows, sort);
  if (!sorted.length) return <Empty text={emptyText} />;

  const changeSort = (key: GradeSortKey) => {
    const direction =
      sort.key === key && sort.direction === "asc" ? "desc" : "asc";
    onSortChange({ key, direction });
  };

  const headerAriaSort = (
    key: GradeSortKey,
  ): "ascending" | "descending" | undefined =>
    sort.key === key
      ? sort.direction === "asc"
        ? "ascending"
        : "descending"
      : undefined;

  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-muted text-muted-foreground">
          <tr>
            <th
              className="px-3 py-2 text-left font-medium"
              aria-sort={headerAriaSort("name")}
            >
              <button
                type="button"
                onClick={() => changeSort("name")}
                className="inline-flex items-center gap-1 hover:text-foreground"
              >
                {t.grades.course}
                <span className="text-[10px]">
                  {sort.key === "name"
                    ? sort.direction === "asc"
                      ? "▲"
                      : "▼"
                    : ""}
                </span>
              </button>
            </th>
            <th className="px-3 py-2 text-left font-medium">
              {t.grades.letter}
            </th>
            <th
              className="px-3 py-2 text-right font-medium"
              aria-sort={headerAriaSort("credits")}
            >
              <button
                type="button"
                onClick={() => changeSort("credits")}
                className="inline-flex items-center gap-1 justify-end hover:text-foreground"
              >
                {t.grades.credits}
                <span className="text-[10px]">
                  {sort.key === "credits"
                    ? sort.direction === "asc"
                      ? "▲"
                      : "▼"
                    : ""}
                </span>
              </button>
            </th>
            <th
              className="px-3 py-2 text-right font-medium"
              aria-sort={headerAriaSort("point10")}
            >
              <button
                type="button"
                onClick={() => changeSort("point10")}
                className="inline-flex items-center gap-1 justify-end hover:text-foreground"
              >
                {t.grades.point10}
                <span className="text-[10px]">
                  {sort.key === "point10"
                    ? sort.direction === "asc"
                      ? "▲"
                      : "▼"
                    : ""}
                </span>
              </button>
            </th>
            <th
              className="px-3 py-2 text-right font-medium max-sm:hidden"
              aria-sort={headerAriaSort("point4")}
            >
              <button
                type="button"
                onClick={() => changeSort("point4")}
                className="inline-flex items-center gap-1 justify-end hover:text-foreground"
              >
                {t.grades.point4}
                <span className="text-[10px]">
                  {sort.key === "point4"
                    ? sort.direction === "asc"
                      ? "▲"
                      : "▼"
                    : ""}
                </span>
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const expanded = expandedIds.has(row.id);
            return (
              <Fragment key={row.id}>
                <tr
                  className="table-row-motion cursor-pointer border-t border-border"
                  onClick={(event) => {
                    if ((event.target as HTMLElement).closest("button")) return;
                    toggleExpanded(row.id);
                  }}
                >
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => toggleExpanded(row.id)}
                        aria-expanded={expanded}
                        aria-label={t.grades.toggleDetails(row.courseName)}
                        className="shrink-0 rounded-md p-0.5 text-muted-foreground hover:text-foreground max-lg:-mx-1.5 max-lg:-my-2 max-lg:p-2"
                      >
                        <ChevronDown
                          className={cn(
                            "h-4 w-4 transition-transform",
                            expanded && "rotate-180",
                          )}
                        />
                      </button>
                      <span>{row.courseName}</span>
                      {row.isSummer ? <SummerBadge /> : null}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    {row.letter ? (
                      <Badge
                        data-testid="letter-badge"
                        className="min-w-9 justify-center text-sm font-semibold tabular-nums"
                      >
                        {row.letter}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {row.credits ?? "-"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {row.point10 ?? "-"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums max-sm:hidden">
                    {row.point4 ?? "-"}
                  </td>
                </tr>
                <tr>
                  <td colSpan={5} className="p-0">
                    <div
                      className="collapsible-panel"
                      data-open={expanded}
                      data-testid="grade-detail"
                    >
                      <div>{expanded ? row.detail.render() : null}</div>
                    </div>
                  </td>
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
