import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type SwitchProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> & {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
};

export function Switch({ checked = false, className, disabled, onClick, onCheckedChange, ...props }: SwitchProps) {
  return (
    <button
      {...props}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={cn("inline-flex min-h-11 min-w-11 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50", className)}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) onCheckedChange?.(!checked);
      }}
    >
      <span className={cn("flex h-6 w-10 items-center rounded-full border border-border p-0.5 transition-colors", checked ? "bg-primary" : "bg-muted")} aria-hidden="true">
        <span className={cn("h-5 w-5 rounded-full bg-background shadow-sm transition-transform", checked && "translate-x-4")} />
      </span>
    </button>
  );
}
