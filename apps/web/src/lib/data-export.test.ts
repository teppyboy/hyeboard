import { describe, expect, it, vi } from "vitest";
import {
  CSV_HEADERS,
  buildExportFilename,
  createBulkExport,
  createClassLookupExport,
  createGradesExport,
  createPdfExportDefinition,
  createResolverLookupExport,
  createTranscriptExport,
  downloadExport,
  downloadPdfExport,
  resolvePdfPageOrientation,
  serializePrintableExport,
  sanitizeAsciiFilenameComponent,
  serializeExportCsv,
  serializeExportJson,
  type ExportBulkItem,
  type ExportClassResult,
  type ExportCourse,
  type ExportDerivedTerm,
  type ExportDocument,
  type ExportQuery,
  type ExportReported,
  type ExportResolverResult,
  type ExportResult,
} from "./data-export";

const SYNTHETIC_STUDENT_CODE = "99000001";
const SYNTHETIC_INTERNAL_ID = "99000000001";
const SYNTHETIC_NEIGHBOR_INTERNAL_ID = String(Number(SYNTHETIC_INTERNAL_ID) + 1);
const SENTINEL = "DO_NOT_EXPORT";
const UNSAFE_FIELDS = {
  sessionToken: SENTINEL,
  cookie: SENTINEL,
  html: `<table>${SENTINEL}</table>`,
  notice: SENTINEL,
  queryKey: [SENTINEL],
  telemetry: SENTINEL,
};

function withUnsafeFields<T extends object>(value: T): T & typeof UNSAFE_FIELDS {
  return Object.assign({}, value, UNSAFE_FIELDS);
}

const term = {
  termCode: "251",
  termLabel: "Semester 1, 2025–2026",
  estimateKind: "derived" as const,
  listedCredits: 6,
  includedCredits: 3,
  termGpa4: 3.5,
  derivedCpa4: 3.5,
  courses: [{ courseCode: "INT1001", courseName: "Reliable, \"Systems\"\nLab", credits: 3, point10: 8, letter: "B+", point4: 3.5 }],
};

const unsafeIdentity = {
  studentCode: SYNTHETIC_STUDENT_CODE,
  studentName: "Synthetic Student",
  ...UNSAFE_FIELDS,
};

function parseRfc4180Csv(input: string): { rows: string[][]; recordSeparators: string[] } {
  expect(input.charCodeAt(0)).toBe(0xfeff);
  const rows: string[][] = [];
  const recordSeparators: string[] = [];
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
      expect(field).toBe("");
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
      expect(input[index + 1]).toBe("\n");
      row.push(field);
      rows.push(row);
      recordSeparators.push("\r\n");
      row = [];
      field = "";
      quoteClosed = false;
      index += 2;
      continue;
    }
    expect(character).not.toBe("\n");
    field += character;
    index += 1;
  }

  expect(quoted).toBe(false);
  expect(row).toEqual([]);
  expect(field).toBe("");
  return { rows, recordSeparators };
}

type CsvContractRecord = Record<string, string>;

function assertExactCsvRecords(actual: readonly CsvContractRecord[], expected: readonly CsvContractRecord[]): void {
  if (actual.length !== expected.length) {
    throw new Error(`CSV record count mismatch: expected ${expected.length}, received ${actual.length}`);
  }
  expected.forEach((expectedRecord, index) => {
    const actualRecord = actual[index];
    if (!actualRecord) throw new Error(`CSV record ${index} is missing`);
    for (const [field, expectedValue] of Object.entries(expectedRecord)) {
      if (actualRecord[field] !== expectedValue) {
        throw new Error(`CSV record ${index} field ${field} mismatch`);
      }
    }
  });
}

