import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "title" | "aria-label"
> {
  /** Required tooltip text, shown on hover. Every icon button must explain itself. */
  tooltip: string;
  /** Accessible name; defaults to the tooltip when omitted. */
  ariaLabel?: string;
}

/** Square transparent button for a single icon; the tooltip is required. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { tooltip, ariaLabel, type = "button", className, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn("icon-button", className)}
      aria-label={ariaLabel ?? tooltip}
      title={tooltip}
      {...props}
    >
      {children}
    </button>
  );
});
