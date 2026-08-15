import { useRef, type KeyboardEvent, type PointerEvent } from "react";

export interface PanelResizeHandleProps {
  label: string;
  value: number;
  min: number;
  max: number;
  edge: "left" | "right";
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
  const drag = useRef<{ pointerId: number; clientX: number; value: number } | undefined>(undefined);
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = undefined;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    onResizeEnd?.();
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const direction = edge === "left" ? 1 : -1;
    const step = event.shiftKey ? 48 : 16;
    let next: number | undefined;
    if (event.key === "ArrowLeft") next = value - step * direction;
    else if (event.key === "ArrowRight") next = value + step * direction;
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
    aria-orientation="vertical"
    aria-valuemin={min}
    aria-valuemax={max}
    aria-valuenow={Math.round(value)}
    tabIndex={0}
    onKeyDown={keyDown}
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      drag.current = { pointerId: event.pointerId, clientX: event.clientX, value };
      event.currentTarget.setPointerCapture?.(event.pointerId);
      onResizeStart?.();
      event.preventDefault();
    }}
    onPointerMove={(event) => {
      if (drag.current?.pointerId !== event.pointerId) return;
      const direction = edge === "left" ? 1 : -1;
      onChange(clamp(drag.current.value + (event.clientX - drag.current.clientX) * direction, min, max));
    }}
    onPointerUp={finish}
    onPointerCancel={finish}
  />;
}
