import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Popover, PopoverContent } from "./popover";

// Window-level input evidence, recorded before React handlers run. Mounting,
// reordering or scrolling content under a resting cursor makes Chromium resend
// pointer events at an unchanged position, and programmatic focus looks like
// any other focus; neither is a request to read the description.
let lastPointer: { x: number; y: number } | undefined;
let pointerTraveled = false;
let keyboardNavigating = false;
const NAVIGATION_KEYS = new Set([
  "Tab",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);
const listenerOptions = { capture: true, passive: true };
window.addEventListener(
  "pointermove",
  (event) => {
    pointerTraveled =
      lastPointer !== undefined &&
      (lastPointer.x !== event.clientX || lastPointer.y !== event.clientY);
    lastPointer = { x: event.clientX, y: event.clientY };
  },
  listenerOptions,
);
window.addEventListener(
  "keydown",
  (event) => {
    keyboardNavigating = NAVIGATION_KEYS.has(event.key);
  },
  listenerOptions,
);
window.addEventListener("pointerdown", () => (keyboardNavigating = false), listenerOptions);

/** Selectable supplementary prose without reflowing or stealing focus from its row. */
export function HoverCard({
  description,
  descriptionId: id,
  children,
}: {
  description: string;
  descriptionId: string;
  children: ReactNode;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const timer = useRef<{ kind: "show" | "hide"; id: ReturnType<typeof setTimeout> }>(undefined);
  // Keyboard focus on the row holds the card open; pointer-click focus does not.
  const focusHeld = useRef(false);
  const [open, setOpen] = useState(false);
  const cancel = () => {
    clearTimeout(timer.current?.id);
    timer.current = undefined;
  };
  const show = () => {
    if (timer.current?.kind === "show" || !description) return;
    cancel();
    timer.current = {
      kind: "show",
      id: setTimeout(() => {
        timer.current = undefined;
        setOpen(true);
      }, 180),
    };
  };
  const hide = () => {
    cancel();
    timer.current = {
      kind: "hide",
      id: setTimeout(() => {
        timer.current = undefined;
        const active = document.activeElement;
        if (
          (focusHeld.current && anchor.current?.contains(active)) ||
          document.getElementById(id)?.parentElement?.contains(active)
        )
          return;
        focusHeld.current = false;
        setOpen(false);
      }, 200),
    };
  };
  const dismiss = () => {
    cancel();
    focusHeld.current = false;
    setOpen(false);
  };
  const escape = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    event.stopPropagation();
    if (!anchor.current?.contains(document.activeElement))
      anchor.current
        ?.querySelector<HTMLElement>("[aria-describedby]")
        ?.focus({ preventScroll: true });
    dismiss();
  };
  useEffect(() => () => clearTimeout(timer.current?.id), []);
  return (
    <Popover open={open && Boolean(description)} onOpenChange={(next) => !next && dismiss()}>
      <div
        ref={anchor}
        onPointerMove={(event) => {
          if (!(event.target instanceof Element)) return;
          const control = event.target.closest("a, button");
          if (control && !control.hasAttribute("aria-describedby")) dismiss();
          else if (pointerTraveled) show();
        }}
        onPointerLeave={hide}
        onFocusCapture={(event) => {
          if (!(event.target instanceof Element) || !event.target.hasAttribute("aria-describedby"))
            dismiss();
          else if (keyboardNavigating) {
            focusHeld.current = true;
            show();
          }
        }}
        onBlurCapture={hide}
        onContextMenuCapture={dismiss}
        onKeyDownCapture={escape}
      >
        {children}
      </div>
      <PopoverContent
        anchorRef={anchor}
        boundary="nearest-ancestor"
        side="left-or-vertical"
        align="start"
        role="tooltip"
        focusOnOpen={false}
        tabIndex={0}
        className="w-80 whitespace-pre-wrap break-words p-3 text-xs font-normal leading-relaxed select-text"
        onKeyDownCapture={escape}
        onPointerEnter={cancel}
        onPointerLeave={hide}
        onFocusCapture={cancel}
        onBlurCapture={hide}
      >
        <span id={id}>{description}</span>
      </PopoverContent>
    </Popover>
  );
}
