// Regex-based HTML scraping for daotao.vnu.edu.vn (classic ASP, no JSON API).
// Attribute order in the source markup is inconsistent (id before/after name,
// value before/after disabled, etc.), so helpers scan whole tags rather than
// assuming a fixed attribute order. See har-notes.md for the exact page
// structures these patterns were derived from.

import type {
  VnuExamRow,
  VnuExamTermOption,
  VnuGradeRow,
  VnuGradesResult,
  VnuProfile,
  VnuSyllabusRow,
  VnuTermProgressRow,
} from "./types";

function decodeEntities(text: string): string {
  return text
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " "));
}

function attrOf(tag: string, attr: string): string | undefined {
  const match = tag.match(new RegExp(`${attr}\\s*=\\s*"([^"]*)"`, "i"));
  return match?.[1];
}

function tagWithAttr(html: string, tag: string, attrName: string, attrValue: string): string | undefined {
  const re = new RegExp(`<${tag}\\b[^>]*>`, "gi");
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    if (new RegExp(`${attrName}\\s*=\\s*"${attrValue}"`, "i").test(match[0])) return match[0];
  }
  return undefined;
}

function inputValue(html: string, name: string): string | undefined {
  const tag = tagWithAttr(html, "input", "name", name);
  const value = tag ? attrOf(tag, "value") : undefined;
  return value?.trim() || undefined;
}

function selectBlock(html: string, name: string): string | undefined {
  const re = new RegExp(`<select\\b[^>]*name\\s*=\\s*"${name}"[^>]*>([\\s\\S]*?)</select>`, "i");
  return re.exec(html)?.[1];
}

function selectedOption(html: string, name: string): { value: string; label: string } | undefined {
  const block = selectBlock(html, name);
  if (!block) return undefined;
  const optionRe = /<option\b([^>]*)>([^<]*)<\/option>/gi;
  let match: RegExpExecArray | null;
  while ((match = optionRe.exec(block))) {
    if (/selected/i.test(match[1])) {
      return { value: attrOf(`<option ${match[1]}>`, "value") ?? "", label: decodeEntities(match[2]) };
    }
  }
  return undefined;
}

export function parseProfileHtml(html: string): VnuProfile {
  const univ = selectedOption(html, "UnivID");
  const major = selectedOption(html, "BrcID");
  const cls = selectedOption(html, "ClsID");
  const cohort = selectedOption(html, "PrmID");
  const level = selectedOption(html, "LevID");
  const mode = selectedOption(html, "SysID");
  const progType = selectedOption(html, "PrgTypeID");
  return {
    studentCode: inputValue(html, "StdCode"),
    fullName: inputValue(html, "StdName"),
    dob: inputValue(html, "StdDob"),
    internalStudentId: inputValue(html, "hidStdID"),
    internalUnivId: univ?.value,
    facultyName: univ?.label,
    majorName: major?.label,
    className: cls?.label,
    cohortName: cohort?.label,
    levelName: level?.label,
    trainingModeName: mode?.label,
    programTypeName: progType?.label,
  };
}

function tdCells(rowHtml: string): string[] {
  return [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => decodeEntities(stripTags(m[1])));
}

// ListPoint/listpoint_Brc1.asp — term-grouped transcript table plus
// plain-text cumulative summary lines after the table.
export function parseGradesHtml(html: string): VnuGradesResult {
  const rows: VnuGradeRow[] = [];
  let currentTermCode: string | undefined;
  let currentTermLabel: string | undefined;
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let match: RegExpExecArray | null;
  while ((match = trRe.exec(html))) {
    const cells = tdCells(match[1]);
    if (!cells.length) continue;
    const joined = cells.join(" ");
    const termHeaderMatch = joined.match(/MÃ HỌC KỲ\s*(\d+)/i);
    if (termHeaderMatch && cells.length <= 2) {
      currentTermCode = termHeaderMatch[1];
      currentTermLabel = joined.replace(/\s+/g, " ").trim();
      continue;
    }
    if (cells.length >= 7 && /^[A-Za-zĐ]{2,6}\d{3,4}/.test(cells[1] ?? "")) {
      const credits = Number.parseFloat(cells[3] ?? "");
      const point10 = Number.parseFloat(cells[4] ?? "");
      const point4 = Number.parseFloat(cells[6] ?? "");
      rows.push({
        termCode: currentTermCode ?? "",
        termLabel: currentTermLabel ?? "",
        courseCode: (cells[1] ?? "").trim(),
        courseName: (cells[2] ?? "").trim(),
        credits: Number.isFinite(credits) ? credits : undefined,
        point10: Number.isFinite(point10) ? point10 : undefined,
        letter: cells[5]?.trim() || undefined,
        point4: Number.isFinite(point4) ? point4 : undefined,
      });
    }
  }
  const plain = stripTags(html);
  const accumulatedMatch = plain.match(/Tổng tín chỉ tích lũy:\s*([\d.]+)/i);
  const listingMatch = plain.match(/Tổng tín chỉ:\s*([\d.]+)/i);
  const cumulativeGpaMatch = plain.match(/Điểm trung bình tích lũy hệ 4:\s*([\d.]+)/i);
  return {
    rows,
    totalCredits: listingMatch ? Number.parseFloat(listingMatch[1]) : undefined,
    totalAccumulatedCredits: accumulatedMatch ? Number.parseFloat(accumulatedMatch[1]) : undefined,
    cumulativeGpa4: cumulativeGpaMatch ? Number.parseFloat(cumulativeGpaMatch[1]) : undefined,
  };
}

