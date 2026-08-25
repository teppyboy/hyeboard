import type { VnuExamCatalogRow, VnuExamTermInfo, VnuProfile, VnuTranscriptRow } from "@hyeboard/university-adapters/src/vnu/types";
import { VNU_EXAM_TERMS } from "@hyeboard/university-adapters/src/vnu/exam-terms";
import { ChevronDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ExportMenu } from "@/components/export-menu";
import { GradeTable } from "@/components/grades/grade-table";
import { AcademicTermSection } from "@/components/grades/academic-term-section";
import type { GradeTableRow } from "@/lib/grade-view-model";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { Empty, FeatureFrame, SummaryStat, SummaryStrip } from "@/components/shared";
import { CompactAcademicMetric } from "@/pages/grades";
import { ACCOUNT_SWITCHED_EVENT, api, ApiError, type VnuBulkLookupItem, type VnuBulkLookupMode, type VnuCrossTranscript, type VnuCrossTranscriptInput } from "@/lib/api";
import { deriveBulkLookupViewState, executeBulkLookup, parseBulkLookupItems, parseBulkLookupMode, parseBulkTargets, type BulkLookupProgress } from "@/lib/bulk-lookup";
import { deriveCrossTranscriptInput, deriveCrossTranscriptView } from "@/lib/cross-transcript-view";
import { createBulkExport, createClassLookupExport, createResolverLookupExport, createTranscriptExport, type ExportBulkItem, type ExportDerivedTerm, type ExportDocument, type ExportSurface } from "@/lib/data-export";
import { useLocale } from "@/lib/i18n";
import { formatTermLabel } from "@/lib/presentation";
import { calculateTermAcademicSummaries, newestAcademicTermsFirst, type AcademicTermSummary } from "@/lib/term-academic-summary";
import { cn } from "@/lib/utils";
import { filterCatalogRowsByUniversity } from "@/lib/university-course-search";
import { useFeatureQuery, useHyeboard } from "@/state";

// Newest first - matches the convention every other term picker in the app
// uses (see mapTerms in the vnu mapper). VNU_EXAM_TERMS itself stays
// oldest-first, matching how the static table was verified.
const TERMS_NEWEST_FIRST: readonly VnuExamTermInfo[] = [...VNU_EXAM_TERMS].reverse();

// Client-side mirrors of the worker's cross-lookup target gates, shared by
// the student-record forms below (the transcript form applies the same pair
// via deriveCrossTranscriptInput). The backend still rejects anything these
// miss — they exist for immediate, localized feedback without a wasted
// round-trip.
const VNU_STD_ID_INPUT_PATTERN = /^\d{1,11}$/;
const VNU_STUDENT_CODE_INPUT_PATTERN = /^\d{8}$/;

export function lookupFreshnessKey(universityId: string, accountId: string | null, sessionNonce: number): string {
  return `${universityId}:${accountId ?? "no-account"}:${sessionNonce}`;
}

// Exact match only — no zero-padding or partial-match normalization, so a
// query can never silently land on a class the user didn't ask for. Every
// match is returned (classIds should be unique within a term's catalog, but
// uniqueness is never assumed: duplicate rows would all be listed).
function filterCatalogRowsByClassId(rows: VnuExamCatalogRow[], classId: string): VnuExamCatalogRow[] {
  const classIdQuery = classId.trim();
  if (!classIdQuery) return [];
  return rows.filter((row) => row.classId === classIdQuery);
}

function classExportResult(row: VnuExamCatalogRow) {
  return { classCode: row.courseCode, classNumber: row.classNo, classId: row.classId, courseName: row.courseName };
}

function ClassResultRow({ row, expanded, onToggleDetail, exportModel }: { row: VnuExamCatalogRow; expanded: boolean; onToggleDetail: () => void; exportModel: ExportDocument }) {
  const { t } = useLocale();
  return (
    <div
      className="list-row flex-col items-stretch gap-3 sm:flex-row sm:items-center cursor-pointer"
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("button, [data-export-surface]")) return;
        onToggleDetail();
      }}
      role="button"
      aria-expanded={expanded}
    >
      <div className="min-w-0 flex items-center gap-2">
        <button
          type="button"
          onClick={onToggleDetail}
          aria-expanded={expanded}
          aria-label={t.lookup.pointDetailAction}
          className="shrink-0 rounded-md p-0.5 text-muted-foreground hover:text-foreground max-lg:-mx-1.5 max-lg:-my-2 max-lg:p-2"
        >
          <ChevronDown className={cn("h-4 w-4 transition-transform", expanded && "rotate-180")} />
        </button>
        <div className="min-w-0">
          <p className="break-words text-sm font-medium">{row.courseCode}{row.classNo ? ` · ${row.classNo}` : ""} — {row.courseName}</p>
          <p className="break-words text-xs text-muted-foreground">{row.examDate || "-"}{row.room ? ` · ${row.room}` : ""}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">
        <Badge className="max-w-full break-all border border-border bg-background font-mono font-normal tabular-nums text-foreground">{row.classId}</Badge>
        <ExportMenu model={exportModel} />
      </div>
    </div>
  );
}

// Inline drilldown for one resolved class row: the per-component grade
// breakdown (portal-provided assessment types, weights, attempts, scores) for the
// student's OWN class. The worker scopes StdID to the session owner — this
// panel can never be pointed at another student.
function PointDetailPanel({ classId, termOrdinal }: { classId: string; termOrdinal: string }) {
  const { t } = useLocale();
  const state = useHyeboard();
  const detailQuery = useFeatureQuery(
    "vnu-point-detail",
    ({ signal }) => api.vnuClassPointDetail({ id: classId, Term: termOrdinal }, signal),
    {
      capability: "classLookup",
      queryKey: ["vnu-point-detail", state.universityId, state.sessionNonce, classId, termOrdinal],
    },
  );

  if (detailQuery.isLoading) return <div className="px-4 py-3"><Skeleton className="h-12" /></div>;
  if (detailQuery.error) return <div className="px-4 py-3" role="alert"><p className="text-sm text-muted-foreground">{t.lookup.pointDetailError}</p></div>;
  const detail = detailQuery.data;
  if (!detail?.components.length) return <div className="px-4 py-3"><Empty text={t.lookup.pointDetailEmpty} /></div>;
  return (
    <div className="divide-y divide-border bg-muted/30 px-4">
      {detail.components.map((component) => (
        <div key={component.index} className="list-row">
          <div className="min-w-0">
            <p className="break-words text-sm font-medium">{component.nature || "-"}</p>
            <p className="text-xs text-muted-foreground">{
              [
                component.weight == null ? undefined : t.lookup.pointDetailWeight(component.weight),
                component.attempt == null ? undefined : t.lookup.pointDetailAttempt(component.attempt),
              ].filter(Boolean).join(" · ") || "-"}</p>
          </div>
          <Badge className="shrink-0 border border-border bg-background font-normal tabular-nums text-foreground">{component.score ?? "-"}</Badge>
        </div>
      ))}
    </div>
  );
}

