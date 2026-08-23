export type ExportFormat = "json" | "csv" | "pdf";
export type TextExportFormat = Exclude<ExportFormat, "pdf">;

export type ExportSurface =
  | "class-forward"
  | "class-reverse"
  | "student-id-to-code"
  | "student-code-to-id"
  | "grades-term"
  | "grades-page"
  | "cross-transcript"
  | "bulk-id-to-code"
  | "bulk-code-to-id"
  | "bulk-id-to-transcript";

export type ExportQuery = { mode: string; value: string };
export type ExportIdentity = { studentCode?: string; internalStudentId?: string; studentName?: string; managingClass?: string };
export type ExportReported = { cumulativeGpa4?: number; totalCredits?: number; accumulatedCredits?: number };
export type ExportCourse = { courseCode: string; courseName: string; credits?: number; point10?: number; letter?: string; point4?: number };
export type ExportDerivedTerm = {
  termCode: string;
  termLabel: string;
  estimateKind: "derived";
  listedCredits: number;
  includedCredits: number;
  termGpa4?: number;
  derivedCpa4?: number;
  courses: ExportCourse[];
};
export type ExportClassResult = { classCode: string; classNumber?: string; classId: string; courseName?: string };
export type ExportResolverResult = { resolvedStudentCode: string; resolvedInternalStudentId: string; probes: number };
export type ExportResult = {
  identity?: ExportIdentity;
  classResult?: ExportClassResult;
  resolver?: ExportResolverResult;
  reported?: ExportReported;
  derivedTerms?: ExportDerivedTerm[];
};
export type ExportBulkItem =
  | { target: string; status: "ok"; result: ExportResult }
  | { target: string; status: "error"; errorCode: string };
export type ExportRun = { status: "complete" | "partial"; mode: string; processedCount: number; totalCount: number };
export type ExportDocument = {
  schemaVersion: 1;
  surface: ExportSurface;
  universityId: string;
  query?: ExportQuery;
  run?: ExportRun;
  identity?: ExportIdentity;
  reported?: ExportReported;
  derivedTerms?: ExportDerivedTerm[];
  results?: Array<ExportResult | ExportBulkItem>;
};

export type PrintableExportLabels = {
  title: string;
  surface: string;
  university: string;
  query: string;
  run: string;
  identity: string;
  reported: string;
  terms: string;
  results: string;
  target: string;
  error: string;
  course: string;
  credits: string;
  score: string;
  letter: string;
  point4: string;
  gpa: string;
  cpa: string;
  studentCode: string;
  name: string;
  managingClass: string;
  classCode: string;
  classNumber: string;
  classId: string;
  internalStudentId: string;
  probes: string;
  accumulatedCredits: string;
  mode: string;
  value: string;
  status: string;
  processed: string;
};

export type PdfExportLabels = Omit<PrintableExportLabels, "internalStudentId"> & {
  heading: string;
  exportedAt: string;
  page: string;
};

type IdentityInput = ExportIdentity & Record<string, unknown>;

function copyIdentity(input: ExportIdentity | IdentityInput | undefined): ExportIdentity | undefined {
  if (!input) return undefined;
  const value = {
    studentCode: input.studentCode,
    internalStudentId: input.internalStudentId,
    studentName: input.studentName,
    managingClass: input.managingClass,
  };
  return Object.values(value).some((field) => field !== undefined) ? value : undefined;
}

function copyReported(input: ExportReported | undefined): ExportReported | undefined {
  if (!input) return undefined;
  const value = {
    cumulativeGpa4: input.cumulativeGpa4,
    totalCredits: input.totalCredits,
    accumulatedCredits: input.accumulatedCredits,
  };
  return Object.values(value).some((field) => field !== undefined) ? value : undefined;
}

function copyCourse(input: ExportCourse): ExportCourse {
  return {
    courseCode: input.courseCode,
    courseName: input.courseName,
    credits: input.credits,
    point10: input.point10,
    letter: input.letter,
    point4: input.point4,
  };
}

function copyDerivedTerm(input: ExportDerivedTerm): ExportDerivedTerm {
  return {
    termCode: input.termCode,
    termLabel: input.termLabel,
    estimateKind: "derived",
    listedCredits: input.listedCredits,
    includedCredits: input.includedCredits,
    termGpa4: input.termGpa4,
    derivedCpa4: input.derivedCpa4,
    courses: input.courses.map(copyCourse),
  };
}

