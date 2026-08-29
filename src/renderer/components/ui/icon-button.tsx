import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import { TooltipBubble, useTooltip } from "./tooltip";

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "title" | "aria-label"
> {
  /** Required tooltip text, shown on hover. Every icon button must explain itself. */
  tooltip: string;
  /** Accessible name; defaults to the tooltip when omitted. */
  ariaLabel?: string;
}

/** Square transparent button for a single icon; the tooltip is required and shows quickly. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    tooltip,
    ariaLabel,
    type = "button",
    className,
    children,
    onMouseEnter,
    onMouseLeave,
    onMouseDown,
    onFocus,
    onBlur,
    ...props
  },
  ref,
) {
  const { anchor, hide, show } = useTooltip();

  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "icon-button grid size-[30px] place-items-center rounded-[7px] border-0 bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:shadow-sm aria-pressed:hover:bg-primary/90",
        className,
      )}
      aria-label={ariaLabel ?? tooltip}
      {...props}
      onMouseEnter={(event) => {
        show(event.currentTarget);
        onMouseEnter?.(event);
      }}
      onMouseLeave={(event) => {
        hide();
        onMouseLeave?.(event);
      }}
      onMouseDown={(event) => {
        hide();
        onMouseDown?.(event);
      }}
      onFocus={(event) => {
        // Only keyboard focus reveals the tooltip; pointer focus is handled by hover.
        if (event.currentTarget.matches(":focus-visible")) show(event.currentTarget);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        hide();
        onBlur?.(event);
      }}
    >
      {children}
      {anchor && <TooltipBubble label={tooltip} anchor={anchor} />}
    </button>
  );
});