function ClassResolver() {
  const { t } = useLocale();
  const state = useHyeboard();
  const [courseCode, setCourseCode] = useState("");
  const [classNo, setClassNo] = useState("");
  const [termOrdinal, setTermOrdinal] = useState<string | undefined>(undefined);
  const [expandedClassIds, setExpandedClassIds] = useState<Set<string>>(new Set());

  // The catalog call needs no ids from the client: the worker derives
  // selStd/selUniv from the session's own profile (same hardening as
  // point-detail) and fails closed with VNU_LOGIN_REQUIRED when it can't.
  const catalogQuery = useFeatureQuery(
    "vnu-lookup-catalog",
    (signal) => api.vnuClassCatalog({ vTermID: termOrdinal! }, signal),
    {
      capability: "classLookup",
      enabled: Boolean(termOrdinal),
      queryKey: ["vnu-lookup-catalog", state.universityId, state.sessionNonce, termOrdinal],
    },
  );

  const filteredRows = filterCatalogRowsByUniversity(catalogQuery.data ?? [], courseCode, classNo, state.universityId);

  return (
    <div className="space-y-4" id="class-forward-panel">
      <p className="max-w-[70ch] text-sm text-muted-foreground">{t.lookup.resolverDescription}</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="space-y-1.5"><label htmlFor="lookup-course-code" className="text-sm font-medium">{t.lookup.courseCodeLabel}</label><Input id="lookup-course-code" className="min-h-11 font-mono tabular-nums" value={courseCode} onChange={(event) => setCourseCode(event.target.value)} placeholder={t.lookup.courseCodePlaceholder} /></div>
        <div className="space-y-1.5"><label htmlFor="lookup-class-number" className="text-sm font-medium">{t.lookup.classNoLabel}</label><Input id="lookup-class-number" className="min-h-11 font-mono tabular-nums" value={classNo} onChange={(event) => setClassNo(event.target.value)} placeholder={t.lookup.classNoPlaceholder} /></div>
        <div className="space-y-1.5 sm:col-span-2 lg:col-span-1"><label htmlFor="lookup-forward-term" className="text-sm font-medium">{t.lookup.termFieldLabel}</label><Select value={termOrdinal ?? ""} onValueChange={(value) => { setTermOrdinal(value);           setExpandedClassIds(new Set()); }}>
          <SelectTrigger id="lookup-forward-term" className="min-h-11"><SelectValue placeholder={t.lookup.termPlaceholder} /></SelectTrigger>
          <SelectContent>
            {TERMS_NEWEST_FIRST.map((term) => <SelectItem key={term.ordinal} value={term.ordinal}>{t.lookup.termLabel(term)}</SelectItem>)}
          </SelectContent>
        </Select></div>
      </div>

      <div data-testid="lookup-results" className="min-h-28" aria-live="polite">
        {termOrdinal ? catalogQuery.isLoading ? (
          <Skeleton className="h-40" />
        ) : catalogQuery.error ? (
          <div className="space-y-2" role="alert"><Empty text={t.lookup.classesError} /><Button type="button" variant="outline" className="min-h-11" onClick={() => void catalogQuery.refetch()}>{t.lookup.retry}</Button></div>
        ) : (
          <div>
            <div className="mb-2 flex items-end justify-between gap-3"><h3 className="text-sm font-semibold">{t.lookup.resultsTitle}</h3><p className="text-xs text-muted-foreground">{t.lookup.resultsCount(filteredRows.length)}</p></div>
              {filteredRows.length ? (
                <>
                  <div className="flex items-center justify-between gap-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    <span>{t.lookup.headers[0]}</span>
                    <span>{t.lookup.headers[1]}</span>
                  </div>
                  <div className="divide-y divide-border">
                    {filteredRows.map((row) => (
                      <div key={row.classId}>
                        <ClassResultRow
                          row={row}
                          expanded={expandedClassIds.has(row.classId)}
                          onToggleDetail={() => setExpandedClassIds((prev) => { const next = new Set(prev); if (next.has(row.classId)) next.delete(row.classId); else next.add(row.classId); return next; })}
                          exportModel={createClassLookupExport({
                            surface: "class-forward",
                            universityId: state.universityId,
                            query: { mode: "course-and-class", value: [termOrdinal, courseCode.trim(), classNo.trim()].filter(Boolean).join(" / ") },
                            result: classExportResult(row),
                          })}
                        />
                        {expandedClassIds.has(row.classId) && termOrdinal ? <PointDetailPanel classId={row.classId} termOrdinal={termOrdinal} /> : null}
                      </div>
                    ))}
                  </div>
                </>
              ) : <Empty text={t.lookup.noMatches} />}
          </div>
        ) : (
          <Empty text={t.lookup.selectTermPrompt} />
        )}
      </div>
    </div>
  );
}

// Meta line mirrors CrossExamRow's field order/formatting exactly (date,
// hour, method, room, seat) so a class resolved by internal id reads
// identically to the forward exam-schedule view - now that
// parseExamCatalogHtml captures the same descriptive columns parseExamsHtml
// does, none of these fields need re-deriving here.
function ReverseClassResultRow({ row, exportModel }: { row: VnuExamCatalogRow; exportModel: ExportDocument }) {
  const { t } = useLocale();
  const meta = [row.examDate || undefined, row.hour, row.method, row.room, row.seatNumber ? t.lookup.crossSeat(row.seatNumber) : undefined].filter(Boolean).join(" · ");
  return (
    <div className="list-row flex-col items-stretch gap-3 sm:flex-row sm:items-center">
      <div className="min-w-0">
        <p className="break-words text-sm font-medium">{row.courseCode}{row.classNo ? ` · ${row.classNo}` : ""} — {row.courseName}</p>
        <p className="break-words text-xs text-muted-foreground">{meta || "-"}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">
        <Badge className="max-w-full break-all border border-border bg-background font-mono font-normal tabular-nums text-foreground">{row.classId}</Badge>
        <ExportMenu model={exportModel} />
      </div>
    </div>
  );
}

// Reverse direction of ClassResolver: internal class ID -> course/class
// row(s). Shares the same per-term catalog fetch (identical queryKey/queryFn,
// so React Query dedupes when both resolvers use the same term) and the same
// hard rule that a term must be picked before anything is fetched or
// filtered — class IDs are only unique within one term's catalog, so an
// unscoped search could silently match the wrong term's class.
function ReverseClassResolver() {
  const { t } = useLocale();
  const state = useHyeboard();
  const [classId, setClassId] = useState("");
  const [termOrdinal, setTermOrdinal] = useState<string | undefined>(undefined);

  const catalogQuery = useFeatureQuery(
    "vnu-lookup-catalog",
    (signal) => api.vnuClassCatalog({ vTermID: termOrdinal! }, signal),
    {
      capability: "classLookup",
      enabled: Boolean(termOrdinal),
      queryKey: ["vnu-lookup-catalog", state.universityId, state.sessionNonce, termOrdinal],
    },
  );

  const trimmedClassId = classId.trim();
  const matchedRows = filterCatalogRowsByClassId(catalogQuery.data ?? [], trimmedClassId);

  return (
    <div className="space-y-4" data-testid="reverse-class-lookup" id="class-reverse-panel">
      <p className="max-w-[70ch] text-sm text-muted-foreground">{t.lookup.reverseDescription}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5"><label htmlFor="lookup-reverse-class-id" className="text-sm font-medium">{t.lookup.reverseClassIdLabel}</label><Input id="lookup-reverse-class-id" className="min-h-11 font-mono tabular-nums" value={classId} onChange={(event) => setClassId(event.target.value)} placeholder={t.lookup.reverseClassIdPlaceholder} /></div>
        <div className="space-y-1.5"><label htmlFor="lookup-reverse-term" className="text-sm font-medium">{t.lookup.termFieldLabel}</label><Select value={termOrdinal ?? ""} onValueChange={setTermOrdinal}>
          <SelectTrigger id="lookup-reverse-term" className="min-h-11"><SelectValue placeholder={t.lookup.termPlaceholder} /></SelectTrigger>
          <SelectContent>
            {TERMS_NEWEST_FIRST.map((term) => <SelectItem key={term.ordinal} value={term.ordinal}>{t.lookup.termLabel(term)}</SelectItem>)}
          </SelectContent>
        </Select></div>
      </div>

      <div className="min-h-28" aria-live="polite">
        {termOrdinal ? catalogQuery.isLoading ? (
          <Skeleton className="h-40" />
        ) : catalogQuery.error ? (
          <div className="space-y-2" role="alert"><Empty text={t.lookup.classesError} /><Button type="button" variant="outline" className="min-h-11" onClick={() => void catalogQuery.refetch()}>{t.lookup.retry}</Button></div>
        ) : trimmedClassId ? matchedRows.length ? (
          <div>
            <div className="mb-2 flex items-end justify-between gap-3"><h3 className="text-sm font-semibold">{t.lookup.resultsTitle}</h3><p className="text-xs text-muted-foreground">{t.lookup.resultsCount(matchedRows.length)}</p></div>
              <div className="flex items-center justify-between gap-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <span>{t.lookup.headers[0]}</span>
                <span>{t.lookup.headers[1]}</span>
              </div>
              <div className="divide-y divide-border">
                {matchedRows.map((row, index) => <ReverseClassResultRow
                  key={`${row.classId}-${index}`}
                  row={row}
                  exportModel={createClassLookupExport({
                    surface: "class-reverse",
                    universityId: state.universityId,
                    query: { mode: "class-id", value: `${termOrdinal} / ${trimmedClassId}` },
                    result: classExportResult(row),
                  })}
                />)}
              </div>
          </div>
        ) : (
          <Empty text={t.lookup.reverseNoMatch} />
        ) : (
          <Empty text={t.lookup.reverseEnterIdPrompt} />
        ) : (
          <Empty text={t.lookup.selectTermPrompt} />
        )}
      </div>
    </div>
  );
}

