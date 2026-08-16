import { useRef, type KeyboardEvent, type PointerEvent } from "react";

export interface PanelResizeHandleProps {
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
export function PanelResizeHandle({ label, value, min, max, edge, className = "", onChange, onResizeStart, onResizeEnd }: PanelResizeHandleProps) {
  const horizontal = edge === "top" || edge === "bottom";
  const direction = edge === "left" || edge === "top" ? 1 : -1;
  const drag = useRef<{ pointerId: number; position: number; value: number } | undefined>(undefined);
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
  return <div
    className={`panel-resize-handle panel-resize-handle-${edge} ${className}`.trim()}
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
      drag.current = { pointerId: event.pointerId, position: horizontal ? event.clientY : event.clientX, value };
      event.currentTarget.setPointerCapture?.(event.pointerId);
      onResizeStart?.();
      event.preventDefault();
    }}
    onPointerMove={(event) => {
      if (drag.current?.pointerId !== event.pointerId) return;
      const position = horizontal ? event.clientY : event.clientX;
      onChange(clamp(drag.current.value + (position - drag.current.position) * direction, min, max));
    }}
    onPointerUp={finish}
    onPointerCancel={finish}
  />;
}
