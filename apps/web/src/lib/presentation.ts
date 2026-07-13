export type StatusTone = "neutral" | "warning" | "danger" | "success" | "accent";

export interface StatusLabels {
  notStarted: string;
  inProgress: string;
  missing: string;
  submitted: string;
  graded: string;
  late: string;
  active: string;
  completed: string;
  upcoming: string;
  paid: string;
  unpaid: string;
  partial: string;
  credit: string;
  available: string;
}

export interface TermLabels {
  semester: (semester: number, year: string) => string;
  summer: (year: string) => string;
}

const statusTones: Record<keyof StatusLabels, StatusTone> = {
  notStarted: "neutral",
  inProgress: "warning",
  missing: "danger",
  submitted: "success",
  graded: "success",
  late: "warning",
  active: "accent",
  completed: "success",
  upcoming: "neutral",
  paid: "success",
  unpaid: "danger",
  partial: "warning",
  credit: "neutral",
  available: "neutral",
};

const statusKeys = new Map<string, keyof StatusLabels>([
  ["not_started", "notStarted"],
  ["in_progress", "inProgress"],
  ["missing", "missing"],
  ["submitted", "submitted"],
  ["graded", "graded"],
  ["late", "late"],
  ["active", "active"],
  ["completed", "completed"],
  ["upcoming", "upcoming"],
  ["paid", "paid"],
  ["unpaid", "unpaid"],
  ["partial", "partial"],
  ["credit", "credit"],
  ["available", "available"],
]);

export function formatStatus(status: string | undefined, labels: StatusLabels): { label: string; tone: StatusTone } {
  const value = status?.trim();
  if (!value) return { label: "-", tone: "neutral" };

  const normalized = value.toLowerCase().replace(/[\s-]+/g, "_");
  const key = statusKeys.get(normalized);
  if (key) return { label: labels[key], tone: statusTones[key] };

  const readable = normalized.replace(/_+/g, " ");
  return { label: readable.charAt(0).toUpperCase() + readable.slice(1), tone: "neutral" };
}

export function formatTermLabel(term: string, universityId: string, labels: TermLabels): string {
  if (universityId !== "uet" && universityId !== "mock") return term;

  const match = /^(\d{4})([123])$/.exec(term);
  if (!match) return term;

  const startYear = Number(match[1]);
  const year = `${startYear}–${startYear + 1}`;
  const semester = Number(match[2]);
  return semester === 3 ? labels.summer(year) : labels.semester(semester, year);
}
