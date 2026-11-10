import { forwardRef } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "./badge";
import { IconButton, type IconButtonProps } from "./icon-button";

export type NumberedIconButtonProps = IconButtonProps & {
  /** Positive counts show a bubble (capped at 99+); zero or undefined show the plain icon. Include the exact count in the accessible label or description. */
  count?: number;
};

/** An IconButton with an opaque count bubble inset in its corner. The target stays the shared square, so rows of icons keep one width and rhythm. */
export const NumberedIconButton = forwardRef<HTMLButtonElement, NumberedIconButtonProps>(
  function NumberedIconButton({ count, children, className, ...props }, ref) {
    return (
      <IconButton {...props} ref={ref} className={cn("relative", className)}>
        <span aria-hidden="true" className="grid place-items-center">
          {children}
        </span>
        {count !== undefined && count > 0 && (
          <span
            aria-hidden="true"
            data-slot="count-badge-anchor"
            className="pointer-events-none absolute -top-1.5 -right-1"
          >
            {/* Counts are compact metadata, below the shared 14px small-copy tier. */}
            <Badge
              data-slot="count-badge"
              size="xs"
              variant="mono"
              className="h-3.5 min-w-3.5 justify-center whitespace-nowrap bg-muted px-0.5 font-sans text-[0.625rem] font-semibold text-muted-foreground leading-none ring-2 ring-background"
            >
              {count > 99 ? "99+" : count}
            </Badge>
          </span>
        )}
      </IconButton>
    );
  },
);
