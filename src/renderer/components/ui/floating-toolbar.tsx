import { useEffect, useRef, useState, type HTMLAttributes } from "react";
import { cn } from "../../lib/utils";
import { IconButton } from "./icon-button";
import { GripIcon } from "./icons";

/** Content-sized floating controls. Only their actual footprint intercepts canvas input.
 * Geometry is transient DOM state, owned by this mounted primitive, never persisted.
 */
export function FloatingToolbar({ children, className, ...props }: HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number } | undefined>(undefined);
  const [position, setPosition] = useState<{ left: number; top: number } | undefined>(undefined);
  const moveTo = (left: number, top: number) => {
    const bounds = ref.current?.getBoundingClientRect();
    if (!bounds) return;
    setPosition({
      left: Math.max(8, Math.min(left, window.innerWidth - bounds.width - 8)),
      top: Math.max(8, Math.min(top, window.innerHeight - bounds.height - 8)),
    });
  };
  useEffect(() => {
    const clamp = () => {
      const bounds = ref.current?.getBoundingClientRect();
      if (bounds) moveTo(bounds.left, bounds.top);
    };
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, []);
  return (
    <div
      {...props}
      ref={ref}
      className={cn(
        "absolute z-20 flex max-w-[calc(100vw-16px)] items-center gap-1 rounded-lg border border-border/85 bg-popover/95 p-1 text-popover-foreground shadow-xl ring-1 ring-black/5 dark:ring-white/10 backdrop-blur-xl",
        !position && "top-4 left-1/2 -translate-x-1/2",
        className,
      )}
      style={position}
    >
      <IconButton
        tooltip="Move capture toolbar"
        ariaLabel="Move capture toolbar"
        className="shrink-0 touch-none cursor-grab active:cursor-grabbing"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const bounds = ref.current?.getBoundingClientRect();
          if (!bounds) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            pointerId: event.pointerId,
            x: event.clientX - bounds.left,
            y: event.clientY - bounds.top,
          };
        }}
        onPointerMove={(event) => {
          const current = drag.current;
          if (current?.pointerId === event.pointerId)
            moveTo(event.clientX - current.x, event.clientY - current.y);
        }}
        onPointerUp={(event) => {
          drag.current = undefined;
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onLostPointerCapture={() => {
          drag.current = undefined;
        }}
        onKeyDown={(event) => {
          const delta = event.shiftKey ? 40 : 10;
          const bounds = ref.current?.getBoundingClientRect();
          if (!bounds || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key))
            return;
          event.preventDefault();
          moveTo(
            bounds.left +
              (event.key === "ArrowLeft" ? -delta : event.key === "ArrowRight" ? delta : 0),
            bounds.top + (event.key === "ArrowUp" ? -delta : event.key === "ArrowDown" ? delta : 0),
          );
        }}
      >
        <GripIcon />
      </IconButton>
      {children}
    </div>
  );
}
