import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ChevronIcon } from "./icons";
import { StatusDot, type StatusDotProps } from "./status-dot";

export interface DisclosureTriggerProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  open?: boolean;
  status?: StatusDotProps["status"];
  title: string;
  subtitle?: ReactNode;
  badge?: ReactNode;
  trailing?: ReactNode;
  showChevron?: boolean;
}

export const DisclosureTrigger = forwardRef<HTMLButtonElement, DisclosureTriggerProps>(
  function DisclosureTrigger(
    {
      className,
      open = false,
      status,
      title,
      subtitle,
      badge,
      trailing,
      showChevron = true,
      type = "button",
      disabled,
      children,
      ...props
    },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type}
        disabled={disabled}
        aria-expanded={open}
        title={title}
        className={cn(
          "flex w-full min-w-0 items-center justify-between gap-2 text-left font-mono text-xs font-semibold text-foreground transition-colors select-none",
          disabled ? "opacity-40 cursor-default" : "cursor-pointer",
          className,
        )}
        {...props}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {status && <StatusDot status={status} />}
          <span className="truncate">{title}</span>
          {subtitle && (
            <span className="font-normal text-muted-foreground truncate">{subtitle}</span>
          )}
          {badge}
        </div>
        <div className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
          {trailing}
          {showChevron && (
            <ChevronIcon
              className={cn("transition-transform duration-150", open && "rotate-180")}
            />
          )}
        </div>
        {children}
      </button>
    );
  },
);
