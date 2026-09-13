import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type RefObject,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Button, type ButtonProps } from "./button";
import { IconButton, type IconButtonProps } from "./icon-button";
import { cn } from "@/lib/utils";

type PopoverSide = "top" | "right" | "bottom" | "left";
type PopoverAlign = "start" | "center" | "end";

interface PopoverContextValue {
  contentId: string;
  open: boolean;
  setOpen(open: boolean): void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}

const PopoverContext = createContext<PopoverContextValue | null>(null);

function usePopoverContext(component: string) {
  const context = useContext(PopoverContext);
  if (!context) throw new Error(`${component} must be rendered inside Popover`);
  return context;
}

export interface PopoverProps {
  children: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?(open: boolean): void;
}

export function Popover({
  children,
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
}: PopoverProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentId = useId();
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = useCallback(
    (next: boolean) => {
      if (controlledOpen === undefined) setUncontrolledOpen(next);
      onOpenChangeRef.current?.(next);
    },
    [controlledOpen],
  );
  const value = useMemo(
    () => ({ contentId, open, setOpen, triggerRef }),
    [contentId, open, setOpen],
  );
  return <PopoverContext.Provider value={value}>{children}</PopoverContext.Provider>;
}

export function PopoverTrigger({
  onClick,
  "aria-haspopup": ariaHasPopup = "dialog",
  ...props
}: ButtonProps) {
  const { contentId, open, setOpen, triggerRef } = usePopoverContext("PopoverTrigger");
  return (
    <Button
      {...props}
      ref={triggerRef}
      aria-controls={contentId}
      aria-expanded={open}
      aria-haspopup={ariaHasPopup}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) setOpen(!open);
      }}
    />
  );
}

export function PopoverIconTrigger({
  onClick,
  "aria-haspopup": ariaHasPopup = "dialog",
  ...props
}: IconButtonProps) {
  const { contentId, open, setOpen, triggerRef } = usePopoverContext("PopoverIconTrigger");
  return (
    <IconButton
      {...props}
      ref={triggerRef}
      aria-controls={contentId}
      aria-expanded={open}
      aria-haspopup={ariaHasPopup}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) setOpen(!open);
      }}
    />
  );
}

export interface PopoverContentProps extends HTMLAttributes<HTMLDivElement> {
  align?: PopoverAlign;
  anchorRef?: RefObject<HTMLButtonElement | null>;
  /** Constrain the surface to the nearest ancestor marked as a popover boundary. */
  boundary?: "viewport" | "nearest-ancestor";
  offset?: number;
  side?: PopoverSide;
  motion?: "none" | "bouncy";
}