function copyQuery(input: ExportQuery | undefined): ExportQuery | undefined {
  if (!input) return undefined;
  return { mode: input.mode, value: input.value };
}

function copyRun(input: ExportRun | undefined): ExportRun | undefined {
  if (!input) return undefined;
  return {
    status: input.status,
    mode: input.mode,
    processedCount: input.processedCount,
    totalCount: input.totalCount,
  };
}

function copyResult(input: ExportResult): ExportResult {
  return {
    identity: copyIdentity(input.identity),
    classResult: input.classResult ? {
      classCode: input.classResult.classCode,
      classNumber: input.classResult.classNumber,
      classId: input.classResult.classId,
      courseName: input.classResult.courseName,
    } : undefined,
    resolver: input.resolver ? {
      resolvedStudentCode: input.resolver.resolvedStudentCode,
      resolvedInternalStudentId: input.resolver.resolvedInternalStudentId,
      probes: input.resolver.probes,
    } : undefined,
    reported: copyReported(input.reported),
    derivedTerms: input.derivedTerms?.map(copyDerivedTerm),
  };
}

function copyNonBulkResult(input: ExportResult | ExportBulkItem): ExportResult {
  return copyResult({
    identity: "identity" in input ? input.identity : undefined,
    classResult: "classResult" in input ? input.classResult : undefined,
    resolver: "resolver" in input ? input.resolver : undefined,
    reported: "reported" in input ? input.reported : undefined,
    derivedTerms: "derivedTerms" in input ? input.derivedTerms : undefined,
  });
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<PropertyKey, unknown>, property: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, property);
}

function copyBulkResult(input: unknown, index: number): ExportBulkItem {
  const invalidResult = () => new Error(`Invalid bulk export result at index ${index}`);
  if (!isRecord(input) || !hasOwn(input, "status") || !hasOwn(input, "target")) throw invalidResult();

  if (input.status === "error") {
    if (typeof input.target !== "string" || !hasOwn(input, "errorCode") || typeof input.errorCode !== "string") throw invalidResult();
    return { target: input.target, status: "error", errorCode: input.errorCode };
  }

  if (input.status === "ok") {
    if (typeof input.target !== "string" || !hasOwn(input, "result") || !isRecord(input.result)) throw invalidResult();
    return { target: input.target, status: "ok", result: copyNonBulkResult(input.result as ExportResult) };
  }

  throw invalidResult();
}

const BULK_EXPORT_SURFACES: ReadonlySet<ExportSurface> = new Set([
  "bulk-id-to-code",
  "bulk-code-to-id",
  "bulk-id-to-transcript",
]);

function copyDocumentResults(surface: ExportSurface, results: ExportDocument["results"]): ExportDocument["results"] {
  if (!results) return undefined;
  if (BULK_EXPORT_SURFACES.has(surface)) return results.map(copyBulkResult);
  return results.map(copyNonBulkResult);
}

export function sanitizeExportDocument(model: ExportDocument): ExportDocument {
  return {
    schemaVersion: 1,
    surface: model.surface,
    universityId: model.universityId,
    query: copyQuery(model.query),
    run: copyRun(model.run),
    identity: copyIdentity(model.identity),
    reported: copyReported(model.reported),
    derivedTerms: model.derivedTerms?.map(copyDerivedTerm),
    results: copyDocumentResults(model.surface, model.results),
  };
}

