import "./styles.css";

import type { Assignment, Bill, ClassSession, Course, DashboardSummary, DocumentItem, ExamSession, Grade, NewsItem, Notification, ServiceRequest, TrainingPoint } from "@hyeboard/schemas";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, Link, Outlet, redirect, RouterProvider, useNavigate } from "@tanstack/react-router";
import { Bell, BookOpen, CalendarDays, Check, CheckCircle2, ChevronDown, ClipboardList, ExternalLink, FileText, GraduationCap, LayoutDashboard, LibraryBig, LogOut, Menu, Moon, PanelLeftClose, PanelLeftOpen, Receipt, Search, Settings, Sun, UserRound, WalletCards, X } from "lucide-react";
import { Loader2 } from "lucide-react";
import { createContext, StrictMode, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";
import { ACCOUNT_SWITCHED_EVENT, api, ApiError, clearSessionToken, getActiveAccount, getActiveAccountId, getSessionToken, listAccounts, removeAccount, SESSION_CLEARED_EVENT, type StoredAccount, switchAccount } from "@/lib/api";
import { LOCALES, LocaleProvider, type Locale, type Translations, useLocale } from "@/lib/i18n";
import { cn, formatCurrency, formatDateTime } from "@/lib/utils";

declare const __HYEB_GIT_COMMIT__: string;

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 60_000, retry: 1 } },
});

type Palette = "geist" | "uet" | "vnu";
type Mode = "light" | "dark";

const THEME_HUE_PRESETS = [
  { hue: 209, key: "blue" },
  { hue: 152, key: "green" },
  { hue: 0, key: "red" },
  { hue: 271, key: "purple" },
  { hue: 25, key: "orange" },
  { hue: 199, key: "teal" },
] as const;

const VNU_UET_LOGO_URL = "https://2489013871.e.cdneverest.net/uet.edu.vn/2017/02/cropped-logo2_new-1-180x180.png";
const VNU_LOGO_URL = "https://raw.githubusercontent.com/gawgua/vnu-dashboard/master/public/vnu_logo.png";

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

const weekdays = [
  { value: 1, key: "mon" },
  { value: 2, key: "tue" },
  { value: 3, key: "wed" },
  { value: 4, key: "thu" },
  { value: 5, key: "fri" },
  { value: 6, key: "sat" },
  { value: 7, key: "sun" },
] as const;

const periodBlocks = [
  { start: 1, end: 3, label: "07:00 - 09:40" },
  { start: 4, end: 6, label: "09:50 - 12:30" },
  { start: 7, end: 9, label: "13:30 - 16:10" },
  { start: 10, end: 12, label: "16:20 - 19:00" },
] as const;

type HyeboardState = ReturnType<typeof useHyeboardState>;
const HyeboardContext = createContext<HyeboardState | null>(null);

function useHyeboard() {
  const state = useContext(HyeboardContext);
  if (!state) throw new Error("useHyeboard must be used inside HyeboardProvider");
  return state;
}

function HyeboardProvider({ children }: { children: ReactNode }) {
  return <HyeboardContext.Provider value={useHyeboardState()}>{children}</HyeboardContext.Provider>;
}

function stored<T extends string>(key: string, fallback: T): T {
  return (localStorage.getItem(key) as T | null) ?? fallback;
}

const RELOGIN_KEYS = {
  uetCanvasToken: "hyeboard.relogin.uet.canvasToken",
  vnuUsername: "hyeboard.relogin.vnu.username",
  vnuPassword: "hyeboard.relogin.vnu.password",
} as const;

function sessionStored(key: string): string {
  return sessionStorage.getItem(key) ?? "";
}

function setSessionStored(key: string, value: string): void {
  if (value) sessionStorage.setItem(key, value);
  else sessionStorage.removeItem(key);
}

function clearReloginSecrets(): void {
  for (const key of Object.values(RELOGIN_KEYS)) sessionStorage.removeItem(key);
}

const THEME_OVERRIDE_PROPS = ["--primary", "--primary-foreground", "--accent", "--accent-foreground", "--ring", "--sidebar"] as const;

function applyAccentHue(hue: number, dark: boolean): void {
  const root = document.documentElement.style;
  root.setProperty("--primary", `${hue} 88% ${dark ? 68 : 28}%`);
  root.setProperty("--primary-foreground", dark ? `${hue} 45% 10%` : "0 0% 100%");
  root.setProperty("--accent", dark ? `${hue} 45% 15%` : `${hue} 55% 96%`);
  root.setProperty("--accent-foreground", dark ? `${hue} 85% 78%` : `${hue} 80% 26%`);
  root.setProperty("--ring", dark ? `${hue} 85% 68%` : `${hue} 70% 40%`);
  root.setProperty("--sidebar", dark ? `${hue} 30% 7%` : `${hue} 35% 99%`);
}

function clearAccentOverride(): void {
  const root = document.documentElement.style;
  for (const prop of THEME_OVERRIDE_PROPS) root.removeProperty(prop);
}

function useHyeboardState() {
  const [universityId, setUniversityId] = useState<string>(() => stored("hyeboard.universityId", "uet"));
  const [palette, setPalette] = useState<Palette>(() => stored("hyeboard.palette", "uet"));
  const [mode, setMode] = useState<Mode>(() => stored("hyeboard.mode", "light"));
  const [themeHue, setThemeHue] = useState<number>(() => Number(stored("hyeboard.themeHue", "209")) || 209);
  const [termCode, setTermCode] = useState<string | undefined>();
  const [sessionNonce, setSessionNonce] = useState(0);
  const [accounts, setAccounts] = useState<StoredAccount[]>(() => listAccounts());
  const [activeAccountId, setActiveAccountId] = useState<string | null>(() => getActiveAccountId());

  // Fires on every account switch/add/remove (see ACCOUNT_SWITCHED_EVENT in
  // lib/api.ts) - re-syncs universityId/palette to whichever account is now
  // active and refetches all feature data for it.
  useEffect(() => {
    const syncActiveAccount = () => {
      setAccounts(listAccounts());
      setActiveAccountId(getActiveAccountId());
      const account = getActiveAccount();
      if (account) {
        setUniversityId(account.universityId);
        setPalette(account.universityId === "uet" || account.universityId === "vnu" ? (account.universityId as Palette) : "geist");
      }
      setSessionNonce((value) => value + 1);
      void queryClient.invalidateQueries();
    };
    window.addEventListener(ACCOUNT_SWITCHED_EVENT, syncActiveAccount);
    return () => window.removeEventListener(ACCOUNT_SWITCHED_EVENT, syncActiveAccount);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = palette;
    document.documentElement.dataset.mode = mode;
    localStorage.setItem("hyeboard.palette", palette);
    localStorage.setItem("hyeboard.mode", mode);
    localStorage.setItem("hyeboard.universityId", universityId);
    localStorage.setItem("hyeboard.themeHue", String(themeHue));
    if (palette === "uet" || palette === "vnu") applyAccentHue(themeHue, mode === "dark");
    else clearAccentOverride();
  }, [mode, palette, universityId, themeHue]);

  const universities = useQuery({ queryKey: ["universities"], queryFn: api.universities });

  const ensureSession = async () => {
    if (getSessionToken()) return;
    throw new Error("Sign in to continue.");
  };

  const dashboard = useQuery({
    queryKey: ["dashboard", universityId, termCode, sessionNonce],
    queryFn: async () => {
      await ensureSession();
      return api.dashboard(universityId, termCode);
    },
  });

  useEffect(() => {
    if (!termCode && dashboard.data?.currentTerm?.code) {
      setTermCode(dashboard.data.currentTerm.code);
    }
  }, [dashboard.data, termCode]);

  const selectUniversity = (nextUniversityId: string, options: { clearSession?: boolean } = {}) => {
    if (options.clearSession ?? true) clearSessionToken();
    setSessionNonce((value) => value + 1);
    setUniversityId(nextUniversityId);
    setPalette(nextUniversityId === "uet" || nextUniversityId === "vnu" ? (nextUniversityId as Palette) : "geist");
  };

  const refreshSession = () => {
    setSessionNonce((value) => value + 1);
    void queryClient.invalidateQueries();
  };

  const logout = () => {
    // Best-effort server-side revocation while the Authorization header still carries a
    // valid token - this is what actually invalidates any persisted uetGoogleCredential.
    // api.logout() never throws, so this fire-and-forget call never blocks local sign-out.
    void api.logout(universityId);
    clearReloginSecrets();
    clearSessionToken();
    setSessionNonce((value) => value + 1);
    void queryClient.invalidateQueries();
  };

  return { universityId, selectUniversity, palette, setPalette, mode, setMode, themeHue, setThemeHue, termCode, setTermCode, universities, dashboard, ensureSession, refreshSession, logout, sessionNonce, accounts, activeAccountId, switchToAccount: switchAccount, removeStoredAccount: removeAccount };
}

