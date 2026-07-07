import type { CSSProperties } from "react";
import { Toaster as SonnerToaster, type ToasterProps } from "sonner";

// Local wrapper around the `sonner` toast library, styled with this app's
// own CSS custom properties (see styles.css `hsl(var(--*))` tokens) instead
// of sonner's theme prop — `theme="light"` disables sonner's own
// prefers-color-scheme detection so our `[data-mode="dark"]` selector (set
// by the app's own dark-mode toggle, see SettingsPage) is what actually
// drives the color switch, matching every other themed surface in the app.
export function Toaster(props: ToasterProps) {
  return (
    <SonnerToaster
      theme="light"
      className="toaster group"
      position="bottom-right"
      richColors={false}
      style={
        {
          "--normal-bg": "hsl(var(--card))",
          "--normal-text": "hsl(var(--card-foreground))",
          "--normal-border": "hsl(var(--border))",
          "--error-bg": "hsl(var(--card))",
          "--error-text": "hsl(var(--destructive))",
          "--error-border": "hsl(var(--destructive) / 0.4)",
          "--success-bg": "hsl(var(--card))",
          "--success-text": "hsl(var(--foreground))",
          "--success-border": "hsl(var(--border))",
        } as CSSProperties
      }
      {...props}
    />
  );
}
