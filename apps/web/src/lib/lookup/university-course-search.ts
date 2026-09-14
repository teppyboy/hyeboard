import type { DocumentItem } from "@hyeboard/schemas";
import { vnuCourseCodeKey } from "@hyeboard/university-adapters/src/vnu/course-code";
import type { VnuExamCatalogRow } from "@hyeboard/university-adapters/src/vnu/types";

export function filterCatalogRowsByUniversity(
  rows: readonly VnuExamCatalogRow[],
  courseCode: string,
  classNo: string,
  universityId: string,
): VnuExamCatalogRow[] {
  const classNoQuery = classNo.trim().toUpperCase();
  if (universityId === "vnu") {
    const codeQuery = vnuCourseCodeKey(courseCode);
    return rows.filter((row) => {
      if (codeQuery && !vnuCourseCodeKey(row.courseCode).includes(codeQuery)) return false;
      if (classNoQuery && (row.classNo ?? "").toUpperCase() !== classNoQuery) return false;
      return true;
    });
  }

  const codeQuery = courseCode.trim().toUpperCase();
  return rows.filter((row) => {
    if (codeQuery && !row.courseCode.toUpperCase().includes(codeQuery)) return false;
    if (classNoQuery && (row.classNo ?? "").toUpperCase() !== classNoQuery) return false;
    return true;
  });
}

export function filterDocumentsByUniversity(
  items: DocumentItem[] | undefined,
  query: string,
  universityId: string,
): DocumentItem[] | undefined {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return items;
  const lowercaseQuery = trimmedQuery.toLowerCase();

  if (universityId !== "vnu") {
    return items?.filter((item) => `${item.name} ${item.courseCode ?? ""}`.toLowerCase().includes(lowercaseQuery));
  }

  const codeQuery = vnuCourseCodeKey(trimmedQuery);
  return items?.filter((item) => (
    item.name.toLowerCase().includes(lowercaseQuery)
    || Boolean(item.courseCode && vnuCourseCodeKey(item.courseCode).includes(codeQuery))
  ));
}
