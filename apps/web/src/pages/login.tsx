import { useNavigate } from "@tanstack/react-router";
import { ExternalLink, GraduationCap, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { universityLogoUrl } from "@/components/shared";
import { api, ApiError, getSessionToken } from "@/lib/api";
import { LOCALES, type Locale, type Translations, useLocale } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { RELOGIN_KEYS, sessionStored, setSessionStored, useHyeboard } from "@/state";

// Country-flag emoji render inconsistently across platforms (Windows Chrome
// falls back to plain "GB"/"VN" region-indicator text instead of a flag
// glyph), so the language toggle uses these small inline SVGs instead.
function FlagIcon({ locale, className }: { locale: Locale; className?: string }) {
  const clipId = `flag-clip-${locale}`;
  if (locale === "vi") {
    return (
      <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
        <clipPath id={clipId}><circle cx="12" cy="12" r="12" /></clipPath>
        <g clipPath={`url(#${clipId})`}>
          <rect width="24" height="24" fill="#DA251D" />
          <path d="M12 5.5 13.76 10.9 19.44 10.9 14.84 14.2 16.6 19.6 12 16.3 7.4 19.6 9.16 14.2 4.56 10.9 10.24 10.9Z" fill="#FFCD00" />
        </g>
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <clipPath id={clipId}><circle cx="12" cy="12" r="12" /></clipPath>
      <g clipPath={`url(#${clipId})`}>
        <rect width="24" height="24" fill="#00247D" />
        <path d="M0 0 24 24M24 0 0 24" stroke="#fff" strokeWidth="4" />
        <path d="M0 0 24 24M24 0 0 24" stroke="#CF142B" strokeWidth="2" />
        <path d="M12 0V24M0 12H24" stroke="#fff" strokeWidth="7" />
        <path d="M12 0V24M0 12H24" stroke="#CF142B" strokeWidth="4" />
      </g>
    </svg>
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

export function LoginPage() {
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
      <button
        type="button"
        onClick={() => setLocale(locale === "en" ? "vi" : "en")}
        className="fixed bottom-4 right-4 z-10 flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1.5 text-sm shadow-sm transition-colors hover:bg-muted"
        aria-label={t.settings.language}
        title={t.settings.language}
      >
        <FlagIcon locale={locale} className="h-4 w-4 shrink-0" />
        <span className="text-xs font-medium leading-none text-muted-foreground">{LOCALES.find((option) => option.id === locale)?.label}</span>
      </button>
      <div className="animate-page mx-auto flex min-h-[calc(100vh-5rem)] w-full max-w-md flex-col justify-center">
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
                <div className="grid gap-2">
                  <label htmlFor="uet-student-code" className="text-sm font-medium">{t.login.studentCodeLabel}</label>
                  <Input id="uet-student-code" name="uet-student-code" type="text" autoComplete="username" placeholder={t.login.studentCodePlaceholder} value={uetGoogleEmail} onChange={(event) => setUetGoogleEmail(event.target.value)} onKeyDown={(event) => submitOnEnter(event, importUetGoogleSession)} />
                </div>
                <div className="grid gap-2">
                  <label htmlFor="uet-google-password" className="text-sm font-medium">{isUetParentLogin ? t.login.passwordLabel : t.login.googlePasswordLabel}</label>
                  <Input id="uet-google-password" name="uet-google-password" type="password" autoComplete="current-password" placeholder={isUetParentLogin ? t.login.passwordPlaceholder : t.login.googlePasswordPlaceholder} value={uetGooglePassword} onChange={(event) => setUetGooglePassword(event.target.value)} onKeyDown={(event) => submitOnEnter(event, importUetGoogleSession)} />
                </div>
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
                    <div className="grid gap-2">
                      <label htmlFor="studenthub-token" className="text-sm font-medium">{t.login.portalTokenLabel}</label>
                      <Input id="studenthub-token" name="studenthub-token" type="password" autoComplete="off" placeholder={t.login.portalTokenPlaceholder} value={studenthubToken} onChange={(event) => setStudenthubToken(event.target.value)} onKeyDown={(event) => submitOnEnter(event, importUetSession)} />
                    </div>
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
                    <div className="grid gap-2">
                      <label htmlFor="canvas-token" className="text-sm font-medium">{t.login.learningTokenLabel}</label>
                      <Input id="canvas-token" name="canvas-token" type="password" autoComplete="off" placeholder={t.login.learningTokenPlaceholder} value={canvasToken} onChange={(event) => { setCanvasToken(event.target.value); setSessionStored(RELOGIN_KEYS.uetCanvasToken, event.target.value); }} onKeyDown={(event) => submitOnEnter(event, importUetSession)} />
                    </div>
                    <details className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
                      <summary className="cursor-pointer font-medium text-foreground">{t.login.advancedCookieOptions}</summary>
                      <div className="mt-3 space-y-3">
                        <div className="grid gap-2">
                          <label htmlFor="studenthub-cookie" className="text-sm font-medium">{t.login.portalCookieLabel}</label>
                          <Input id="studenthub-cookie" name="studenthub-cookie" type="password" autoComplete="off" placeholder={t.login.portalCookiePlaceholder} value={studenthubCookie} onChange={(event) => setStudenthubCookie(event.target.value)} onKeyDown={(event) => submitOnEnter(event, importUetSession)} />
                        </div>
                        <div className="grid gap-2">
                          <label htmlFor="canvas-cookie" className="text-sm font-medium">{t.login.learningCookieLabel}</label>
                          <Input id="canvas-cookie" name="canvas-cookie" type="password" autoComplete="off" placeholder={t.login.learningCookiePlaceholder} value={canvasCookie} onChange={(event) => setCanvasCookie(event.target.value)} onKeyDown={(event) => submitOnEnter(event, importUetSession)} />
                        </div>
                        <div className="grid gap-2">
                          <label htmlFor="canvas-csrf" className="text-sm font-medium">{t.login.learningCsrfLabel}</label>
                          <Input id="canvas-csrf" name="canvas-csrf" type="password" autoComplete="off" placeholder={t.login.learningCsrfPlaceholder} value={canvasCsrfToken} onChange={(event) => setCanvasCsrfToken(event.target.value)} onKeyDown={(event) => submitOnEnter(event, importUetSession)} />
                        </div>
                      </div>
                    </details>
                    <Button onClick={importUetSession} disabled={busy} variant="outline" className="w-full">{busy ? <Loader2 size={16} className="animate-spin" /> : null}{t.login.importUniversitySession}</Button>
                  </>
                )}
              </>
            ) : selectedUniversity === "vnu" ? (
              <>
                <div className="grid gap-2">
                  <label htmlFor="vnu-username" className="text-sm font-medium">{t.login.usernameLabel}</label>
                  <Input id="vnu-username" name="vnu-username" placeholder={t.login.studentUsernamePlaceholder} autoComplete="username" value={vnuUsername} onChange={(event) => { setVnuUsername(event.target.value); setSessionStored(RELOGIN_KEYS.vnuUsername, event.target.value); }} />
                </div>
                <div className="grid gap-2">
                  <label htmlFor="vnu-password" className="text-sm font-medium">{t.login.passwordLabel}</label>
                  <Input id="vnu-password" name="vnu-password" type="password" autoComplete="current-password" placeholder={t.login.passwordPlaceholder} value={vnuPassword} onChange={(event) => { setVnuPassword(event.target.value); setSessionStored(RELOGIN_KEYS.vnuPassword, event.target.value); }} onKeyDown={(event) => submitOnEnter(event, importVnuSession)} />
                </div>
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
              <div className="grid gap-2">
                <label htmlFor="captcha-answer" className="text-sm font-medium">{t.login.verificationCodeLabel}</label>
                <Input
                  id="captcha-answer"
                  name="captcha-answer"
                  autoFocus
                  value={captchaAnswer}
                  onChange={(event) => setCaptchaAnswer(event.target.value)}
                  placeholder={t.login.enterCodeShown}
                  onKeyDown={(event) => { if (event.key === "Enter") submitCaptchaAnswer(); }}
                />
              </div>
              <Button onClick={submitCaptchaAnswer} disabled={!captchaAnswer.trim()} className="w-full">{t.common.submit}</Button>
            </CardContent>
          </Card>
        </div>
      ) : null}
    </main>
  );
}
