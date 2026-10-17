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
  chevronPosition?: "start" | "end";
  wrapTitle?: boolean;
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
      chevronPosition = "end",
      wrapTitle = false,
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
        data-cake-hint="off"
        title={title}
        className={cn(
          "flex w-full min-w-0 items-center justify-between gap-2 text-left text-xs font-medium text-foreground transition-colors select-none",
          disabled ? "opacity-40 cursor-default" : "cursor-pointer",
          className,
        )}
        {...props}
      >
        <div
          className={cn(
            "flex min-w-0 flex-1 gap-2",
            chevronPosition === "start" ? "items-start" : "items-center",
          )}
        >
          {showChevron && chevronPosition === "start" && (
            <ChevronIcon
              className={cn(
                "mt-1 shrink-0 text-muted-foreground transition-transform duration-150",
                !open && "-rotate-90",
              )}
            />
          )}
          {status && <StatusDot status={status} />}
          <span className={cn(wrapTitle ? "min-w-0 whitespace-pre-wrap break-words" : "truncate")}>
            {title}
          </span>
          {subtitle && (
            <span className="font-normal text-muted-foreground truncate">{subtitle}</span>
          )}
          {badge}
        </div>
        <div className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
          {trailing}
          {showChevron && chevronPosition === "end" && (
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