// StdInfo/TabStdStudy.asp, Section 2 "Thông tin học tập" — per-term conduct
// score + term/cumulative GPA. Other sections (rewards, discipline,
// scholarships, science awards, overseas travel) render only an empty
// "add new" template row for most students and are intentionally not parsed.
export function parseStudyProgressHtml(html: string): VnuTermProgressRow[] {
  const rows: VnuTermProgressRow[] = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let match: RegExpExecArray | null;
  while ((match = trRe.exec(html))) {
    const cells = tdCells(match[1]);
    if (cells.length < 5) continue;
    const termCodeMatch = cells[1]?.match(/MÃ\s*(\d+)/i);
    if (!termCodeMatch) continue;
    const conduct = Number.parseFloat(cells[2] ?? "");
    const termGpa = Number.parseFloat(cells[3] ?? "");
    const cumulativeGpa = Number.parseFloat(cells[4] ?? "");
    rows.push({
      termCode: termCodeMatch[1],
      termLabel: (cells[1] ?? "").trim(),
      conductScore: Number.isFinite(conduct) ? conduct : undefined,
      termGpa: Number.isFinite(termGpa) ? termGpa : undefined,
      cumulativeGpa: Number.isFinite(cumulativeGpa) ? cumulativeGpa : undefined,
    });
  }
  return rows;
}

// StdExamination.asp?selViewType=StdExam — the vTermID dropdown, used to
// resolve a requested termCode (from the grades page's "MÃ HỌC KỲ" scheme)
// to this page's separate internal vTermID scheme.
export function parseExamTermOptions(html: string): VnuExamTermOption[] {
  const block = selectBlock(html, "selTermID");
  if (!block) return [];
  return [...block.matchAll(/<option\b([^>]*)>([^<]*)<\/option>/gi)].map((m) => ({
    value: attrOf(`<option ${m[1]}>`, "value") ?? "",
    label: decodeEntities(m[2]),
    selected: /selected/i.test(m[1]),
  }));
}

// StdExamination.asp?selViewType=StdExam&vTermID=... data rows.
export function parseExamsHtml(html: string): VnuExamRow[] {
  const rows: VnuExamRow[] = [];
  const trRe = /<tr\b[^>]*id="\d+"[^>]*>([\s\S]*?)<\/tr>/gi;
  let match: RegExpExecArray | null;
  while ((match = trRe.exec(html))) {
    const cells = tdCells(match[1]);
    if (cells.length < 8) continue;
    const examCode = (cells[1] ?? "").trim();
    const codeMatch = examCode.match(/^(\d+)-([A-Za-zĐ]{2,6}\d{3,4})/);
    const sessionMatch = cells[4]?.match(/(\d+)\(([\d:]+)\)/);
    rows.push({
      termCode: codeMatch?.[1],
      courseCode: codeMatch?.[2] ?? examCode,
      courseName: (cells[2] ?? "").trim(),
      examDate: (cells[3] ?? "").trim(),
      session: sessionMatch ? Number.parseInt(sessionMatch[1], 10) : undefined,
      hour: sessionMatch?.[2],
      method: cells[5]?.trim() || undefined,
      room: cells[6]?.trim() || undefined,
      seatNumber: cells[7]?.trim() || undefined,
    });
  }
  return rows;
}

// SiteManager/Syllabus/default.asp — paginated syllabus/curriculum PDF
// listing. Only parses the current page; pagination (nPage/pStart) is not
// followed since the adapter has no use case requiring the full 9-page list.
export function parseSyllabusHtml(html: string): VnuSyllabusRow[] {
  const rows: VnuSyllabusRow[] = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let match: RegExpExecArray | null;
  while ((match = trRe.exec(html))) {
    const cellsHtml = [...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (cellsHtml.length < 7) continue;
    const codeText = decodeEntities(stripTags(cellsHtml[1] ?? ""));
    if (!/^[A-Za-zĐ]{2,6}\d{3,4}/.test(codeText)) continue;
    const nameText = decodeEntities(stripTags(cellsHtml[2] ?? ""));
    const creditsText = decodeEntities(stripTags(cellsHtml[3] ?? ""));
    const fileHrefMatch = (cellsHtml[4] ?? "").match(/href="([^"]+\.pdf)"/i);
    const sizeText = decodeEntities(stripTags(cellsHtml[6] ?? ""));
    const dateText = cellsHtml[7] ? decodeEntities(stripTags(cellsHtml[7])) : undefined;
    const credits = Number.parseFloat(creditsText);
    rows.push({
      courseCode: codeText.trim(),
      courseName: nameText.trim(),
      credits: Number.isFinite(credits) ? credits : undefined,
      fileUrl: fileHrefMatch ? new URL(fileHrefMatch[1], "https://daotao.vnu.edu.vn/SiteManager/Syllabus/").toString() : undefined,
      fileSize: sizeText || undefined,
      uploadedAt: dateText || undefined,
    });
  }
  return rows;
}

export function hasLoginForm(html: string): boolean {
  return html.includes('name="txtLoginId"') || html.includes("name='txtLoginId'");
}
