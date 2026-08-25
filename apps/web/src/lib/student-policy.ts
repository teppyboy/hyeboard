import type { DashboardSummary, UniversityCapabilities } from "@hyeboard/schemas";

type DashboardIdentity = Pick<DashboardSummary, "student" | "currentTerm">;

export function effectiveDashboardIdentity(
  dashboard: DashboardIdentity | undefined,
  capabilities: UniversityCapabilities | undefined,
) {
  return {
    student: capabilities?.profile === true ? dashboard?.student : undefined,
    currentTerm: capabilities?.terms === true ? dashboard?.currentTerm : undefined,
  };
}

export function effectiveDashboardStudent(
  dashboard: Pick<DashboardSummary, "student"> | undefined,
  capabilities: UniversityCapabilities | undefined,
) {
  return effectiveDashboardIdentity(dashboard, capabilities).student;
}

export function dashboardSections(
  dashboard: DashboardSummary | undefined,
  capabilities: UniversityCapabilities | undefined,
  identity: DashboardIdentity = dashboard ?? {},
) {
  return {
    identity: effectiveDashboardIdentity(identity, capabilities),
    stats: {
      courses: capabilities?.courses === true,
      assignments: capabilities?.assignments === true,
      grades: capabilities?.grades === true,
      tuition: capabilities?.tuition === true,
    },
    panels: {
      timetable: capabilities?.timetable === true,
      assignments: capabilities?.assignments === true,
      courses: capabilities?.courses === true,
      notifications: capabilities?.notifications === true,
    },
  };
}
