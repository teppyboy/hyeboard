import "./styles.css";

import type { Notification } from "@hyeboard/schemas";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, Link, Outlet, redirect, RouterProvider, useNavigate } from "@tanstack/react-router";
import { Bell, BookOpen, CalendarDays, Check, CheckCircle2, ClipboardList, FileText, GraduationCap, LayoutDashboard, LibraryBig, LogOut, Menu, PanelLeftClose, PanelLeftOpen, Receipt, Search, Settings, UserRound, X } from "lucide-react";
import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Toaster } from "@/components/ui/sonner";
import { universityLogoUrl } from "@/components/shared";
import { getSessionToken, SESSION_CLEARED_EVENT, type StoredAccount } from "@/lib/api";
import { LocaleProvider, type Translations, useLocale } from "@/lib/i18n";
import { cn, formatDateTime } from "@/lib/utils";
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
import { HyeboardProvider, useHyeboard } from "@/state";

declare const __HYEB_GIT_COMMIT__: string;

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 60_000, retry: 1 } },
});

const nav = [
  { to: "/", key: "dashboard", icon: LayoutDashboard },
  { to: "/timetable", key: "timetable", icon: CalendarDays, capability: "timetable" },
  { to: "/courses", key: "courses", icon: BookOpen, capability: "courses" },
  { to: "/assignments", key: "assignments", icon: ClipboardList, capability: "assignments" },
  { to: "/grades", key: "grades", icon: GraduationCap, capability: "grades" },
  { to: "/exams", key: "exams", icon: LibraryBig, capability: "exams" },
  { to: "/tuition", key: "tuition", icon: Receipt, capability: "tuition" },
  { to: "/documents", key: "documents", icon: FileText, capability: "documentsHub" },
  { to: "/training-points", key: "trainingPoints", icon: CheckCircle2, capability: "trainingPoints" },
  { to: "/settings", key: "settings", icon: Settings },
] as const;

function SidebarNav({ collapsed = false }: { collapsed?: boolean } = {}) {
  const state = useHyeboard();
  const { t } = useLocale();
  const capabilities = state.universities.data?.find((u) => u.id === state.universityId)?.capabilities;
  const visibleNav = nav.filter((item) => {
    if (!("capability" in item)) return true;
    if (!capabilities) return true;
    if (item.capability === "documentsHub") return capabilities.documents || capabilities.requests || capabilities.news;
    return capabilities[item.capability as keyof typeof capabilities] !== false;
  });
  return (
    <nav className="space-y-1 px-3 py-4">
      {visibleNav.map((item) => <NavLink key={item.to} to={item.to} label={t.nav[item.key]} icon={item.icon} collapsed={collapsed} />)}
    </nav>
  );
}

function SidebarFooter({ collapsed = false }: { collapsed?: boolean } = {}) {
  const { t } = useLocale();
  if (collapsed) return <div className="mt-auto" />;
  return <p className="mt-auto px-5 pb-4 text-xs text-muted-foreground">{t.common.poweredBy(__HYEB_GIT_COMMIT__)}</p>;
}

function BrandMark({ collapsed = false }: { collapsed?: boolean } = {}) {
  const state = useHyeboard();
  const university = state.universities.data?.find((item) => item.id === state.universityId);
  const logoUrl = universityLogoUrl(state.universityId);
  return (
    <div className={cn("flex h-16 items-center gap-3", collapsed ? "px-[18px]" : "px-5")}>
      <div
        data-testid="brand-icon"
        data-university={state.universityId}
        className={cn(
          "brand-icon grid shrink-0 place-items-center rounded-lg",
          logoUrl ? "border border-border bg-background p-1" : "bg-primary text-primary-foreground",
        )}
      >
        {logoUrl
          ? <img className="h-full w-full object-contain" src={logoUrl} alt="" draggable={false} />
          : <GraduationCap size={19} aria-hidden="true" />}
      </div>
      <div
        className={cn(
          "min-w-0 overflow-hidden whitespace-nowrap transition-[max-width,opacity,transform] duration-300 ease-[var(--ease-out-quint)]",
          collapsed ? "max-w-0 -translate-x-1 opacity-0" : "max-w-44 translate-x-0 opacity-100",
        )}
      >
        <p className="truncate text-sm font-semibold tracking-tight text-foreground">{university?.shortName ?? "Hyeboard"}</p>
      </div>
    </div>
  );
}

