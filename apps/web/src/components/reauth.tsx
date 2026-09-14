import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CaptchaDialog, useCaptchaRelay } from "@/components/captcha-dialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { api, ApiError, clearSessionToken } from "@/lib/api/api";
import { useLocale } from "@/lib/i18n";
import {
  clearUetReauthCredentials,
  markReauthSucceeded,
  readUetReauthCredentials,
  SESSION_REAUTH_REQUIRED_EVENT,
} from "@/lib/session/reauth";

// Global inline re-authentication for expired UET sessions. Mounted once in
// RootLayout so it covers every authenticated route (the login page keeps its
// own CAPTCHA modal). When lib/api.ts detects a session death that looks
// recoverable it dispatches SESSION_REAUTH_REQUIRED_EVENT instead of clearing
// the session; this gate then re-runs the login with the stored credentials,
// relaying a CAPTCHA dialog when StudentHub demands one. Success swaps in the
// fresh token via upsertAccount (which already triggers a full refetch);
// failure or cancellation falls back to the old clear-and-redirect behavior.
export function SessionReauthGate() {
  const { t } = useLocale();
  const [reauthing, setReauthing] = useState(false);
  const [status, setStatus] = useState<string>();
  const captcha = useCaptchaRelay(t.login.verificationCancelled);
  const inFlightRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  // Refs keep the event listener stable across locale changes - re-running
  // the effect mid-attempt must never abort an in-flight re-auth.
  const translationsRef = useRef(t);
  const relayCaptchaRef = useRef(captcha.relayCaptcha);

  useEffect(() => {
    translationsRef.current = t;
    relayCaptchaRef.current = captcha.relayCaptcha;
  }, [captcha.relayCaptcha, t]);

  useEffect(() => {
    const signBackIn = async () => {
      const messages = translationsRef.current;
      const credentials = readUetReauthCredentials();
      if (!credentials) {
        // The api layer checks before dispatching, but never leave the user
        // stranded with a dead session and no dialog if the creds vanished.
        clearSessionToken();
        return;
      }
      const controller = new AbortController();
      controllerRef.current = controller;
      setReauthing(true);
      setStatus(undefined);
      try {
        await api.importUetGoogleSession(
          {
            uetGoogleEmail: credentials.email,
            uetGooglePassword: credentials.password,
          },
          (message) => setStatus(message),
          (imageDataUrl, signal) =>
            relayCaptchaRef.current(imageDataUrl, signal),
          controller.signal,
        );
        markReauthSucceeded();
        toast.success(messages.reauth.success);
      } catch (error) {
        // Stored credentials are provably wrong - drop them so the next
        // session death goes straight to the login page instead of looping.
        if (
          error instanceof ApiError &&
          error.code === "INVALID_STUDENTHUB_CREDENTIAL"
        )
          clearUetReauthCredentials();
        if (!controller.signal.aborted) toast.error(messages.reauth.failed);
        // Fall back to the pre-existing behavior: drop the dead account,
        // which redirects to /login (or auto-switches to another account).
        clearSessionToken();
      } finally {
        controllerRef.current = null;
        inFlightRef.current = false;
        setReauthing(false);
        setStatus(undefined);
      }
    };
    const beginReauth = () => {
      // Coalesce bursts of dying requests into a single attempt.
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      void signBackIn();
    };
    window.addEventListener(SESSION_REAUTH_REQUIRED_EVENT, beginReauth);
    return () =>
      window.removeEventListener(SESSION_REAUTH_REQUIRED_EVENT, beginReauth);
  }, []);

  // Abort only on unmount (redirect away), never on locale re-renders.
  useEffect(() => () => controllerRef.current?.abort(), []);

  if (!reauthing) return null;

  const cancelButton = (
    <Button
      variant="ghost"
      className="w-full"
      onClick={() => controllerRef.current?.abort()}
    >
      {t.reauth.cancelAndSignOut}
    </Button>
  );

  if (captcha.challenge) {
    return (
      <CaptchaDialog
        image={captcha.challenge.image}
        answer={captcha.answer}
        onAnswerChange={captcha.setAnswer}
        onSubmit={captcha.submitAnswer}
        title={t.reauth.title}
        footer={cancelButton}
      />
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{t.reauth.title}</CardTitle>
          <CardDescription>{t.reauth.reconnectDesc}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 size={16} className="animate-spin" aria-hidden="true" />
            {status ?? t.reauth.signingBackIn}
          </p>
          {cancelButton}
        </CardContent>
      </Card>
    </div>
  );
}
