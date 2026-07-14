import { createRootRoute, createRoute, createRouter, Outlet, redirect } from "@tanstack/react-router";
import { RootLayout } from "@/components/layout";
import { getSessionToken } from "@/lib/api";
import { AssignmentsPage } from "@/pages/assignments";
import { CoursesPage } from "@/pages/courses";
import { DashboardPage } from "@/pages/dashboard";
import { DocumentsPage } from "@/pages/documents";
import { ExamsPage } from "@/pages/exams";
import { GradesPage } from "@/pages/grades";
import { LoginPage } from "@/pages/login";
import { SettingsPage } from "@/pages/settings";
import { TimetablePage } from "@/pages/timetable";
import { TrainingPointsPage } from "@/pages/training-points";
import { TuitionPage } from "@/pages/tuition";

const rootRoute = createRootRoute({ component: Outlet });
const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: "/login", component: LoginPage });
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  component: RootLayout,
  beforeLoad: () => {
    if (!getSessionToken()) throw redirect({ to: "/login" });
  },
});
const indexRoute = createRoute({ getParentRoute: () => appRoute, path: "/", component: DashboardPage });
const routeTree = rootRoute.addChildren([
  loginRoute,
  appRoute.addChildren([
    indexRoute,
    createRoute({ getParentRoute: () => appRoute, path: "/timetable", component: TimetablePage }),
    createRoute({ getParentRoute: () => appRoute, path: "/courses", component: CoursesPage }),
    createRoute({ getParentRoute: () => appRoute, path: "/assignments", component: AssignmentsPage }),
    createRoute({ getParentRoute: () => appRoute, path: "/grades", component: GradesPage }),
    createRoute({ getParentRoute: () => appRoute, path: "/exams", component: ExamsPage }),
    createRoute({ getParentRoute: () => appRoute, path: "/tuition", component: TuitionPage }),
    createRoute({ getParentRoute: () => appRoute, path: "/documents", component: DocumentsPage }),
    createRoute({ getParentRoute: () => appRoute, path: "/training-points", component: TrainingPointsPage }),
    createRoute({ getParentRoute: () => appRoute, path: "/settings", component: SettingsPage }),
  ]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