describe("export models", () => {
  const models = [
    ["class-forward", createClassLookupExport({ surface: "class-forward", universityId: "vnu", query: { mode: "course-and-class", value: "INT1001 / 01" }, result: { classCode: "INT1001", classNumber: "01", classId: "000001", courseName: "Reliable Systems" } })],
    ["class-reverse", createClassLookupExport({ surface: "class-reverse", universityId: "vnu", query: { mode: "class-id", value: "000001" }, result: { classCode: "INT1001", classNumber: "01", classId: "000001", courseName: "Reliable Systems" } })],
    ["student-id-to-code", createResolverLookupExport({ surface: "student-id-to-code", universityId: "vnu", query: { mode: "stdId", value: SYNTHETIC_INTERNAL_ID }, identity: unsafeIdentity })],
    ["student-code-to-id", createResolverLookupExport({ surface: "student-code-to-id", universityId: "vnu", query: { mode: "stdCode", value: SYNTHETIC_STUDENT_CODE }, resolver: { resolvedStudentCode: SYNTHETIC_STUDENT_CODE, resolvedInternalStudentId: SYNTHETIC_INTERNAL_ID, probes: 2 } })],
    ["grades-term", createGradesExport({ surface: "grades-term", universityId: "mock", identity: unsafeIdentity, reported: { cumulativeGpa4: 3.48 }, derivedTerms: [term] })],
    ["grades-page", createGradesExport({ surface: "grades-page", universityId: "mock", identity: unsafeIdentity, reported: { cumulativeGpa4: 3.48 }, derivedTerms: [term] })],
    ["cross-transcript", createTranscriptExport({ universityId: "vnu", query: { mode: "stdId", value: SYNTHETIC_INTERNAL_ID }, identity: unsafeIdentity, reported: { cumulativeGpa4: 3.2, totalCredits: 90, accumulatedCredits: 84 }, derivedTerms: [term] })],
    ["bulk-id-to-code", createBulkExport({ surface: "bulk-id-to-code", universityId: "vnu", mode: "stdid-to-code", total: 1, items: [{ target: SYNTHETIC_INTERNAL_ID, status: "ok", result: { identity: unsafeIdentity } }] })],
    ["bulk-code-to-id", createBulkExport({ surface: "bulk-code-to-id", universityId: "vnu", mode: "code-to-stdid", total: 1, items: [{ target: SYNTHETIC_STUDENT_CODE, status: "ok", result: { resolver: { resolvedStudentCode: SYNTHETIC_STUDENT_CODE, resolvedInternalStudentId: SYNTHETIC_INTERNAL_ID, probes: 2 } } }] })],
    ["bulk-id-to-transcript", createBulkExport({ surface: "bulk-id-to-transcript", universityId: "vnu", mode: "stdid-to-transcript", total: 1, items: [{ target: SYNTHETIC_INTERNAL_ID, status: "ok", result: { identity: unsafeIdentity, reported: { cumulativeGpa4: 3.2 }, derivedTerms: [term] } }] })],
  ] as const;

  it.each(models)("builds allowlisted versioned %s JSON", (surface, model) => {
    expect(model).toMatchObject({ schemaVersion: 1, surface, universityId: expect.any(String) });
    const json = serializeExportJson(model);
    expect(json).toBe(`${JSON.stringify(model, null, 2)}\n`);
    for (const forbidden of ["sessionToken", "cookie", "<input", "notice", "queryKey", "telemetry", SENTINEL]) expect(json).not.toContain(forbidden);
  });

  it("keeps complete and partial bulk items ordered without inventing unprocessed errors", () => {
    const items = [
      { target: SYNTHETIC_STUDENT_CODE, status: "ok" as const, result: { resolver: { resolvedStudentCode: SYNTHETIC_STUDENT_CODE, resolvedInternalStudentId: SYNTHETIC_INTERNAL_ID, probes: 2 } } },
      { target: "bad", status: "error" as const, errorCode: "VNU_CROSS_LOOKUP_INVALID_TARGET" },
    ];
    const partial = createBulkExport({
      surface: "bulk-code-to-id",
      universityId: "vnu",
      mode: "code-to-stdid",
      total: 4,
      items,
    });
    const complete = createBulkExport({ surface: "bulk-code-to-id", universityId: "vnu", mode: "code-to-stdid", total: 2, items });
    expect(partial.run).toEqual({ status: "partial", mode: "code-to-stdid", processedCount: 2, totalCount: 4 });
    expect(complete.run?.status).toBe("complete");
    expect(partial.results?.map((item) => "target" in item ? item.target : undefined)).toEqual([SYNTHETIC_STUDENT_CODE, "bad"]);
    expect(serializeExportJson(partial)).not.toContain('"target": "unprocessed"');
  });

  it("allowlists every accepted nested boundary in JSON and CSV", () => {
    const unsafeQuery: ExportQuery & typeof UNSAFE_FIELDS = withUnsafeFields({ mode: "stdId", value: SYNTHETIC_INTERNAL_ID });
    const unsafeClassResult: ExportClassResult & typeof UNSAFE_FIELDS = withUnsafeFields({ classCode: "INT1001", classNumber: "01", classId: "000001", courseName: "Reliable Systems" });
    const unsafeResolver: ExportResolverResult & typeof UNSAFE_FIELDS = withUnsafeFields({ resolvedStudentCode: SYNTHETIC_STUDENT_CODE, resolvedInternalStudentId: SYNTHETIC_INTERNAL_ID, probes: 2 });
    const unsafeReported: ExportReported & typeof UNSAFE_FIELDS = withUnsafeFields({ cumulativeGpa4: 3.2, totalCredits: 90, accumulatedCredits: 84 });
    const unsafeCourse: ExportCourse & typeof UNSAFE_FIELDS = withUnsafeFields({ courseCode: "INT1001", courseName: "Reliable Systems", credits: 3, point4: 3.5 });
    const unsafeTerm: ExportDerivedTerm & typeof UNSAFE_FIELDS = withUnsafeFields({ ...term, courses: [unsafeCourse] });
    const unsafeSuccessResult: ExportResult & typeof UNSAFE_FIELDS = withUnsafeFields({ identity: unsafeIdentity, resolver: unsafeResolver, reported: unsafeReported, derivedTerms: [unsafeTerm] });
    const unsafeSuccessItem: Extract<ExportBulkItem, { status: "ok" }> & typeof UNSAFE_FIELDS = withUnsafeFields({ target: SYNTHETIC_INTERNAL_ID, status: "ok", result: unsafeSuccessResult });
    const unsafeErrorItem: Extract<ExportBulkItem, { status: "error" }> & typeof UNSAFE_FIELDS = withUnsafeFields({ target: SYNTHETIC_NEIGHBOR_INTERNAL_ID, status: "error", errorCode: "VNU_CROSS_LOOKUP_NOT_FOUND" });
    const models = [
      createClassLookupExport({ surface: "class-forward", universityId: "vnu", query: unsafeQuery, result: unsafeClassResult }),
      createResolverLookupExport({ surface: "student-code-to-id", universityId: "vnu", query: unsafeQuery, identity: unsafeIdentity, resolver: unsafeResolver }),
      createTranscriptExport({ universityId: "vnu", query: unsafeQuery, identity: unsafeIdentity, reported: unsafeReported, derivedTerms: [unsafeTerm] }),
      createBulkExport({ surface: "bulk-id-to-transcript", universityId: "vnu", mode: "stdid-to-transcript", total: 2, items: [unsafeSuccessItem, unsafeErrorItem] }),
    ];

    for (const model of models) {
      for (const serialized of [serializeExportJson(model), serializeExportCsv(model)]) {
        expect(serialized).not.toContain(SENTINEL);
        for (const field of Object.keys(UNSAFE_FIELDS)) expect(serialized).not.toContain(field);
      }
    }
  });

  it("sanitizes structurally typed documents at both serializer boundaries", () => {
    const unsafeQuery = withUnsafeFields<ExportQuery>({ mode: "stdId", value: SYNTHETIC_INTERNAL_ID });
    const unsafeCourse = withUnsafeFields<ExportCourse>({ courseCode: "INT1001", courseName: "Reliable Systems", credits: 3 });
    const unsafeTerm = withUnsafeFields<ExportDerivedTerm>({ ...term, courses: [unsafeCourse] });
    const unsafeReported = withUnsafeFields<ExportReported>({ cumulativeGpa4: 3.2, totalCredits: 90 });
    const unsafeResolver = withUnsafeFields<ExportResolverResult>({ resolvedStudentCode: SYNTHETIC_STUDENT_CODE, resolvedInternalStudentId: SYNTHETIC_INTERNAL_ID, probes: 2 });
    const unsafeSimpleResult = withUnsafeFields<ExportResult>({
      identity: unsafeIdentity,
      classResult: withUnsafeFields<ExportClassResult>({ classCode: "INT1001", classId: "000001" }),
      resolver: unsafeResolver,
      reported: unsafeReported,
      derivedTerms: [unsafeTerm],
    });
    const unsafeBulkResult = withUnsafeFields<ExportResult>({ identity: unsafeIdentity, resolver: unsafeResolver });
    const unsafeSuccess = withUnsafeFields<Extract<ExportBulkItem, { status: "ok" }>>({ target: SYNTHETIC_INTERNAL_ID, status: "ok", result: unsafeBulkResult });
    const unsafeError = withUnsafeFields<Extract<ExportBulkItem, { status: "error" }>>({ target: SYNTHETIC_NEIGHBOR_INTERNAL_ID, status: "error", errorCode: "VNU_CROSS_LOOKUP_NOT_FOUND" });
    const directNonBulkModel = withUnsafeFields<ExportDocument>({
      schemaVersion: 1,
      surface: "cross-transcript",
      universityId: "vnu",
      query: unsafeQuery,
      identity: unsafeIdentity,
      reported: unsafeReported,
      derivedTerms: [unsafeTerm],
      results: [unsafeSimpleResult],
    });
    const directBulkModel = withUnsafeFields<ExportDocument>({
      schemaVersion: 1,
      surface: "bulk-id-to-transcript",
      universityId: "vnu",
      run: withUnsafeFields({ status: "complete" as const, mode: "stdid-to-transcript", processedCount: 2, totalCount: 2 }),
      results: [unsafeSuccess, unsafeError],
    });

    for (const model of [directNonBulkModel, directBulkModel]) {
      for (const serialized of [serializeExportJson(model), serializeExportCsv(model)]) {
        expect(serialized).not.toContain(SENTINEL);
        for (const field of Object.keys(UNSAFE_FIELDS)) expect(serialized).not.toContain(field);
      }
    }
  });

  it("ignores own and inherited bulk discriminators on non-bulk results", () => {
    const ownCollision = Object.assign(
      { identity: { studentCode: SYNTHETIC_STUDENT_CODE } },
      { status: "error" as const, target: SENTINEL, errorCode: SENTINEL, result: withUnsafeFields<ExportResult>({}) },
    );
    const inheritedCollision: ExportResult = Object.setPrototypeOf(
      { identity: { internalStudentId: SYNTHETIC_INTERNAL_ID } },
      { status: "ok", target: SENTINEL, errorCode: SENTINEL, result: withUnsafeFields<ExportResult>({}) },
    );
    const directModel: ExportDocument = {
      schemaVersion: 1,
      surface: "student-id-to-code",
      universityId: "vnu",
      results: [ownCollision, inheritedCollision],
    };

    for (const serialized of [serializeExportJson(directModel), serializeExportCsv(directModel)]) {
      expect(serialized).toContain(SYNTHETIC_STUDENT_CODE);
      expect(serialized).toContain(SYNTHETIC_INTERNAL_ID);
      expect(serialized).not.toContain(SENTINEL);
    }
  });

  it("fails descriptively for malformed bulk entries without exposing unsafe data", () => {
    const malformedEntry = Object.assign(
      withUnsafeFields<ExportResult>({ identity: { studentCode: SYNTHETIC_STUDENT_CODE } }),
      { status: "ok" as const, target: SYNTHETIC_INTERNAL_ID },
    );
    const directModel: ExportDocument = {
      schemaVersion: 1,
      surface: "bulk-id-to-code",
      universityId: "vnu",
      results: [malformedEntry],
    };

    for (const serialize of [serializeExportJson, serializeExportCsv]) {
      expect(() => serialize(directModel)).toThrowError(new Error("Invalid bulk export result at index 0"));
      try {
        serialize(directModel);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).not.toContain(SENTINEL);
      }
    }
  });

  it("preserves spaced VNU course display in class, grades, and transcript JSON and CSV", () => {
    const spacedTerm: ExportDerivedTerm = {
      ...term,
      courses: [{ courseCode: "INT 3103", courseName: "Synthetic Parsing", credits: 3 }],
    };
    const models = [
      createClassLookupExport({
        surface: "class-forward",
        universityId: "vnu",
        query: { mode: "course-and-class", value: "INT3103 / 6" },
        result: { classCode: "INT 3103", classNumber: "6", classId: "SYNTHETIC-CLASS-ID", courseName: "Synthetic Parsing" },
      }),
      createGradesExport({ surface: "grades-page", universityId: "vnu", derivedTerms: [spacedTerm] }),
      createTranscriptExport({
        universityId: "vnu",
        query: { mode: "stdId", value: "SYNTHETIC-TARGET" },
        derivedTerms: [spacedTerm],
      }),
    ];

    for (const model of models) {
      const json = serializeExportJson(model);
      const csv = parseRfc4180Csv(serializeExportCsv(model));
      const header = csv.rows[0]!;
      const classCode = header.indexOf("class_code");
      const courseCode = header.indexOf("course_code");

      expect(json).toContain("INT 3103");
      expect(csv.rows.slice(1).some((row) => row[classCode] === "'INT 3103" || row[courseCode] === "'INT 3103")).toBe(true);
    }
  });
});