function escapePrintableHtml(value: string | number | undefined): string {
  if (value === undefined) return "";
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function printableDefinitionList(value: Record<string, string | number | undefined>): string {
  const entries = Object.entries(value).filter(([, field]) => field !== undefined);
  if (!entries.length) return "";
  return `<dl>${entries.map(([label, field]) => `<dt>${escapePrintableHtml(label)}</dt><dd>${escapePrintableHtml(field)}</dd>`).join("")}</dl>`;
}

function printableTerms(terms: readonly ExportDerivedTerm[], labels: PrintableExportLabels): string {
  if (!terms.length) return "";
  return `<section><h2>${escapePrintableHtml(labels.terms)}</h2>${terms.map((term) => `<article><h3>${escapePrintableHtml(term.termLabel)}</h3>${printableDefinitionList({ [labels.credits]: `${term.includedCredits} / ${term.listedCredits}`, [labels.gpa]: term.termGpa4, [labels.cpa]: term.derivedCpa4 })}<table><thead><tr><th>${escapePrintableHtml(labels.course)}</th><th>${escapePrintableHtml(labels.credits)}</th><th>${escapePrintableHtml(labels.score)}</th></tr></thead><tbody>${term.courses.map((course) => `<tr><td>${escapePrintableHtml(`${course.courseCode} — ${course.courseName}`)}</td><td>${escapePrintableHtml(course.credits)}</td><td>${escapePrintableHtml(course.point10 ?? course.point4 ?? course.letter)}</td></tr>`).join("")}</tbody></table></article>`).join("")}</section>`;
}

function printableResult(result: ExportResult, labels: PrintableExportLabels): string {
  return [
    result.identity && printableDefinitionList({ [labels.name]: result.identity.studentName, [labels.studentCode]: result.identity.studentCode, [labels.managingClass]: result.identity.managingClass }),
    result.classResult && printableDefinitionList({ [labels.course]: result.classResult.courseName, [labels.classCode]: result.classResult.classCode, [labels.classId]: result.classResult.classId }),
    result.resolver && printableDefinitionList({ [labels.studentCode]: result.resolver.resolvedStudentCode, [labels.internalStudentId]: result.resolver.resolvedInternalStudentId, [labels.probes]: result.resolver.probes }),
    result.reported && printableDefinitionList({ [labels.gpa]: result.reported.cumulativeGpa4, [labels.credits]: result.reported.totalCredits, [labels.accumulatedCredits]: result.reported.accumulatedCredits }),
    result.derivedTerms && printableTerms(result.derivedTerms, labels),
  ].filter(Boolean).join("");
}

export function serializePrintableExport(model: ExportDocument, locale: string, labels: PrintableExportLabels): string {
  const document = sanitizeExportDocument(model);
  const sections = [
    printableDefinitionList({ [labels.surface]: document.surface, [labels.university]: document.universityId }),
    document.query && `<section><h2>${escapePrintableHtml(labels.query)}</h2>${printableDefinitionList({ [labels.mode]: document.query.mode, [labels.value]: document.query.value })}</section>`,
    document.run && `<section><h2>${escapePrintableHtml(labels.run)}</h2>${printableDefinitionList({ [labels.status]: document.run.status, [labels.mode]: document.run.mode, [labels.processed]: `${document.run.processedCount} / ${document.run.totalCount}` })}</section>`,
    document.identity && `<section><h2>${escapePrintableHtml(labels.identity)}</h2>${printableDefinitionList({ [labels.studentCode]: document.identity.studentCode, [labels.name]: document.identity.studentName, [labels.managingClass]: document.identity.managingClass })}</section>`,
    document.reported && `<section><h2>${escapePrintableHtml(labels.reported)}</h2>${printableDefinitionList({ [labels.gpa]: document.reported.cumulativeGpa4, [labels.credits]: document.reported.totalCredits, [labels.accumulatedCredits]: document.reported.accumulatedCredits })}</section>`,
    document.derivedTerms && printableTerms(document.derivedTerms, labels),
    document.results && `<section><h2>${escapePrintableHtml(labels.results)}</h2>${document.results.map((item) => "status" in item ? `<article><h3>${escapePrintableHtml(item.target)}</h3>${item.status === "error" ? printableDefinitionList({ [labels.error]: item.errorCode }) : printableResult(item.result, labels)}</article>` : `<article>${printableResult(item, labels)}</article>`).join("")}</section>`,
  ].filter(Boolean).join("");
  return `<!doctype html><html lang="${escapePrintableHtml(locale)}"><head><meta charset="utf-8"><title>${escapePrintableHtml(labels.title)}</title><style>body{font:14px/1.45 sans-serif;color:#111;margin:32px}h1{font-size:24px}h2{font-size:18px;margin-top:28px}h3{font-size:15px}section,article{break-inside:avoid}dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px}dt{font-weight:600}dd{margin:0}table{border-collapse:collapse;width:100%;margin-top:8px}th,td{border:1px solid #aaa;padding:6px;text-align:left}@media print{body{margin:16px}}</style></head><body><h1>${escapePrintableHtml(labels.title)}</h1>${sections}</body></html>`;
}

export type PdfPageOrientation = "portrait" | "landscape";
export type PdfDocumentDefinition = Record<string, unknown>;
export type PdfGenerator = { getBlob(): Promise<Blob> };
export type PdfLibrary = { createPdf(definition: PdfDocumentDefinition): PdfGenerator };
export type PdfLibraryLoader = () => Promise<PdfLibrary>;

const PDF_COLORS = {
  accent: "#1f4e79",
  accentFill: "#eaf1f7",
  border: "#cbd5df",
  muted: "#64748b",
  stripe: "#f7f9fb",
} as const;

const PDF_TABLE_LAYOUT = {
  hLineColor: () => PDF_COLORS.border,
  vLineColor: () => PDF_COLORS.border,
  hLineWidth: () => 0.5,
  vLineWidth: () => 0.5,
  paddingLeft: () => 5,
  paddingRight: () => 5,
  paddingTop: () => 4,
  paddingBottom: () => 4,
  fillColor: (rowIndex: number) => rowIndex === 0 ? PDF_COLORS.accentFill : rowIndex % 2 === 0 ? PDF_COLORS.stripe : undefined,
};

type PdfMakeModule = PdfLibrary & { addVirtualFileSystem(vfs: unknown): void };
type PdfVfsModule = { pdfMake?: { vfs?: unknown }; default?: unknown };

async function loadPdfMake(): Promise<PdfLibrary> {
  const [pdfMakeModule, pdfVfsModule] = await Promise.all([
    import("pdfmake/build/pdfmake") as Promise<PdfMakeModule & { default?: PdfMakeModule }>,
    import("pdfmake/build/vfs_fonts") as Promise<PdfVfsModule>,
  ]);
  const pdfMake = pdfMakeModule.default ?? pdfMakeModule;
  const defaultVfs = isRecord(pdfVfsModule.default) ? pdfVfsModule.default : undefined;
  const vfs = pdfVfsModule.pdfMake?.vfs ?? defaultVfs?.vfs ?? (isRecord(defaultVfs?.pdfMake) ? defaultVfs.pdfMake.vfs : undefined) ?? pdfVfsModule.default;
  if (!isRecord(vfs)) throw new Error("PDF font assets are unavailable");
  pdfMake.addVirtualFileSystem(vfs);
  return pdfMake;
}

function pdfValue(value: string | number | undefined): string {
  return value === undefined || value === "" ? "—" : String(value);
}

function pdfMetadataTable(value: Record<string, string | number | undefined>): PdfDocumentDefinition | undefined {
  const body = Object.entries(value)
    .filter(([, field]) => field !== undefined)
    .map(([label, field]) => [{ text: label, bold: true, color: PDF_COLORS.accent }, pdfValue(field)]);
  return body.length ? { table: { widths: [118, "*"], body }, layout: PDF_TABLE_LAYOUT, fontSize: 8.5, margin: [0, 3, 0, 9] } : undefined;
}

function pdfCourseTable(term: ExportDerivedTerm, labels: PdfExportLabels): PdfDocumentDefinition | undefined {
  if (!term.courses.length) return undefined;
  return {
    table: {
      headerRows: 1,
      widths: ["auto", "*", "auto", "auto", "auto", "auto"],
      body: [[
        { text: labels.course, bold: true, color: PDF_COLORS.accent },
        { text: labels.name, bold: true, color: PDF_COLORS.accent },
        { text: labels.credits, bold: true, color: PDF_COLORS.accent },
        { text: labels.score, bold: true, color: PDF_COLORS.accent },
        { text: labels.letter, bold: true, color: PDF_COLORS.accent },
        { text: labels.point4, bold: true, color: PDF_COLORS.accent },
      ], ...term.courses.map((course) => [
        course.courseCode,
        course.courseName,
        pdfValue(course.credits),
        pdfValue(course.point10),
        pdfValue(course.letter),
        pdfValue(course.point4),
      ])],
    },
    layout: PDF_TABLE_LAYOUT,
    fontSize: 7.5,
    margin: [0, 3, 0, 10],
  };
}

function pdfTermContent(terms: readonly ExportDerivedTerm[], labels: PdfExportLabels): PdfDocumentDefinition[] {
  const content: PdfDocumentDefinition[] = [];
  for (const term of terms) {
    content.push({ text: term.termLabel, style: "subsection" });
    const summary = pdfMetadataTable({ [labels.credits]: `${term.includedCredits} / ${term.listedCredits}`, [labels.gpa]: term.termGpa4, [labels.cpa]: term.derivedCpa4 });
    if (summary) content.push(summary);
    const courses = pdfCourseTable(term, labels);
    if (courses) content.push(courses);
  }
  return content;
}

function pdfResultContent(result: ExportResult, labels: PdfExportLabels): PdfDocumentDefinition[] {
  const content: PdfDocumentDefinition[] = [];
  const identity = result.identity && pdfMetadataTable({ [labels.name]: result.identity.studentName, [labels.studentCode]: result.identity.studentCode, [labels.managingClass]: result.identity.managingClass });
  const classResult = result.classResult && pdfMetadataTable({ [labels.course]: result.classResult.courseName, [labels.classCode]: result.classResult.classCode, [labels.classNumber]: result.classResult.classNumber, [labels.classId]: result.classResult.classId });
  const resolver = result.resolver && pdfMetadataTable({ [labels.studentCode]: result.resolver.resolvedStudentCode, [labels.probes]: result.resolver.probes });
  const reported = result.reported && pdfMetadataTable({ [labels.gpa]: result.reported.cumulativeGpa4, [labels.credits]: result.reported.totalCredits, [labels.accumulatedCredits]: result.reported.accumulatedCredits });
  for (const section of [identity, classResult, resolver, reported]) if (section) content.push(section);
  if (result.derivedTerms) content.push(...pdfTermContent(result.derivedTerms, labels));
  return content;
}

function maxPdfTableColumns(model: ExportDocument): number {
  const document = sanitizeExportDocument(model);
  const hasCourses = (terms: readonly ExportDerivedTerm[] | undefined) => terms?.some((term) => term.courses.length > 0) ?? false;
  if (hasCourses(document.derivedTerms)) return 6;
  if (document.results?.some((item) => hasCourses("status" in item && item.status === "ok" ? item.result.derivedTerms : "status" in item ? undefined : item.derivedTerms))) return 6;
  return 2;
}

export function resolvePdfPageOrientation(model: ExportDocument): PdfPageOrientation {
  return maxPdfTableColumns(model) >= 6 ? "landscape" : "portrait";
}

function formatPdfTimestamp(locale: string, date: Date): string {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }).format(date);
  } catch {
    return date.toISOString();
  }
}

