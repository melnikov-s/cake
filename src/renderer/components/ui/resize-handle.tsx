import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
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
  const endDrag = useRef<(() => void) | undefined>(undefined);
  const live = useRef({ min, max, onChange, onDrag, onResizeEnd });
  useLayoutEffect(() => {
    live.current = { min, max, onChange, onDrag, onResizeEnd };
  });

  useEffect(() => () => endDrag.current?.(), []);

  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || endDrag.current) return;
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const position = horizontal ? event.clientY : event.clientX;
    let previewValue = value;
    let previewedValue: number | undefined;
    let moved = false;
    let previewFrame: number | undefined;

    const flushPreview = () => {
      if (previewFrame !== undefined) {
        cancelAnimationFrame(previewFrame);
        previewFrame = undefined;
      }
      if (moved && previewedValue !== previewValue) {
        live.current.onDrag?.(previewValue);
        previewedValue = previewValue;
      }
    };
    const finish = () => {
      if (endDrag.current !== finish) return;
      // Clear ownership/listeners before releasing capture: that can itself
      // dispatch lostpointercapture. Every exit must commit/end exactly once.
      endDrag.current = undefined;
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
      window.removeEventListener("blur", finish);
      document.removeEventListener("visibilitychange", visibilityChange);
      handle.removeEventListener("lostpointercapture", release);
      flushPreview();
      if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
      if (live.current.onDrag && moved) live.current.onChange(previewValue);
      live.current.onResizeEnd?.();
    };
    const release = (event: globalThis.PointerEvent) => {
      if (event.pointerId === pointerId) finish();
    };
    const visibilityChange = () => {
      if (document.hidden) finish();
    };
    const move = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      // Recover if the OS/browser swallowed the release during an interruption.
      if ((event.buttons & 1) === 0) {
        finish();
        return;
      }
      const nextPosition = horizontal ? event.clientY : event.clientX;
      previewValue = clamp(
        value + (nextPosition - position) * direction,
        live.current.min,
        live.current.max,
      );
      moved = true;
      handle.setAttribute("aria-valuenow", String(Math.round(previewValue)));
      if (!live.current.onDrag) {
        live.current.onChange(previewValue);
        return;
      }
      if (previewFrame !== undefined) return;
      previewFrame = requestAnimationFrame(() => {
        previewFrame = undefined;
        flushPreview();
      });
    };

    endDrag.current = finish;
    // Window capture listeners also see release outside the handle (or when
    // another surface stops propagation); pointer capture is not our only exit.
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
    window.addEventListener("blur", finish);
    document.addEventListener("visibilitychange", visibilityChange);
    handle.addEventListener("lostpointercapture", release);
    handle.setPointerCapture?.(pointerId);
    onResizeStart?.();
    event.preventDefault();
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
      onPointerDown={start}
    />
  );
}
