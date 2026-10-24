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
        "inline-flex items-center gap-0.5 rounded-md border border-border/75 bg-muted/65 p-0.5 shadow-inner select-none",
        size === "sm" && "rounded-sm p-0.5 gap-0.5",
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
          "inline-flex items-center justify-center rounded-sm text-xs font-medium text-muted-foreground transition-all hover:bg-muted/80 hover:text-foreground",
          size === "sm" && "h-6 px-2 text-xs",
          size === "default" && "h-7 px-2.5",
          active &&
            "bg-card text-foreground font-medium shadow-xs ring-1 ring-border/50 hover:bg-card hover:text-foreground",
          className,
        )}
        {...props}
      >
        {children}
      </button>
    );
  },
);
