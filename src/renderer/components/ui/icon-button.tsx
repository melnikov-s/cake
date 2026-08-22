import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
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

/** Hover/focus delay before the tooltip appears; far snappier than native titles. */
const TOOLTIP_DELAY_MS = 120;

/** Fixed-position tooltip bubble clamped to the viewport, flipping above when cramped. */
function TooltipBubble({ label, anchor }: { label: string; anchor: HTMLElement }) {
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>();
  useLayoutEffect(() => {
    const bubble = bubbleRef.current;
    const rect = anchor.getBoundingClientRect();
    if (!bubble) return;
    const left = Math.min(
      Math.max(8, rect.left + rect.width / 2 - bubble.offsetWidth / 2),
      window.innerWidth - bubble.offsetWidth - 8,
    );
    const below = rect.bottom + 6;
    const top =
      below + bubble.offsetHeight > window.innerHeight - 8
        ? rect.top - bubble.offsetHeight - 6
        : below;
    setPosition({ top, left });
  }, [anchor]);
  return createPortal(
    <span
      ref={bubbleRef}
      role="tooltip"
      className="icon-button-tooltip"
      style={position ? { top: position.top, left: position.left } : undefined}
    >
      {label}
    </span>,
    document.body,
  );
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
  const timer = useRef<number | undefined>(undefined);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  const show = (target: HTMLElement) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setAnchor(target), TOOLTIP_DELAY_MS);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    setAnchor(null);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <button
      ref={ref}
      type={type}
      className={cn("icon-button", className)}
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
