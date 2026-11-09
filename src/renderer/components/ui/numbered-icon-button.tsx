import { forwardRef } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "./badge";
import { IconButton, type IconButtonProps } from "./icon-button";

export type NumberedIconButtonProps = IconButtonProps & {
  /** Zero is a known count and is shown; undefined omits the bubble. Include count meaning in the accessible label or description. */
  count?: number;
};

/** An IconButton with an opaque, inset count bubble. Its target grows with the count, never into adjacent controls. */
export const NumberedIconButton = forwardRef<HTMLButtonElement, NumberedIconButtonProps>(
  function NumberedIconButton({ count, children, className, ...props }, ref) {
    return (
      <IconButton {...props} ref={ref} className={cn("h-8 min-w-8 w-auto px-1", className)}>
        {count === undefined ? (
          <span aria-hidden="true">{children}</span>
        ) : (
          <span aria-hidden="true" className="relative grid h-7 min-w-7 grid-cols-[0.75rem_auto]">
            <span className="absolute bottom-0 left-0 flex size-6 items-center justify-center">
              {children}
            </span>
            {/* Counts are compact metadata, below the shared 14px small-copy tier. */}
            <Badge
              size="xs"
              variant="mono"
              className="relative col-start-2 h-3.5 min-w-3.5 justify-center self-start whitespace-nowrap bg-muted px-0.5 font-sans text-[0.625rem] font-semibold text-muted-foreground leading-none"
            >
              {count}
            </Badge>
          </span>
        )}
      </IconButton>
    );
  },
);
