import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  messageActionPlacement,
  type MessageActionPlacement,
} from "@/lib/message-action-placement";

/** One toolbar, moved without remounting its buttons or changing their semantics. */
export function MessageActions({ children }: { children: ReactNode }) {
  const clearanceRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<MessageActionPlacement>({ kind: "footer" });
  const [footerHeight, setFooterHeight] = useState(28);
  const [clearanceHeight, setClearanceHeight] = useState(28);

  useLayoutEffect(() => {
    const slot = slotRef.current;
    const toolbar = toolbarRef.current;
    const message = slot?.parentElement;
    const scroller = slot?.closest<HTMLElement>(".transcript");
    if (!slot || !toolbar || !message || !scroller) return;
    let frame: number | undefined;
    const update = () => {
      frame = undefined;
      const bounds = scroller.getBoundingClientRect();
      const messageBounds = message.getBoundingClientRect();
      // Neither reserved action row is part of the message body. Keep both in
      // flow regardless of placement so scrolling never changes message height.
      let bodyTop = Infinity;
      let bodyBottom = messageBounds.top;
      for (let child = slot.previousElementSibling; child; child = child.previousElementSibling) {
        if (child === clearanceRef.current) continue;
        // Annotation markers can follow the body in DOM order without being its
        // bottom boundary. Measure all preceding content, not just the last node.
        const bounds = child.getBoundingClientRect();
        bodyTop = Math.min(bodyTop, bounds.top);
        bodyBottom = Math.max(bodyBottom, bounds.bottom);
      }
      const items = Array.from(toolbar.children, (child) => child.getBoundingClientRect());
      if (!items.length) return;
      const gap = Number.parseFloat(getComputedStyle(toolbar).gap) || 0;
      const row = {
        width: items.reduce((sum, item) => sum + item.width, 0) + gap * (items.length - 1),
        height: Math.max(...items.map((item) => item.height)),
      };
      const bodyGap = Number.parseFloat(getComputedStyle(message).rowGap) || 0;
      setClearanceHeight(row.height + Math.max(0, 8 - bodyGap));
      const column = {
        width: Math.max(...items.map((item) => item.width)),
        height: items.reduce((sum, item) => sum + item.height, 0) + gap * (items.length - 1),
      };
      const viewportPlacement = messageActionPlacement({
        message: {
          top: Number.isFinite(bodyTop) ? bodyTop : messageBounds.top,
          bottom: bodyBottom,
          left: messageBounds.left,
          right: messageBounds.right,
        },
        viewport: {
          top: Math.max(0, bounds.top + scroller.clientTop),
          bottom: Math.min(
            window.innerHeight,
            bounds.top + scroller.clientTop + scroller.clientHeight,
          ),
          left: Math.max(0, bounds.left + scroller.clientLeft),
          right: Math.min(
            window.innerWidth,
            bounds.left + scroller.clientLeft + scroller.clientWidth,
          ),
        },
        row,
        column,
      });
      // Use the footer slot as the containing block. Fixed positioning would
      // instead be captured by the transcript's CSS query container.
      const slotBounds = slot.getBoundingClientRect();
      const next: MessageActionPlacement =
        "top" in viewportPlacement
          ? {
              ...viewportPlacement,
              top: viewportPlacement.top - slotBounds.top,
              left: viewportPlacement.left - slotBounds.left,
            }
          : viewportPlacement;
      setPlacement((current) =>
        current.kind === next.kind &&
        (!("top" in current) ||
          ("top" in next && current.top === next.top && current.left === next.left))
          ? current
          : next,
      );
      if (toolbar.dataset.placement === "footer")
        setFooterHeight(toolbar.getBoundingClientRect().height);
    };
    const schedule = () => {
      if (frame === undefined) frame = requestAnimationFrame(update);
    };
    update();
    // Capture also handles an outer pane scrolling. Content observation covers
    // streaming and earlier rows growing without a scroll event.
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
    const observer = "ResizeObserver" in globalThis ? new ResizeObserver(schedule) : undefined;
    for (const element of [message, scroller, scroller.firstElementChild, toolbar]) {
      if (element) observer?.observe(element);
    }
    return () => {
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [children]);

  const floating = "top" in placement;
  const hidden = placement.kind === "hidden";
  return (
    <>
      {/* The grid places this stable exterior row before the body, including
          after a Work log card. Its normal grid gap separates actions and body. */}
      <div
        ref={clearanceRef}
        data-slot="message-action-clearance"
        aria-hidden="true"
        className="-order-1 h-7"
        style={{ height: clearanceHeight }}
      />
      <div
        ref={slotRef}
        data-slot="message-actions"
        className="relative mt-1.5 min-h-7"
        style={{ minHeight: footerHeight }}
      >
        <div
          ref={toolbarRef}
          data-slot="message-action-toolbar"
          data-placement={placement.kind}
          aria-label="Message actions"
          aria-hidden={hidden || undefined}
          inert={hidden}
          className={cn(
            "flex min-h-7 items-center gap-1 opacity-0 transition-opacity group-hover/msg:opacity-100 group-focus-within/msg:opacity-100",
            placement.kind === "side" ? "flex-col" : "flex-wrap",
            floating && "z-20 w-max rounded-md bg-background",
          )}
          style={
            floating
              ? { position: "absolute", top: placement.top, left: placement.left }
              : hidden
                ? { visibility: "hidden" }
                : undefined
          }
        >
          {children}
        </div>
      </div>
    </>
  );
}