type ClassLookupMode = "forward" | "reverse";

function ClassIdentifierTools() {
  const { t } = useLocale();
  const state = useHyeboard();
  const [mode, setMode] = useState<ClassLookupMode>("forward");
  const key = `${state.activeAccountId}:${state.sessionNonce}`;
  return (
    <Card key={key} data-testid="class-identifier-tools">
      <CardHeader>
        <CardTitle className="text-base">{t.lookup.classIdentifiersTitle}</CardTitle>
        <CardDescription className="max-w-[70ch]">{t.lookup.classIdentifiersDescription}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 rounded-lg border border-border p-1" role="group" aria-label={t.lookup.classModeLabel}>
          <Button type="button" variant={mode === "forward" ? "default" : "ghost"} className="min-h-11 min-w-0 whitespace-normal px-2" aria-pressed={mode === "forward"} aria-controls="class-forward-panel" onClick={() => setMode("forward")}>{t.lookup.resolverTitle}</Button>
          <Button type="button" variant={mode === "reverse" ? "default" : "ghost"} className="min-h-11 min-w-0 whitespace-normal px-2" aria-pressed={mode === "reverse"} aria-controls="class-reverse-panel" onClick={() => setMode("reverse")}>{t.lookup.reverseMode}</Button>
        </div>
        {mode === "forward" ? <ClassResolver /> : <ReverseClassResolver />}
      </CardContent>
    </Card>
  );
}

// Cross-student StdID -> student-code resolver (crossLookup capability, vnu
// only). The heading/description state the intent openly — this is deliberate
// transparency about behavior the upstream portal itself permits, not a
// hidden shortcut. The worker route requires allowCrossLookup=true, rejects
// self-targeting, and never caches; the client mirrors the self-target check
// early so the user gets an inline answer without a wasted round-trip. The
// worker parses the target student's transcript-page header server-side and
// returns only the resolved code/name/class.
function CrossStudentCodeSection({ profile }: { profile: VnuProfile }) {
  const { t } = useLocale();
  const state = useHyeboard();
  const [stdId, setStdId] = useState("");
  const [submitted, setSubmitted] = useState<{ stdId: string } | null>(null);

  const trimmedStdId = stdId.trim();
  const isValid = VNU_STD_ID_INPUT_PATTERN.test(trimmedStdId);
  // Numeric comparison, so leading-zero spellings of the caller's own id
  // still count as self-targeting (same normalization as the worker).
  const isSelfTarget = isValid && Number(trimmedStdId) === Number(profile.internalStudentId);

  const codeQuery = useFeatureQuery(
    "vnu-cross-student-code",
    ({ signal }) => api.vnuCrossStudentCode(submitted!, signal),
    {
      capability: "crossLookup",
      enabled: Boolean(submitted),
      queryKey: ["vnu-cross-student-code", state.universityId, state.sessionNonce, submitted],
    },
  );

  const submit = () => {
    if (!isValid || isSelfTarget) return;
    setSubmitted({ stdId: trimmedStdId });
  };

  const result = codeQuery.data;
  const exportModel = submitted && result?.studentCode && !codeQuery.error ? createResolverLookupExport({
    surface: "student-id-to-code",
    universityId: state.universityId,
    query: { mode: "stdId", value: submitted.stdId },
    identity: {
      internalStudentId: submitted.stdId,
      studentCode: result.studentCode,
      studentName: result.studentName,
      managingClass: result.className,
    },
  }) : undefined;
  const codeError = codeQuery.error instanceof ApiError && codeQuery.error.code === "VNU_CROSS_LOOKUP_NOT_FOUND"
    ? t.lookup.crossCodeNotFound
    : codeQuery.error instanceof ApiError && codeQuery.error.code === "VNU_RATE_LIMITED"
      ? t.lookup.crossTranscriptRateLimited
      : codeQuery.error instanceof ApiError && codeQuery.error.code === "VNU_PROBE_BUDGET_UNAVAILABLE"
        ? t.lookup.crossTranscriptUnavailable
        : t.lookup.crossLookupError;

  return (
    <section data-testid="cross-student-code" className="space-y-4" aria-labelledby="cross-code-heading">
      <div className="space-y-1"><h3 id="cross-code-heading" className="text-sm font-semibold">{t.lookup.crossCodeTitle}</h3><p className="max-w-[70ch] text-sm text-muted-foreground">{t.lookup.crossCodeDescription}</p></div>
        <form className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]" onSubmit={(event) => { event.preventDefault(); submit(); }}>
          <div className="space-y-1.5"><label htmlFor="cross-code-stdid" className="text-sm font-medium">{t.lookup.crossStdIdLabel}</label><Input id="cross-code-stdid" className="min-h-11 font-mono tabular-nums" inputMode="numeric" value={stdId} onChange={(event) => { setStdId(event.target.value); setSubmitted(null); }} placeholder={t.lookup.crossStdIdPlaceholder} aria-invalid={trimmedStdId.length > 0 && !isValid} /></div>
          <Button type="submit" className="min-h-11 sm:self-end" disabled={!isValid || isSelfTarget}>{t.lookup.crossSubmit}</Button>
        </form>
        <div className="min-h-20" aria-live="polite">{trimmedStdId && !isValid ? <Empty text={t.lookup.crossCodeInvalidStdId} /> : isSelfTarget ? <Empty text={t.lookup.crossCodeSelfTarget} /> : submitted ? (
          codeQuery.isLoading ? (
            <Skeleton className="h-20" />
          ) : codeQuery.error ? (
            <div className="space-y-2" role="alert"><Empty text={codeError} /><Button type="button" variant="outline" className="min-h-11" onClick={() => void codeQuery.refetch()}>{t.lookup.retry}</Button></div>
          ) : result?.studentCode ? (
            <div className="divide-y divide-border">
              <div className="list-row flex-col items-stretch gap-2 sm:flex-row sm:items-center">
                <div className="min-w-0">
                  <p className="break-words text-sm font-medium">{result.studentName ?? t.lookup.crossCodeResolvedTitle}</p>
                  <p className="break-words text-xs text-muted-foreground">{[t.lookup.crossCodeResolvedFrom(submitted.stdId), result.className || undefined].filter(Boolean).join(" · ")}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">
                  <Badge className="max-w-full break-all border border-border bg-background font-mono font-normal tabular-nums text-foreground">{result.studentCode}</Badge>
                  {exportModel ? <ExportMenu model={exportModel} /> : null}
                </div>
              </div>
            </div>
          ) : (
            <Empty text={t.lookup.crossCodeNotFound} />
          )
        ) : <Empty text={t.lookup.crossCodePrompt} />}</div>
    </section>
  );
}