describe("CSV", () => {
  it("rejects characters after a closing quote", () => {
    expect(() => parseRfc4180Csv('\ufeff"value"junk\r\n')).toThrow("Unexpected character after closing CSV quote");
  });

  it("preserves quoted controls and doubled quotes", () => {
    expect(parseRfc4180Csv('\ufeff"LF\nCR\rCRLF\r\nQuote ""ok""",tail\r\n"EOF"\r\n').rows)
      .toEqual([["LF\nCR\rCRLF\r\nQuote \"ok\"", "tail"], ["EOF"]]);
  });

  it("detects injected records against the exact export model", () => {
    const expected = [{ record_type: "query" }, { record_type: "result" }];
    const injected = [{ record_type: "query" }, { record_type: "injected" }, { record_type: "result" }];
    expect(() => assertExactCsvRecords(injected, expected)).toThrow("CSV record count mismatch");
  });

  it("detects reordered bulk item groups", () => {
    const expected = [
      { item_index: "1", target: `'${SYNTHETIC_INTERNAL_ID}` },
      { item_index: "2", target: `'${SYNTHETIC_NEIGHBOR_INTERNAL_ID}` },
    ];
    const reordered = [expected[1]!, expected[0]!];
    expect(() => assertExactCsvRecords(reordered, expected)).toThrow("CSV record 0 field item_index mismatch");
  });

  it("uses fixed headers, deterministic order, Unicode, formula defense, and numeric values", () => {
    const model = createTranscriptExport({
      universityId: "vnu",
      query: { mode: "stdId", value: SYNTHETIC_INTERNAL_ID },
      identity: { studentCode: SYNTHETIC_STUDENT_CODE, studentName: "  =HYPERLINK(\"bad\")", managingClass: "Lớp tổng hợp" },
      reported: { cumulativeGpa4: 3.2 },
      derivedTerms: [term],
    });
    const parsed = parseRfc4180Csv(serializeExportCsv(model));
    expect(parsed.rows[0]).toEqual([...CSV_HEADERS]);
    expect(parsed.recordSeparators).toEqual(parsed.rows.map(() => "\r\n"));
    const column = (name: typeof CSV_HEADERS[number]) => parsed.rows[0]!.indexOf(name);
    const identity = parsed.rows.slice(1).find((row) => row[column("record_type")] === "identity")!;
    const reported = parsed.rows.slice(1).find((row) => row[column("record_type")] === "reported_summary")!;
    expect(identity[column("student_name")]).toBe("'  =HYPERLINK(\"bad\")");
    expect(identity[column("student_code")]).toBe(`'${SYNTHETIC_STUDENT_CODE}`);
    expect(identity[column("managing_class")]).toBe("'Lớp tổng hợp");
    expect(reported[column("reported_cumulative_gpa4")]).toBe("3.2");
    expect(parsed.rows.slice(1).map((row) => row[0])).toEqual(["query", "identity", "reported_summary", "term_summary", "course"]);
  });

  it("round-trips RFC4180 special characters and empty fields", () => {
    const specialCourseName = 'LF\nCR\rCRLF\r\nComma, Quote "quoted"';
    const parsed = parseRfc4180Csv(serializeExportCsv(createClassLookupExport({
      surface: "class-forward",
      universityId: "vnu",
      query: { mode: "course-and-class", value: specialCourseName },
      result: { classCode: "INT1001", classId: "000001", courseName: specialCourseName },
    })));
    const column = (name: typeof CSV_HEADERS[number]) => parsed.rows[0]!.indexOf(name);
    expect(parsed.rows[1]![column("query_value")]).toBe(`'${specialCourseName}`);
    expect(parsed.rows[2]![column("course_name")]).toBe(specialCourseName);
    expect(parsed.rows[2]![column("class_number")]).toBe("");
    expect(parsed.recordSeparators).toEqual(["\r\n", "\r\n", "\r\n"]);
  });

  it.each([["=1+1", "'=1+1"], [" +SUM(A1:A2)", "' +SUM(A1:A2)"], ["\t-2", "'\t-2"], ["\r@cmd", "'\r@cmd"]])("protects formula-like text %j", (studentName, expected) => {
    const parsed = parseRfc4180Csv(serializeExportCsv(createTranscriptExport({
      universityId: "vnu", query: { mode: "stdId", value: SYNTHETIC_INTERNAL_ID }, identity: { studentName, studentCode: SYNTHETIC_STUDENT_CODE }, reported: { cumulativeGpa4: 3.2 }, derivedTerms: [],
    })));
    const column = (name: typeof CSV_HEADERS[number]) => parsed.rows[0]!.indexOf(name);
    expect(parsed.rows.find((row) => row[column("record_type")] === "identity")![column("student_name")]).toBe(expected);
  });

  it("emits bulk successes, transcript records, and errors in item order", () => {
    const csv = serializeExportCsv(createBulkExport({
      surface: "bulk-id-to-transcript", universityId: "vnu", mode: "stdid-to-transcript", total: 2,
      items: [
        { target: SYNTHETIC_INTERNAL_ID, status: "ok", result: { identity: { studentCode: SYNTHETIC_STUDENT_CODE }, reported: { cumulativeGpa4: 3.2 }, derivedTerms: [term] } },
        { target: SYNTHETIC_NEIGHBOR_INTERNAL_ID, status: "error", errorCode: "VNU_CROSS_LOOKUP_NOT_FOUND" },
      ],
    }));
    expect(csv.indexOf(SYNTHETIC_STUDENT_CODE)).toBeLessThan(csv.indexOf("VNU_CROSS_LOOKUP_NOT_FOUND"));
    expect(csv).toContain("complete");
  });

  it("marks every identifier string as text while leaving numeric metrics bare", () => {
    const model = createBulkExport({
      surface: "bulk-id-to-transcript",
      universityId: "123",
      mode: "stdid-to-transcript",
      total: 1,
      items: [{
        target: "00000000009",
        status: "ok",
        result: {
          identity: { studentCode: "00000009", internalStudentId: "00000000009", managingClass: "000042" },
          classResult: { classCode: "INT1001", classNumber: "1/2", classId: "03-04" },
          resolver: { resolvedStudentCode: "00000009", resolvedInternalStudentId: "00000000009", probes: 2 },
          reported: { cumulativeGpa4: 3.2 },
          derivedTerms: [{
            termCode: "03-04",
            termLabel: "Synthetic term",
            estimateKind: "derived",
            listedCredits: 6,
            includedCredits: 3,
            termGpa4: 3.5,
            courses: [{ courseCode: "INT1001", courseName: "Synthetic course", credits: 3, point10: 8, point4: 3.5 }],
          }],
        },
      }],
    });
    const csv = serializeExportCsv(model);
    const parsed = parseRfc4180Csv(csv);
    const header = parsed.rows[0]!;
    const column = (name: typeof CSV_HEADERS[number]) => header.indexOf(name);
    const resultRows = parsed.rows.slice(1);
    const resolver = resultRows.find((row) => row[column("resolved_internal_student_id")])!;
    const identity = resultRows.find((row) => row[column("student_code")])!;
    const classResult = resultRows.find((row) => row[column("class_id")])!;
    const termSummary = resultRows.find((row) => row[column("record_type")] === "term_summary")!;
    const course = resultRows.find((row) => row[column("record_type")] === "course")!;

    expect(csv).toContain("'00000000009");
    expect(identity[column("university_id")]).toBe("'123");
    expect(identity[column("target")]).toBe("'00000000009");
    expect(identity[column("student_code")]).toBe("'00000009");
    expect(identity[column("internal_student_id")]).toBe("'00000000009");
    expect(identity[column("managing_class")]).toBe("'000042");
    expect(classResult[column("class_code")]).toBe("'INT1001");
    expect(classResult[column("class_number")]).toBe("'1/2");
    expect(classResult[column("class_id")]).toBe("'03-04");
    expect(resolver[column("resolved_student_code")]).toBe("'00000009");
    expect(resolver[column("resolved_internal_student_id")]).toBe("'00000000009");
    expect(resolver[column("probes")]).toBe("2");
    expect(termSummary[column("term_code")]).toBe("'03-04");
    expect(termSummary[column("listed_credits")]).toBe("6");
    expect(termSummary[column("included_credits")]).toBe("3");
    expect(termSummary[column("term_gpa4")]).toBe("3.5");
    expect(course[column("course_code")]).toBe("'INT1001");
    expect(course[column("credits")]).toBe("3");
    expect(course[column("point10")]).toBe("8");
    expect(course[column("point4")]).toBe("3.5");

    const queryCsv = serializeExportCsv(createClassLookupExport({
      surface: "class-reverse",
      universityId: "vnu",
      query: { mode: "class-id", value: "03-04" },
      result: { classCode: "INT1001", classId: "03-04" },
    }));
    const queryParsed = parseRfc4180Csv(queryCsv);
    const queryColumn = queryParsed.rows[0]!.indexOf("query_value");
    expect(queryCsv).toContain("'03-04");
    expect(queryParsed.rows[1]![queryColumn]).toBe("'03-04");
  });
});

