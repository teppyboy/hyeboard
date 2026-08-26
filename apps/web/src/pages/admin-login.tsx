import type { AdminSessionStatus } from "@hyeboard/schemas";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Loader2, LockKeyhole, ShieldCheck } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { adminApi } from "@/lib/admin-api";
import { useLocale } from "@/lib/i18n";

type AdminMethod = AdminSessionStatus["methods"][number];

type AdminLoginViewProps = {
  methods: AdminMethod[];
  password: string;
  onPasswordChange?: (password: string) => void;
  onPasswordSubmit?: () => void;
  pending?: boolean;
  loading?: boolean;
  error?: boolean;
  failed?: boolean;
};

export function AdminLoginView({ methods, password, onPasswordChange, onPasswordSubmit, pending, loading, error, failed }: AdminLoginViewProps) {
  const { t } = useLocale();
  if (loading) return <LoginState message={t.admin.login.loading} />;
  if (error) return <LoginState message={t.admin.login.unavailable} />;
  return (
    <main className="grid min-h-screen place-items-center bg-background p-4 text-foreground">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="mb-2 grid h-11 w-11 place-items-center rounded-lg bg-primary text-primary-foreground"><ShieldCheck size={20} aria-hidden="true" /></div>
          <CardTitle className="text-xl">{t.admin.login.title}</CardTitle>
          <CardDescription>{t.admin.login.description}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {failed ? <p role="alert" className="text-sm text-destructive">{t.admin.login.failed}</p> : null}
          {methods.includes("password") ? (
            <form className="space-y-3" onSubmit={(event: FormEvent) => { event.preventDefault(); onPasswordSubmit?.(); }}>
              <label htmlFor="admin-password" className="block text-sm font-medium">{t.admin.login.password}</label>
              <Input id="admin-password" className="min-h-11" type="password" autoComplete="current-password" value={password} disabled={pending} onChange={(event) => onPasswordChange?.(event.target.value)} required />
              <Button className="min-h-11 w-full" type="submit" disabled={pending || !password}>
                {pending ? <Loader2 className="animate-spin" size={16} aria-hidden="true" /> : <LockKeyhole size={16} aria-hidden="true" />}
                {pending ? t.admin.login.signingIn : t.admin.login.passwordAction}
              </Button>
            </form>
          ) : null}
          {methods.includes("github") ? <OAuthLink provider="github" label={t.admin.login.githubAction} /> : null}
          {methods.includes("discord") ? <OAuthLink provider="discord" label={t.admin.login.discordAction} /> : null}
          {methods.length ? null : <p className="text-sm text-muted-foreground">{t.admin.login.notConfigured}</p>}
        </CardContent>
      </Card>
    </main>
  );
}

export function AdminLoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const sessionQuery = useQuery({ queryKey: ["admin", "session"], queryFn: adminApi.session, retry: false });

  useEffect(() => {
    if (sessionQuery.data?.authenticated) void navigate({ to: "/admin", replace: true });
  }, [navigate, sessionQuery.data]);

  const login = async () => {
    setPending(true);
    setFailed(false);
    try {
      const session = await adminApi.loginPassword(password);
      setPassword("");
      queryClient.setQueryData(["admin", "session"], session);
      if (session.authenticated) await navigate({ to: "/admin", replace: true });
      else setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };

  return <AdminLoginView methods={sessionQuery.data?.methods ?? []} password={password} onPasswordChange={setPassword} onPasswordSubmit={login} pending={pending} loading={sessionQuery.isPending} error={sessionQuery.isError} failed={failed} />;
}

function OAuthLink({ provider, label }: { provider: "github" | "discord"; label: string }) {
  return <a className="inline-flex min-h-11 w-full items-center justify-center rounded-md border border-border bg-background px-4 text-sm font-medium hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={adminApi.oauthStartUrl(provider)}>{label}</a>;
}

function LoginState({ message }: { message: string }) {
  return <main className="grid min-h-screen place-items-center bg-background p-4 text-foreground"><p role="status">{message}</p></main>;
}
