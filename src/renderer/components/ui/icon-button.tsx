import type { ButtonHTMLAttributes } from "react";
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
export function IconButton({ tooltip, ariaLabel, className, children, ...props }: IconButtonProps) {
  return (
    <button
      type="button"
      className={cn("icon-button", className)}
      aria-label={ariaLabel ?? tooltip}
      title={tooltip}
      {...props}
    >
      {children}
    </button>
  );
}
