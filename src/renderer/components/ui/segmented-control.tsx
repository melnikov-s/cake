import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export interface SegmentedControlGroupProps extends HTMLAttributes<HTMLDivElement> {
  size?: "sm" | "default";
}

export function SegmentedControlGroup({
  className,
  size = "default",
  children,
  ...props
}: SegmentedControlGroupProps) {
  return (
    <div
      role="group"
      className={cn(
        "inline-flex items-center gap-0.5 rounded-lg border border-border/80 bg-muted/50 p-0.5 select-none",
        size === "sm" && "rounded-md p-0.5 gap-0.5",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export interface SegmentedControlButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  size?: "sm" | "default";
}

export const SegmentedControlButton = forwardRef<HTMLButtonElement, SegmentedControlButtonProps>(
  function SegmentedControlButton(
    { className, active, size = "default", children, ...props },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type="button"
        aria-pressed={active}
        className={cn(
          "inline-flex items-center justify-center rounded-md text-xs font-medium text-muted-foreground transition-all hover:bg-muted/80 hover:text-foreground",
          size === "sm" && "h-6 px-2 text-[11px]",
          size === "default" && "h-7.5 px-3",
          active &&
            "bg-card text-foreground font-semibold shadow-xs hover:bg-card hover:text-foreground",
          className,
        )}
        {...props}
      >
        {children}
      </button>
    );
  },
);
