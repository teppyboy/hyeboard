import type { AdminActor } from "@hyeboard/schemas";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { LogOut } from "lucide-react";
import { useState } from "react";
import { useAdminSession } from "@/components/admin/admin-layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { adminApi } from "@/lib/admin-api";
import { useLocale } from "@/lib/i18n";

type AdminAuthViewProps = {
  actor: AdminActor;
  onLogout: () => unknown;
  pending?: boolean;
  failed?: boolean;
};

export function AdminAuthView({ actor, onLogout, pending, failed }: AdminAuthViewProps) {
  const { t } = useLocale();
  const method = t.admin.auth[actor.method];
  return (
    <section className="mx-auto max-w-2xl space-y-4">
      <div><h1 className="text-2xl font-semibold tracking-tight">{t.admin.auth.title}</h1><p className="mt-1 text-sm text-muted-foreground">{t.admin.auth.description}</p></div>
      <Card>
        <CardHeader><CardTitle className="text-base">{t.admin.auth.identity}</CardTitle></CardHeader>
        <CardContent>
          <dl className="divide-y divide-border text-sm">
            {actor.label ? <div className="flex min-h-11 items-center justify-between gap-4 py-2"><dt className="text-muted-foreground">{t.admin.auth.identity}</dt><dd className="break-all text-right font-medium">{actor.label}</dd></div> : null}
            <div className="flex min-h-11 items-center justify-between gap-4 py-2"><dt className="text-muted-foreground">{t.admin.auth.method}</dt><dd className="text-right font-medium">{method}</dd></div>
            <div className="flex min-h-11 items-center justify-between gap-4 py-2"><dt className="text-muted-foreground">{t.admin.auth.subject}</dt><dd className="break-all text-right font-mono text-xs">{actor.subject}</dd></div>
          </dl>
          {failed ? <p className="mt-4 text-sm text-destructive" role="alert">{t.admin.auth.logoutFailed}</p> : null}
          <Button type="button" variant="outline" className="mt-5 min-h-11" disabled={pending} onClick={onLogout}><LogOut size={16} aria-hidden="true" />{pending ? t.admin.auth.loggingOut : t.admin.auth.logout}</Button>
        </CardContent>
      </Card>
    </section>
  );
}

export function AdminAuthPage() {
  const { session } = useAdminSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  const logout = async () => {
    setPending(true);
    setFailed(false);
    try {
      await adminApi.logout(session.csrfToken);
      queryClient.setQueryData(["admin", "session"], { authenticated: false, methods: session.methods });
      await navigate({ to: "/admin/login", replace: true });
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };

  return <AdminAuthView actor={session.actor} onLogout={logout} pending={pending} failed={failed} />;
}
