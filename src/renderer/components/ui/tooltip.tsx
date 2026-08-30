import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** Hover/focus delay before the tooltip appears; far snappier than native titles. */
const TOOLTIP_DELAY_MS = 120;

export function useTooltip() {
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

  return { anchor, hide, show };
}

/** Fixed-position tooltip bubble clamped to the viewport, flipping when cramped. */
export function TooltipBubble({
  label,
  anchor,
  placement = "below",
}: {
  label: string;
  anchor: HTMLElement;
  placement?: "above" | "below";
}) {
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
    const above = rect.top - bubble.offsetHeight - 6;
    const top =
      placement === "above"
        ? above >= 8
          ? above
          : below
        : below + bubble.offsetHeight > window.innerHeight - 8
          ? above
          : below;
    setPosition({ top, left });
  }, [anchor, placement]);

  return createPortal(
    <span
      ref={bubbleRef}
      role="tooltip"
      className="pointer-events-none fixed z-[1000] max-w-[280px] overflow-hidden truncate whitespace-nowrap rounded-md bg-primary px-2 py-1 text-[11px] font-medium leading-tight text-primary-foreground shadow-md select-none"
      style={position ? { top: position.top, left: position.left } : { visibility: "hidden" }}
    >
      {label}
    </span>,
    document.body,
  );
}
