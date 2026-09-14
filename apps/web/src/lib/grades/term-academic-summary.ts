export type AcademicCourseInput<T> = {
  termKey: string;
  credits?: number | null;
  point4?: number | null;
  course: T;
  isSummer?: boolean;
};

export type AcademicTermSummary<T> = {
  termKey: string;
  courses: T[];
  includesSummer: boolean;
  listedCredits: number;
  includedCredits: number;
  termGpa4?: number;
  cpa4?: number;
  estimateKind: "derived";
};

type Group<T> = {
  termKey: string;
  courses: T[];
  includesSummer: boolean;
  listedCredits: number;
  includedCredits: number;
  weightedPoints: number;
  sourceIndex: number;
};

function usesUetSummerRule(universityId: string): boolean {
  return universityId === "uet" || universityId === "mock";
}

function groupedTermKey(termKey: string, universityId: string): string {
  if (usesUetSummerRule(universityId) && /^\d+3$/.test(termKey)) {
    return `${termKey.slice(0, -1)}2`;
  }

  return termKey;
}

function positiveFinite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function finiteGrade(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function chronologicalGroups<T>(groups: Group<T>[]): Group<T>[] {
  const numericGroups = groups
    .filter((group) => /^\d+$/.test(group.termKey))
    .sort(
      (left, right) =>
        Number(left.termKey) - Number(right.termKey) ||
        left.sourceIndex - right.sourceIndex,
    );
  let numericIndex = 0;

  return groups.map((group) => {
    if (!/^\d+$/.test(group.termKey)) {
      return group;
    }

    return numericGroups[numericIndex++]!;
  });
}

export function calculateTermAcademicSummaries<T>(
  rows: readonly AcademicCourseInput<T>[],
  universityId: string,
): AcademicTermSummary<T>[] {
  const groups = new Map<string, Group<T>>();

  rows.forEach((row, sourceIndex) => {
    const termKey = groupedTermKey(row.termKey, universityId);
    const group = groups.get(termKey) ?? {
      termKey,
      courses: [],
      includesSummer: false,
      listedCredits: 0,
      includedCredits: 0,
      weightedPoints: 0,
      sourceIndex,
    };

    group.courses.push(row.course);
    group.includesSummer ||=
      row.isSummer === true ||
      (usesUetSummerRule(universityId) &&
        row.termKey !== termKey &&
        row.termKey.endsWith("3"));

    if (positiveFinite(row.credits)) {
      group.listedCredits += row.credits;

      if (finiteGrade(row.point4)) {
        group.includedCredits += row.credits;
        group.weightedPoints += row.credits * row.point4;
      }
    }

    groups.set(termKey, group);
  });

  let runningCredits = 0;
  let runningPoints = 0;

  return chronologicalGroups([...groups.values()]).map((group) => {
    runningCredits += group.includedCredits;
    runningPoints += group.weightedPoints;

    return {
      termKey: group.termKey,
      courses: group.courses,
      includesSummer: group.includesSummer,
      listedCredits: group.listedCredits,
      includedCredits: group.includedCredits,
      termGpa4:
        group.includedCredits > 0
          ? group.weightedPoints / group.includedCredits
          : undefined,
      cpa4: runningCredits > 0 ? runningPoints / runningCredits : undefined,
      estimateKind: "derived",
    };
  });
}

export function newestAcademicTermsFirst<T>(
  summaries: readonly AcademicTermSummary<T>[],
): AcademicTermSummary<T>[] {
  return [...summaries].reverse();
}