// Cross-student student-code -> StdID resolver (crossLookup capability, vnu
// only) — the reverse direction of CrossStudentCodeSection. No portal
// endpoint maps a public code back to an internal id, so the worker walks
// the transcript oracle from the caller's own anchor pair; the resolved id
// and the probe count are the only results. Same transparency + gating story
// as the sibling section; an unresolvable code renders an explicit empty
// state (VNU_CROSS_LOOKUP_NOT_CONVERGED), never a guessed id.
function CrossStudentIdSection({ profile }: { profile: VnuProfile }) {
  const { t } = useLocale();
  const state = useHyeboard();
  const [stdCode, setStdCode] = useState("");
  const [submitted, setSubmitted] = useState<{ stdCode: string } | null>(null);

  const trimmedStdCode = stdCode.trim();
  const isValid = VNU_STUDENT_CODE_INPUT_PATTERN.test(trimmedStdCode);
  // Numeric comparison, matching the worker's normalized self-target check.
  const isSelfTarget = isValid && Number(trimmedStdCode) === Number(profile.studentCode);

  const idQuery = useFeatureQuery(
    "vnu-cross-student-id",
    ({ signal }) => api.vnuCrossStudentId(submitted!, signal),
    {
      capability: "crossLookup",
      enabled: Boolean(submitted),
      queryKey: ["vnu-cross-student-id", state.universityId, state.sessionNonce, submitted],
    },
  );

  const submit = () => {
    if (!isValid || isSelfTarget) return;
    setSubmitted({ stdCode: trimmedStdCode });
  };

  const result = idQuery.data;
  const exportModel = submitted && result && !idQuery.error ? createResolverLookupExport({
    surface: "student-code-to-id",
    universityId: state.universityId,
    query: { mode: "stdCode", value: submitted.stdCode },
    resolver: {
      resolvedStudentCode: result.stdCode,
      resolvedInternalStudentId: result.stdId,
      probes: result.probes,
    },
  }) : undefined;
  const notConverged = idQuery.error instanceof ApiError && idQuery.error.code === "VNU_CROSS_LOOKUP_NOT_CONVERGED";
  const idError = idQuery.error instanceof ApiError && idQuery.error.code === "VNU_RATE_LIMITED"
    ? t.lookup.crossTranscriptRateLimited
    : idQuery.error instanceof ApiError && idQuery.error.code === "VNU_PROBE_BUDGET_UNAVAILABLE"
      ? t.lookup.crossTranscriptUnavailable
      : t.lookup.crossLookupError;

  return (
    <section data-testid="cross-student-id" className="space-y-4" aria-labelledby="cross-id-heading">
      <div className="space-y-1"><h3 id="cross-id-heading" className="text-sm font-semibold">{t.lookup.crossIdTitle}</h3><p className="max-w-[70ch] text-sm text-muted-foreground">{t.lookup.crossIdDescription}</p></div>
        <form className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]" onSubmit={(event) => { event.preventDefault(); submit(); }}>
          <div className="space-y-1.5"><label htmlFor="cross-id-code" className="text-sm font-medium">{t.lookup.crossIdStdCodeLabel}</label><Input id="cross-id-code" className="min-h-11 font-mono tabular-nums" inputMode="numeric" value={stdCode} onChange={(event) => { setStdCode(event.target.value); setSubmitted(null); }} placeholder={t.lookup.crossIdStdCodePlaceholder} aria-invalid={trimmedStdCode.length > 0 && !isValid} /></div>
          <Button type="submit" className="min-h-11 sm:self-end" disabled={!isValid || isSelfTarget}>{t.lookup.crossSubmit}</Button>
        </form>
        <div className="min-h-20" aria-live="polite">{trimmedStdCode && !isValid ? <Empty text={t.lookup.crossIdInvalidStdCode} /> : isSelfTarget ? <Empty text={t.lookup.crossIdSelfTarget} /> : submitted ? (
          idQuery.isLoading ? (
            <Skeleton className="h-20" />
          ) : notConverged ? (
            <Empty text={t.lookup.crossIdNotConverged} />
          ) : idQuery.error ? (
            <div className="space-y-2" role="alert"><Empty text={idError} /><Button type="button" variant="outline" className="min-h-11" onClick={() => void idQuery.refetch()}>{t.lookup.retry}</Button></div>
          ) : result ? (
            <div className="divide-y divide-border">
              <div className="list-row flex-col items-stretch gap-2 sm:flex-row sm:items-center">
                <div className="min-w-0">
                  <p className="break-words text-sm font-medium">{t.lookup.crossIdResolvedTitle}</p>
                  <p className="break-words text-xs text-muted-foreground">{[t.lookup.crossIdResolvedFrom(result.stdCode), t.lookup.crossIdProbes(result.probes)].join(" · ")}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">
                  <Badge className="max-w-full break-all border border-border bg-background font-mono font-normal tabular-nums text-foreground">{result.stdId}</Badge>
                  {exportModel ? <ExportMenu model={exportModel} /> : null}
                </div>
              </div>
            </div>
          ) : null
        ) : <Empty text={t.lookup.crossIdPrompt} />}</div>
    </section>
  );
}

function crossTranscriptExportTerm(summary: AcademicTermSummary<VnuTranscriptRow>, label: string): ExportDerivedTerm {
  return {
    termCode: summary.termKey,
    termLabel: label,
    estimateKind: "derived",
    listedCredits: summary.listedCredits,
    includedCredits: summary.includedCredits,
    termGpa4: summary.termGpa4,
    derivedCpa4: summary.cpa4,
    courses: summary.courses.map((row) => ({
      courseCode: row.courseCode,
      courseName: row.courseName,
      credits: row.credits,
      point10: row.grade10,
      letter: row.letterGrade,
      point4: row.grade4,
    })),
  };
}

function transcriptAcademicSummaries(transcript?: VnuCrossTranscript): AcademicTermSummary<VnuTranscriptRow>[] {
  if (!transcript) return [];
  return newestAcademicTermsFirst(calculateTermAcademicSummaries(
    transcript.terms.flatMap((term) => term.rows.map((row) => ({
      termKey: term.maHK,
      credits: row.credits,
      point4: row.grade4,
      course: row,
    }))),
    "vnu",
  ));
}

function CrossTranscriptDetail({ permit }: { permit: string }) {
  const { t } = useLocale();
  const state = useHyeboard();
  const detailQuery = useFeatureQuery(
    "vnu-cross-detail",
    ({ signal }) => api.vnuCrossDetail(permit, signal),
    {
      capability: "crossLookup",
      queryKey: ["vnu-cross-detail", state.universityId, state.sessionNonce, permit],
      staleTime: Infinity,
    },
  );

  if (detailQuery.isLoading) return <div className="px-4 py-3"><Skeleton className="h-12" /></div>;
  if (detailQuery.error) return <div className="px-4 py-3" role="alert"><p className="text-sm text-muted-foreground">{t.lookup.pointDetailError}</p></div>;
  if (!detailQuery.data?.length) return <div className="px-4 py-3"><Empty text={t.lookup.pointDetailEmpty} /></div>;
  return (
    <div className="divide-y divide-border bg-muted/30 px-4">
      {detailQuery.data.map((component) => (
        <div key={component.index} className="list-row">
          <div className="min-w-0">
            <p className="break-words text-sm font-medium">{component.nature || "-"}</p>
            <p className="text-xs text-muted-foreground">
              {[
                component.weight == null ? undefined : t.lookup.pointDetailWeight(component.weight),
                component.attempt == null ? undefined : t.lookup.pointDetailAttempt(component.attempt),
              ].filter(Boolean).join(" · ") || "-"}
            </p>
          </div>
          <Badge className="shrink-0 border border-border bg-background font-normal tabular-nums text-foreground">{component.score ?? "-"}</Badge>
        </div>
      ))}
    </div>
  );
}

function CrossTranscriptTerm({ summary, permits }: {
  summary: AcademicTermSummary<VnuTranscriptRow>;
  permits: Map<string, string>;
}) {
  const { t } = useLocale();
  const label = formatTermLabel(summary.termKey, "vnu", t.terms);
  const headingId = `cross-transcript-term-${summary.termKey}`;

  const rows: GradeTableRow[] = useMemo(() => summary.courses.map((row, index) => {
    const permitKey = `${summary.termKey}:${row.courseCode}:${row.classId ?? index}`;
    const permit = permits.get(permitKey);
    const id = `${summary.termKey}:${index}`;
    return {
      id,
      courseName: row.courseName,
      credits: row.credits ?? null,
      point10: row.grade10 ?? null,
      letter: row.letterGrade ?? undefined,
      point4: row.grade4 ?? null,
      detail: permit
        ? { kind: "available" as const, render: () => <CrossTranscriptDetail permit={permit} /> }
        : { kind: "unavailable" as const, render: () => <div className="px-4 py-3"><Empty text={t.grades.componentDetailUnavailable} /></div> },
    };
  }), [summary.courses, summary.termKey, permits, t]);

  return (
    <AcademicTermSection
      id={headingId}
      label={label}
      headingLevel="h4"
      includesSummer={false}
      derivedLabel={t.grades.derived}
      metrics={<>
        <CompactAcademicMetric label={t.grades.termGpa} value={summary.termGpa4?.toFixed(2) ?? "-"} />
        <CompactAcademicMetric label={t.grades.cpa} value={summary.cpa4?.toFixed(2) ?? "-"} />
        <CompactAcademicMetric label={t.grades.includedCredits} value={t.grades.creditRatio(summary.includedCredits, summary.listedCredits)} />
      </>}
    >
      <GradeTable rows={rows} sort={{ key: "name", direction: "asc" }} onSortChange={() => {}} emptyText={t.grades.noGrades} />
    </AcademicTermSection>
  );
}

