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
          <span aria-hidden="true" className="relative grid h-6 min-w-6 grid-cols-[0.5rem_auto]">
            <span className="absolute bottom-0 left-0 flex size-4 items-center justify-center">
              {children}
            </span>
            <Badge
              size="xs"
              variant="mono"
              className="relative col-start-2 h-4 min-w-4 justify-center self-start whitespace-nowrap bg-card px-1 text-card-foreground leading-none"
            >
              {count}
            </Badge>
          </span>
        )}
      </IconButton>
    );
  },
);