function RootLayout() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("hyeboard.sidebarCollapsed") === "true");

  useEffect(() => {
    localStorage.setItem("hyeboard.sidebarCollapsed", String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  useEffect(() => {
    const redirectToLogin = () => { void navigate({ to: "/login" }); };
    window.addEventListener(SESSION_CLEARED_EVENT, redirectToLogin);
    return () => window.removeEventListener(SESSION_CLEARED_EVENT, redirectToLogin);
  }, [navigate]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className={cn("app-shell grid min-h-screen", sidebarCollapsed ? "lg:grid-cols-[76px_1fr]" : "lg:grid-cols-[270px_1fr]")}>
        <aside className="sticky top-0 hidden h-screen self-start overflow-hidden border-r border-border bg-sidebar lg:flex lg:flex-col">
          <div className={cn("transition-[padding] duration-300 ease-[var(--ease-out-quint)]", sidebarCollapsed ? "px-0 pb-2" : "flex items-center")}>
            <div className={cn("min-w-0", sidebarCollapsed ? "w-full" : "flex-1")}><BrandMark collapsed={sidebarCollapsed} /></div>
            <Button
              variant="ghost"
              size="sm"
              className={cn("sidebar-rail-button shrink-0 transition-transform duration-200 ease-[var(--ease-out-quint)] active:scale-95", sidebarCollapsed ? "ml-[18px]" : "mr-2")}
              onClick={() => setSidebarCollapsed((value) => !value)}
              aria-label={sidebarCollapsed ? t.common.expandSidebar : t.common.collapseSidebar}
            >
              {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
            </Button>
          </div>
          <SidebarNav collapsed={sidebarCollapsed} />
          <SidebarFooter collapsed={sidebarCollapsed} />
        </aside>

        <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
          <SheetContent className="lg:hidden">
            <SheetTitle className="sr-only">{t.common.navigation}</SheetTitle>
            <BrandMark />
            <div onClick={() => setMobileNavOpen(false)}><SidebarNav /></div>
          </SheetContent>
        </Sheet>

        <main className="min-w-0">
          <header className="sticky top-0 z-10 flex h-16 items-center gap-3 border-b border-border bg-background/85 px-4 backdrop-blur lg:px-6">
            <Button variant="ghost" size="sm" className="lg:hidden" onClick={() => setMobileNavOpen(true)} aria-label={t.common.openNavigationMenu}><Menu size={18} /></Button>
            <NavSearch />
            <NotificationsMenu />
            <AccountMenu />
          </header>
          <div className="p-4 lg:p-6">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}

function NavSearch() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const navWithLabels = useMemo(() => nav.map((item) => ({ ...item, label: t.nav[item.key] })), [t]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return navWithLabels;
    return navWithLabels.filter((item) => item.label.toLowerCase().includes(q));
  }, [query, navWithLabels]);

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const go = (to: string) => {
    setOpen(false);
    setQuery("");
    void navigate({ to });
  };

  return (
    <div ref={containerRef} className="relative min-w-0 flex-1">
      <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm focus-within:border-ring">
        <Search size={16} className="shrink-0 text-muted-foreground" />
        <input
          value={query}
          onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => { if (event.key === "Enter" && matches[0]) go(matches[0].to); if (event.key === "Escape") setOpen(false); }}
          placeholder={t.common.searchPlaceholder}
          className="min-w-0 flex-1 truncate bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>
      {open ? (
        <div className="motion-popover absolute left-0 right-0 top-[calc(100%+0.375rem)] z-20 overflow-hidden rounded-lg border border-border bg-card shadow-lg">
          {matches.length ? matches.map((item) => (
            <button key={item.to} type="button" onClick={() => go(item.to)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent hover:text-accent-foreground">
              <item.icon size={15} className="text-muted-foreground" /> {item.label}
            </button>
          )) : <p className="px-3 py-2 text-sm text-muted-foreground">{t.common.noPageMatches}</p>}
        </div>
      ) : null}
    </div>
  );
}

function NotificationsMenu() {
  const { dashboard } = useHyeboard();
  const { t } = useLocale();
  const items: Notification[] = dashboard.data?.notifications ?? [];
  const unreadCount = items.filter((item) => item.unread).length;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="pressable-icon-button relative" aria-label={t.common.notifications} data-testid="notifications-trigger">
          <Bell size={17} />
          {unreadCount ? <span className="absolute right-0.5 top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground">{unreadCount > 9 ? "9+" : unreadCount}</span> : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel>{t.common.notifications}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {items.length ? items.slice(0, 6).map((item) => (
          <DropdownMenuItem key={item.id} className="flex-col items-start gap-0.5">
            <span className="text-sm font-medium leading-tight">{item.title}</span>
            <span className="text-xs text-muted-foreground">{formatDateTime(item.createdAt)}</span>
          </DropdownMenuItem>
        )) : <p className="px-2 py-3 text-sm text-muted-foreground">{t.common.noNotifications}</p>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function accountLabel(account: StoredAccount, t: Translations): string {
  if (account.studentCode) return account.studentCode;
  if (account.universityId === "mock") return t.common.demo;
  return account.universityId.toUpperCase();
}

function AccountMenu() {
  const state = useHyeboard();
  const { t } = useLocale();
  const navigate = useNavigate();
  const student = state.dashboard.data?.student;

  const signOut = () => {
    state.logout();
    void navigate({ to: "/login" });
  };

  const handleRemove = (event: React.MouseEvent, accountId: string) => {
    event.preventDefault();
    event.stopPropagation();
    state.removeStoredAccount(accountId);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="pressable-icon-button" aria-label={t.common.openAccountMenu} data-testid="account-trigger"><UserRound size={17} /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>
          <span className="block text-sm">{student?.fullName ?? t.common.account}</span>
          <span className="block text-xs font-normal text-muted-foreground">{student?.studentCode ?? state.universityId.toUpperCase()}</span>
        </DropdownMenuLabel>
        {state.accounts.length > 1 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{t.common.accounts}</DropdownMenuLabel>
            {state.accounts.map((account) => (
              <DropdownMenuItem
                key={account.id}
                onSelect={() => account.id !== state.activeAccountId && state.switchToAccount(account.id)}
                className="justify-between gap-2"
                data-testid="account-switch-item"
              >
                <span className="flex min-w-0 items-center gap-2">
                  {account.id === state.activeAccountId ? <Check size={14} className="shrink-0 text-primary" /> : <span className="w-3.5 shrink-0" />}
                  <span className="truncate">{accountLabel(account, t)} <span className="text-muted-foreground">({account.universityId.toUpperCase()})</span></span>
                </span>
                <button type="button" onClick={(event) => handleRemove(event, account.id)} aria-label={t.common.remove(accountLabel(account, t))} className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive">
                  <X size={13} />
                </button>
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild><Link to="/settings"><Settings size={16} /> {t.common.settings}</Link></DropdownMenuItem>
        <DropdownMenuItem asChild><Link to="/login"><UserRound size={16} /> {t.common.addAccount}</Link></DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={signOut} className="text-destructive focus:text-destructive"><LogOut size={16} /> {t.common.signOut}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NavLink({ to, label, icon: Icon, collapsed = false }: { to: string; label: string; icon: typeof LayoutDashboard; collapsed?: boolean }) {
  return (
    <Link to={to} className={cn("nav-link", collapsed && "justify-center gap-0 px-0")} activeProps={{ className: cn("nav-link active", collapsed && "justify-center gap-0 px-0") }} title={collapsed ? label : undefined}>
      <Icon size={16} className="shrink-0" />
      <span
        className={cn(
          "overflow-hidden whitespace-nowrap transition-[max-width,opacity,transform] duration-300 ease-[var(--ease-out-quint)]",
          collapsed ? "max-w-0 -translate-x-1 opacity-0" : "max-w-36 translate-x-0 opacity-100",
        )}
      >
        {label}
      </span>
    </Link>
  );
}

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

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" { interface Register { router: typeof router } }

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <LocaleProvider>
        <HyeboardProvider>
          <RouterProvider router={router} />
          <Toaster />
        </HyeboardProvider>
      </LocaleProvider>
    </QueryClientProvider>
  </StrictMode>,
);