function CrossTranscriptSection({ profile, crossDetailEnabled }: { profile: VnuProfile; crossDetailEnabled: boolean }) {
  const { t } = useLocale();
  const state = useHyeboard();
  const [mode, setMode] = useState<VnuCrossTranscriptInput["mode"]>("stdId");
  const [stdId, setStdId] = useState("");
  const [stdCode, setStdCode] = useState("");
  const [submitted, setSubmitted] = useState<VnuCrossTranscriptInput | null>(null);
  const inputState = deriveCrossTranscriptInput(mode, mode === "stdId" ? stdId : stdCode, profile);

  const transcriptQuery = useFeatureQuery(
    "vnu-cross-transcript",
    ({ signal }) => api.vnuCrossTranscript(submitted!, signal),
    {
      capability: "crossLookup",
      enabled: Boolean(submitted),
      queryKey: ["vnu-cross-transcript", state.universityId, state.sessionNonce, submitted],
    },
  );
  const derivedTerms = useMemo(() => transcriptAcademicSummaries(transcriptQuery.data), [transcriptQuery.data]);
  const permits = useMemo(() => {
    const mapped = new Map<string, string>();
    if (!crossDetailEnabled) return mapped;
    for (const permit of transcriptQuery.data?.detailPermits ?? []) {
      const term = transcriptQuery.data?.terms[permit.termIndex];
      const row = term?.rows[permit.rowIndex];
      if (term && row) mapped.set(`${term.maHK}:${row.courseCode}:${row.classId ?? permit.rowIndex}`, permit.permit);
    }
    return mapped;
  }, [crossDetailEnabled, transcriptQuery.data]);

  useEffect(() => {
    setSubmitted(null);
    const clearForAccount = () => setSubmitted(null);
    window.addEventListener(ACCOUNT_SWITCHED_EVENT, clearForAccount);
    return () => {
      window.removeEventListener(ACCOUNT_SWITCHED_EVENT, clearForAccount);
      setSubmitted(null);
    };
  }, [state.sessionNonce, state.universityId]);

  const submit = () => {
    if (!inputState.target) return;
    setSubmitted(inputState.target);
  };
  const transcriptView = deriveCrossTranscriptView({
    input: inputState,
    submitted: Boolean(submitted),
    isLoading: transcriptQuery.isLoading,
    hasError: Boolean(transcriptQuery.error),
    errorCode: transcriptQuery.error instanceof ApiError ? transcriptQuery.error.code : undefined,
    transcript: transcriptQuery.data,
    derivedTerms,
  });
  const transcriptExportModel = transcriptView.kind === "success" && submitted ? createTranscriptExport({
    universityId: state.universityId,
    query: { mode: submitted.mode, value: submitted.mode === "stdId" ? submitted.stdId : submitted.stdCode },
    identity: {
      internalStudentId: submitted.mode === "stdId" ? submitted.stdId : undefined,
      studentCode: transcriptView.transcript.header.studentCode,
      studentName: transcriptView.transcript.header.studentName,
      managingClass: transcriptView.transcript.header.className,
    },
    reported: {
      cumulativeGpa4: transcriptView.transcript.totals.gpa4,
      totalCredits: transcriptView.transcript.totals.totalCredits,
      accumulatedCredits: transcriptView.transcript.totals.accumulatedCredits,
    },
    derivedTerms: transcriptView.derivedTerms.map((summary) => crossTranscriptExportTerm(summary, formatTermLabel(summary.termKey, "vnu", t.terms))),
  }) : undefined;
  const translatedError = transcriptView.kind === "error"
    ? transcriptView.errorKind === "rateLimited"
      ? t.lookup.crossTranscriptRateLimited
      : transcriptView.errorKind === "temporarilyUnavailable"
        ? t.lookup.crossTranscriptUnavailable
        : t.lookup.crossTranscriptError
    : t.lookup.crossTranscriptError;

  return (
    <section data-testid="cross-transcript" className="space-y-4" aria-labelledby="cross-transcript-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1"><h3 id="cross-transcript-heading" className="text-sm font-semibold">{t.lookup.crossTranscriptTitle}</h3><p className="max-w-[70ch] text-sm text-muted-foreground">{t.lookup.crossTranscriptDescription}</p></div>
        {transcriptExportModel ? <ExportMenu model={transcriptExportModel} /> : null}
      </div>
        <div className="grid min-h-11 grid-cols-2 rounded-lg border border-border p-1 sm:inline-grid" role="group" aria-label={t.lookup.crossTranscriptModeLabel}>
          <Button type="button" size="sm" variant={mode === "stdId" ? "default" : "ghost"} className="min-h-11" aria-pressed={mode === "stdId"} onClick={() => { setMode("stdId"); setSubmitted(null); }}>{t.lookup.crossTranscriptStdIdMode}</Button>
          <Button type="button" size="sm" variant={mode === "stdCode" ? "default" : "ghost"} className="min-h-11" aria-pressed={mode === "stdCode"} onClick={() => { setMode("stdCode"); setSubmitted(null); }}>{t.lookup.crossTranscriptStdCodeMode}</Button>
        </div>
        <form className="grid gap-3 sm:grid-cols-[1fr_auto]" onSubmit={(event) => { event.preventDefault(); submit(); }}>
          <div className="space-y-1.5">
            <label htmlFor="cross-transcript-target" className="text-sm font-medium">{mode === "stdId" ? t.lookup.crossStdIdLabel : t.lookup.crossIdStdCodeLabel}</label>
            <Input
              id="cross-transcript-target"
              className="min-h-11 font-mono tabular-nums"
              inputMode="numeric"
              value={mode === "stdId" ? stdId : stdCode}
              onChange={(event) => { if (mode === "stdId") setStdId(event.target.value); else setStdCode(event.target.value); setSubmitted(null); }}
              placeholder={mode === "stdId" ? t.lookup.crossStdIdPlaceholder : t.lookup.crossIdStdCodePlaceholder}
              aria-invalid={inputState.input.length > 0 && !inputState.isValid}
            />
          </div>
          <Button type="submit" className="min-h-11 sm:self-end" disabled={!inputState.target}>{t.lookup.crossTranscriptSubmit}</Button>
        </form>

        <div className="min-h-24" aria-live="polite">{transcriptView.kind === "prompt" ? <Empty text={t.lookup.crossTranscriptPrompt} />
          : transcriptView.kind === "invalid" ? <Empty text={mode === "stdId" ? t.lookup.crossTranscriptInvalidStdId : t.lookup.crossTranscriptInvalidStdCode} />
          : transcriptView.kind === "selfTarget" ? <Empty text={t.lookup.crossTranscriptSelfTarget} />
          : transcriptView.kind === "loading" ? <Empty text={t.lookup.crossTranscriptLoading} />
          : transcriptView.kind === "error" ? <div className="space-y-2" role="alert"><Empty text={translatedError} /><Button type="button" variant="outline" className="min-h-11" onClick={() => void transcriptQuery.refetch()}>{t.lookup.retry}</Button></div>
          : transcriptView.kind === "notFound" ? <Empty text={t.lookup.crossTranscriptNoStudent} />
          : transcriptView.kind === "noRows" ? <Empty text={t.lookup.crossTranscriptNoRows} />
          : transcriptView.kind === "success" ? (
            <div className="space-y-5">
              <div className="list-row border-y border-border px-0">
                <div className="min-w-0">
                  <p className="break-words text-sm font-semibold">{transcriptView.transcript.header.studentName ?? transcriptView.transcript.header.studentCode}</p>
                  <p className="break-words text-xs text-muted-foreground">{[transcriptView.transcript.header.studentCode, transcriptView.transcript.header.className].filter(Boolean).join(" · ")}</p>
                </div>
              </div>
              <SummaryStrip testId="cross-transcript-totals">
                <SummaryStat label={t.lookup.crossTranscriptTotalCredits} value={transcriptView.transcript.totals.totalCredits ?? "-"} />
                <SummaryStat label={t.lookup.crossTranscriptAccumulatedCredits} value={transcriptView.transcript.totals.accumulatedCredits ?? "-"} />
                <SummaryStat label={t.lookup.crossTranscriptGpa4} value={transcriptView.transcript.totals.gpa4 ?? "-"} />
              </SummaryStrip>
              {transcriptView.derivedTerms.map((summary) => <CrossTranscriptTerm key={summary.termKey} summary={summary} permits={permits} />)}
            </div>
          ) : null}</div>
    </section>
  );
}

