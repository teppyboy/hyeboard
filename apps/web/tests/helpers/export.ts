import { expect } from "@playwright/test";

export async function downloadText(download: import("@playwright/test").Download): Promise<string> {
  const stream = await download.createReadStream();
  if (!stream) throw new Error("Playwright download stream was unavailable");

  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export type ApiRequestSnapshot = {
  total: number;
  paths: Array<readonly [string, number]>;
};

export type ApiRequestTracker = {
  count(path: string): number;
  snapshot(): ApiRequestSnapshot;
};

export function trackApiRequestCounts(page: import("@playwright/test").Page): ApiRequestTracker {
  const counts = new Map<string, number>();
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/") && path !== "/api/policy/events") counts.set(path, (counts.get(path) ?? 0) + 1);
  });
  return {
    count: (path) => counts.get(path) ?? 0,
    snapshot: () => {
      const paths = [...counts.entries()].sort(([left], [right]) => left.localeCompare(right));
      return { total: paths.reduce((total, [, count]) => total + count, 0), paths };
    },
  };
}

function snapshotExcludingPointDetail(snapshot: ApiRequestSnapshot): ApiRequestSnapshot {
  const paths = snapshot.paths.filter(([path]) => path !== "/api/vnu/raw/point-detail");
  const total = paths.reduce((sum, [, count]) => sum + count, 0);
  return { total, paths };
}

