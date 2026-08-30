import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "@/lib/utils";

export interface ResizeHandleProps {
  label: string;
  value: number;
  min: number;
  max: number;
  edge: "left" | "right" | "top" | "bottom";
  className?: string;
  onChange(value: number): void;
  onResizeStart?(): void;
  onResizeEnd?(): void;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

/** A pointer- and keyboard-accessible separator for CSS-grid side panels. */
export function ResizeHandle({
  label,
  value,
  min,
  max,
  edge,
  className,
  onChange,
  onResizeStart,
  onResizeEnd,
}: ResizeHandleProps) {
  const horizontal = edge === "top" || edge === "bottom";
  const direction = edge === "left" || edge === "top" ? 1 : -1;
  const drag = useRef<{ pointerId: number; position: number; value: number } | undefined>(
    undefined,
  );

  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = undefined;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    onResizeEnd?.();
  };

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 48 : 16;
    let next: number | undefined;
    if (!horizontal && event.key === "ArrowLeft") next = value - step * direction;
    else if (!horizontal && event.key === "ArrowRight") next = value + step * direction;
    else if (horizontal && event.key === "ArrowUp") next = value - step * direction;
    else if (horizontal && event.key === "ArrowDown") next = value + step * direction;
    else if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    if (next === undefined) return;
    event.preventDefault();
    onChange(clamp(next, min, max));
  };

  return (
    <div
      className={cn(
        "absolute z-40 touch-none outline-none [app-region:no-drag] after:absolute after:bg-transparent after:content-[''] after:transition-all after:duration-100",
        horizontal
          ? "inset-x-0 h-[9px] cursor-row-resize after:inset-x-0 after:top-[4px] after:h-[1px]"
          : "inset-y-0 w-[9px] cursor-col-resize after:inset-y-0 after:left-[4px] after:w-[1px]",
        "hover:after:bg-accent hover:after:shadow-[0_0_0_1px_color-mix(in_oklab,var(--accent)_25%,transparent)]",
        "focus-visible:after:bg-accent focus-visible:after:shadow-[0_0_0_1px_color-mix(in_oklab,var(--accent)_25%,transparent)]",
        "active:after:bg-accent active:after:shadow-[0_0_0_1px_color-mix(in_oklab,var(--accent)_25%,transparent)]",
        className,
      )}
      role="separator"
      aria-label={label}
      aria-orientation={horizontal ? "horizontal" : "vertical"}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      onKeyDown={keyDown}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        drag.current = {
          pointerId: event.pointerId,
          position: horizontal ? event.clientY : event.clientX,
          value,
        };
        event.currentTarget.setPointerCapture?.(event.pointerId);
        onResizeStart?.();
        event.preventDefault();
      }}
      onPointerMove={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        const position = horizontal ? event.clientY : event.clientX;
        onChange(
          clamp(drag.current.value + (position - drag.current.position) * direction, min, max),
        );
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
    />
  );
}