type StudentLookupMode = "id-to-code" | "code-to-id" | "transcript";

function StudentRecordTools({ profile, crossLookupEnabled, crossDetailEnabled }: { profile: VnuProfile; crossLookupEnabled: boolean; crossDetailEnabled: boolean }) {
  const { t } = useLocale();
  const state = useHyeboard();
  const [mode, setMode] = useState<StudentLookupMode>("id-to-code");
  const key = `${state.activeAccountId}:${state.sessionNonce}`;
  return (
    <Card key={key} data-testid="student-record-tools">
      <CardHeader>
        <CardTitle className="text-base">{t.lookup.studentRecordsTitle}</CardTitle>
        <CardDescription className="max-w-[70ch]">{t.lookup.studentRecordsDescription}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <section className="space-y-2" aria-labelledby="own-identifiers-heading">
          <h3 id="own-identifiers-heading" className="text-sm font-semibold">{t.lookup.ownIdsTitle}</h3>
          <SummaryStrip testId="lookup-own-ids">
            <SummaryStat label={t.lookup.studentCodeLabel} value={<span className="break-all font-mono text-xl tabular-nums sm:text-2xl">{profile.studentCode ?? "-"}</span>} />
            <SummaryStat label={t.lookup.internalIdLabel} value={<span className="break-all font-mono text-xl tabular-nums sm:text-2xl">{profile.internalStudentId ?? "-"}</span>} />
          </SummaryStrip>
        </section>
        {crossLookupEnabled ? (
          <>
            <div className="border-t border-border pt-5">
              <div className="grid grid-cols-3 rounded-lg border border-border p-1" role="group" aria-label={t.lookup.studentModeLabel}>
                <Button type="button" variant={mode === "id-to-code" ? "default" : "ghost"} className="min-h-11 min-w-0 whitespace-normal px-2" aria-pressed={mode === "id-to-code"} onClick={() => setMode("id-to-code")}>{t.lookup.studentModeIdToCode}</Button>
                <Button type="button" variant={mode === "code-to-id" ? "default" : "ghost"} className="min-h-11 min-w-0 whitespace-normal px-2" aria-pressed={mode === "code-to-id"} onClick={() => setMode("code-to-id")}>{t.lookup.studentModeCodeToId}</Button>
                <Button type="button" variant={mode === "transcript" ? "default" : "ghost"} className="min-h-11 min-w-0 whitespace-normal px-2" aria-pressed={mode === "transcript"} onClick={() => setMode("transcript")}>{t.lookup.studentModeTranscript}</Button>
              </div>
            </div>
            {mode === "id-to-code" ? <CrossStudentCodeSection profile={profile} /> : mode === "code-to-id" ? <CrossStudentIdSection profile={profile} /> : <CrossTranscriptSection profile={profile} crossDetailEnabled={crossDetailEnabled} />}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function BulkLookupResultRow({ item, mode }: { item: VnuBulkLookupItem; mode: VnuBulkLookupMode }) {
  const { t } = useLocale();
  if (item.status === "error") {
    const message = item.errorCode === "VNU_CROSS_LOOKUP_SELF_TARGET"
      ? t.lookup.bulkErrorSelf
      : item.errorCode === "VNU_CROSS_LOOKUP_NOT_FOUND" || item.errorCode === "VNU_CROSS_LOOKUP_NOT_CONVERGED"
        ? t.lookup.bulkErrorNotFound
        : item.errorCode === "VNU_CROSS_LOOKUP_INVALID_TARGET"
          ? t.lookup.bulkErrorInvalid
          : t.lookup.bulkErrorGeneric;
    return <div className="list-row flex-col items-stretch gap-1 sm:flex-row sm:items-center"><span className="break-all font-mono text-sm tabular-nums">{item.target}</span><span className="break-words text-sm text-muted-foreground sm:text-right">{message}</span></div>;
  }

  const result = item.result;
  let primary = "-";
  let secondary = t.lookup.bulkCompletedItem;
  if (mode === "stdid-to-code" && "studentCode" in result) {
    primary = result.studentCode ?? "-";
    secondary = [result.studentName, result.className].filter(Boolean).join(" · ") || t.lookup.bulkCompletedItem;
  } else if (mode === "code-to-stdid" && "stdId" in result) {
    primary = result.stdId;
    secondary = t.lookup.crossIdProbes(result.probes);
  } else if ("header" in result) {
    primary = result.header.studentCode ?? "-";
    const rowCount = result.terms.reduce((total, term) => total + term.rows.length, 0);
    secondary = t.lookup.bulkTranscriptRows(rowCount);
  }
  return (
    <div className="list-row flex-col items-stretch gap-2 sm:flex-row sm:items-center">
      <div className="min-w-0"><p className="break-all font-mono text-sm tabular-nums">{item.target}</p><p className="break-words text-xs text-muted-foreground">{secondary}</p></div>
      <Badge className="max-w-full self-start break-all border border-border bg-background font-mono font-normal tabular-nums text-foreground sm:shrink-0 sm:self-auto">{primary}</Badge>
    </div>
  );
}

const BULK_EXPORT_SURFACE: Record<VnuBulkLookupMode, Extract<ExportSurface, `bulk-${string}`>> = {
  "stdid-to-code": "bulk-id-to-code",
  "code-to-stdid": "bulk-code-to-id",
  "stdid-to-transcript": "bulk-id-to-transcript",
};

function bulkExportItem(item: VnuBulkLookupItem, mode: VnuBulkLookupMode, termLabel: (termCode: string) => string): ExportBulkItem {
  if (item.status === "error") return { target: item.target, status: "error", errorCode: item.errorCode };

  if (mode === "stdid-to-code") {
    const result = item.result;
    if (!("studentCode" in result) || typeof result.studentCode !== "string") throw new Error("Invalid bulk lookup response");
    return {
      target: item.target,
      status: "ok",
      result: { identity: { studentCode: result.studentCode, internalStudentId: item.target, studentName: result.studentName, managingClass: result.className } },
    };
  }

  if (mode === "code-to-stdid") {
    const result = item.result;
    if (!("stdCode" in result) || !("stdId" in result) || !("probes" in result) || typeof result.stdCode !== "string" || typeof result.stdId !== "string" || typeof result.probes !== "number" || !Number.isFinite(result.probes)) {
      throw new Error("Invalid bulk lookup response");
    }
    return {
      target: item.target,
      status: "ok",
      result: { resolver: { resolvedStudentCode: result.stdCode, resolvedInternalStudentId: result.stdId, probes: result.probes } },
    };
  }

  const transcript = item.result;
  if (!("header" in transcript) || !("totals" in transcript) || !("terms" in transcript)) throw new Error("Invalid bulk lookup response");
  return {
    target: item.target,
    status: "ok",
    result: {
      identity: {
        studentCode: transcript.header.studentCode,
        internalStudentId: item.target,
        studentName: transcript.header.studentName,
        managingClass: transcript.header.className,
      },
      reported: {
        cumulativeGpa4: transcript.totals.gpa4,
        totalCredits: transcript.totals.totalCredits,
        accumulatedCredits: transcript.totals.accumulatedCredits,
      },
      derivedTerms: transcriptAcademicSummaries(transcript).map((summary) => crossTranscriptExportTerm(summary, termLabel(summary.termKey))),
    },
  };
}

function createdBulkExportItems(model: ExportDocument): ExportBulkItem[] {
  if (!model.results) throw new Error("Bulk export model omitted results");
  return model.results.map((item) => {
    if (!("target" in item) || !("status" in item) || typeof item.target !== "string") throw new Error("Bulk export model contained an invalid result");
    if (item.status === "error" && "errorCode" in item && typeof item.errorCode === "string") {
      return { target: item.target, status: "error", errorCode: item.errorCode };
    }
    if (item.status === "ok" && "result" in item) return { target: item.target, status: "ok", result: item.result };
    throw new Error("Bulk export model contained an invalid result");
  });
}

const BULK_RESULTS_PAGE_SIZE = 50;

function BulkLookupSection({ maximum, modeMaximums, directChunkMaximum }: { maximum: number; modeMaximums?: Partial<Record<VnuBulkLookupMode, number>>; directChunkMaximum?: number }) {
  const { locale, t } = useLocale();
  const state = useHyeboard();
  const [mode, setMode] = useState<VnuBulkLookupMode>("stdid-to-code");
  const [rawTargets, setRawTargets] = useState("");
  const [active, setActive] = useState(false);
  const [progress, setProgress] = useState<BulkLookupProgress>({ processed: 0, total: 0, items: [] });
  const [remainingTargets, setRemainingTargets] = useState<string[]>([]);
  const [restoredWithoutReplay, setRestoredWithoutReplay] = useState(false);
  const [requestError, setRequestError] = useState<string | undefined>();
  const [exportModel, setExportModel] = useState<ExportDocument | undefined>();
  const [resultPageStart, setResultPageStart] = useState(0);
  const abortController = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const processedItemCount = useRef(0);
  const progressSnapshot = useRef<BulkLookupProgress>({ processed: 0, total: 0, items: [] });
  const exportItems = useRef<ExportBulkItem[]>([]);
  const termDictionary = useRef(t.terms);
  useEffect(() => {
    termDictionary.current = t.terms;
  }, [t.terms]);
  const activeMaximum = modeMaximums?.[mode] ?? maximum;
  const parsed = useMemo(() => parseBulkTargets(rawTargets, activeMaximum), [rawTargets, activeMaximum]);
  const viewState = deriveBulkLookupViewState(parsed, active, progress.processed);
  const lastPageStart = Math.floor(Math.max(0, progress.items.length - 1) / BULK_RESULTS_PAGE_SIZE) * BULK_RESULTS_PAGE_SIZE;
  const effectivePageStart = Math.min(resultPageStart, lastPageStart);
  const visibleItems = progress.items.slice(effectivePageStart, effectivePageStart + BULK_RESULTS_PAGE_SIZE);
  const visibleRangeStart = progress.items.length > 0 ? effectivePageStart + 1 : 0;
  const visibleRangeEnd = effectivePageStart + visibleItems.length;

  const invalidateRun = () => {
    generation.current += 1;
    const controller = abortController.current;
    abortController.current = null;
    controller?.abort();
  };

  const clearLookupState = (clearInput: boolean) => {
    invalidateRun();
    setActive(false);
    if (clearInput) setRawTargets("");
    const emptyProgress = { processed: 0, total: 0, items: [] };
    progressSnapshot.current = emptyProgress;
    processedItemCount.current = 0;
    exportItems.current = [];
    setProgress({ processed: 0, total: 0, items: [] });
    setRemainingTargets([]);
    setRestoredWithoutReplay(false);
    setRequestError(undefined);
    setExportModel(undefined);
    setResultPageStart(0);
  };

  useEffect(() => {
    const invalidateForAccountSwitch = () => clearLookupState(true);
    const invalidateForRefresh = (event: Event) => {
      const detail = (event as CustomEvent<{ preserveFeatureState?: boolean }>).detail;
      if (detail?.preserveFeatureState) return;
      clearLookupState(true);
    };
    window.addEventListener(ACCOUNT_SWITCHED_EVENT, invalidateForAccountSwitch);
    window.addEventListener("hyeboard:vnu-refresh-committed", invalidateForRefresh);
    return () => {
      window.removeEventListener(ACCOUNT_SWITCHED_EVENT, invalidateForAccountSwitch);
      window.removeEventListener("hyeboard:vnu-refresh-committed", invalidateForRefresh);
      invalidateRun();
    };
  }, []);

  useEffect(() => {
    if (exportItems.current.length === 0) return;
    const rebuilt = createBulkExport({
      surface: BULK_EXPORT_SURFACE[mode],
      universityId: state.universityId,
      mode,
      total: progressSnapshot.current.total,
      items: progressSnapshot.current.items.map((item) => bulkExportItem(item, mode, (termCode) => formatTermLabel(termCode, "vnu", termDictionary.current))),
    });
    exportItems.current = createdBulkExportItems(rebuilt);
    setExportModel((current) => current ? { ...rebuilt, run: { ...rebuilt.run!, status: current.run?.status ?? "partial" } } : undefined);
  }, [locale]);

  useEffect(() => {
    if (resultPageStart > lastPageStart) setResultPageStart(lastPageStart);
  }, [lastPageStart, resultPageStart]);

  const appendExportItems = (items: VnuBulkLookupItem[], total: number, runGeneration: number, controller: AbortController) => {
    if (generation.current !== runGeneration || abortController.current !== controller) return;
    const projectedItems = items.map((item) => bulkExportItem(item, mode, (termCode) => formatTermLabel(termCode, "vnu", termDictionary.current)));
    const chunkModel = createBulkExport({ surface: BULK_EXPORT_SURFACE[mode], universityId: state.universityId, mode, total: projectedItems.length, items: projectedItems });
    exportItems.current.push(...createdBulkExportItems(chunkModel));
    setExportModel({
      ...chunkModel,
      run: { status: "partial", mode, processedCount: exportItems.current.length, totalCount: total },
      results: exportItems.current,
    });
  };

  const reset = () => clearLookupState(true);

  const run = async () => {
    if (parsed.error) return;
    invalidateRun();
    const controller = new AbortController();
    const runGeneration = generation.current;
    abortController.current = controller;
    setActive(true);
    setRequestError(undefined);
    setRestoredWithoutReplay(false);
    const retrying = remainingTargets.length > 0;
    const pendingTargets = retrying ? remainingTargets : parsed.targets;
    const initialProgress = retrying ? progress : { processed: 0, total: parsed.targets.length, items: [] };
    if (retrying) {
      setExportModel((current) => current?.run ? { ...current, run: { ...current.run, status: "partial" } } : current);
    } else {
      exportItems.current = [];
      setExportModel(undefined);
      setResultPageStart(0);
    }
    processedItemCount.current = initialProgress.items.length;
    progressSnapshot.current = initialProgress;
    setProgress(initialProgress);
    try {
      await state.ensureSession();
      if (generation.current !== runGeneration || abortController.current !== controller) return;
      const execution = await executeBulkLookup({
        mode,
        targets: pendingTargets,
        signal: controller.signal,
        initialProgress,
        modeMaxTargets: modeMaximums,
        directChunkMaxTargets: directChunkMaximum,
        requestChunk: async (requestMode, targets, signal) => {
          if (generation.current !== runGeneration || abortController.current !== controller) throw new Error("Stale bulk lookup run");
          return parseBulkLookupItems(requestMode, await api.vnuCrossLookupBulk(requestMode, targets, signal));
        },
        onProgress: (nextProgress) => {
          if (generation.current !== runGeneration || abortController.current !== controller) return;
          const newItems = nextProgress.items.slice(processedItemCount.current);
          processedItemCount.current = nextProgress.items.length;
          progressSnapshot.current = nextProgress;
          appendExportItems(newItems, nextProgress.total, runGeneration, controller);
          setProgress(nextProgress);
        },
      });
      if (generation.current !== runGeneration || abortController.current !== controller) return;
      progressSnapshot.current = execution.progress;
      setProgress(execution.progress);
      setRemainingTargets(execution.remainingTargets);
      setRestoredWithoutReplay(execution.restoredWithoutReplay);
      const errorCode = execution.error instanceof ApiError
        ? execution.error.code
        : execution.error instanceof Error && execution.error.message === "Invalid bulk lookup response"
          ? "VNU_CROSS_LOOKUP_INVALID_RESPONSE"
          : execution.error
            ? "VNU_CROSS_LOOKUP_FAILED"
            : undefined;
      if (errorCode) setRequestError(errorCode);
      const complete = !execution.aborted && !execution.error && execution.progress.processed === execution.progress.total && execution.remainingTargets.length === 0;
      setExportModel((current) => current?.run ? { ...current, run: { ...current.run, status: complete ? "complete" : "partial" } } : current);
    } catch (error) {
      if (generation.current === runGeneration && abortController.current === controller && !controller.signal.aborted) {
        setRemainingTargets(pendingTargets);
        setRequestError(error instanceof ApiError ? error.code : "VNU_CROSS_LOOKUP_FAILED");
      }
    } finally {
      if (generation.current === runGeneration && abortController.current === controller) {
        abortController.current = null;
        setActive(false);
      }
    }
  };

  const validationMessage = parsed.error === "tooMany"
    ? t.lookup.bulkTooMany(activeMaximum)
    : t.lookup.bulkEmpty;
  const requestErrorMessage = requestError === "VNU_RATE_LIMITED"
    ? t.lookup.bulkRateLimited
    : requestError === "VNU_PROBE_BUDGET_UNAVAILABLE"
      ? t.lookup.bulkUnavailable
      : requestError === "VNU_CROSS_LOOKUP_INVALID_RESPONSE"
        ? t.lookup.bulkInvalidResponse
        : t.lookup.bulkRequestFailed;

  return (
    <Card data-testid="bulk-lookup" aria-busy={active}>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <CardTitle className="text-base">{t.lookup.bulkTitle}</CardTitle>
          {exportModel ? <ExportMenu model={exportModel} /> : null}
        </div>
        <CardDescription>{t.lookup.bulkDescription(maximum)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[minmax(12rem,0.45fr)_1fr]">
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="bulk-lookup-mode">{t.lookup.bulkModeLabel}</label>
            <Select value={mode} onValueChange={(value) => { const nextMode = parseBulkLookupMode(value); clearLookupState(false); setMode(nextMode); }} disabled={active}>
              <SelectTrigger id="bulk-lookup-mode" className="min-h-11"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="stdid-to-code">{t.lookup.bulkModeIdToCode}</SelectItem>
                <SelectItem value="code-to-stdid">{t.lookup.bulkModeCodeToId}</SelectItem>
                <SelectItem value="stdid-to-transcript">{t.lookup.bulkModeIdToTranscript}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="bulk-lookup-targets">{t.lookup.bulkTargetsLabel}</label>
            <Textarea id="bulk-lookup-targets" className="min-h-32 font-mono" value={rawTargets} disabled={active} onChange={(event) => { clearLookupState(false); setRawTargets(event.target.value); }} placeholder={t.lookup.bulkTargetsPlaceholder} aria-invalid={parsed.error === "tooMany"} />
          </div>
        </div>
        <div className="grid gap-2 sm:flex sm:flex-wrap">
          <Button type="button" className="min-h-11" disabled={active || Boolean(parsed.error)} onClick={() => void run()}>{remainingTargets.length ? t.lookup.bulkRetry : t.lookup.bulkRun}</Button>
          {active ? <Button type="button" variant="outline" className="min-h-11" onClick={() => abortController.current?.abort()}>{t.lookup.bulkCancel}</Button> : null}
          <Button type="button" variant="ghost" className="min-h-11" disabled={active && progress.processed === 0} onClick={reset}>{t.lookup.bulkReset}</Button>
        </div>

        <div className="min-h-20" aria-live="polite">{active ? <div className="space-y-2"><p id="bulk-lookup-progress-label" className="text-sm text-muted-foreground">{t.lookup.bulkProgress(progress.processed, progress.total)}</p><Progress value={progress.total ? progress.processed / progress.total * 100 : 0} aria-labelledby="bulk-lookup-progress-label" /></div> : null}
        {requestError ? <div role="alert"><Empty text={requestErrorMessage} /></div>
          : restoredWithoutReplay ? <div role="status"><Empty text={t.lookup.bulkSessionRestored} /></div>
          : viewState === "empty" ? <Empty text={t.lookup.bulkEmpty} />
          : viewState === "validation" ? <Empty text={validationMessage} />
          : viewState === "loading" && progress.items.length === 0 ? <Empty text={t.lookup.bulkLoading} />
          : null}</div>
        {progress.items.length > 0 ? (
           <div className="max-h-[32rem] overflow-auto">
            <div className="flex items-center justify-between border-b border-border pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"><span>{t.lookup.bulkTargetColumn}</span><span>{viewState === "completed" ? t.lookup.bulkCompleted(progress.processed) : t.lookup.bulkProgress(progress.processed, progress.total)}</span></div>
            <div data-testid="bulk-results-list" className="divide-y divide-border">{visibleItems.map((item, index) => <BulkLookupResultRow key={`${item.target}-${index}`} item={item} mode={mode} />)}</div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
              <p className="text-sm text-muted-foreground">{t.lookup.bulkShowingRange(visibleRangeStart, visibleRangeEnd, progress.items.length)}</p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" className="min-h-11" disabled={effectivePageStart === 0} onClick={() => setResultPageStart((start) => Math.max(0, start - BULK_RESULTS_PAGE_SIZE))}>{t.lookup.bulkPreviousPage}</Button>
                <Button type="button" variant="outline" className="min-h-11" disabled={visibleRangeEnd >= progress.items.length} onClick={() => setResultPageStart((start) => Math.min(lastPageStart, start + BULK_RESULTS_PAGE_SIZE))}>{t.lookup.bulkNextPage}</Button>
              </div>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function LookupPage() {
  const state = useHyeboard();
  const { t } = useLocale();
  const classLookupEnabled = state.activeUniversity?.capabilities.classLookup === true;
  const crossLookup = state.activeUniversity?.limits?.crossLookup;
  const crossLookupEnabled = state.activeUniversity?.capabilities.crossLookup === true && crossLookup !== undefined;
  const bulkMaximum = crossLookup?.bulkMaxTargets;
  const bulkDirectChunkMaximum = crossLookup?.bulkDirectChunkMaxTargets;
  const bulkModeMaximums = crossLookup?.bulkModeMaxTargets;
  const crossDetailEnabled = crossLookupEnabled && Number.isSafeInteger(crossLookup?.crossDetail?.maxRows)
    && crossLookup!.crossDetail!.maxRows > 0;
  const bulkLookupEnabled = crossLookupEnabled && Number.isSafeInteger(bulkMaximum) && bulkMaximum! > 0;
  const profileQuery = useFeatureQuery("vnu-lookup-profile", ({ signal }) => api.vnuOwnProfile(signal), {
    capability: ["classLookup", "crossLookup"],
    enabled: classLookupEnabled || crossLookupEnabled,
    queryKey: ["vnu-lookup-profile", state.universityId, state.activeAccountId],
  });

  return (
    <FeatureFrame title={t.lookup.title} description={t.lookup.description} query={classLookupEnabled || crossLookupEnabled ? profileQuery : { ...profileQuery, data: {} as VnuProfile }}>
      {(profile) => (
        <div className="space-y-6">
          {classLookupEnabled ? <ClassIdentifierTools /> : null}
          {crossLookupEnabled ? <StudentRecordTools profile={profile} crossLookupEnabled crossDetailEnabled={crossDetailEnabled} /> : null}
          {bulkLookupEnabled ? <BulkLookupSection maximum={bulkMaximum!} modeMaximums={bulkModeMaximums} directChunkMaximum={bulkDirectChunkMaximum} /> : null}
        </div>
      )}
    </FeatureFrame>
  );
}