export function parseDownloadedRfc4180Csv(input: string): string[][] {
  expect(input.charCodeAt(0)).toBe(0xfeff);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let quoteClosed = false;
  let index = 1;

  while (index < input.length) {
    const character = input[index]!;
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        field += '"';
        index += 2;
        continue;
      }
      if (character === '"') {
        quoted = false;
        quoteClosed = true;
        index += 1;
        continue;
      }
      field += character;
      index += 1;
      continue;
    }
    if (quoteClosed && character !== "," && character !== "\r") {
      throw new Error("Unexpected character after closing CSV quote");
    }
    if (character === '"') {
      if (field !== "") throw new Error("Unexpected quote inside unquoted CSV field");
      quoted = true;
      index += 1;
      continue;
    }
    if (character === ",") {
      row.push(field);
      field = "";
      quoteClosed = false;
      index += 1;
      continue;
    }
    if (character === "\r") {
      if (input[index + 1] !== "\n") throw new Error("CSV records must use CRLF separators");
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      quoteClosed = false;
      index += 2;
      continue;
    }
    if (character === "\n") throw new Error("Bare LF outside a quoted CSV field");
    field += character;
    index += 1;
  }

  if (quoted) throw new Error("Unclosed quoted CSV field");
  if (quoteClosed || row.length > 0 || field.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export type DownloadedIdentity = {
  studentCode?: string;
  internalStudentId?: string;
  studentName?: string;
  managingClass?: string;
};

export type DownloadedCourse = {
  courseCode: string;
  courseName: string;
  credits?: number;
  point10?: number;
  letter?: string;
  point4?: number;
};

export type DownloadedTerm = {
  termCode: string;
  termLabel?: string;
  estimateKind?: string;
  listedCredits?: number;
  includedCredits?: number;
  termGpa4?: number;
  derivedCpa4?: number;
  courses: DownloadedCourse[];
  [key: string]: unknown;
};

export type DownloadedResult = {
  target?: string;
  status?: string;
  errorCode?: string;
  identity?: DownloadedIdentity;
  classResult?: { classCode: string; classNumber?: string; classId: string; courseName?: string };
  resolver?: { resolvedStudentCode: string; resolvedInternalStudentId: string; probes: number };
  reported?: { cumulativeGpa4?: number };
  derivedTerms?: DownloadedTerm[];
  result?: DownloadedResult;
};

export type DownloadedExport = {
  surface: string;
  universityId?: string;
  query?: { mode: string; value: string };
  identity?: DownloadedIdentity;
  reported?: { cumulativeGpa4?: number };
  derivedTerms?: DownloadedTerm[];
  run?: { status: string; mode: string; processedCount: number; totalCount: number };
  results?: DownloadedResult[];
};

export type CsvRecord = Record<string, string>;

export type CsvExpectation = Record<string, string>;

export function csvIdentifier(value: string): string {
  return `'${value}`;
}

export function csvValue(value: string | number | undefined): string {
  return value === undefined ? "" : String(value);
}

export function expectExactCsvRecords(records: CsvRecord[], expectations: CsvExpectation[]): void {
  expect(records, "CSV emitted an unexpected number of records").toHaveLength(expectations.length);
  expectations.forEach((expectedRecord, index) => {
    expect(records[index], `Unexpected CSV record at index ${index}`).toMatchObject(expectedRecord);
  });
}

export function expectAcademicCsvMatchesJson(model: DownloadedExport, records: CsvRecord[]): void {
  const expectedRecords: CsvExpectation[] = [];
  if (model.query) {
    expectedRecords.push({ record_type: "query", query_mode: model.query.mode, query_value: csvIdentifier(model.query.value) });
  }
  if (model.identity) {
    expectedRecords.push({
      record_type: "identity",
      student_code: model.identity.studentCode ? csvIdentifier(model.identity.studentCode) : "",
      internal_student_id: model.identity.internalStudentId ? csvIdentifier(model.identity.internalStudentId) : "",
      student_name: model.identity.studentName ?? "",
      managing_class: model.identity.managingClass ? csvIdentifier(model.identity.managingClass) : "",
    });
  }
  if (model.reported) {
    expectedRecords.push({ record_type: "reported_summary", reported_cumulative_gpa4: csvValue(model.reported.cumulativeGpa4) });
  }
  for (const term of model.derivedTerms ?? []) {
    expectedRecords.push({
      record_type: "term_summary",
      term_code: csvIdentifier(term.termCode),
      listed_credits: csvValue(term.listedCredits),
      included_credits: csvValue(term.includedCredits),
      term_gpa4: csvValue(term.termGpa4),
      derived_cpa4: csvValue(term.derivedCpa4),
    });
    for (const course of term.courses) {
      expectedRecords.push({
        record_type: "course",
        term_code: csvIdentifier(term.termCode),
        course_code: csvIdentifier(course.courseCode),
        course_name: course.courseName,
        credits: csvValue(course.credits),
        point10: csvValue(course.point10),
        letter: csvValue(course.letter),
        point4: csvValue(course.point4),
      });
    }
  }
  expectExactCsvRecords(records, expectedRecords);
}

export function expectClassCsvMatchesJson(model: DownloadedExport, records: CsvRecord[]): void {
  const classResult = model.results?.[0]?.classResult;
  expect(model.query).toBeDefined();
  expect(classResult).toBeDefined();
  expectExactCsvRecords(records, [
    { record_type: "query", query_mode: model.query!.mode, query_value: csvIdentifier(model.query!.value) },
    {
      record_type: "result",
      class_code: csvIdentifier(classResult!.classCode),
      class_number: classResult!.classNumber ? csvIdentifier(classResult!.classNumber) : "",
      class_id: csvIdentifier(classResult!.classId),
      course_name: classResult!.courseName ?? "",
    },
  ]);
}

export function expectResolverCsvMatchesJson(model: DownloadedExport, records: CsvRecord[]): void {
  const result = model.results?.[0];
  expect(model.query).toBeDefined();
  expect(result).toBeDefined();
  const resultExpectation: CsvExpectation = result?.resolver
    ? {
        record_type: "result",
        resolved_student_code: csvIdentifier(result.resolver.resolvedStudentCode),
        resolved_internal_student_id: csvIdentifier(result.resolver.resolvedInternalStudentId),
        probes: String(result.resolver.probes),
      }
    : {
        record_type: "result",
        student_code: result?.identity?.studentCode ? csvIdentifier(result.identity.studentCode) : "",
        internal_student_id: result?.identity?.internalStudentId ? csvIdentifier(result.identity.internalStudentId) : "",
        student_name: result?.identity?.studentName ?? "",
      };
  expectExactCsvRecords(records, [
    { record_type: "query", query_mode: model.query!.mode, query_value: csvIdentifier(model.query!.value) },
    resultExpectation,
  ]);
}

export function expectBulkCsvMatchesJson(model: DownloadedExport, records: CsvRecord[]): void {
  const run = model.run;
  const results = model.results ?? [];
  expect(run).toBeDefined();
  expect(results).toHaveLength(run!.processedCount);

  const expectedRecords = results.flatMap((item, index): CsvExpectation[] => {
    const base = (recordType: string): CsvExpectation => ({
      item_index: String(index + 1),
      record_type: recordType,
      run_status: run!.status,
      status: item.status!,
      target: csvIdentifier(item.target!),
    });
    if (item.status === "error") return [{ ...base("item"), error_code: item.errorCode! }];

    const result = item.result;
    expect(result).toBeDefined();
    const itemRecords: CsvExpectation[] = [];
    if (result?.identity) {
      itemRecords.push({
        ...base(result.derivedTerms !== undefined || result.reported !== undefined ? "identity" : "result"),
        student_code: result.identity.studentCode ? csvIdentifier(result.identity.studentCode) : "",
        internal_student_id: result.identity.internalStudentId ? csvIdentifier(result.identity.internalStudentId) : "",
        student_name: result.identity.studentName ?? "",
        managing_class: result.identity.managingClass ? csvIdentifier(result.identity.managingClass) : "",
      });
    }
    if (result?.classResult) {
      itemRecords.push({
        ...base("result"),
        class_code: csvIdentifier(result.classResult.classCode),
        class_number: result.classResult.classNumber ? csvIdentifier(result.classResult.classNumber) : "",
        class_id: csvIdentifier(result.classResult.classId),
        course_name: result.classResult.courseName ?? "",
      });
    }
    if (result?.resolver) {
      itemRecords.push({
        ...base("result"),
        resolved_student_code: csvIdentifier(result.resolver.resolvedStudentCode),
        resolved_internal_student_id: csvIdentifier(result.resolver.resolvedInternalStudentId),
        probes: String(result.resolver.probes),
      });
    }
    if (result?.reported) {
      itemRecords.push({ ...base("reported_summary"), reported_cumulative_gpa4: csvValue(result.reported.cumulativeGpa4) });
    }
    for (const term of result?.derivedTerms ?? []) {
      itemRecords.push({
        ...base("term_summary"),
        term_code: csvIdentifier(term.termCode),
        listed_credits: csvValue(term.listedCredits),
        included_credits: csvValue(term.includedCredits),
        term_gpa4: csvValue(term.termGpa4),
        derived_cpa4: csvValue(term.derivedCpa4),
      });
      for (const course of term.courses) {
        itemRecords.push({
          ...base("course"),
          term_code: csvIdentifier(term.termCode),
          course_code: csvIdentifier(course.courseCode),
          course_name: course.courseName,
          credits: csvValue(course.credits),
          point10: csvValue(course.point10),
          letter: csvValue(course.letter),
          point4: csvValue(course.point4),
        });
      }
    }
    return itemRecords;
  });
  expectExactCsvRecords(records, expectedRecords);
}

export type ExportFormatExpectations = {
  sourcePath: string;
  assertCsv(model: DownloadedExport, records: CsvRecord[]): void;
};

export async function expectExportFormats(
  page: import("@playwright/test").Page,
  surface: string,
  apiRequests: ApiRequestTracker,
  expectations: ExportFormatExpectations,
): Promise<DownloadedExport> {
  const exportRoot = page.locator(`[data-export-surface="${surface}"]`).first();
  const trigger = exportRoot.getByRole("button", { name: "Export" });
  expect(apiRequests.count(expectations.sourcePath), `Expected source request ${expectations.sourcePath}`).toBeGreaterThan(0);

  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Download JSON" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();

  const requestsBeforeJson = apiRequests.snapshot();
  const jsonPromise = page.waitForEvent("download");
  await trigger.click();
  await page.getByRole("menuitem", { name: "Download JSON" }).click();
  const jsonDownload = await jsonPromise;
  expect(jsonDownload.suggestedFilename()).toMatch(new RegExp(`^hyeboard-${surface}-\\d{4}-\\d{2}-\\d{2}\\.json$`));
  const jsonModel = JSON.parse(await downloadText(jsonDownload)) as DownloadedExport;
  expect(jsonModel.surface).toBe(surface);
  expect(jsonModel.derivedTerms?.length ?? jsonModel.results?.length ?? 0).toBeGreaterThan(0);
  expect(snapshotExcludingPointDetail(apiRequests.snapshot())).toEqual(snapshotExcludingPointDetail(requestsBeforeJson));
  await expect(trigger).toBeFocused();

  const requestsBeforeCsv = apiRequests.snapshot();
  const csvPromise = page.waitForEvent("download");
  await trigger.click();
  await page.getByRole("menuitem", { name: "Download CSV" }).click();
  const csvDownload = await csvPromise;
  expect(csvDownload.suggestedFilename()).toMatch(new RegExp(`^hyeboard-${surface}-\\d{4}-\\d{2}-\\d{2}\\.csv$`));
  const csvRows = parseDownloadedRfc4180Csv(await downloadText(csvDownload));
  const csvHeader = csvRows[0]!;
  expect(csvHeader.slice(0, 3)).toEqual(["record_type", "surface", "run_status"]);
  const surfaceColumn = csvHeader.indexOf("surface");
  expect(surfaceColumn).toBeGreaterThanOrEqual(0);
  const csvRecords = csvRows.slice(1).map((row) => Object.fromEntries(csvHeader.map((header, index) => [header, row[index] ?? ""])));
  expect(csvRecords.length).toBeGreaterThan(0);
  expect(csvRecords.every((record) => record.surface === surface)).toBe(true);
  expectations.assertCsv(jsonModel, csvRecords);
  expect(snapshotExcludingPointDetail(apiRequests.snapshot())).toEqual(snapshotExcludingPointDetail(requestsBeforeCsv));
  await expect(trigger).toBeFocused();
  return jsonModel;
}

export async function readOpenMenuTheme(page: import("@playwright/test").Page) {
  return page.getByRole("menu").evaluate((menu) => {
    const createTokenProbe = (background: string, color: string) => {
      const probe = document.createElement("div");
      probe.style.backgroundColor = background;
      probe.style.color = color;
      document.body.append(probe);
      const styles = getComputedStyle(probe);
      const result = { background: styles.backgroundColor, color: styles.color };
      probe.remove();
      return result;
    };
    const cardToken = createTokenProbe("hsl(var(--card))", "hsl(var(--card-foreground))");
    const accentToken = createTokenProbe("hsl(var(--accent))", "hsl(var(--accent-foreground))");
    const menuStyles = getComputedStyle(menu);
    const highlightedItem = menu.querySelector<HTMLElement>('[role="menuitem"][data-highlighted]');
    if (!highlightedItem) throw new Error("Export menu has no highlighted keyboard item");
    const itemStyles = getComputedStyle(highlightedItem);
    return {
      menuBackground: menuStyles.backgroundColor,
      menuForeground: menuStyles.color,
      itemBackground: itemStyles.backgroundColor,
      itemForeground: itemStyles.color,
      cardToken,
      accentToken,
    };
  });
}

export async function expectOpenMenuUsesThemeTokens(page: import("@playwright/test").Page) {
  await expect.poll(async () => {
    const theme = await readOpenMenuTheme(page);
    return {
      menuBackground: theme.menuBackground === theme.cardToken.background,
      menuForeground: theme.menuForeground === theme.cardToken.color,
      itemBackground: theme.itemBackground === theme.accentToken.background,
      itemForeground: theme.itemForeground === theme.accentToken.color,
    };
  }).toEqual({ menuBackground: true, menuForeground: true, itemBackground: true, itemForeground: true });
  return readOpenMenuTheme(page);
}
