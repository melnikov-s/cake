import { createPortal } from "react-dom";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** Hover/focus delay before the tooltip appears; far snappier than native titles. */
const TOOLTIP_DELAY_MS = 120;

export function useTooltip(enabled = true) {
  const timer = useRef<number | undefined>(undefined);
  const cleanup = useRef<(() => void) | undefined>(undefined);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  const clear = useCallback(() => {
    window.clearTimeout(timer.current);
    cleanup.current?.();
    cleanup.current = undefined;
  }, []);
  const hide = useCallback(() => {
    clear();
    setAnchor(null);
  }, [clear]);

  const show = (target: HTMLElement) => {
    hide();
    if (!enabled || !target.isConnected) return;

    // A fixed portal can outlive hover when its trigger moves or disappears.
    // Watch only while this tooltip is pending/visible, not for every icon button.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    const observer = new MutationObserver(() => {
      if (!target.isConnected) hide();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("blur", hide);
    document.addEventListener("keydown", onKeyDown, true);
    cleanup.current = () => {
      observer.disconnect();
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("blur", hide);
      document.removeEventListener("keydown", onKeyDown, true);
    };
    timer.current = window.setTimeout(() => {
      if (target.isConnected) setAnchor(target);
      else hide();
    }, TOOLTIP_DELAY_MS);
  };

  useLayoutEffect(() => {
    if (!enabled) hide();
  }, [enabled, hide]);
  useEffect(() => clear, [clear]);

  return { anchor, hide, show };
}

/** Fixed-position tooltip bubble clamped to the viewport, flipping when cramped. */
export function TooltipBubble({
  label,
  anchor,
  placement = "below",
  wrap = false,
  className,
}: {
  label: string;
  anchor: HTMLElement;
  placement?: "above" | "below";
  wrap?: boolean;
  className?: string;
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
      className={cn(
        "pointer-events-none fixed z-[1000] max-w-[280px] overflow-hidden rounded-md border border-border/80 bg-popover/95 px-2 py-1 text-xs font-medium leading-tight text-popover-foreground shadow-md backdrop-blur-md select-none",
        wrap ? "whitespace-normal" : "truncate whitespace-nowrap",
        className,
      )}
      style={position ? { top: position.top, left: position.left } : { visibility: "hidden" }}
    >
      {label}
    </span>,
    document.body,
  );
}