export function createPdfExportDefinition(model: ExportDocument, locale: string, labels: PdfExportLabels, date = new Date()): PdfDocumentDefinition {
  const document = sanitizeExportDocument(model);
  const content: PdfDocumentDefinition[] = [
    { text: labels.heading, style: "heading" },
    { text: labels.title, style: "title" },
    { text: `${labels.exportedAt}: ${formatPdfTimestamp(locale, date)}`, style: "timestamp" },
  ];
  const context = pdfMetadataTable({
    [labels.surface]: document.surface,
    [labels.university]: document.universityId,
    [labels.mode]: document.query?.mode,
    [labels.value]: document.query?.mode === "stdId" ? undefined : document.query?.value,
    [labels.studentCode]: document.identity?.studentCode,
    [labels.name]: document.identity?.studentName,
    [labels.managingClass]: document.identity?.managingClass,
  });
  if (context) content.push(context);
  const reported = document.reported && pdfMetadataTable({ [labels.gpa]: document.reported.cumulativeGpa4, [labels.credits]: document.reported.totalCredits, [labels.accumulatedCredits]: document.reported.accumulatedCredits });
  if (reported) content.push({ text: labels.reported, style: "section" }, reported);
  if (document.derivedTerms?.length) {
    content.push({ text: labels.terms, style: "section" }, ...pdfTermContent(document.derivedTerms, labels));
  }
  if (document.run) {
    content.push({ text: labels.run, style: "section" });
    const run = pdfMetadataTable({ [labels.status]: document.run.status, [labels.mode]: document.run.mode, [labels.processed]: `${document.run.processedCount} / ${document.run.totalCount}` });
    if (run) content.push(run);
  }
  if (document.results?.length) {
    content.push({ text: labels.results, style: "section" });
    for (const item of document.results) {
      if ("status" in item) {
        if (document.surface === "bulk-code-to-id") content.push({ text: item.target, style: "subsection" });
        if (item.status === "error") {
          const error = pdfMetadataTable({ [labels.error]: item.errorCode });
          if (error) content.push(error);
        } else content.push(...pdfResultContent(item.result, labels));
      } else content.push(...pdfResultContent(item, labels));
    }
  }
  return {
    pageSize: "A4",
    pageOrientation: resolvePdfPageOrientation(document),
    pageMargins: [32, 32, 32, 30],
    defaultStyle: { font: "Roboto", fontSize: 8.5, color: "#1f2933" },
    styles: {
      heading: { fontSize: 12, bold: true, color: PDF_COLORS.accent, margin: [0, 0, 0, 2] },
      title: { fontSize: 17, bold: true, color: "#1f2933", margin: [0, 2, 0, 1] },
      timestamp: { fontSize: 7.5, color: PDF_COLORS.muted, margin: [0, 0, 0, 9] },
      section: { fontSize: 11, bold: true, color: PDF_COLORS.accent, margin: [0, 6, 0, 3] },
      subsection: { fontSize: 9, bold: true, color: PDF_COLORS.accent, margin: [0, 4, 0, 1] },
    },
    content,
    footer: (currentPage: number, pageCount: number) => ({ text: `${labels.page} ${currentPage} / ${pageCount}`, alignment: "center", fontSize: 7.5, color: PDF_COLORS.muted, margin: [0, 6, 0, 0] }),
  };
}