describe("filenames and browser lifecycle", () => {
  it.each([["CON", "export"], ["PRN.txt", "export"], ["AUX", "export"], ["NUL", "export"], ["COM9", "export"], ["LPT1", "export"], ["../grades///page...csv", "grades-page-csv"], ["report...   ", "report"], [`${"x".repeat(200)}.json`, "x".repeat(48)], ["line\u0000break", "line-break"], ["ĐIỂM HỌC KỲ", "iem-hoc-ky"]])("sanitizes %j", (input, expected) => {
    expect(sanitizeAsciiFilenameComponent(input)).toBe(expected);
  });

  it("forces selected extension and excludes identity", () => {
    const model = createResolverLookupExport({ surface: "student-id-to-code", universityId: "vnu", query: { mode: "stdId", value: SYNTHETIC_INTERNAL_ID }, identity: unsafeIdentity });
    const filename = buildExportFilename(model.surface, new Date("2026-07-27T12:00:00Z"), "json");
    expect(filename).toBe("hyeboard-student-id-to-code-2026-07-27.json");
    expect(filename).not.toContain(SYNTHETIC_STUDENT_CODE);
    expect(filename).not.toContain("Synthetic");
    expect(buildExportFilename("../CON.csv" as "grades-page", new Date("2026-07-27T12:00:00Z"), "json")).toBe("hyeboard-con-csv-2026-07-27.json");
  });

  it("uses the local calendar date in filenames", () => {
    expect(buildExportFilename("grades-page", new Date(2026, 6, 28, 1, 0), "csv")).toBe("hyeboard-grades-page-2026-07-28.csv");
  });

  it.each([false, true])("cleans URL and anchor when click failure is %s", (clickFails) => {
    const remove = vi.fn();
    const revokeObjectURL = vi.fn();
    const anchor = { href: "", download: "", click: vi.fn(() => { if (clickFails) throw new Error("synthetic click failure"); }), remove };
    const environment = { createObjectURL: vi.fn(() => "blob:synthetic"), revokeObjectURL, createAnchor: vi.fn(() => anchor), appendAnchor: vi.fn() };
    const model: ExportDocument = { schemaVersion: 1, surface: "grades-page", universityId: "mock", derivedTerms: [] };
    if (clickFails) expect(() => downloadExport(model, "json", new Date("2026-07-27T12:00:00Z"), environment)).toThrow("synthetic click failure");
    else expect(() => downloadExport(model, "json", new Date("2026-07-27T12:00:00Z"), environment)).not.toThrow();
    expect(anchor.remove).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:synthetic");
  });

  it("does not revoke when object URL creation fails", () => {
    const revokeObjectURL = vi.fn();
    const environment = { createObjectURL: vi.fn(() => { throw new Error("synthetic URL failure"); }), revokeObjectURL, createAnchor: vi.fn(), appendAnchor: vi.fn() };
    const model: ExportDocument = { schemaVersion: 1, surface: "grades-page", universityId: "mock", derivedTerms: [] };
    expect(() => downloadExport(model, "csv", new Date(), environment as never)).toThrow("synthetic URL failure");
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });
});

