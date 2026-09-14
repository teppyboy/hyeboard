import type { DocumentItem, ExamSession, Grade, Term, TrainingPoint } from "@hyeboard/schemas";
import type { VnuExamCatalogRow, VnuPointDetail, VnuProfile, VnuTranscript } from "@hyeboard/university-adapters/src/vnu/types";
import { mapExamRow, mapGradeRow, mapSyllabusRow, mapTerms, mapTrainingPoints } from "@hyeboard/university-adapters/src/vnu/mapper";
import { isPointDetailPageHtml, parseExamCatalogHtml, parseExamTermOptions, parseExamsHtml, parseGradesHtml, parsePointDetailHtml, parseProfileHtml, parseStudyProgressHtml, parseSyllabusHtml } from "@hyeboard/university-adapters/src/vnu/parser";
import { ApiError } from "./api-types";

export type AuthenticatedRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

export type VnuCrossStudentCode = { studentCode?: string; studentName?: string; className?: string };
export type VnuCrossDetailComponent = { index: number; nature: string; weight?: number; attempt?: number; score?: number };
export type VnuCrossDetailPermit = { termIndex: number; rowIndex: number; permit: string };
export type VnuCrossDetailItem = { permit: string; status: "ok"; components: VnuCrossDetailComponent[] } | { permit: string; status: "error"; errorCode: string };
export type VnuCrossTranscript = Omit<VnuTranscript, "notice"> & { detailPermits?: VnuCrossDetailPermit[] };
export type VnuCrossStudentId = { stdId: string; stdCode: string; probes: number };
export type VnuCrossTranscriptInput =
  | { mode: "stdId"; stdId: string }
  | { mode: "stdCode"; stdCode: string };
export type VnuBulkLookupMode = "stdid-to-code" | "code-to-stdid" | "stdid-to-transcript";
export type VnuBulkLookupResult = VnuCrossStudentCode | VnuCrossStudentId | VnuCrossTranscript;
export type VnuBulkLookupItem =
  | { target: string; status: "ok"; result: VnuBulkLookupResult }
  | { target: string; status: "error"; errorCode: string };

function queryString(params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value);
  }
  const rendered = query.toString();
  return rendered ? `?${rendered}` : "";
}

function sanitizeCrossStudentCode(result: VnuCrossStudentCode): VnuCrossStudentCode {
  return { studentCode: result.studentCode, studentName: result.studentName, className: result.className };
}

function sanitizeCrossTranscript(result: VnuTranscript): VnuCrossTranscript {
  const permits = (result as VnuCrossTranscript).detailPermits;
  return { header: result.header, terms: result.terms, totals: result.totals, ...(Array.isArray(permits) ? { detailPermits: permits } : {}) };
}

function parseCrossDetailHtml(html: unknown): VnuCrossDetailComponent[] {
  if (typeof html !== "string" || !isPointDetailPageHtml(html)) throw new ApiError("The university returned an invalid point-detail page.", "VNU_CROSS_DETAIL_RESPONSE_INVALID", 502);
  return parsePointDetailHtml(html).components.map(({ index, nature, weight, attempt, score }) => ({ index, nature, weight, attempt, score }));
}

type CrossDetailWorkerItem = { permit: string; status: "ok"; html: string } | { permit: string; status: "error"; errorCode: string };

function parseCrossDetailBatchResponse(value: unknown, permits: string[]): CrossDetailWorkerItem[] {
  if (typeof value !== "object" || value === null || !Array.isArray((value as { items?: unknown }).items)) throw new ApiError("The cross-detail response is invalid.", "VNU_CROSS_DETAIL_RESPONSE_INVALID", 502);
  const items = (value as { items: unknown[] }).items;
  if (items.length !== permits.length) throw new ApiError("The cross-detail response is incomplete.", "VNU_CROSS_DETAIL_RESPONSE_INVALID", 502);
  return items.map((item, index) => {
    if (typeof item !== "object" || item === null || (item as { permit?: unknown }).permit !== permits[index]) throw new ApiError("The cross-detail response does not match its permits.", "VNU_CROSS_DETAIL_RESPONSE_INVALID", 502);
    const candidate = item as { permit: unknown; status?: unknown; html?: unknown; errorCode?: unknown };
    if (candidate.status === "ok" && typeof candidate.html === "string") return { permit: candidate.permit as string, status: "ok", html: candidate.html };
    if (candidate.status === "error" && typeof candidate.errorCode === "string") return { permit: candidate.permit as string, status: "error", errorCode: candidate.errorCode };
    throw new ApiError("The cross-detail response item is invalid.", "VNU_CROSS_DETAIL_RESPONSE_INVALID", 502);
  });
}