export function createClassLookupExport(input: {
  surface: "class-forward" | "class-reverse";
  universityId: string;
  query: ExportQuery;
  result: ExportClassResult;
}): ExportDocument {
  return {
    schemaVersion: 1,
    surface: input.surface,
    universityId: input.universityId,
    query: copyQuery(input.query),
    results: [copyResult({ classResult: input.result })],
  };
}

export function createResolverLookupExport(input: {
  surface: "student-id-to-code" | "student-code-to-id";
  universityId: string;
  query: ExportQuery;
  identity?: IdentityInput;
  resolver?: ExportResolverResult;
}): ExportDocument {
  return {
    schemaVersion: 1,
    surface: input.surface,
    universityId: input.universityId,
    query: copyQuery(input.query),
    results: [copyResult({ identity: copyIdentity(input.identity), resolver: input.resolver })],
  };
}

export function createGradesExport(input: {
  surface: "grades-term" | "grades-page";
  universityId: string;
  identity?: IdentityInput;
  reported?: ExportReported;
  derivedTerms: ExportDerivedTerm[];
}): ExportDocument {
  return {
    schemaVersion: 1,
    surface: input.surface,
    universityId: input.universityId,
    identity: copyIdentity(input.identity),
    reported: copyReported(input.reported),
    derivedTerms: input.derivedTerms.map(copyDerivedTerm),
  };
}