function useFeatureQuery<T>(name: string, queryFn: () => Promise<T>, options: { enabled?: boolean } = {}) {
  const state = useHyeboard();
  return useQuery({
    queryKey: [name, state.universityId, state.termCode, state.sessionNonce],
    queryFn: async () => {
      await state.ensureSession();
      return queryFn();
    },
    enabled: options.enabled ?? true,
  });
}

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

function universityLogoUrl(universityId: string): string | undefined {
  if (universityId === "uet") return VNU_UET_LOGO_URL;
  if (universityId === "vnu") return VNU_LOGO_URL;
  return undefined;
}

function safeExternalUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
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

function DashboardPage() {
  const { dashboard } = useHyeboard();
  const { t } = useLocale();
  const data = dashboard.data;
  if (dashboard.isLoading) return <DashboardSkeleton />;
  if (dashboard.error) return <QueryErrorPanel error={dashboard.error} />;
  return (
    <div className="space-y-6 animate-page">
      <section className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2"><Badge className="bg-primary/10 text-primary">{data?.currentTerm?.name ?? t.dashboard.currentTerm}</Badge><Badge className="border border-border bg-background text-foreground">{data?.student?.studentCode ?? t.common.demo}</Badge></div>
          <h1 className="text-3xl font-semibold tracking-[-0.03em] md:text-4xl">{t.dashboard.welcomeBack(data?.student?.fullName ?? t.dashboard.student)}</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">{t.dashboard.subtitle}</p>
        </div>
        <Card className="animate-card min-w-64">
          <CardHeader className="pb-2"><CardDescription>{t.dashboard.nextClass}</CardDescription><CardTitle className="text-2xl">{data?.nextClass?.courseCode ?? t.dashboard.allClear}</CardTitle></CardHeader>
          <CardContent><p className="text-sm text-muted-foreground">{data?.nextClass ? (data.nextClass.timeLabel ?? formatDateTime(data.nextClass.startTime)) : t.dashboard.noUpcomingClass}</p></CardContent>
        </Card>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric title={t.dashboard.gpa} value={data?.gpa?.gpa?.toFixed(2) ?? "-"} detail={`${t.grades.cpa} ${data?.gpa?.cpa?.toFixed(2) ?? "-"}`} icon={GraduationCap} tone="accent" />
        <Metric title={t.dashboard.credits} value={String(data?.gpa?.totalAccumulatedCredits ?? "-")} detail={data?.courseCount ? t.dashboard.completedEnrolled(data.courseCount.completed, data.courseCount.inTerm) : t.dashboard.thisTerm(data?.gpa?.totalCredits ?? 0)} icon={BookOpen} />
        <Metric title={t.dashboard.assignments} value={String(data?.assignments?.length ?? 0)} detail={t.dashboard.requireAttention(data?.assignments?.filter((item) => item.status === "missing").length ?? 0)} icon={ClipboardList} />
        <Metric title={t.dashboard.tuition} value={formatCurrency(data?.tuition?.remainingAmount)} detail={t.dashboard.outstandingBalance} icon={WalletCards} />
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <Card className="animate-card">
          <CardHeader><CardTitle>{t.dashboard.todaySchedule}</CardTitle><CardDescription>{t.dashboard.todayScheduleDesc}</CardDescription></CardHeader>
          <CardContent className="divide-y divide-border pt-0">{data?.todaySchedule?.length ? data.todaySchedule.map((item) => <ScheduleItem key={item.id} item={item} />) : <Empty text={t.dashboard.noClassesToday} />}</CardContent>
        </Card>
        <Card className="animate-card">
          <CardHeader><CardTitle>{t.dashboard.assignmentTimeline}</CardTitle><CardDescription>{t.dashboard.assignmentTimelineDesc}</CardDescription></CardHeader>
          <CardContent className="divide-y divide-border pt-0">{data?.assignments?.length ? data.assignments.slice(0, 5).map((item) => <AssignmentItem key={item.id} item={item} />) : <Empty text={t.dashboard.noAssignmentsAttention} />}</CardContent>
        </Card>
      </section>

      <section className="grid gap-4 xl:grid-cols-3">
        <Card className="animate-card xl:col-span-2">
          <CardHeader><CardTitle>{t.dashboard.activeCourses}</CardTitle><CardDescription>{t.dashboard.activeCoursesDesc}</CardDescription></CardHeader>
          <CardContent className="grid gap-3 pt-0 md:grid-cols-2">{data?.courses?.length ? data.courses.map((course) => <CourseCard key={course.id} course={course} />) : <Empty text={t.dashboard.noCoursesYet} />}</CardContent>
        </Card>
        <Card className="animate-card">
          <CardHeader><CardTitle>{t.dashboard.recentNotifications}</CardTitle><CardDescription>{t.dashboard.recentNotificationsDesc}</CardDescription></CardHeader>
          <CardContent className="divide-y divide-border pt-0">{data?.notifications?.length ? data.notifications.map((item) => <FeedItem key={item.id} title={item.title} detail={item.source ?? t.common.university} />) : <Empty text={t.dashboard.noRecentNotifications} />}</CardContent>
        </Card>
      </section>
    </div>
  );
}

function TimetablePage() {
  const state = useHyeboard();
  const { t } = useLocale();
  const [view, setView] = useState<"calendar" | "list">("calendar");
  const query = useFeatureQuery("timetable", () => api.timetable(state.universityId, state.termCode));
  return (
    <FeatureFrame title={t.timetable.title} description={t.timetable.description} query={query}>
      {(items) => items.length ? (
        <div className="space-y-4">
          <ViewToggle value={view} onChange={setView} />
          <div key={view} className="view-panel">{view === "calendar" ? <TimetableCalendar items={items} /> : <TimetableList items={items} />}</div>
        </div>
      ) : <Empty text={t.timetable.noClasses} />}
    </FeatureFrame>
  );
}

function ViewToggle<T extends string>({ value, onChange, options = ["list", "calendar"] as T[] }: { value: T; onChange: (value: T) => void; options?: T[] }) {
  const { t } = useLocale();
  const optionLabel = (option: T) => (option === "list" ? t.common.list : option === "calendar" ? t.common.calendar : option);
  return (
    <div className="flex flex-wrap justify-end gap-2">
      {options.map((option) => <Button key={option} variant={value === option ? "default" : "outline"} size="sm" onClick={() => onChange(option)}>{optionLabel(option)}</Button>)}
    </div>
  );
}

function sessionsForBlock(items: ClassSession[], weekday: number, block: { start: number; end: number }) {
  return items
    .filter((item) => item.weekday === weekday && (item.periodStart ?? 0) >= block.start && (item.periodStart ?? 0) <= block.end)
    .sort((a, b) => (a.periodStart ?? 0) - (b.periodStart ?? 0) || a.courseName.localeCompare(b.courseName));
}

