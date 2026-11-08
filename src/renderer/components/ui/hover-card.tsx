import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Popover, PopoverContent } from "./popover";

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
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const cancel = () => clearTimeout(timer.current);
  const show = () => {
    cancel();
    if (description) timer.current = setTimeout(() => setOpen(true), 180);
  };
  const hide = () => {
    cancel();
    timer.current = setTimeout(() => {
      const active = document.activeElement;
      if (
        anchor.current?.contains(active) ||
        document.getElementById(id)?.parentElement?.contains(active)
      )
        return;
      setOpen(false);
    }, 200);
  };
  const dismiss = () => {
    cancel();
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
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <Popover open={open && Boolean(description)} onOpenChange={(next) => !next && dismiss()}>
      <div
        ref={anchor}
        onPointerOver={(event) => {
          if (!(event.target instanceof Element)) return;
          const control = event.target.closest("a, button");
          if (control && !control.hasAttribute("aria-describedby")) dismiss();
          else show();
        }}
        onPointerLeave={hide}
        onFocusCapture={(event) => {
          if (event.target instanceof Element && event.target.hasAttribute("aria-describedby"))
            show();
          else dismiss();
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
