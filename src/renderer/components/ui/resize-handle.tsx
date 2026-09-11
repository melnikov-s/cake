import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "@/lib/utils";

export interface ResizeHandleProps {
  label: string;
  value: number;
  min: number;
  max: number;
  edge: "left" | "right" | "top" | "bottom";
  className?: string;
  onChange(value: number): void;
  /**
   * Provides a frame-coalesced pointer-drag preview. When supplied, `onChange`
   * is deferred until pointer release so callers can preview geometry without
   * re-rendering an expensive React tree for every pointer move.
   */
  onDrag?(value: number): void;
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
  onDrag,
  onResizeStart,
  onResizeEnd,
}: ResizeHandleProps) {
  const horizontal = edge === "top" || edge === "bottom";
  const direction = edge === "left" || edge === "top" ? 1 : -1;
  const drag = useRef<
    | {
        pointerId: number;
        position: number;
        value: number;
        previewValue: number;
        previewedValue?: number;
        moved: boolean;
      }
    | undefined
  >(undefined);
  const previewFrame = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      if (previewFrame.current !== undefined) cancelAnimationFrame(previewFrame.current);
    },
    [],
  );

  const flushPreview = () => {
    if (previewFrame.current !== undefined) {
      cancelAnimationFrame(previewFrame.current);
      previewFrame.current = undefined;
    }
    const current = drag.current;
    if (current?.moved && current.previewedValue !== current.previewValue) {
      onDrag?.(current.previewValue);
      current.previewedValue = current.previewValue;
    }
  };

  const finish = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (current?.pointerId !== event.pointerId) return;
    flushPreview();
    drag.current = undefined;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (onDrag && current.moved) onChange(current.previewValue);
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
          previewValue: value,
          moved: false,
        };
        event.currentTarget.setPointerCapture?.(event.pointerId);
        onResizeStart?.();
        event.preventDefault();
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (current?.pointerId !== event.pointerId) return;
        const position = horizontal ? event.clientY : event.clientX;
        const next = clamp(current.value + (position - current.position) * direction, min, max);
        current.previewValue = next;
        current.moved = true;
        event.currentTarget.setAttribute("aria-valuenow", String(Math.round(next)));
        if (!onDrag) {
          onChange(next);
          return;
        }
        if (previewFrame.current !== undefined) return;
        previewFrame.current = requestAnimationFrame(() => {
          previewFrame.current = undefined;
          const pending = drag.current;
          if (pending?.moved) {
            onDrag(pending.previewValue);
            pending.previewedValue = pending.previewValue;
          }
        });
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
    />
  );
}