export function PopoverContent({
  align = "center",
  anchorRef,
  boundary = "viewport",
  children,
  className,
  offset = 8,
  side = "bottom",
  motion = "none",
  style,
  ...props
}: PopoverContentProps) {
  const { contentId, open, setOpen, triggerRef } = usePopoverContext("PopoverContent");
  const effectiveAnchorRef = anchorRef ?? triggerRef;
  const contentRef = useRef<HTMLDivElement>(null);
  // DOM presence only: dismissal remains immediate while the visual shell collapses.
  const [exiting, setExiting] = useState(false);
  const interruptedFrame = useRef<Keyframe | null>(null);
  const [position, setPosition] = useState({
    left: 0,
    top: 0,
    originX: 0,
    originY: 0,
    ready: false,
  });
  const updatePosition = useCallback(() => {
    const anchor = effectiveAnchorRef.current;
    const content = contentRef.current;
    if (!anchor || !content) return;
    const boundaryElement =
      boundary === "nearest-ancestor"
        ? anchor.closest<HTMLElement>("[data-popover-boundary]")
        : null;
    const next = calculatePopoverPosition(
      anchor.getBoundingClientRect(),
      { width: content.offsetWidth, height: content.offsetHeight },
      boundaryElement?.getBoundingClientRect() ?? {
        left: 0,
        top: 0,
        right: window.innerWidth,
        bottom: window.innerHeight,
      },
      side,
      align,
      offset,
    );
    const anchorRect = anchor.getBoundingClientRect();
    setPosition({
      ...next,
      originX: Math.max(
        0,
        Math.min(content.offsetWidth, anchorRect.left + anchorRect.width / 2 - next.left),
      ),
      originY: Math.max(
        0,
        Math.min(content.offsetHeight, anchorRect.top + anchorRect.height / 2 - next.top),
      ),
      ready: true,
    });
  }, [align, boundary, effectiveAnchorRef, offset, side]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [open, updatePosition, children]);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (motion !== "bouncy" || !content) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setExiting(false);
      return;
    }
    if (open) setExiting(true);
    const from = interruptedFrame.current ?? {
      opacity: open ? 0 : 1,
      transform: open ? "scale(0.78, 0.86)" : "scale(1)",
    };
    interruptedFrame.current = null;
    const animation = content.animate(
      open
        ? [
            { ...from, easing: "cubic-bezier(0.22, 0.8, 0.3, 1)" },
            { opacity: 1, transform: "scale(1.035, 1.02)", offset: 0.6, easing: "ease-in-out" },
            { opacity: 1, transform: "scale(0.993, 0.996)", offset: 0.82, easing: "ease-in-out" },
            { opacity: 1, transform: "scale(1)" },
          ]
        : [from, { opacity: 0, transform: "scale(0.78, 0.86)" }],
      {
        duration: open ? 420 : 180,
        easing: open ? "linear" : "cubic-bezier(0.4, 0, 1, 1)",
        fill: "both",
      },
    );
    animation.onfinish = () => {
      if (!open) setExiting(false);
    };
    return () => {
      if (animation.playState === "running") {
        const computed = getComputedStyle(content);
        interruptedFrame.current = { opacity: computed.opacity, transform: computed.transform };
      }
      animation.onfinish = null;
      animation.cancel();
    };
  }, [motion, open]);

  const prevOpenRef = useRef(false);
  useEffect(() => {
    if (!open) {
      prevOpenRef.current = false;
      return;
    }
    if (!prevOpenRef.current) {
      prevOpenRef.current = true;
      const content = contentRef.current;
      if (content && !content.contains(document.activeElement)) {
        const focusable = content.querySelector<HTMLElement>(
          'input:not([disabled]), button:not([disabled]), [href], select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        focusable?.focus();
      }
    }
  }, [open]);

  const updatePositionRef = useRef(updatePosition);
  updatePositionRef.current = updatePosition;
  const setOpenRef = useRef(setOpen);
  setOpenRef.current = setOpen;

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (
        !(target instanceof Node) ||
        contentRef.current?.contains(target) ||
        effectiveAnchorRef.current?.contains(target)
      )
        return;
      setOpenRef.current(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpenRef.current(false);
      effectiveAnchorRef.current?.focus();
    };
    const reposition = () => updatePositionRef.current();
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", escape);
    document.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    const observer =
      "ResizeObserver" in globalThis ? new globalThis.ResizeObserver(reposition) : undefined;
    if (contentRef.current) observer?.observe(contentRef.current);
    if (effectiveAnchorRef.current) observer?.observe(effectiveAnchorRef.current);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", escape);
      document.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
      observer?.disconnect();
    };
  }, [effectiveAnchorRef, open]);

  if ((!open && !exiting) || !("document" in globalThis)) return null;
  return createPortal(
    <div
      {...props}
      id={contentId}
      ref={contentRef}
      role={props.role ?? "dialog"}
      inert={!open}
      aria-hidden={!open || undefined}
      data-state={open ? "open" : "closed"}
      className={cn(
        "fixed z-50 max-h-[calc(100vh-16px)] max-w-[calc(100vw-16px)] overflow-auto rounded-xl border border-border bg-card p-3 text-foreground shadow-2xl",
        !open && "pointer-events-none",
        className,
      )}
      style={{
        ...style,
        left: position.left,
        top: position.top,
        transformOrigin:
          motion === "bouncy" ? `${position.originX}px ${position.originY}px` : undefined,
        visibility: position.ready ? "visible" : "hidden",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

export function calculatePopoverPosition(
  trigger: Pick<DOMRect, "top" | "right" | "bottom" | "left" | "width" | "height">,
  content: Pick<DOMRect, "width" | "height">,
  boundary: {
    left?: number;
    top?: number;
    right?: number;
    bottom?: number;
    width?: number;
    height?: number;
  },
  requestedSide: PopoverSide,
  align: PopoverAlign,
  offset: number,
) {
  const margin = 8;
  const boundaryLeft = boundary.left ?? 0;
  const boundaryTop = boundary.top ?? 0;
  const boundaryRight = boundary.right ?? boundaryLeft + (boundary.width ?? 0);
  const boundaryBottom = boundary.bottom ?? boundaryTop + (boundary.height ?? 0);
  const roomAbove = trigger.top - boundaryTop;
  const roomBelow = boundaryBottom - trigger.bottom;
  const roomLeft = trigger.left - boundaryLeft;
  const roomRight = boundaryRight - trigger.right;
  let side = requestedSide;
  if (side === "bottom" && content.height > roomBelow - offset && roomAbove > roomBelow)
    side = "top";
  else if (side === "top" && content.height > roomAbove - offset && roomBelow > roomAbove)
    side = "bottom";
  else if (side === "right" && content.width > roomRight - offset && roomLeft > roomRight)
    side = "left";
  else if (side === "left" && content.width > roomLeft - offset && roomRight > roomLeft)
    side = "right";

  let left =
    side === "right"
      ? trigger.right + offset
      : side === "left"
        ? trigger.left - content.width - offset
        : alignedCoordinate(trigger.left, trigger.width, content.width, align);
  let top =
    side === "bottom"
      ? trigger.bottom + offset
      : side === "top"
        ? trigger.top - content.height - offset
        : alignedCoordinate(trigger.top, trigger.height, content.height, align);
  left = Math.min(
    Math.max(boundaryLeft + margin, left),
    Math.max(boundaryLeft + margin, boundaryRight - content.width - margin),
  );
  top = Math.min(
    Math.max(boundaryTop + margin, top),
    Math.max(boundaryTop + margin, boundaryBottom - content.height - margin),
  );
  return { left, top };
}

function alignedCoordinate(
  start: number,
  anchorSize: number,
  contentSize: number,
  align: PopoverAlign,
) {
  if (align === "start") return start;
  if (align === "end") return start + anchorSize - contentSize;
  return start + (anchorSize - contentSize) / 2;
}