export function createTranscriptExport(input: {
  universityId: string;
  query: ExportQuery;
  identity?: IdentityInput;
  reported?: ExportReported;
  derivedTerms: ExportDerivedTerm[];
}): ExportDocument {
  return {
    schemaVersion: 1,
    surface: "cross-transcript",
    universityId: input.universityId,
    query: copyQuery(input.query),
    identity: copyIdentity(input.identity),
    reported: copyReported(input.reported),
    derivedTerms: input.derivedTerms.map(copyDerivedTerm),
  };
}

export function createBulkExport(input: {
  surface: "bulk-id-to-code" | "bulk-code-to-id" | "bulk-id-to-transcript";
  universityId: string;
  mode: string;
  total: number;
  items: ExportBulkItem[];
}): ExportDocument {
  const results = input.items.map((item): ExportBulkItem => item.status === "error"
    ? { target: item.target, status: "error", errorCode: item.errorCode }
    : { target: item.target, status: "ok", result: copyResult(item.result) });

  return {
    schemaVersion: 1,
    surface: input.surface,
    universityId: input.universityId,
    run: {
      status: results.length === input.total ? "complete" : "partial",
      mode: input.mode,
      processedCount: results.length,
      totalCount: input.total,
    },
    results,
  };
}

export function serializeExportJson(model: ExportDocument): string {
  return `${JSON.stringify(sanitizeExportDocument(model), null, 2)}\n`;
}

export const CSV_HEADERS = [
  "record_type", "surface", "run_status", "item_index", "status", "error_code", "query_mode", "query_value", "target", "university_id",
  "student_code", "internal_student_id", "student_name", "managing_class", "class_code", "class_number", "class_id", "resolved_student_code",
  "resolved_internal_student_id", "probes", "term_code", "term_label", "estimate_kind", "listed_credits", "included_credits", "term_gpa4",
  "derived_cpa4", "reported_cumulative_gpa4", "course_code", "course_name", "credits", "point10", "letter", "point4",
] as const;

