import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  icon?: ReactNode;
  trailing?: ReactNode;
}

export const Chip = forwardRef<HTMLButtonElement, ChipProps>(function Chip(
  { className, active = false, icon, trailing, type = "button", disabled, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        "inline-flex h-6 min-w-0 shrink-0 items-center gap-1.5 rounded-full border px-2 text-[11px] font-medium transition-colors select-none",
        active
          ? "border-accent/40 bg-accent/15 text-accent font-semibold"
          : "border-border/80 bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
        disabled
          ? "opacity-40 cursor-default hover:bg-card hover:text-muted-foreground"
          : "cursor-pointer",
        className,
      )}
      {...props}
    >
      {icon && <span className="shrink-0">{icon}</span>}
      {children}
      {trailing && <span className="shrink-0">{trailing}</span>}
    </button>
  );
});
