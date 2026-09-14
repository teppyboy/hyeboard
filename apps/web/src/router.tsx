import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
  type RouteComponent,
} from "@tanstack/react-router";
import { RootLayout } from "@/components/layout";
import { getSessionToken } from "@/lib/api/api";
import { LoginPage } from "@/pages/account/login";
import { HyeboardProvider } from "@/state";

const rootRoute = createRootRoute({ component: Outlet });
const studentRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "student",
  component: () => (
    <HyeboardProvider>
      <Outlet />
    </HyeboardProvider>
  ),
});
const loginRoute = createRoute({
  getParentRoute: () => studentRoute,
  path: "/login",
  component: LoginPage,
});
const appRoute = createRoute({
  getParentRoute: () => studentRoute,
  id: "app",
  component: RootLayout,
  beforeLoad: () => {
    if (!getSessionToken()) throw redirect({ to: "/login" });
  },
});

const lazyPage = (
  importer: () => Promise<Record<string, unknown>>,
  exportName: string,
): RouteComponent =>
  lazyRouteComponent(importer, exportName as never) as RouteComponent;
const indexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  component: lazyPage(
    () => import("@/pages/dashboard/dashboard"),
    "DashboardPage",
  ),
});
const adminLoginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/login",
  component: lazyPage(
    () => import("@/pages/admin/admin-login"),
    "AdminLoginPage",
  ),
});
const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  component: lazyPage(
    () => import("@/components/admin/admin-layout"),
    "AdminLayout",
  ),
});
const adminIndexRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/",
  component: lazyPage(
    () => import("@/pages/admin/admin-control"),
    "AdminControlPage",
  ),
});
const adminHistoryRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/history",
  component: lazyPage(
    () => import("@/pages/admin/admin-history"),
    "AdminHistoryPage",
  ),
});
const adminAuthRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/auth",
  component: lazyPage(
    () => import("@/pages/admin/admin-auth"),
    "AdminAuthPage",
  ),
});

const routeTree = rootRoute.addChildren([
  studentRoute.addChildren([
    loginRoute,
    appRoute.addChildren([
      indexRoute,
      createRoute({
        getParentRoute: () => appRoute,
        path: "/timetable",
        component: lazyPage(
          () => import("@/pages/academic/timetable"),
          "TimetablePage",
        ),
      }),
      createRoute({
        getParentRoute: () => appRoute,
        path: "/courses",
        component: lazyPage(
          () => import("@/pages/academic/courses"),
          "CoursesPage",
        ),
      }),
      createRoute({
        getParentRoute: () => appRoute,
        path: "/assignments",
        component: lazyPage(
          () => import("@/pages/academic/assignments"),
          "AssignmentsPage",
        ),
      }),
      createRoute({
        getParentRoute: () => appRoute,
        path: "/grades",
        component: lazyPage(
          () => import("@/pages/academic/grades"),
          "GradesPage",
        ),
      }),
      createRoute({
        getParentRoute: () => appRoute,
        path: "/exams",
        component: lazyPage(
          () => import("@/pages/academic/exams"),
          "ExamsPage",
        ),
      }),
      createRoute({
        getParentRoute: () => appRoute,
        path: "/tuition",
        component: lazyPage(
          () => import("@/pages/academic/tuition"),
          "TuitionPage",
        ),
      }),
      createRoute({
        getParentRoute: () => appRoute,
        path: "/documents",
        component: lazyPage(
          () => import("@/pages/academic/documents"),
          "DocumentsPage",
        ),
      }),
      createRoute({
        getParentRoute: () => appRoute,
        path: "/training-points",
        component: lazyPage(
          () => import("@/pages/academic/training-points"),
          "TrainingPointsPage",
        ),
      }),
      createRoute({
        getParentRoute: () => appRoute,
        path: "/lookup",
        component: lazyPage(
          () => import("@/pages/lookup/lookup"),
          "LookupPage",
        ),
      }),
      createRoute({
        getParentRoute: () => appRoute,
        path: "/settings",
        component: lazyPage(
          () => import("@/pages/account/settings"),
          "SettingsPage",
        ),
      }),
    ]),
  ]),
  adminLoginRoute,
  adminRoute.addChildren([adminIndexRoute, adminHistoryRoute, adminAuthRoute]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
