import type { DocumentItem } from "@hyeboard/schemas";
import type { VnuExamCatalogRow } from "@hyeboard/university-adapters/src/vnu/types";
import { describe, expect, it } from "vitest";
import { filterCatalogRowsByUniversity, filterDocumentsByUniversity } from "./university-course-search";

const catalogRows: VnuExamCatalogRow[] = [{
  classId: "SYNTHETIC-CLASS-ID",
  termCode: "252",
  courseCode: "INT 3103",
  classNo: "CN7",
  courseName: "Synthetic Search Systems",
  examDate: "31/12/2099",
}];

const documents: DocumentItem[] = [{
  id: "synthetic-document",
  name: "INT 3103 — Synthetic Syllabus",
  courseCode: "INT 3103",
}];

describe("VNU class filtering", () => {
  it.each(["INT3103", "INT 3103", " int\u00a03103 "])("matches %j against preserved display", (query) => {
    expect(filterCatalogRowsByUniversity(catalogRows, query, "", "vnu")).toEqual(catalogRows);
  });

  it("keeps class-number matching exact apart from edge trim and case", () => {
    expect(filterCatalogRowsByUniversity(catalogRows, "INT3103", " cn7 ", "vnu")).toEqual(catalogRows);
    expect(filterCatalogRowsByUniversity(catalogRows, "INT3103", "CN 7", "vnu")).toEqual([]);
    expect(filterCatalogRowsByUniversity(catalogRows, "INT3103", "CN", "vnu")).toEqual([]);
  });

  it.each(["mock", "uet"])("preserves existing spaced substring semantics for %s", (universityId) => {
    expect(filterCatalogRowsByUniversity(catalogRows, "INT3103", "", universityId)).toEqual([]);
    expect(filterCatalogRowsByUniversity(catalogRows, " INT 3103 ", "", universityId)).toEqual(catalogRows);
  });
});

describe("university-aware document filtering", () => {
  it.each([
    ["mock", ""],
    ["mock", " \t\n"],
    ["uet", ""],
    ["uet", " \t\n"],
    ["vnu", ""],
    ["vnu", " \t\n"],
  ])("returns the original items reference for %s query %j", (universityId, query) => {
    expect(filterDocumentsByUniversity(documents, query, universityId)).toBe(documents);
  });

  it.each(["INT3103", "INT 3103"])("matches VNU course query %j", (query) => {
    expect(filterDocumentsByUniversity(documents, query, "vnu")).toEqual(documents);
  });

  it("retains VNU document-name substring search", () => {
    expect(filterDocumentsByUniversity(documents, "synthetic syllabus", "vnu")).toEqual(documents);
  });

  it.each(["uet", "mock"])("retains combined lowercase substring semantics for %s", (universityId) => {
    expect(filterDocumentsByUniversity(documents, "int 3103", universityId)).toEqual(documents);
    expect(filterDocumentsByUniversity(documents, "INT3103", universityId)).toEqual([]);
    expect(filterDocumentsByUniversity(documents, "synthetic syllabus", universityId)).toEqual(documents);
  });
});