function TimetableCalendar({ items }: { items: ClassSession[] }) {
  const { t } = useLocale();
  return (
      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <div className="min-w-[980px]">
          <div className="grid grid-cols-[8.5rem_repeat(7,minmax(0,1fr))] border-b border-border bg-muted/60 text-xs font-medium text-muted-foreground">
            <div className="px-3 py-3">{t.timetable.periodHeader}</div>
            {weekdays.map((day) => <div key={day.value} className="border-l border-border px-3 py-3 text-center">{t.weekday[day.key]}</div>)}
          </div>
          {periodBlocks.map((block) => (
            <div key={block.start} className="grid min-h-36 grid-cols-[8.5rem_repeat(7,minmax(0,1fr))] border-b border-border last:border-b-0">
              <div className="bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
                <p className="font-semibold text-foreground">{t.timetable.periodRange(block.start, block.end)}</p>
                <p>{block.label}</p>
              </div>
              {weekdays.map((day) => {
                const sessions = sessionsForBlock(items, day.value, block);
                return (
                  <div key={day.value} className="space-y-2 border-l border-border p-2">
                    {sessions.map((item) => <CalendarSessionCard key={item.id} item={item} />)}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
  );
}

function TimetableList({ items }: { items: ClassSession[] }) {
  return <Card><CardContent className="divide-y divide-border p-5">{[...items].sort((a, b) => (a.weekday ?? 0) - (b.weekday ?? 0) || (a.periodStart ?? 0) - (b.periodStart ?? 0)).map((item) => <ScheduleItem key={item.id} item={item} />)}</CardContent></Card>;
}

function CalendarSessionCard({ item }: { item: ClassSession }) {
  const { t } = useLocale();
  return (
    <div className="motion-surface rounded-lg border border-border bg-background p-2 text-xs">
      <p className="line-clamp-2 font-medium text-foreground">{item.courseName}</p>
      <p className="mt-1 text-muted-foreground">{item.courseCode} · {item.type ?? t.timetable.classSession}</p>
      <p className="text-muted-foreground">{item.room ?? t.timetable.roomNotListed}</p>
      {item.instructor ? <p className="truncate text-muted-foreground">{item.instructor}</p> : null}
      {safeExternalUrl(item.url) ? <a className="mt-1 inline-flex items-center gap-1 font-medium text-primary hover:underline" href={safeExternalUrl(item.url)} target="_blank" rel="noreferrer"><ExternalLink size={11} /> {t.timetable.openClassPage}</a> : null}
    </div>
  );
}

function CoursesPage() {
  const state = useHyeboard();
  const { t } = useLocale();
  const query = useFeatureQuery("courses", () => api.courses(state.universityId));
  return <FeatureFrame title={t.courses.title} description={t.courses.description} query={query}>{(items) => <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{items.map((course) => <CourseCard key={course.id} course={course} />)}</div>}</FeatureFrame>;
}

function AssignmentsPage() {
  const state = useHyeboard();
  const { t } = useLocale();
  const query = useFeatureQuery("assignments", () => api.assignments(state.universityId));
  return <FeatureFrame title={t.assignments.title} description={t.assignments.description} query={query}>{(items) => items.length ? <Card><CardContent className="divide-y divide-border p-5">{items.map((item) => <AssignmentItem key={item.id} item={item} />)}</CardContent></Card> : <Empty text={t.assignments.noneDue} />}</FeatureFrame>;
}

function gradeTermKey(grade: Grade, universityId: string, unknownTermLabel: string) {
  const code = grade.termCode ?? unknownTermLabel;
  if (usesUetTermRules(universityId) && /^\d+3$/.test(code)) return `${code.slice(0, -1)}2`;
  return code;
}

function usesUetTermRules(universityId: string) {
  return universityId === "uet" || universityId === "mock";
}

function summarizeGrades(grades: Grade[]) {
  const totalCredits = grades.reduce((sum, grade) => sum + (grade.credits ?? 0), 0);
  const weightedPoint4 = grades.reduce((sum, grade) => sum + ((grade.point4 ?? 0) * (grade.credits ?? 0)), 0);
  const weightedPoint10 = grades.reduce((sum, grade) => sum + ((grade.point10 ?? 0) * (grade.credits ?? 0)), 0);
  return {
    credits: totalCredits,
    point4: totalCredits ? weightedPoint4 / totalCredits : undefined,
    point10: totalCredits ? weightedPoint10 / totalCredits : undefined,
  };
}

type GradeSortKey = "name" | "credits" | "point10" | "point4";
type GradeSortState = { key: GradeSortKey; direction: "asc" | "desc" };

function sortGradeValue(grade: Grade, key: GradeSortKey): string | number {
  if (key === "name") return grade.courseName;
  if (key === "credits") return grade.credits ?? -1;
  if (key === "point10") return grade.point10 ?? -1;
  return grade.point4 ?? -1;
}

function sortGrades(grades: Grade[], sort: GradeSortState) {
  return [...grades].sort((a, b) => {
    const left = sortGradeValue(a, sort.key);
    const right = sortGradeValue(b, sort.key);
    const base = typeof left === "number" && typeof right === "number"
      ? left - right
      : String(left).localeCompare(String(right));
    const ordered = sort.direction === "asc" ? base : -base;
    return ordered || a.courseName.localeCompare(b.courseName);
  });
}

function GradesPage() {
  const state = useHyeboard();
  const { t } = useLocale();
  const [sort, setSort] = useState<GradeSortState>({ key: "name", direction: "asc" });
  const query = useFeatureQuery("grades", () => api.grades(state.universityId));
  const gpa = state.dashboard.data?.gpa;
  return (
    <FeatureFrame title={t.grades.title} description={t.grades.description} query={query}>
      {(items) => {
        const byTerm = items.reduce<Record<string, Grade[]>>((acc, g) => {
          const key = gradeTermKey(g, state.universityId, t.grades.unknownTerm);
          (acc[key] ??= []).push(g);
          return acc;
        }, {});
        return (
          <div className="space-y-6">
            <div className="grid gap-3 md:grid-cols-3">
              <Metric title={t.dashboard.gpa} value={gpa?.gpa?.toFixed(2) ?? "-"} detail={t.grades.gpaDetail} />
              <Metric title={t.grades.cpa} value={gpa?.cpa?.toFixed(2) ?? "-"} detail={state.universityId === "vnu" ? t.grades.cpaDetailVnu : t.grades.cpaDetailOther} />
              <Metric title={t.grades.credits} value={String(gpa?.totalAccumulatedCredits ?? "-")} detail={t.grades.creditsCompleted} />
            </div>
            {Object.entries(byTerm).sort(([a], [b]) => b.localeCompare(a)).map(([term, grades]) => {
              const summary = summarizeGrades(grades);
              const includesSummer = usesUetTermRules(state.universityId) && grades.some((grade) => grade.termCode && grade.termCode !== term && grade.termCode.endsWith("3"));
              const sortedGrades = sortGrades(grades, sort);
              return (
              <div key={term} className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{term}</h2>
                  {includesSummer ? <Badge className="border border-border bg-background text-foreground">{t.grades.includesSummer}</Badge> : null}
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  <Metric title={t.grades.termGpa} value={summary.point4?.toFixed(2) ?? "-"} detail={t.grades.termGpaDetail} />
                  <Metric title={t.grades.average10} value={summary.point10?.toFixed(2) ?? "-"} detail={t.grades.average10Detail} />
                  <Metric title={t.grades.credits} value={String(summary.credits || "-")} detail={t.grades.creditsIncludedDetail} />
                </div>
                <GradeTable grades={sortedGrades} sort={sort} onSortChange={setSort} universityId={state.universityId} />
              </div>
            );})}
          </div>
        );
      }}
    </FeatureFrame>
  );
}

function GradeTable({ grades, sort, onSortChange, universityId }: { grades: Grade[]; sort: GradeSortState; onSortChange: (sort: GradeSortState) => void; universityId: string }) {
  const { t } = useLocale();
  const headers: Array<{ key: GradeSortKey; label: string; align?: "right" }> = [
    { key: "name", label: t.grades.course },
    { key: "credits", label: t.grades.credits, align: "right" },
    { key: "point10", label: t.grades.point10, align: "right" },
    { key: "point4", label: t.grades.point4, align: "right" },
  ];
  const changeSort = (key: GradeSortKey) => {
    const direction = sort.key === key && sort.direction === "asc" ? "desc" : "asc";
    onSortChange({ key, direction });
  };
  if (!grades.length) return <Empty text={t.grades.noGrades} />;
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-muted text-muted-foreground">
          <tr>
            {headers.map((header) => (
              <th
                key={header.key}
                className={cn("px-3 py-2 font-medium", header.align === "right" ? "text-right" : "text-left")}
                aria-sort={sort.key === header.key ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
              >
                <button type="button" onClick={() => changeSort(header.key)} className={cn("inline-flex items-center gap-1 hover:text-foreground", header.align === "right" && "justify-end")}> 
                  {header.label}
                  <span className="text-[10px]">{sort.key === header.key ? (sort.direction === "asc" ? "▲" : "▼") : ""}</span>
                </button>
              </th>
            ))}
            <th className="px-3 py-2 text-left font-medium">{t.grades.note}</th>
          </tr>
        </thead>
        <tbody>
          {grades.map((grade) => (
            <tr key={grade.id} className="table-row-motion border-t border-border">
              <td className="px-3 py-2">{grade.courseName}</td>
              <td className="px-3 py-2 text-right tabular-nums">{grade.credits ?? "-"}</td>
              <td className="px-3 py-2 text-right tabular-nums">{grade.point10 ?? "-"}</td>
              <td className="px-3 py-2 text-right tabular-nums">{grade.point4 ?? "-"}</td>
              <td className="px-3 py-2">{usesUetTermRules(universityId) && grade.termCode?.endsWith("3") ? <Badge className="border border-border bg-background text-foreground">{t.grades.summerTerm}</Badge> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExamsPage() {
  const state = useHyeboard();
  const { t } = useLocale();
  const [view, setView] = useState<"list" | "calendar">("list");
  const [selectedTerm, setSelectedTerm] = useState<string | undefined>(undefined);
  const terms = useQuery({
    queryKey: ["terms", state.universityId, state.sessionNonce],
    queryFn: async () => { await state.ensureSession(); return api.terms(state.universityId); },
  });
  const effectiveTerm = selectedTerm ?? state.termCode;
  const query = useQuery({
    queryKey: ["exams", state.universityId, effectiveTerm, state.sessionNonce],
    queryFn: async () => { await state.ensureSession(); return api.exams(state.universityId, effectiveTerm); },
  });
  return (
    <FeatureFrame title={t.exams.title} description={t.exams.description} query={query}>
      {(items) => (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            {terms.data?.length ? (
              <Select value={effectiveTerm ?? ""} onValueChange={(value) => setSelectedTerm(value)}>
                <SelectTrigger className="h-9 w-[220px]" aria-label={t.exams.term}><SelectValue placeholder={t.exams.term} /></SelectTrigger>
                <SelectContent>
                  {terms.data.map((term) => <SelectItem key={term.code} value={term.code}>{term.name}</SelectItem>)}
                </SelectContent>
              </Select>
            ) : <span />}
            <div className="flex gap-2">
              <Button variant={view === "list" ? "default" : "outline"} size="sm" onClick={() => setView("list")}>{t.common.list}</Button>
              <Button variant={view === "calendar" ? "default" : "outline"} size="sm" onClick={() => setView("calendar")}>{t.common.calendar}</Button>
            </div>
          </div>
          <div key={view} className="view-panel">{items.length ? (view === "list" ? <ExamList items={items} /> : <ExamCalendar items={items} />) : <Empty text={t.exams.noExams} />}</div>
        </div>
      )}
    </FeatureFrame>
  );
}

function examDateKey(exam: ExamSession) {
  return (exam.startTime ?? exam.examDate).slice(0, 10);
}

function examTime(exam: ExamSession) {
  return exam.startTime ? new Date(exam.startTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "-";
}

function formatDateOnly(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

function ExamList({ items }: { items: ExamSession[] }) {
  const { t } = useLocale();
  const sorted = [...items].sort((a, b) => (a.startTime ?? a.examDate).localeCompare(b.startTime ?? b.examDate));
  return <DataTable headers={t.exams.headers} rows={sorted.map((exam) => [exam.courseName, exam.examType ?? t.exams.examType, exam.examMethod ?? "-", formatDateOnly(exam.examDate), examTime(exam), exam.examSession ? String(exam.examSession) : "-", exam.room ?? "-", exam.examNumber ?? "-"])} />;
}

function ExamCalendar({ items }: { items: ExamSession[] }) {
  const { t } = useLocale();
  const groups = items.reduce<Record<string, ExamSession[]>>((acc, exam) => {
    const key = examDateKey(exam);
    (acc[key] ??= []).push(exam);
    return acc;
  }, {});
  const days = Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {days.map(([day, exams]) => (
        <Card key={day}>
          <CardHeader className="pb-3"><CardTitle className="text-base">{formatDateOnly(day)}</CardTitle><CardDescription>{t.exams.scheduledExams(exams.length)}</CardDescription></CardHeader>
          <CardContent className="divide-y divide-border pt-0">
            {exams.sort((a, b) => (a.startTime ?? "").localeCompare(b.startTime ?? "")).map((exam) => (
              <div key={exam.id} className="list-row">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{exam.courseName}</p>
                  <p className="truncate text-xs text-muted-foreground">{exam.courseCode} · {exam.examMethod ?? exam.examType ?? t.exams.examType} · {exam.room ?? t.timetable.roomNotListed}</p>
                </div>
                <Badge className="shrink-0 border border-border bg-background font-normal text-foreground">{examTime(exam)}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function TuitionPage() {
  const state = useHyeboard();
  const { t } = useLocale();
  const query = useFeatureQuery("tuition", () => api.tuition(state.universityId));
  return (
    <FeatureFrame title={t.tuition.title} description={t.tuition.description} query={query}>
      {(tuition) => {
        const byTerm = tuition.bills.reduce<Record<string, Bill[]>>((acc, b) => {
          const key = b.termCode ?? (b.status === "credit" ? t.tuition.creditsAdjustments : t.tuition.other);
          (acc[key] ??= []).push(b);
          return acc;
        }, {});
        return (
          <div className="space-y-6">
            <div className="grid gap-3 md:grid-cols-3">
              <Metric title={t.tuition.total} value={formatCurrency(tuition.totalAmount)} detail={t.tuition.chargesPosted} />
              <Metric title={t.tuition.paid} value={formatCurrency(tuition.paidAmount)} detail={t.tuition.paymentsReceived} />
              <Metric title={t.tuition.remaining} value={formatCurrency(tuition.remainingAmount)} detail={t.tuition.amountDue} />
            </div>
            {Object.entries(byTerm).sort(([a], [b]) => b.localeCompare(a)).map(([term, bills]) => (
              <div key={term} className="space-y-2">
                <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{term}</h2>
                <DataTable headers={t.tuition.headers} rows={bills.map((b) => [b.title, b.status ?? "-", b.paidAt ? formatDateTime(b.paidAt) : "-", formatCurrency(b.totalAmount), formatCurrency(b.paidAmount), formatCurrency(b.remainingAmount)])} />
              </div>
            ))}
          </div>
        );
      }}
    </FeatureFrame>
  );
}

function DocumentsPage() {
  const state = useHyeboard();
  const { t } = useLocale();
  const capabilities = state.universities.data?.find((u) => u.id === state.universityId)?.capabilities;
  const showDocuments = capabilities?.documents ?? true;
  const showNews = capabilities?.news ?? true;
  const showRequests = capabilities?.requests ?? true;
  const [docSearch, setDocSearch] = useState("");

  const docs = useFeatureQuery("documents", () => api.documents(state.universityId), { enabled: showDocuments });
  const news = useFeatureQuery("news", () => api.news(state.universityId), { enabled: showNews });
  const requests = useFeatureQuery("requests", () => api.requests(state.universityId), { enabled: showRequests });
  const filteredDocs = docSearch.trim()
    ? docs.data?.filter((item) => `${item.name} ${item.courseCode ?? ""}`.toLowerCase().includes(docSearch.trim().toLowerCase()))
    : docs.data;

  return (
    <div className="space-y-4">
      <FeatureHeader title={t.documents.title} description={t.documents.description} />
      <div className="grid gap-4 xl:grid-cols-2">
        {showDocuments ? (
          <div className="space-y-2">
            <Input value={docSearch} onChange={(event) => setDocSearch(event.target.value)} placeholder={t.documents.searchPlaceholder} aria-label={t.documents.searchAriaLabel} />
            <MiniPanel title={t.documents.documentsTitle} query={{ ...docs, data: filteredDocs }}>{(items) => items.map((item) => <DocumentRow key={item.id} item={item} />)}</MiniPanel>
          </div>
        ) : <UnsupportedPanel title={t.documents.documentsTitle} />}
        {showNews ? <MiniPanel title={t.documents.news} query={news}>{(items) => items.map((item) => <FeedItem key={item.id} title={item.title} detail={item.category ?? item.date ?? t.common.news} url={item.url} />)}</MiniPanel> : <UnsupportedPanel title={t.documents.news} />}
        {showRequests ? <MiniPanel title={t.documents.requests} query={requests}>{(items) => items.map((item) => <RequestRow key={item.id} item={item} />)}</MiniPanel> : <UnsupportedPanel title={t.documents.requests} />}
      </div>
    </div>
  );
}

function TrainingPointsPage() {
  const state = useHyeboard();
  const { t } = useLocale();
  const query = useFeatureQuery("training-points", () => api.trainingPoints(state.universityId));
  return (
    <FeatureFrame title={t.trainingPoints.title} description={t.trainingPoints.description} query={query}>
      {(items) => items.length ? <Card><CardContent className="divide-y divide-border p-5">{items.map((item) => <TrainingPointRow key={item.id} item={item} />)}</CardContent></Card> : <Empty text={t.trainingPoints.none} />}
    </FeatureFrame>
  );
}

function UnsupportedPanel({ title }: { title: string }) {
  const { t } = useLocale();
  return (
    <Card className="animate-card">
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent><p className="text-sm text-muted-foreground">{t.documents.notSupported}</p></CardContent>
    </Card>
  );
}

const AUTOMATION_FAILURE_CODES = new Set(["GOOGLE_CHALLENGE_REQUIRED", "GOOGLE_2FA_REQUIRED", "GOOGLE_AUTOMATION_BLOCKED", "GOOGLE_SIGNIN_FAILURE", "GOOGLE_LOGIN_RATE_LIMITED", "GOOGLE_AUTOMATION_TIMEOUT", "GOOGLE_KEYCLOAK_REDIRECT_MISSING"]);

// Maps known error codes to plain-language, actionable text. The server now
// includes real technical detail in some error messages (e.g.
// GOOGLE_SIGNIN_FAILURE's message embeds the raw exception text — a
// TimeoutError stack summary, a Puppeteer/CDP error, etc. — for logs/
// diagnosis, see google-login-automation.ts) which is exactly the kind of
// "system error" that shouldn't be shown to the user directly. This is the
// translation layer: known codes get a clear, friendly message; anything
// unrecognized falls back to the caller-supplied default rather than
// leaking a raw stack/exception string into a toast.
function humanizeUetLoginError(code: string | undefined, fallback: string, t: Translations): string {
  switch (code) {
    case "STUDENTHUB_MAINTENANCE":
      return t.loginErrors.studenthubMaintenance;
    case "GOOGLE_2FA_REQUIRED":
      return t.loginErrors.google2fa;
    case "GOOGLE_CHALLENGE_REQUIRED":
      return t.loginErrors.googleChallenge;
    case "GOOGLE_AUTOMATION_BLOCKED":
      return t.loginErrors.googleBlocked;
    case "GOOGLE_SIGNIN_FAILURE":
      return t.loginErrors.googleSigninFailure;
    case "GOOGLE_AUTOMATION_TIMEOUT":
      return t.loginErrors.googleTimeout;
    case "GOOGLE_KEYCLOAK_REDIRECT_MISSING":
      return t.loginErrors.googleKeycloakMissing;
    case "GOOGLE_LOGIN_RATE_LIMITED":
      return t.loginErrors.googleRateLimited;
    case "INVALID_STUDENTHUB_CREDENTIAL":
      return t.loginErrors.invalidCredential;
    case "MISSING_UPSTREAM_CREDENTIAL":
      return t.loginErrors.missingCredential;
    case "SERVER_CONFIG_ERROR":
      return t.loginErrors.serverConfigError;
    default:
      return fallback;
  }
}

function LoginPage() {
  const state = useHyeboard();
  const { t, locale, setLocale } = useLocale();
  const navigate = useNavigate();
  const [selectedUniversity, setSelectedUniversity] = useState<"mock" | "uet" | "vnu">(() => (getSessionToken() && (state.universityId === "mock" || state.universityId === "vnu") ? (state.universityId as "mock" | "vnu") : "uet"));
  const [studenthubToken, setStudenthubToken] = useState("");
  const [studenthubCookie, setStudenthubCookie] = useState("");
  const [canvasToken, setCanvasToken] = useState(() => sessionStored(RELOGIN_KEYS.uetCanvasToken));
  const [canvasCookie, setCanvasCookie] = useState("");
  const [canvasCsrfToken, setCanvasCsrfToken] = useState("");
  const [vnuUsername, setVnuUsername] = useState(() => sessionStored(RELOGIN_KEYS.vnuUsername));
  const [vnuPassword, setVnuPassword] = useState(() => sessionStored(RELOGIN_KEYS.vnuPassword));
  const [status, setStatus] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [uetGoogleEmail, setUetGoogleEmail] = useState("");
  const [uetGooglePassword, setUetGooglePassword] = useState("");
  const [showManualFallback, setShowManualFallback] = useState(false);
  // Parent/guardian accounts use a "PH..." account code and log in with a
  // direct StudentHub username/password instead of VNU Google SSO — same
  // two input boxes below, detected purely by this prefix (see
  // importUetGoogleSession and har-notes.md's "parent/guardian account"
  // section).
  const isUetParentLogin = /^ph/i.test(uetGoogleEmail.trim());
  // Set only while a parent/guardian direct-login is waiting on a CAPTCHA
  // the server's own OCR couldn't confidently solve (see
  // api.importUetGoogleSession's onCaptchaNeeded and app.ts's
  // "captcha_required" SSE event). The stream aborts and clears this prompt
  // if the relay fails or disconnects before the user submits an answer.
  const [captchaChallenge, setCaptchaChallenge] = useState<{ image: string; resolve: (answer: string) => void }>();
  const [captchaAnswer, setCaptchaAnswer] = useState("");
  const uetLoginControllerRef = useRef<AbortController | null>(null);

  // The global palette can be left over from a previous session (e.g. still
  // "geist" after signing out of a mock session). Force it to match whichever
  // school is selected on this screen so the login page never renders with
  // the wrong accent color.
  useEffect(() => {
    state.setPalette(selectedUniversity === "uet" || selectedUniversity === "vnu" ? selectedUniversity : "geist");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => {
    const active = uetLoginControllerRef.current;
    uetLoginControllerRef.current = null;
    active?.abort();
  }, []);

  const useDemo = async () => {
    setBusy(true);
    setStatus(t.login.preparingDemo);
    try {
      await api.importSession("mock", {});
      state.selectUniversity("mock", { clearSession: false });
      state.refreshSession();
      setStatus(t.login.demoReady);
      await navigate({ to: "/" });
    } catch (error) {
      const message = error instanceof Error ? error.message : t.login.demoFailed;
      setStatus(undefined);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  const chooseUniversity = (universityId: "mock" | "uet" | "vnu") => {
    setSelectedUniversity(universityId);
    state.setPalette(universityId === "uet" || universityId === "vnu" ? universityId : "geist");
    setStatus(undefined);
  };

  const importUetSession = async () => {
    setBusy(true);
    setStatus(t.login.securingSession);
    try {
      await api.importSession("uet", {
        studenthubToken: studenthubToken || undefined,
        studenthubCookie: studenthubCookie || undefined,
        canvasToken: canvasToken || undefined,
        canvasCookie: canvasCookie || undefined,
        canvasCsrfToken: canvasCsrfToken || undefined,
      });
      state.selectUniversity("uet", { clearSession: false });
      state.refreshSession();
      setStatus(t.login.sessionReadyOpening);
      await navigate({ to: "/" });
    } catch (error) {
      const message = error instanceof Error ? error.message : t.login.sessionImportFailed;
      setStatus(undefined);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  const importUetGoogleSession = async () => {
    uetLoginControllerRef.current?.abort();
    const loginController = new AbortController();
    uetLoginControllerRef.current = loginController;
    setBusy(true);
    // The login box only ever needs the student code (MSV) or a
    // parent/guardian account code — the server always derives the
    // @vnu.edu.vn address itself for student logins and ignores any other
    // domain a caller might supply, so no client-side email construction
    // happens here (see MISSING_UPSTREAM_CREDENTIAL / adapter.ts normalization).
    const studentCodeInput = uetGoogleEmail.trim();
    // Parent/guardian accounts ("PH..." prefix) use StudentHub's direct
    // CAPTCHA and login APIs instead of Google OAuth. They stay on the SSE
    // path so onCaptchaNeeded can relay an image when server-side OCR fails.
    const isParentLogin = /^ph/i.test(studentCodeInput);
    setStatus(isParentLogin ? t.login.signingInParent : t.login.signingInGoogle);
    try {
      // Google automation can take 90s+; parent login may pause for a human
      // CAPTCHA answer. Both use the same SSE transport.
      await api.importUetGoogleSession(
        { uetGoogleEmail: studentCodeInput, uetGooglePassword },
        (message) => setStatus(message),
        (imageDataUrl, signal) => new Promise<string>((resolve, reject) => {
          const challenge = {
            image: imageDataUrl,
            resolve: (answer: string) => {
              signal.removeEventListener("abort", onAbort);
              setCaptchaChallenge((current) => current === challenge ? undefined : current);
              setCaptchaAnswer("");
              resolve(answer);
            },
          };
          const onAbort = () => {
            setCaptchaChallenge((current) => current === challenge ? undefined : current);
            setCaptchaAnswer("");
            reject(signal.reason ?? new DOMException(t.login.verificationCancelled, "AbortError"));
          };
          if (signal.aborted) onAbort();
          else {
            signal.addEventListener("abort", onAbort, { once: true });
            setCaptchaChallenge(challenge);
          }
        }),
        loginController.signal,
      );
      state.selectUniversity("uet", { clearSession: false });
      state.refreshSession();
      setStatus(t.login.sessionReadyOpening);
      await navigate({ to: "/" });
    } catch (error) {
      if (loginController.signal.aborted) return;
      const code = error instanceof ApiError ? error.code : undefined;
      if (isParentLogin) {
        toast.error(humanizeUetLoginError(code, error instanceof Error ? error.message : t.login.signInFailedGeneric, t));
      } else {
        if (code && AUTOMATION_FAILURE_CODES.has(code)) setShowManualFallback(true);
        toast.error(humanizeUetLoginError(code, error instanceof Error ? error.message : t.login.googleSignInIncomplete, t));
      }
      setStatus(undefined);
    } finally {
      if (uetLoginControllerRef.current === loginController) {
        uetLoginControllerRef.current = null;
        setBusy(false);
      }
    }
  };

  const submitCaptchaAnswer = () => {
    if (!captchaChallenge) return;
    const answer = captchaAnswer.trim();
    if (!answer) return;
    captchaChallenge.resolve(answer);
  };

  const importVnuSession = async () => {
    setBusy(true);
    setStatus(t.login.securingSession);
    try {
      await api.importSession("vnu", { vnuUsername: vnuUsername || undefined, vnuPassword: vnuPassword || undefined });
      state.selectUniversity("vnu", { clearSession: false });
      state.refreshSession();
      setStatus(t.login.sessionReadyOpening);
      await navigate({ to: "/" });
    } catch (error) {
      const message = error instanceof Error ? error.message : t.login.sessionImportFailed;
      setStatus(undefined);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  const submitOnEnter = (event: React.KeyboardEvent<HTMLInputElement>, submit: () => Promise<void>) => {
    if (event.key !== "Enter" || busy) return;
    event.preventDefault();
    void submit();
  };

  return (
    <main className="login-screen min-h-screen bg-background px-4 py-10 text-foreground">
      <div className="mx-auto flex w-full max-w-md justify-end">
        <Select value={locale} onValueChange={(value) => setLocale(value as Locale)}>
          <SelectTrigger className="h-8 w-[130px] text-xs" aria-label={t.settings.language}><SelectValue /></SelectTrigger>
          <SelectContent>
            {LOCALES.map((option) => (
              <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="animate-page mx-auto flex min-h-[calc(100vh-8rem)] w-full max-w-md flex-col justify-center">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className={cn("mb-4 grid h-16 w-16 place-items-center rounded-xl shadow-sm", universityLogoUrl(selectedUniversity) ? "border border-border bg-background p-2" : "bg-primary text-primary-foreground")}>
            {universityLogoUrl(selectedUniversity)
              ? <img className="h-full w-full object-contain" src={universityLogoUrl(selectedUniversity)} alt="" draggable={false} />
              : <GraduationCap size={21} aria-hidden="true" />}
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">{t.login.signInTitle}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t.login.signInSubtitle}</p>
        </div>

        <Card className="login-card animate-card">
          <CardHeader className="space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle>{selectedUniversity === "uet" ? t.login.connectUniversityAccount : selectedUniversity === "vnu" ? t.login.connectVnuAccount : t.login.useDemoData}</CardTitle>
                {selectedUniversity === "uet" && showManualFallback ? (
                  <CardDescription>{t.login.importPortalDesc}</CardDescription>
                ) : selectedUniversity === "uet" && isUetParentLogin ? (
                  <CardDescription>{t.login.parentLoginDesc}</CardDescription>
                ) : selectedUniversity === "uet" ? (
                  <CardDescription>{t.login.googleLoginDesc}</CardDescription>
                ) : selectedUniversity === "vnu" ? (
                  <CardDescription>{t.login.vnuLoginDesc}</CardDescription>
                ) : selectedUniversity === "mock" ? (
                  <CardDescription>{t.login.demoDesc}</CardDescription>
                ) : null}
              </div>
              <Select value={selectedUniversity} onValueChange={(value) => chooseUniversity(value as "mock" | "uet" | "vnu")}>
                <SelectTrigger className="h-9 w-[128px] shrink-0" aria-label={t.login.schoolLabel}><SelectValue placeholder={t.login.schoolLabel} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="uet">{t.login.uetOption}</SelectItem>
                  <SelectItem value="vnu">{t.login.vnuOption}</SelectItem>
                  <SelectItem value="mock">{t.login.mockOption}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {selectedUniversity === "uet" ? (
              <>
                <Input type="text" autoComplete="username" placeholder={t.login.studentCodePlaceholder} value={uetGoogleEmail} onChange={(event) => setUetGoogleEmail(event.target.value)} onKeyDown={(event) => submitOnEnter(event, importUetGoogleSession)} />
                <Input type="password" autoComplete="current-password" placeholder={isUetParentLogin ? t.login.passwordPlaceholder : t.login.googlePasswordPlaceholder} value={uetGooglePassword} onChange={(event) => setUetGooglePassword(event.target.value)} onKeyDown={(event) => submitOnEnter(event, importUetGoogleSession)} />
                <Button onClick={importUetGoogleSession} disabled={busy} className="w-full">{busy ? <Loader2 size={16} className="animate-spin" /> : null}{isUetParentLogin ? t.login.signIn : t.login.signInWithGoogle}</Button>

                {!showManualFallback ? (
                  <button type="button" className="w-full text-center text-xs text-muted-foreground underline underline-offset-2" onClick={() => setShowManualFallback(true)}>
                    {t.login.troubleSigningIn}
                  </button>
                ) : (
                  <>
                    <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
                      <p className="font-medium text-foreground">{t.login.connectPortalTitle}</p>
                      <p className="mt-1">{t.login.connectPortalDesc}</p>
                      <ol className="mt-2 list-decimal space-y-1 pl-4">
                        <li>{t.login.step1PortalOpen}</li>
                        <li>{t.login.step2Console}</li>
                        <li>{t.login.step3RunPrefix} <code className="select-all rounded bg-background px-1 text-foreground">copy(localStorage.getItem(&apos;accessToken&apos;))</code>.</li>
                        <li>{t.login.step4Paste}</li>
                      </ol>
                      <p className="mt-2 text-foreground">{t.login.tokensExpireNote}</p>
                    </div>
                    <Button className="w-full" type="button" variant="secondary" onClick={() => window.open("https://studenthub.uet.edu.vn", "_blank", "noopener,noreferrer")}><ExternalLink size={16} /> {t.login.openUniversityPortal}</Button>
                    <Input type="password" autoComplete="off" placeholder={t.login.portalTokenPlaceholder} value={studenthubToken} onChange={(event) => setStudenthubToken(event.target.value)} onKeyDown={(event) => submitOnEnter(event, importUetSession)} />
                    <Button className="w-full" type="button" variant="secondary" onClick={() => window.open("https://portal.uet.vnu.edu.vn", "_blank", "noopener,noreferrer")}><ExternalLink size={16} /> {t.login.openLearningPlatform}</Button>
                    <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
                      <p className="font-medium text-foreground">{t.login.optionalConnectLearning}</p>
                      <p className="mt-1">{t.login.learningPlatformDesc}</p>
                      <ol className="mt-2 list-decimal space-y-1 pl-4">
                        <li>{t.login.step1Learning}</li>
                        <li>{t.login.step2LearningPrefix} <strong className="text-foreground">{t.login.accountLabel}</strong> {t.login.step2LearningMid} <strong className="text-foreground">{t.login.settingsLabel}</strong>.</li>
                        <li>{t.login.step3LearningPrefix} <strong className="text-foreground">{t.login.approvedIntegrations}</strong> {t.login.step3LearningMid} <strong className="text-foreground">{t.login.newAccessToken}</strong> {t.login.step3LearningSuffix}</li>
                        <li>{t.login.step4Learning}</li>
                      </ol>
                    </div>
                    <Input type="password" autoComplete="off" placeholder={t.login.learningTokenPlaceholder} value={canvasToken} onChange={(event) => { setCanvasToken(event.target.value); setSessionStored(RELOGIN_KEYS.uetCanvasToken, event.target.value); }} onKeyDown={(event) => submitOnEnter(event, importUetSession)} />
                    <details className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
                      <summary className="cursor-pointer font-medium text-foreground">{t.login.advancedCookieOptions}</summary>
                      <div className="mt-3 space-y-3">
                        <Input type="password" autoComplete="off" placeholder={t.login.portalCookiePlaceholder} value={studenthubCookie} onChange={(event) => setStudenthubCookie(event.target.value)} onKeyDown={(event) => submitOnEnter(event, importUetSession)} />
                        <Input type="password" autoComplete="off" placeholder={t.login.learningCookiePlaceholder} value={canvasCookie} onChange={(event) => setCanvasCookie(event.target.value)} onKeyDown={(event) => submitOnEnter(event, importUetSession)} />
                        <Input type="password" autoComplete="off" placeholder={t.login.learningCsrfPlaceholder} value={canvasCsrfToken} onChange={(event) => setCanvasCsrfToken(event.target.value)} onKeyDown={(event) => submitOnEnter(event, importUetSession)} />
                      </div>
                    </details>
                    <Button onClick={importUetSession} disabled={busy} variant="outline" className="w-full">{busy ? <Loader2 size={16} className="animate-spin" /> : null}{t.login.importUniversitySession}</Button>
                  </>
                )}
              </>
            ) : selectedUniversity === "vnu" ? (
              <>
                <Input placeholder={t.login.studentUsernamePlaceholder} autoComplete="username" value={vnuUsername} onChange={(event) => { setVnuUsername(event.target.value); setSessionStored(RELOGIN_KEYS.vnuUsername, event.target.value); }} />
                <Input type="password" autoComplete="current-password" placeholder={t.login.passwordPlaceholder} value={vnuPassword} onChange={(event) => { setVnuPassword(event.target.value); setSessionStored(RELOGIN_KEYS.vnuPassword, event.target.value); }} onKeyDown={(event) => submitOnEnter(event, importVnuSession)} />
                <Button onClick={importVnuSession} disabled={busy} variant="outline" className="w-full">{busy ? <Loader2 size={16} className="animate-spin" /> : null}{t.login.importUniversitySession}</Button>
              </>
            ) : (
              <>
                <Button onClick={useDemo} disabled={busy} className="w-full">{busy ? <Loader2 size={16} className="animate-spin" /> : null}{t.login.openDemoWorkspace}</Button>
              </>
            )}
            {status ? <p className="text-sm text-muted-foreground">{status}</p> : null}
          </CardContent>
        </Card>
      </div>
      {captchaChallenge ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <Card className="w-full max-w-sm">
            <CardHeader>
              <CardTitle>{t.login.enterVerificationCode}</CardTitle>
              <CardDescription>{t.login.verificationCodeDesc}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <img src={captchaChallenge.image} alt={t.login.verificationImageAlt} className="w-full rounded-lg border border-border" />
              <Input
                autoFocus
                value={captchaAnswer}
                onChange={(event) => setCaptchaAnswer(event.target.value)}
                placeholder={t.login.enterCodeShown}
                onKeyDown={(event) => { if (event.key === "Enter") submitCaptchaAnswer(); }}
              />
              <Button onClick={submitCaptchaAnswer} disabled={!captchaAnswer.trim()} className="w-full">{t.common.submit}</Button>
            </CardContent>
          </Card>
        </div>
      ) : null}
    </main>
  );
}

function SettingsPage() {
  const state = useHyeboard();
  const { t, locale, setLocale } = useLocale();
  const navigate = useNavigate();
  const data = state.dashboard.data;
  const signOut = () => { state.logout(); void navigate({ to: "/login" }); };
  return (
    <div className="space-y-6">
      <FeatureHeader title={t.settings.title} description={t.settings.description} />
      <div className="grid max-w-lg gap-4">
        <Card>
          <CardHeader>
            <CardTitle>{t.settings.display}</CardTitle>
            <CardDescription>{t.settings.displayDesc}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm">{t.settings.colorMode}</span>
              <Button variant="outline" size="sm" onClick={() => state.setMode(state.mode === "dark" ? "light" : "dark")} aria-label={t.common.toggleLightDark}>
                {state.mode === "dark" ? <><Sun size={14} className="mr-1" />{t.common.light}</> : <><Moon size={14} className="mr-1" />{t.common.dark}</>}
              </Button>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm">{t.settings.themeStyle}</span>
              <div className="flex rounded-lg border border-border p-1" role="group" aria-label={t.settings.themeStyle}>
                <Button type="button" variant={state.palette === "geist" ? "default" : "ghost"} size="sm" onClick={() => state.setPalette("geist")}>{t.settings.neutral}</Button>
                <Button type="button" variant={state.palette !== "geist" ? "default" : "ghost"} size="sm" onClick={() => state.setPalette(state.universityId === "uet" || state.universityId === "vnu" ? state.universityId : "uet")}>{t.settings.colored}</Button>
              </div>
            </div>
            {state.palette === "uet" || state.palette === "vnu" ? (
              <div className="flex items-center justify-between">
                <span className="text-sm">{t.settings.themeColor}</span>
                <div className="flex items-center gap-1.5" role="group" aria-label={t.settings.themeColor}>
                  {THEME_HUE_PRESETS.map((preset) => (
                    <button
                      key={preset.hue}
                      type="button"
                      title={t.colors[preset.key]}
                      aria-label={t.colors[preset.key]}
                      aria-pressed={state.themeHue === preset.hue}
                      onClick={() => state.setThemeHue(preset.hue)}
                      className={cn(
                        "h-6 w-6 shrink-0 rounded-full border transition-transform",
                        state.themeHue === preset.hue ? "border-foreground scale-110" : "border-border hover:scale-105",
                      )}
                      style={{ background: `hsl(${preset.hue} 80% 45%)` }}
                    />
                  ))}
                </div>
              </div>
            ) : null}
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm">{t.settings.language}</span>
              <Select value={locale} onValueChange={(value) => setLocale(value as Locale)}>
                <SelectTrigger className="h-9 w-[160px]" aria-label={t.settings.language}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {LOCALES.map((option) => <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t.settings.account}</CardTitle>
            <CardDescription>{data?.student?.fullName ? t.settings.signedInAs(data.student.fullName, data.student.studentCode) : t.settings.sessionUnavailable}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="destructive" className="w-full" onClick={signOut}><LogOut size={15} className="mr-2" />{t.settings.signOut}</Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function FeatureFrame<T>({ title, description, query, children }: { title: string; description: string; query: { data?: T; error: Error | null; isLoading: boolean }; children: (data: T) => ReactNode }) {
  const { t } = useLocale();
  if (query.isLoading) return <PageSkeleton />;
  if (query.error) return <QueryErrorPanel error={query.error} />;
  return <div className="animate-page space-y-4"><FeatureHeader title={title} description={description} />{query.data ? children(query.data) : <Empty text={t.common.noData} />}</div>;
}

function FeatureHeader({ title, description }: { title: string; description: string }) {
  return <div><h1 className="text-2xl font-semibold tracking-tight md:text-3xl">{title}</h1><p className="mt-1 text-sm text-muted-foreground">{description}</p></div>;
}

function MiniPanel<T>({ title, query, children }: { title: string; query: { data?: T[]; error: Error | null; isLoading: boolean }; children: (data: T[]) => ReactNode }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(true);
  return (
    <Card className="animate-card">
      <CardHeader className="pb-3">
        <button type="button" className="flex w-full items-center justify-between gap-3 text-left" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-label={t.documents.toggle(title)}>
          <CardTitle className="text-base">{title}</CardTitle>
          <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
        </button>
      </CardHeader>
      <div className="collapsible-panel" data-open={open}>
        <div>
          <CardContent className="divide-y divide-border pt-0">{query.isLoading ? <Skeleton className="h-24" /> : query.error ? <p className="py-2 text-sm text-muted-foreground">{query.error.message}</p> : query.data?.length ? children(query.data) : <Empty text={t.common.noItemsYet} />}</CardContent>
        </div>
      </div>
    </Card>
  );
}

function Metric({ title, value, detail, icon: Icon, tone = "default" }: { title: string; value: string; detail: string; icon?: typeof LayoutDashboard; tone?: "default" | "accent" }) {
  return (
    <div className={cn("stat-card", tone === "accent" && "accent")}>
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">{title}</p>
        {Icon ? <Icon className={cn("h-4 w-4", tone === "accent" ? "text-primary" : "text-muted-foreground")} /> : null}
      </div>
      <p className={cn("mt-2 text-3xl font-semibold tracking-tight", tone === "accent" && "text-primary")}>{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function ScheduleItem({ item }: { item: ClassSession }) {
  const { t } = useLocale();
  const label = item.timeLabel ?? (item.periodStart != null
    ? `${t.timetable.periodHeader} ${item.periodStart}${item.periodEnd && item.periodEnd !== item.periodStart ? `–${item.periodEnd}` : ""}`
    : formatDateTime(item.startTime));
  return (
    <div className="list-row">
      <div className="min-w-0">
        <p className="truncate font-medium">{item.courseName}</p>
        <p className="truncate text-xs text-muted-foreground">{item.courseCode} · {item.room ?? t.timetable.noRoom} · {item.instructor ?? t.timetable.instructorTbd}</p>
        {safeExternalUrl(item.url) ? <a className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline" href={safeExternalUrl(item.url)} target="_blank" rel="noreferrer"><ExternalLink size={12} /> {t.timetable.openClassPage}</a> : null}
      </div>
      <Badge className="shrink-0 border border-border bg-background font-normal text-foreground">{label}</Badge>
    </div>
  );
}

function AssignmentItem({ item }: { item: Assignment }) {
  const { t } = useLocale();
  return (
    <div className="list-row">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{item.title}</p>
        <p className="truncate text-xs text-muted-foreground">{item.courseName ?? item.courseCode ?? t.assignments.learningPlatform} · {formatDateTime(item.dueAt)}</p>
      </div>
      <Badge className={cn("shrink-0", item.status === "missing" ? "bg-destructive text-destructive-foreground" : "border border-border bg-background font-normal text-foreground")}>{item.status}</Badge>
    </div>
  );
}

function CourseCard({ course }: { course: Course }) {
  const { t } = useLocale();
  const className = "motion-surface block rounded-lg border border-border p-4 hover:bg-muted/40";
  const url = safeExternalUrl(course.url);
  const content = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0"><p className="truncate text-sm font-semibold">{course.code}</p><p className="truncate text-sm text-muted-foreground">{course.name}</p></div>
        <Badge className="shrink-0 border border-border bg-background font-normal text-foreground">{course.status ?? t.courses.statusActive}</Badge>
      </div>
      {course.nextDeadline ? <p className="mt-2 text-xs text-muted-foreground">{t.courses.nextDeadline(formatDateTime(course.nextDeadline))}</p> : null}
      {url ? <p className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary"><ExternalLink size={12} /> {t.courses.openCoursePage}</p> : null}
    </>
  );
  return url ? (
    <a className={className} href={url} target="_blank" rel="noreferrer">{content}</a>
  ) : (
    <div className={className}>{content}</div>
  );
}

function DocumentRow({ item }: { item: DocumentItem }) {
  const { t } = useLocale();
  return <FeedItem title={item.name} detail={`${item.courseCode ?? t.common.document}${item.updatedAt ? ` · ${formatDateTime(item.updatedAt)}` : ""}`} url={item.url} />;
}

function TrainingPointRow({ item }: { item: TrainingPoint }) {
  const { t } = useLocale();
  const score = item.score == null ? t.common.pending : `${item.score}/${item.maxScore ?? 100}`;
  return <FeedItem title={item.title} detail={score} />;
}

function RequestRow({ item }: { item: ServiceRequest }) {
  const { t } = useLocale();
  return <FeedItem title={item.title} detail={item.status ?? item.type ?? t.common.request} />;
}

function FeedItem({ title, detail, url }: { title: string; detail: string; url?: string }) {
  const safeUrl = safeExternalUrl(url);
  const titleNode = safeUrl ? <a href={safeUrl} target="_blank" rel="noreferrer" className="hover:underline">{title}</a> : title;
  return (
    <div className="list-row">
      <div className="flex min-w-0 items-start gap-3">
        <CheckCircle2 className="mt-0.5 shrink-0 text-primary" size={16} />
        <div className="min-w-0"><p className="truncate text-sm font-medium">{titleNode}</p><p className="truncate text-xs text-muted-foreground">{detail}</p></div>
      </div>
    </div>
  );
}

function DataTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  const { t } = useLocale();
  if (!rows.length) return <Empty text={t.common.noRows} />;
  return <div className="overflow-hidden rounded-xl border border-border"><table className="w-full border-collapse text-sm"><thead className="bg-muted text-muted-foreground"><tr>{headers.map((header) => <th key={header} className="px-3 py-2 text-left font-medium">{header}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index} className="border-t border-border">{row.map((cell, cellIndex) => <td key={cellIndex} className="px-3 py-2">{cell}</td>)}</tr>)}</tbody></table></div>;
}

function LoginNeeded({ message }: { message: string }) {
  const { t } = useLocale();
  return <Card><CardHeader><CardTitle>{t.common.loginNeeded}</CardTitle><CardDescription>{message}</CardDescription></CardHeader><CardContent className="flex flex-wrap gap-2"><Link to="/login"><Button>{t.common.openLogin}</Button></Link></CardContent></Card>;
}

function CanvasRequired({ message }: { message: string }) {
  const { t } = useLocale();
  return (
    <Card>
      <CardHeader><CardTitle>{t.canvasRequired.title}</CardTitle><CardDescription>{message}</CardDescription></CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2">
        <Link to="/login"><Button variant="outline">{t.canvasRequired.addToken}</Button></Link>
        <p className="text-xs text-muted-foreground">{t.canvasRequired.note}</p>
      </CardContent>
    </Card>
  );
}

function NotSupported({ message }: { message: string }) {
  const { t } = useLocale();
  return <Card><CardHeader><CardTitle>{t.notSupported.title}</CardTitle><CardDescription>{message}</CardDescription></CardHeader><CardContent className="flex flex-wrap gap-2"><Link to="/"><Button variant="outline">{t.common.return}</Button></Link></CardContent></Card>;
}

function QueryErrorPanel({ error }: { error: Error }) {
  if (error instanceof ApiError && error.code === "UNSUPPORTED_FEATURE") return <NotSupported message={error.message} />;
  return error instanceof ApiError && error.code?.startsWith("CANVAS_")
    ? <CanvasRequired message={error.message} />
    : <LoginNeeded message={error.message} />;
}

function Empty({ text }: { text: string }) { return <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">{text}</div>; }
function PageSkeleton() { return <div className="space-y-4"><Skeleton className="h-12" /><Skeleton className="h-40" /><Skeleton className="h-40" /></div>; }
function DashboardSkeleton() { return <div className="space-y-4"><Skeleton className="h-40" /><div className="grid gap-4 md:grid-cols-4"><Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="h-28" /></div></div>; }

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
