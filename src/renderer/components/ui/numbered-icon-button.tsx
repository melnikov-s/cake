import { forwardRef } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "./badge";
import { IconButton, type IconButtonProps } from "./icon-button";

export type NumberedIconButtonProps = IconButtonProps & {
  /** Positive counts show a bubble (capped at 99+); zero or undefined show the plain icon. Include the exact count in the accessible label or description. */
  count?: number;
  /** Inline counts reserve their own space beside the glyph, retaining the toolbar height. */
  countPlacement?: "corner" | "inline";
};

/** A counted toolbar action; corner badges keep a square target, inline badges never cover the glyph. */
export const NumberedIconButton = forwardRef<HTMLButtonElement, NumberedIconButtonProps>(
  function NumberedIconButton(
    { count, countPlacement = "corner", children, className, ...props },
    ref,
  ) {
    const inline = countPlacement === "inline";
    const hasCount = count !== undefined && count > 0;
    return (
      <IconButton
        {...props}
        ref={ref}
        className={cn(
          "relative",
          inline && "text-foreground",
          inline && hasCount && "inline-flex w-auto min-w-7 justify-center gap-1 px-1",
          className,
        )}
      >
        <span aria-hidden="true" className="grid place-items-center">
          {children}
        </span>
        {hasCount && (
          <span
            aria-hidden="true"
            data-slot="count-badge-anchor"
            className={cn("pointer-events-none", inline ? "flex" : "absolute -top-1.5 -right-1")}
          >
            <Badge
              data-slot="count-badge"
              size="xs"
              variant={inline ? "secondary" : "mono"}
              className={cn(
                "justify-center whitespace-nowrap font-sans font-semibold leading-none",
                inline
                  ? "h-5 min-w-5 px-1 text-xs"
                  : "h-3.5 min-w-3.5 bg-muted px-0.5 text-[0.625rem] text-muted-foreground ring-2 ring-background",
              )}
            >
              {count > 99 ? "99+" : count}
            </Badge>
          </span>
        )}
      </IconButton>
    );
  },
);