describe("PDF export", () => {
  const labels = {
    heading: "Hyeboard",
    title: "Export",
    exportedAt: "Exported",
    page: "Page",
    surface: "Surface",
    university: "University",
    query: "Query",
    run: "Run",
    identity: "Identity",
    reported: "Reported",
    terms: "Terms",
    results: "Results",
    target: "Target",
    error: "Error",
    course: "Course",
    credits: "Credits",
    score: "Score",
    letter: "Letter grade",
    point4: "4-point score",
    gpa: "GPA",
    cpa: "CPA",
    studentCode: "Student code",
    name: "Name",
    managingClass: "Managing class",
    classCode: "Class code",
    classNumber: "Class number",
    classId: "Class ID",
    probes: "Probes",
    accumulatedCredits: "Accumulated credits",
    mode: "Mode",
    value: "Value",
    status: "Status",
    processed: "Processed",
  };

  const pdfModels = [
    createClassLookupExport({ surface: "class-forward", universityId: "vnu", query: { mode: "course-and-class", value: "INT1001 / 01" }, result: { classCode: "INT1001", classNumber: "01", classId: "000001", courseName: "Reliable Systems" } }),
    createClassLookupExport({ surface: "class-reverse", universityId: "vnu", query: { mode: "class-id", value: "000001" }, result: { classCode: "INT1001", classNumber: "01", classId: "000001", courseName: "Reliable Systems" } }),
    createResolverLookupExport({ surface: "student-id-to-code", universityId: "vnu", query: { mode: "stdId", value: SYNTHETIC_INTERNAL_ID }, identity: { studentCode: SYNTHETIC_STUDENT_CODE, internalStudentId: SYNTHETIC_INTERNAL_ID } }),
    createResolverLookupExport({ surface: "student-code-to-id", universityId: "vnu", query: { mode: "stdCode", value: SYNTHETIC_STUDENT_CODE }, resolver: { resolvedStudentCode: SYNTHETIC_STUDENT_CODE, resolvedInternalStudentId: SYNTHETIC_INTERNAL_ID, probes: 2 } }),
    createGradesExport({ surface: "grades-term", universityId: "mock", identity: { studentCode: SYNTHETIC_STUDENT_CODE, internalStudentId: SYNTHETIC_INTERNAL_ID }, derivedTerms: [term] }),
    createGradesExport({ surface: "grades-page", universityId: "mock", identity: { studentCode: SYNTHETIC_STUDENT_CODE, internalStudentId: SYNTHETIC_INTERNAL_ID }, derivedTerms: [term] }),
    createTranscriptExport({ universityId: "vnu", query: { mode: "stdId", value: SYNTHETIC_INTERNAL_ID }, identity: { studentCode: SYNTHETIC_STUDENT_CODE, internalStudentId: SYNTHETIC_INTERNAL_ID }, derivedTerms: [term] }),
    createBulkExport({ surface: "bulk-id-to-code", universityId: "vnu", mode: "stdid-to-code", total: 1, items: [{ target: SYNTHETIC_INTERNAL_ID, status: "ok", result: { identity: { studentCode: SYNTHETIC_STUDENT_CODE, internalStudentId: SYNTHETIC_INTERNAL_ID } } }] }),
    createBulkExport({ surface: "bulk-code-to-id", universityId: "vnu", mode: "code-to-stdid", total: 1, items: [{ target: SYNTHETIC_STUDENT_CODE, status: "ok", result: { resolver: { resolvedStudentCode: SYNTHETIC_STUDENT_CODE, resolvedInternalStudentId: SYNTHETIC_INTERNAL_ID, probes: 2 } } }] }),
    createBulkExport({ surface: "bulk-id-to-transcript", universityId: "vnu", mode: "stdid-to-transcript", total: 1, items: [{ target: SYNTHETIC_INTERNAL_ID, status: "ok", result: { identity: { studentCode: SYNTHETIC_STUDENT_CODE, internalStudentId: SYNTHETIC_INTERNAL_ID }, derivedTerms: [term] } }] }),
  ] as const;
  const printableLabels = { ...labels, internalStudentId: "Internal student ID" };

  it("serializes only allowlisted values into escaped standalone HTML", () => {
    const html = serializePrintableExport({
      schemaVersion: 1,
      surface: "grades-page",
      universityId: "<unsafe>",
      identity: { studentName: "<img src=x onerror=alert(1)>" },
      derivedTerms: [{ ...term, courses: [{ ...term.courses[0]!, courseName: "<script>bad()</script>" }] }],
      extra: SENTINEL,
    } as ExportDocument, "en", printableLabels);

    expect(html).toContain('<html lang="en">');
    expect(html).toContain("&lt;unsafe&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;script&gt;bad()&lt;/script&gt;");
    expect(html).not.toContain(SENTINEL);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
  });

  it("downloads a generated PDF without opening a window", async () => {
    let downloadedBlob: Blob | undefined;
    const createObjectURL = vi.fn((blob: Blob) => {
      downloadedBlob = blob;
      return "blob:synthetic-pdf";
    });
    const revokeObjectURL = vi.fn();
    const remove = vi.fn();
    const anchor = { href: "", download: "", click: vi.fn(), remove };
    const environment = { createObjectURL, revokeObjectURL, createAnchor: vi.fn(() => anchor), appendAnchor: vi.fn() };
    const createPdf = vi.fn(() => ({ getBlob: async () => new Blob(["%PDF-1.7\nsynthetic"], { type: "application/pdf" }) }));
    const open = vi.fn();
    vi.stubGlobal("open", open);

    await downloadPdfExport(
      createGradesExport({ surface: "grades-page", universityId: "mock", identity: { studentName: "Sinh viên thử nghiệm" }, derivedTerms: [term] }),
      "vi",
      labels,
      new Date("2026-08-02T12:00:00Z"),
      environment,
      async () => ({ createPdf }),
    );

    expect(downloadedBlob).toBeDefined();
    const blob = downloadedBlob!;
    expect(blob.type).toBe("application/pdf");
    expect(await blob.text()).toMatch(/^%PDF-/);
    expect(createPdf).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
    expect(anchor.download).toBe("hyeboard-grades-page-2026-08-02.pdf");
    expect(remove).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:synthetic-pdf");
  });

  it("uses landscape only when the report table needs six or more columns", () => {
    expect(resolvePdfPageOrientation(createClassLookupExport({
      surface: "class-forward", universityId: "vnu", query: { mode: "class-id", value: "000001" }, result: { classCode: "INT1001", classId: "000001" },
    }))).toBe("portrait");
    expect(resolvePdfPageOrientation(createGradesExport({ surface: "grades-page", universityId: "mock", derivedTerms: [term] }))).toBe("landscape");
  });

  it("splits PDF course tables by term", () => {
    const secondTerm: ExportDerivedTerm = {
      ...term,
      termCode: "252",
      termLabel: "Semester 2, 2025–2026",
      courses: [{ courseCode: "INT2002", courseName: "Separate Course", credits: 3, point10: 9, letter: "A", point4: 4 }],
    };
    const courseTables = (definition: ReturnType<typeof createPdfExportDefinition>) =>
      (definition.content as Array<{ table?: { body?: Array<Array<string | { text?: string }>> } }>).filter((item) =>
        item.table?.body?.[0]?.some((cell) => typeof cell === "object" && cell.text === labels.course),
      );
    const definition = createPdfExportDefinition(
      createGradesExport({ surface: "grades-page", universityId: "mock", derivedTerms: [term, secondTerm] }),
      "en",
      labels,
      new Date("2026-08-02T12:00:00Z"),
    );
    const tables = courseTables(definition);
    const headers = [labels.course, labels.name, labels.credits, labels.score, labels.letter, labels.point4];

    expect(tables).toHaveLength(2);
    expect(tables.map((table) => table.table?.body?.[0]?.map((cell) => typeof cell === "object" ? cell.text : cell))).toEqual([headers, headers]);
    expect(JSON.stringify(tables[0])).toContain(term.courses[0]!.courseCode);
    expect(JSON.stringify(tables[0])).not.toContain(secondTerm.courses[0]!.courseCode);
    expect(JSON.stringify(tables[1])).toContain(secondTerm.courses[0]!.courseCode);
    expect(JSON.stringify(tables[1])).not.toContain(term.courses[0]!.courseCode);

    const emptyTerm: ExportDerivedTerm = { ...secondTerm, termCode: "253", termLabel: "Empty semester", courses: [] };
    const emptyDefinition = createPdfExportDefinition(
      createGradesExport({ surface: "grades-page", universityId: "mock", derivedTerms: [term, emptyTerm] }),
      "en",
      labels,
      new Date("2026-08-02T12:00:00Z"),
    );
    expect(emptyDefinition.content).toContainEqual({ text: emptyTerm.termLabel, style: "subsection" });
    expect(emptyDefinition.content).toContainEqual(expect.objectContaining({ table: expect.objectContaining({ body: expect.arrayContaining([[expect.objectContaining({ text: labels.credits }), `${emptyTerm.includedCredits} / ${emptyTerm.listedCredits}`]]) }) }));
    expect(courseTables(emptyDefinition)).toHaveLength(1);

    const nestedDefinition = createPdfExportDefinition(
      createBulkExport({
        surface: "bulk-id-to-transcript",
        universityId: "mock",
        mode: "stdid-to-transcript",
        total: 1,
        items: [{ target: SYNTHETIC_INTERNAL_ID, status: "ok", result: { derivedTerms: [term, secondTerm] } }],
      }),
      "en",
      labels,
      new Date("2026-08-02T12:00:00Z"),
    );
    const nestedTables = courseTables(nestedDefinition);
    expect(nestedTables).toHaveLength(2);
    expect(JSON.stringify(nestedTables[0])).toContain(term.courses[0]!.courseCode);
    expect(JSON.stringify(nestedTables[0])).not.toContain(secondTerm.courses[0]!.courseCode);
    expect(JSON.stringify(nestedTables[1])).toContain(secondTerm.courses[0]!.courseCode);
    expect(JSON.stringify(nestedTables[1])).not.toContain(term.courses[0]!.courseCode);
  });

  it("maps grades into a six-column landscape course table without conflating letter and 4-point scores", () => {
    const definition = JSON.stringify(createPdfExportDefinition(
      createGradesExport({
        surface: "grades-page",
        universityId: "mock",
        identity: { studentCode: SYNTHETIC_STUDENT_CODE, internalStudentId: SYNTHETIC_INTERNAL_ID, studentName: "Synthetic Student" },
        derivedTerms: [term],
      }),
      "en",
      labels,
      new Date("2026-08-02T12:00:00Z"),
    ));

    expect(definition).toContain('"pageOrientation":"landscape"');
    expect(definition).toContain(labels.title);
    expect(definition).toContain("Synthetic Student");
    expect(definition).toContain(term.courses[0]!.courseCode);
    expect(definition).toContain(labels.letter);
    expect(definition).toContain(labels.point4);
    expect(definition).toContain("B+");
    expect(definition).toContain("3.5");
    expect(definition).toContain(SYNTHETIC_STUDENT_CODE);
    expect(definition).not.toContain(SYNTHETIC_INTERNAL_ID);
    expect(definition).not.toContain("Internal student ID");
  });

  it("maps lookup class numbers and Vietnamese identity labels into report metadata", () => {
    const vietnameseLabels = { ...labels, title: "Báo cáo xuất dữ liệu", classNumber: "Số lớp" };
    const definition = JSON.stringify(createPdfExportDefinition(
      createClassLookupExport({
        surface: "class-forward",
        universityId: "vnu",
        query: { mode: "class-id", value: "000001" },
        result: { classCode: "INT1001", classNumber: "01", classId: "000001", courseName: "Lập trình" },
      }),
      "vi",
      vietnameseLabels,
      new Date("2026-08-02T12:00:00Z"),
    ));

    expect(definition).toContain("Số lớp");
    expect(definition).toContain("Báo cáo xuất dữ liệu");
    expect(definition).toContain('"pageOrientation":"portrait"');
    expect(definition).toContain("01");
    expect(definition).toContain("Lập trình");
  });

  it("maps transcript and bulk lookup identities, results, and course tables into reports", () => {
    const transcript = JSON.stringify(createPdfExportDefinition(
      createTranscriptExport({
        universityId: "vnu",
        query: { mode: "stdId", value: SYNTHETIC_INTERNAL_ID },
        identity: { internalStudentId: SYNTHETIC_INTERNAL_ID, studentCode: SYNTHETIC_STUDENT_CODE, studentName: "Synthetic Student" },
        derivedTerms: [term],
      }),
      "en",
      labels,
      new Date("2026-08-02T12:00:00Z"),
    ));
    const bulk = JSON.stringify(createPdfExportDefinition(
      createBulkExport({
        surface: "bulk-id-to-transcript",
        universityId: "vnu",
        mode: "stdid-to-transcript",
        total: 1,
        items: [{ target: SYNTHETIC_INTERNAL_ID, status: "ok", result: { identity: { studentCode: SYNTHETIC_STUDENT_CODE, internalStudentId: SYNTHETIC_INTERNAL_ID, studentName: "Synthetic Student" }, derivedTerms: [term] } }],
      }),
      "en",
      labels,
      new Date("2026-08-02T12:00:00Z"),
    ));

    for (const definition of [transcript, bulk]) {
      expect(definition).toContain(labels.title);
      expect(definition).toContain('"pageOrientation":"landscape"');
      expect(definition).toContain("Synthetic Student");
       expect(definition).not.toContain("Internal student ID");
       expect(definition).not.toContain(SYNTHETIC_INTERNAL_ID);
       expect(definition).toContain(SYNTHETIC_STUDENT_CODE);
      expect(definition).toContain("Reliable, \\\"Systems\\\"");
      expect(definition).toContain(labels.letter);
      expect(definition).toContain(labels.point4);
    }
  });

  it("uses restrained print tokens, compact spacing, and preserves studentCode", () => {
    const definition = createPdfExportDefinition(
      createGradesExport({
        surface: "grades-page",
        universityId: "mock",
        identity: { studentCode: SYNTHETIC_STUDENT_CODE, internalStudentId: SYNTHETIC_INTERNAL_ID },
        derivedTerms: [term],
      }),
      "en",
      labels,
      new Date("2026-08-02T12:00:00Z"),
    );
    const serialized = JSON.stringify(definition);

    expect(serialized).toContain("#1f4e79");
    expect(serialized).toContain(SYNTHETIC_STUDENT_CODE);
    expect(serialized).not.toContain(SYNTHETIC_INTERNAL_ID);
    expect(serialized).not.toContain("lightHorizontalLines");
    expect(definition).toMatchObject({ pageSize: "A4", pageMargins: [32, 32, 32, 30], defaultStyle: { font: "Roboto", fontSize: 8.5 } });
    expect(definition.styles).toMatchObject({ heading: { fontSize: 12 }, title: { fontSize: 17 }, section: { fontSize: 11 }, subsection: { fontSize: 9 } });
    expect((definition.content as Array<{ layout?: unknown }>).some((item) => typeof item.layout === "object")).toBe(true);
    const table = (definition.content as Array<{ table?: unknown }>).find((item) => item.table) as { layout: { hLineColor: () => string; paddingTop: () => number } };
    expect(table.layout.hLineColor()).toBe("#cbd5df");
    expect(table.layout.paddingTop()).toBe(4);
  });

  it("renders a real pdfmake Blob from the formal report definition", async () => {
    const [pdfMakeModule, pdfVfsModule] = await Promise.all([
      import("pdfmake/build/pdfmake"),
      import("pdfmake/build/vfs_fonts"),
    ]);
    const pdfMake = (pdfMakeModule.default ?? pdfMakeModule) as { addVirtualFileSystem(vfs: unknown): void; createPdf(definition: unknown): { getBlob(): Promise<Blob> } };
    const vfs = (pdfVfsModule.default ?? pdfVfsModule) as unknown;
    pdfMake.addVirtualFileSystem(vfs);
    const definition = createPdfExportDefinition(
      createGradesExport({ surface: "grades-page", universityId: "mock", identity: { studentName: "Sinh viên thử nghiệm" }, derivedTerms: [term] }),
      "vi",
      { ...labels, heading: "Hyeboard", title: "Báo cáo xuất dữ liệu", letter: "Điểm chữ", point4: "Điểm hệ 4" },
      new Date("2026-08-02T12:00:00Z"),
    );
    // pdfmake does not expose stable text extraction. Assert structured report content above;
    // here verify real renderer output without snapshotting volatile PDF bytes.
    const blob = await pdfMake.createPdf(definition).getBlob();

    expect(blob.type).toBe("application/pdf");
    expect((await blob.text()).slice(0, 5)).toBe("%PDF-");
  });

  it.each(pdfModels)("keeps studentCode and excludes internal IDs for %s PDF", (model) => {
    const definition = JSON.stringify(createPdfExportDefinition(model, "en", labels, new Date("2026-08-02T12:00:00Z")));
    const json = serializeExportJson(model);
    const csv = serializeExportCsv(model);
    expect(definition).not.toContain(SYNTHETIC_INTERNAL_ID);
    expect(definition).not.toContain("Internal student ID");
    if (json.includes(SYNTHETIC_STUDENT_CODE)) expect(definition).toContain(SYNTHETIC_STUDENT_CODE);
    if (json.includes(SYNTHETIC_INTERNAL_ID)) {
      expect(json).toContain(SYNTHETIC_INTERNAL_ID);
      expect(csv).toContain(SYNTHETIC_INTERNAL_ID);
    }
  });
});