type CsvHeader = typeof CSV_HEADERS[number];
type CsvValue = string | number | undefined;
type CsvRow = Partial<Record<CsvHeader, CsvValue>>;
type CsvContext = {
  surface: ExportSurface;
  universityId: string;
  runStatus?: "complete" | "partial";
  itemIndex?: number;
  status?: "ok" | "error";
  errorCode?: string;
  target?: string;
};

function createBaseRow(context: CsvContext, recordType: string): CsvRow {
  return {
    record_type: recordType,
    surface: context.surface,
    run_status: context.runStatus,
    item_index: context.itemIndex,
    status: context.status,
    error_code: context.errorCode,
    target: context.target,
    university_id: context.universityId,
  };
}

function createIdentityRow(context: CsvContext, value: ExportIdentity, recordType = "identity"): CsvRow {
  return {
    ...createBaseRow(context, recordType),
    student_code: value.studentCode,
    internal_student_id: value.internalStudentId,
    student_name: value.studentName,
    managing_class: value.managingClass,
  };
}

function createReportedRow(context: CsvContext, value: ExportReported): CsvRow {
  return {
    ...createBaseRow(context, "reported_summary"),
    reported_cumulative_gpa4: value.cumulativeGpa4,
  };
}

function createTermRows(context: CsvContext, terms: readonly ExportDerivedTerm[]): CsvRow[] {
  return terms.flatMap((term) => [
    {
      ...createBaseRow(context, "term_summary"),
      term_code: term.termCode,
      term_label: term.termLabel,
      estimate_kind: term.estimateKind,
      listed_credits: term.listedCredits,
      included_credits: term.includedCredits,
      term_gpa4: term.termGpa4,
      derived_cpa4: term.derivedCpa4,
    },
    ...term.courses.map((course): CsvRow => ({
      ...createBaseRow(context, "course"),
      term_code: term.termCode,
      term_label: term.termLabel,
      course_code: course.courseCode,
      course_name: course.courseName,
      credits: course.credits,
      point10: course.point10,
      letter: course.letter,
      point4: course.point4,
    })),
  ]);
}

function createResultRows(context: CsvContext, value: ExportResult): CsvRow[] {
  const rows: CsvRow[] = [];
  if (value.identity) rows.push(createIdentityRow(context, value.identity, value.derivedTerms !== undefined || value.reported !== undefined ? "identity" : "result"));
  if (value.classResult) rows.push({
    ...createBaseRow(context, "result"),
    class_code: value.classResult.classCode,
    class_number: value.classResult.classNumber,
    class_id: value.classResult.classId,
    course_name: value.classResult.courseName,
  });
  if (value.resolver) rows.push({
    ...createBaseRow(context, "result"),
    resolved_student_code: value.resolver.resolvedStudentCode,
    resolved_internal_student_id: value.resolver.resolvedInternalStudentId,
    probes: value.resolver.probes,
  });
  if (value.reported) rows.push(createReportedRow(context, value.reported));
  if (value.derivedTerms) rows.push(...createTermRows(context, value.derivedTerms));
  return rows;
}

function createCsvRows(model: ExportDocument): CsvRow[] {
  const context: CsvContext = { surface: model.surface, universityId: model.universityId, runStatus: model.run?.status };
  const rows: CsvRow[] = [];
  if (model.query) rows.push({ ...createBaseRow(context, "query"), query_mode: model.query.mode, query_value: model.query.value });
  if (model.identity) rows.push(createIdentityRow(context, model.identity));
  if (model.reported) rows.push(createReportedRow(context, model.reported));
  if (model.derivedTerms) rows.push(...createTermRows(context, model.derivedTerms));
  model.results?.forEach((item, index) => {
    if ("status" in item) {
      const itemContext: CsvContext = {
        ...context,
        itemIndex: index + 1,
        status: item.status,
        target: item.target,
        errorCode: item.status === "error" ? item.errorCode : undefined,
      };
      if (item.status === "error") rows.push(createBaseRow(itemContext, "item"));
      else rows.push(...createResultRows(itemContext, item.result));
      return;
    }
    rows.push(...createResultRows(context, item));
  });
  return rows;
}

