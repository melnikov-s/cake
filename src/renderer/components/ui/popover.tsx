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
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import { Button, type ButtonProps } from "./button";
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

export function Popover({ children, defaultOpen = false, open: controlledOpen, onOpenChange }: PopoverProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentId = useId();
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = useCallback((next: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  }, [controlledOpen, onOpenChange]);
  const value = useMemo(() => ({ contentId, open, setOpen, triggerRef }), [contentId, open, setOpen]);
  return <PopoverContext.Provider value={value}>{children}</PopoverContext.Provider>;
}

export function PopoverTrigger({ onClick, ...props }: ButtonProps) {
  const { contentId, open, setOpen, triggerRef } = usePopoverContext("PopoverTrigger");
  return <Button
    {...props}
    ref={triggerRef}
    aria-controls={contentId}
    aria-expanded={open}
    aria-haspopup="dialog"
    onClick={(event) => {
      onClick?.(event);
      if (!event.defaultPrevented) setOpen(!open);
    }}
  />;
}

export interface PopoverContentProps extends HTMLAttributes<HTMLDivElement> {
  align?: PopoverAlign;
  offset?: number;
  side?: PopoverSide;
}

export function PopoverContent({ align = "center", children, className, offset = 8, side = "bottom", style, ...props }: PopoverContentProps) {
  const { contentId, open, setOpen, triggerRef } = usePopoverContext("PopoverContent");
  const contentRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false });
  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    const content = contentRef.current;
    if (!trigger || !content) return;
    const next = calculatePopoverPosition(
      trigger.getBoundingClientRect(),
      content.getBoundingClientRect(),
      { width: window.innerWidth, height: window.innerHeight },
      side,
      align,
      offset
    );
    setPosition({ ...next, ready: true });
  }, [align, offset, side, triggerRef]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [open, updatePosition, children]);

  useEffect(() => {
    if (!open) return;
    const content = contentRef.current;
    const focusable = content?.querySelector<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
    focusable?.focus();
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || contentRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    const reposition = () => updatePosition();
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", escape);
    document.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    const observer = "ResizeObserver" in globalThis ? new globalThis.ResizeObserver(reposition) : undefined;
    if (contentRef.current) observer?.observe(contentRef.current);
    if (triggerRef.current) observer?.observe(triggerRef.current);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", escape);
      document.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
      observer?.disconnect();
    };
  }, [open, setOpen, triggerRef, updatePosition]);

  if (!open || !("document" in globalThis)) return null;
  return createPortal(<div
    {...props}
    id={contentId}
    ref={contentRef}
    role={props.role ?? "dialog"}
    className={cn("cake-popover-content", className)}
    style={{ ...style, left: position.left, top: position.top, visibility: position.ready ? "visible" : "hidden" }}
  >{children}</div>, document.body);
}

export function calculatePopoverPosition(
  trigger: Pick<DOMRect, "top" | "right" | "bottom" | "left" | "width" | "height">,
  content: Pick<DOMRect, "width" | "height">,
  viewport: { width: number; height: number },
  requestedSide: PopoverSide,
  align: PopoverAlign,
  offset: number
) {
  const margin = 8;
  let side = requestedSide;
  if (side === "bottom" && content.height > viewport.height - trigger.bottom - offset && trigger.top > viewport.height - trigger.bottom) side = "top";
  else if (side === "top" && content.height > trigger.top - offset && viewport.height - trigger.bottom > trigger.top) side = "bottom";
  else if (side === "right" && content.width > viewport.width - trigger.right - offset && trigger.left > viewport.width - trigger.right) side = "left";
  else if (side === "left" && content.width > trigger.left - offset && viewport.width - trigger.right > trigger.left) side = "right";

  let left = side === "right" ? trigger.right + offset : side === "left" ? trigger.left - content.width - offset : alignedCoordinate(trigger.left, trigger.width, content.width, align);
  let top = side === "bottom" ? trigger.bottom + offset : side === "top" ? trigger.top - content.height - offset : alignedCoordinate(trigger.top, trigger.height, content.height, align);
  left = Math.min(Math.max(margin, left), Math.max(margin, viewport.width - content.width - margin));
  top = Math.min(Math.max(margin, top), Math.max(margin, viewport.height - content.height - margin));
  return { left, top };
}

function alignedCoordinate(start: number, anchorSize: number, contentSize: number, align: PopoverAlign) {
  if (align === "start") return start;
  if (align === "end") return start + anchorSize - contentSize;
  return start + (anchorSize - contentSize) / 2;
}
