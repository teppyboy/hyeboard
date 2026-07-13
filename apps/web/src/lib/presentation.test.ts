import { describe, expect, it } from "vitest";
import { formatStatus, formatTermLabel, type StatusLabels, type TermLabels } from "./presentation";

const statusLabels: StatusLabels = {
  notStarted: "Not started",
  inProgress: "In progress",
  missing: "Missing",
  submitted: "Submitted",
  graded: "Graded",
  late: "Late",
  active: "Active",
  completed: "Completed",
  upcoming: "Upcoming",
  paid: "Paid",
  unpaid: "Unpaid",
  partial: "Partially paid",
  credit: "Credit",
  available: "Available",
};

const termLabels: TermLabels = {
  semester: (semester, year) => `Semester ${semester}, ${year}`,
  summer: (year) => `Summer semester, ${year}`,
};

describe("formatStatus", () => {
  it.each([
    ["not_started", "Not started", "neutral"],
    ["in_progress", "In progress", "warning"],
    ["missing", "Missing", "danger"],
    ["submitted", "Submitted", "success"],
    ["graded", "Graded", "success"],
    ["late", "Late", "warning"],
    ["active", "Active", "accent"],
    ["completed", "Completed", "success"],
    ["upcoming", "Upcoming", "neutral"],
    ["paid", "Paid", "success"],
    ["unpaid", "Unpaid", "danger"],
    ["partial", "Partially paid", "warning"],
    ["credit", "Credit", "neutral"],
    ["available", "Available", "neutral"],
  ] as const)("formats %s with its semantic tone", (status, label, tone) => {
    expect(formatStatus(status, statusLabels)).toEqual({ label, tone });
  });

  it.each([
    ["awaiting_department_review", "Awaiting department review"],
    ["ON-HOLD", "On hold"],
    ["custom status", "Custom status"],
    ["constructor", "Constructor"],
  ])("preserves unknown status meaning for %s", (status, label) => {
    expect(formatStatus(status, statusLabels)).toEqual({ label, tone: "neutral" });
  });

  it.each([undefined, ""])("uses a neutral placeholder for %s", (status) => {
    expect(formatStatus(status, statusLabels)).toEqual({ label: "-", tone: "neutral" });
  });
});

describe("formatTermLabel", () => {
  it.each(["uet", "mock"])("formats verified %s term codes", (universityId) => {
    expect(formatTermLabel("20251", universityId, termLabels)).toBe("Semester 1, 2025–2026");
    expect(formatTermLabel("20252", universityId, termLabels)).toBe("Semester 2, 2025–2026");
    expect(formatTermLabel("20253", universityId, termLabels)).toBe("Summer semester, 2025–2026");
  });

  it.each([
    ["20251", "vnu"],
    ["2025", "uet"],
    ["20254", "uet"],
    ["", "uet"],
  ])("leaves unverified or malformed term %s for %s verbatim", (term, universityId) => {
    expect(formatTermLabel(term, universityId, termLabels)).toBe(term);
  });
});
