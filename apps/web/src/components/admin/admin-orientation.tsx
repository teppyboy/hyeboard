import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/lib/i18n";

const DISMISSED_KEY = "hyeboard.admin.policy-orientation.dismissed";

function wasDismissed(): boolean {
  try {
    return typeof window !== "undefined" && window.sessionStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

export type AdminOrientationProps = {
  onDismiss?: () => void;
};

export function AdminOrientation({ onDismiss }: AdminOrientationProps) {
  const { t } = useLocale();
  const [dismissed, setDismissed] = useState(wasDismissed);

  if (dismissed) return null;

  const dismiss = () => {
    try {
      window.sessionStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // Session storage can be unavailable in privacy-restricted browsers; dismissal still applies in memory.
    }
    setDismissed(true);
    onDismiss?.();
  };

  return (
    <aside className="rounded-lg border border-border bg-muted p-4 text-foreground" aria-labelledby="admin-orientation-title">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 id="admin-orientation-title" className="font-semibold">{t.admin.orientation.title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t.admin.orientation.description}</p>
        </div>
        <Button type="button" variant="ghost" className="min-h-11 shrink-0" onClick={dismiss} aria-label={t.admin.orientation.dismiss}>
          {t.admin.orientation.dismiss}
        </Button>
      </div>
      <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm">
        <li>{t.admin.orientation.steps.stage}</li>
        <li>{t.admin.orientation.steps.review}</li>
        <li>{t.admin.orientation.steps.publish}</li>
      </ol>
      <p className="mt-4 text-sm text-muted-foreground">{t.admin.orientation.locked}</p>
    </aside>
  );
}