export function createVnuClient(request: AuthenticatedRequest) {
  const raw = (page: string, params: Record<string, string | undefined> = {}, signal?: AbortSignal) =>
    request<{ html: string }>(`/api/vnu/raw/${page}${queryString(params)}`, { signal });

  return {
    terms: async (): Promise<Term[]> => mapTerms(parseGradesHtml((await raw("grades")).html)),
    grades: async (): Promise<Grade[]> => parseGradesHtml((await raw("grades")).html).rows.map(mapGradeRow),
    exams: async (termCode?: string): Promise<ExamSession[]> => {
      const options = parseExamTermOptions((await raw("exam-base")).html);
      const option = termCode ? options.find((item) => item.label.startsWith(`${termCode}.`)) : (options.find((item) => item.selected) ?? options[0]);
      if (!option) return [];
      return parseExamsHtml((await raw("exams", { vTermID: option.value })).html).map(mapExamRow);
    },
    ownProfile: async (signal?: AbortSignal): Promise<VnuProfile> => parseProfileHtml((await raw("profile", {}, signal)).html),
    classCatalog: async (params: { vTermID: string }, signal?: AbortSignal): Promise<VnuExamCatalogRow[]> => parseExamCatalogHtml((await request<{ html: string }>(`/api/vnu/class-lookup/catalog${queryString(params)}`, { signal })).html),
    classPointDetail: async (params: { id: string; Term: string }, signal?: AbortSignal): Promise<VnuPointDetail> => parsePointDetailHtml((await request<{ html: string }>(`/api/vnu/class-lookup/point-detail${queryString(params)}`, { signal })).html),
    pointDetail: async (params: { id: string; Term: string }, signal?: AbortSignal): Promise<VnuPointDetail> => parsePointDetailHtml((await raw("point-detail", params, signal)).html),
    crossStudentCode: async (params: { stdId: string }, signal?: AbortSignal): Promise<VnuCrossStudentCode> => sanitizeCrossStudentCode(await request<VnuCrossStudentCode>(`/api/vnu/cross-lookup/student-code${queryString({ stdId: params.stdId, allowCrossLookup: "true" })}`, { signal })),
    crossStudentId: (params: { stdCode: string }, signal?: AbortSignal): Promise<VnuCrossStudentId> => request<VnuCrossStudentId>(`/api/vnu/cross-lookup/student-id${queryString({ stdCode: params.stdCode, allowCrossLookup: "true" })}`, { signal }),
    crossTranscript: async (input: VnuCrossTranscriptInput, signal?: AbortSignal): Promise<VnuCrossTranscript> => {
      const target = input.mode === "stdId" ? { stdId: input.stdId } : { stdCode: input.stdCode };
      return sanitizeCrossTranscript(await request<VnuTranscript>(`/api/vnu/cross-lookup/transcript${queryString({ ...target, allowCrossLookup: "true" })}`, { signal }));
    },
    crossDetail: async (permit: string, signal?: AbortSignal): Promise<VnuCrossDetailComponent[]> => {
      const response = await request<{ permit: string; html: string }>("/api/vnu/cross-lookup/detail", { method: "POST", body: JSON.stringify({ allowCrossLookup: true, permit }), signal });
      if (response.permit !== permit) throw new ApiError("The cross-detail response does not match its permit.", "VNU_CROSS_DETAIL_RESPONSE_INVALID", 502);
      return parseCrossDetailHtml(response.html);
    },
    crossDetailBulk: async (permits: string[], signal?: AbortSignal): Promise<VnuCrossDetailItem[]> => {
      const items = parseCrossDetailBatchResponse(await request<unknown>("/api/vnu/cross-lookup/detail/bulk", { method: "POST", body: JSON.stringify({ allowCrossLookup: true, permits }), signal }), permits);
      return items.map((item) => {
        if (item.status === "error") return item;
        try { return { permit: item.permit, status: "ok" as const, components: parseCrossDetailHtml(item.html) }; }
        catch { return { permit: item.permit, status: "error" as const, errorCode: "VNU_CROSS_DETAIL_RESPONSE_INVALID" }; }
      });
    },
    crossDetailExport: async (permits: string[], signal?: AbortSignal): Promise<VnuCrossDetailItem[]> => {
      const items = parseCrossDetailBatchResponse(await request<unknown>("/api/vnu/cross-lookup/detail/export", { method: "POST", body: JSON.stringify({ allowCrossLookup: true, permits }), signal }), permits);
      return items.map((item) => {
        if (item.status === "error") return item;
        try { return { permit: item.permit, status: "ok" as const, components: parseCrossDetailHtml(item.html) }; }
        catch { return { permit: item.permit, status: "error" as const, errorCode: "VNU_CROSS_DETAIL_RESPONSE_INVALID" }; }
      });
    },
    crossLookupBulk: async (mode: VnuBulkLookupMode, targets: string[], signal?: AbortSignal): Promise<VnuBulkLookupItem[]> => {
      const response = await request<{ items: VnuBulkLookupItem[] }>("/api/vnu/cross-lookup/bulk", { method: "POST", body: JSON.stringify({ mode, targets, allowCrossLookup: true }), signal });
      return response.items.map((item) => {
        if (item.status === "error") return item;
        if (mode === "stdid-to-code") return { ...item, result: sanitizeCrossStudentCode(item.result as VnuCrossStudentCode) };
        if (mode === "stdid-to-transcript") return { ...item, result: sanitizeCrossTranscript(item.result as VnuTranscript) };
        const result = item.result as VnuCrossStudentId;
        return { ...item, result: { stdId: result.stdId, stdCode: result.stdCode, probes: result.probes } };
      });
    },
    documents: async (): Promise<DocumentItem[]> => parseSyllabusHtml((await raw("syllabus")).html).map(mapSyllabusRow),
    trainingPoints: async (): Promise<TrainingPoint[]> => mapTrainingPoints(parseStudyProgressHtml((await raw("progress")).html)),
  };
}
