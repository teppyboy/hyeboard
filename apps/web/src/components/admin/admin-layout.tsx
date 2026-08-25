import type { AdminSessionStatus } from "@hyeboard/schemas";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Outlet, useNavigate } from "@tanstack/react-router";
import { History, LayoutDashboard, ShieldCheck, UserRound } from "lucide-react";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { adminApi } from "@/lib/admin-api";
import { subscribeToAdminPolicyEvents } from "@/lib/admin-policy-events";
import { useLocale } from "@/lib/i18n";

type AuthenticatedAdminSession = AdminSessionStatus & {
  authenticated: true;
  actor: NonNullable<AdminSessionStatus["actor"]>;
  csrfToken: string;
};

type AdminSessionContextValue = {
  session: AuthenticatedAdminSession;
  refreshSession: () => Promise<unknown>;
  policyRevision?: number;
};

const AdminSessionContext = createContext<AdminSessionContextValue | null>(null);

export function useAdminSession(): AdminSessionContextValue {
  const value = useContext(AdminSessionContext);
  if (!value) throw new Error("useAdminSession must be used inside AdminLayout");
  return value;
}

export function AdminShell({ children }: { children: ReactNode }) {
  const { t } = useLocale();
  const links = [
    { href: "/admin", label: t.admin.nav.control, icon: LayoutDashboard },
    { href: "/admin/history", label: t.admin.nav.history, icon: History },
    { href: "/admin/auth", label: t.admin.nav.account, icon: UserRound },
  ];
  return (
    <div className="min-h-screen bg-background text-foreground lg:grid lg:grid-cols-[240px_1fr]">
      <aside className="border-b border-border bg-sidebar lg:min-h-screen lg:border-b-0 lg:border-r">
        <div className="flex min-h-16 items-center gap-3 px-4 lg:px-5">
          <span className="grid h-10 w-10 place-items-center rounded-lg bg-primary text-primary-foreground"><ShieldCheck size={19} aria-hidden="true" /></span>
          <div><p className="font-semibold tracking-tight">Hyeboard</p><p className="text-xs text-muted-foreground">{t.admin.product}</p></div>
        </div>
        <nav aria-label={t.admin.nav.label} className="flex gap-1 overflow-x-auto px-3 pb-3 lg:block lg:space-y-1 lg:py-3">
          {links.map(({ href, label, icon: Icon }) => (
            <a key={href} href={href} className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-md px-3 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Icon size={16} aria-hidden="true" />{label}
            </a>
          ))}
        </nav>
      </aside>
      <main className="min-w-0 p-4 lg:p-6">{children}</main>
    </div>
  );
}

export function AdminLayout() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const sessionQuery = useQuery({ queryKey: ["admin", "session"], queryFn: adminApi.session, retry: false });
  const authenticated = sessionQuery.data?.authenticated === true;
  const [policyRevision, setPolicyRevision] = useState<number>();

  useEffect(() => {
    if (sessionQuery.data && !sessionQuery.data.authenticated) void navigate({ to: "/admin/login", replace: true });
  }, [navigate, sessionQuery.data]);
  useEffect(() => {
    if (!authenticated) return;
    const invalidate = () => Promise.all([
      queryClient.invalidateQueries({ queryKey: ["admin", "policy"] }),
      queryClient.invalidateQueries({ queryKey: ["admin", "history"] }),
    ]).then(() => undefined);
    const refresh = async (revision?: number) => {
      await invalidate();
      setPolicyRevision(revision ?? queryClient.getQueryData<{ snapshot: { revision: number } }>(["admin", "policy"])?.snapshot.revision);
    };
    return subscribeToAdminPolicyEvents({
      getRevision: () => queryClient.getQueryData<{ snapshot: { revision: number } }>(["admin", "policy"])?.snapshot.revision,
      onRevision: refresh,
      onPoll: (signal) => {
        if (signal.aborted) return;
        return refresh();
      },
    });
  }, [authenticated, queryClient]);

  if (sessionQuery.isPending) return <AdminState message={t.admin.session.loading} />;
  if (sessionQuery.isError) return <AdminState message={t.admin.session.error} retry={() => sessionQuery.refetch()} />;
  if (!sessionQuery.data.authenticated || !sessionQuery.data.actor || !sessionQuery.data.csrfToken) return <AdminState message={t.admin.session.redirecting} />;

  const session = sessionQuery.data as AuthenticatedAdminSession;
  return (
    <AdminSessionContext.Provider value={{ session, refreshSession: sessionQuery.refetch, policyRevision }}>
      <AdminShell><Outlet /></AdminShell>
    </AdminSessionContext.Provider>
  );
}

function AdminState({ message, retry }: { message: string; retry?: () => unknown }) {
  const { t } = useLocale();
  return (
    <main className="grid min-h-screen place-items-center bg-background p-4 text-foreground">
      <div className="text-center" role="status"><p>{message}</p>{retry ? <Button className="mt-4 min-h-11" variant="outline" onClick={retry}>{t.admin.actions.retry}</Button> : null}</div>
    </main>
  );
}