const IDENTIFIER_CSV_HEADERS: ReadonlySet<CsvHeader> = new Set([
  "query_value",
  "target",
  "university_id",
  "student_code",
  "internal_student_id",
  "managing_class",
  "class_code",
  "class_number",
  "class_id",
  "resolved_student_code",
  "resolved_internal_student_id",
  "term_code",
  "course_code",
]);
const FORMULA_LIKE_TEXT = /^[\t\r\n ]*[=+\-@]/;

function encodeCsvField(header: CsvHeader, value: CsvValue): string {
  if (value === undefined) return "";
  const text = typeof value === "number"
    ? String(value)
    : (IDENTIFIER_CSV_HEADERS.has(header) || FORMULA_LIKE_TEXT.test(value) ? `'${value}` : value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function serializeExportCsv(model: ExportDocument): string {
  const sanitizedModel = sanitizeExportDocument(model);
  const rows = createCsvRows(sanitizedModel).map((row) => CSV_HEADERS.map((header) => encodeCsvField(header, row[header])).join(","));
  return `\ufeff${[CSV_HEADERS.join(","), ...rows].join("\r\n")}\r\n`;
}

const RESERVED_COMPONENTS = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export function sanitizeAsciiFilenameComponent(value: string): string {
  const ascii = value.normalize("NFKD").replace(/[^\x00-\x7f]/g, "");
  if (RESERVED_COMPONENTS.test(ascii.trim())) return "export";
  const cleaned = ascii
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*]+/g, "-")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return !cleaned || RESERVED_COMPONENTS.test(cleaned) ? "export" : cleaned.toLowerCase();
}

export function buildExportFilename(surface: ExportSurface, date: Date, format: ExportFormat): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const dayOfMonth = String(date.getDate()).padStart(2, "0");
  const day = `${year}-${month}-${dayOfMonth}`;
  return `hyeboard-${sanitizeAsciiFilenameComponent(surface)}-${day}.${format}`;
}

export type DownloadAnchor = { href: string; download: string; click(): void; remove(): void };
export type DownloadEnvironment = {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  createAnchor(): DownloadAnchor;
  appendAnchor(anchor: DownloadAnchor): void;
};

function createBrowserDownloadEnvironment(): DownloadEnvironment {
  return {
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    createAnchor: () => document.createElement("a"),
    appendAnchor: (anchor) => document.body.append(anchor as HTMLAnchorElement),
  };
}

async function createPdfBlob(library: PdfLibrary, definition: PdfDocumentDefinition): Promise<Blob> {
  try {
    const blob = await library.createPdf(definition).getBlob();
    return new Blob([blob], { type: "application/pdf" });
  } catch (error) {
    throw error instanceof Error ? error : new Error("PDF generation failed");
  }
}

export async function downloadPdfExport(
  model: ExportDocument,
  locale: string,
  labels: PdfExportLabels,
  date = new Date(),
  environment = createBrowserDownloadEnvironment(),
  libraryLoader: PdfLibraryLoader = loadPdfMake,
): Promise<void> {
  const library = await libraryLoader();
  const blob = await createPdfBlob(library, createPdfExportDefinition(model, locale, labels, date));
  let url: string | undefined;
  let anchor: DownloadAnchor | undefined;
  try {
    url = environment.createObjectURL(blob);
    anchor = environment.createAnchor();
    anchor.href = url;
    anchor.download = buildExportFilename(model.surface, date, "pdf");
    environment.appendAnchor(anchor);
    anchor.click();
  } finally {
    anchor?.remove();
    if (url) environment.revokeObjectURL(url);
  }
}

export function downloadExport(
  model: ExportDocument,
  format: TextExportFormat,
  date = new Date(),
  environment = createBrowserDownloadEnvironment(),
): void {
  const content = format === "json" ? serializeExportJson(model) : serializeExportCsv(model);
  const mime = format === "json" ? "application/json;charset=utf-8" : "text/csv;charset=utf-8";
  const blob = new Blob([content], { type: mime });
  let url: string | undefined;
  let anchor: DownloadAnchor | undefined;
  try {
    url = environment.createObjectURL(blob);
    anchor = environment.createAnchor();
    anchor.href = url;
    anchor.download = buildExportFilename(model.surface, date, format);
    environment.appendAnchor(anchor);
    anchor.click();
  } finally {
    anchor?.remove();
    if (url) environment.revokeObjectURL(url);
  }
}
