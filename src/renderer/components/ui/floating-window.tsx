import {
  useCallback,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { cn } from "@/lib/utils";
import { TrafficLights } from "./traffic-lights";

/** Placement and size of a floating window. `height: "auto"` sizes to content. */
export interface FloatingWindowGeometry {
  left: number;
  top: number;
  width: number;
  height: number | "auto";
}

export const FLOATING_WINDOW_MARGIN = 12;
const FLOATING_WINDOW_MIN_WIDTH = 320;
const FLOATING_WINDOW_MIN_HEIGHT = 240;

type ResizeDirection = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const resizeEdgeClass = {
  n: "inset-x-3 top-0 h-2 cursor-n-resize",
  s: "inset-x-3 bottom-0 h-2 cursor-s-resize",
  e: "inset-y-3 right-0 w-2 cursor-e-resize",
  w: "inset-y-3 left-0 w-2 cursor-w-resize",
  ne: "right-0 top-0 size-3.5 cursor-ne-resize",
  nw: "left-0 top-0 size-3.5 cursor-nw-resize",
  se: "bottom-0 right-0 size-3.5 cursor-se-resize",
  sw: "bottom-0 left-0 size-3.5 cursor-sw-resize",
} satisfies Record<ResizeDirection, string>;

const resizeDirections: readonly ResizeDirection[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

/** Keeps a floating window inside the viewport with the minimum size enforced. */
export function clampFloatingWindowGeometry(
  geometry: FloatingWindowGeometry,
  measuredAutoHeight?: number,
  minWidth = FLOATING_WINDOW_MIN_WIDTH,
  minHeight = FLOATING_WINDOW_MIN_HEIGHT,
): FloatingWindowGeometry {
  const maxWidth = Math.max(minWidth, window.innerWidth - FLOATING_WINDOW_MARGIN * 2);
  const maxHeight = Math.max(minHeight, window.innerHeight - FLOATING_WINDOW_MARGIN * 2);
  const width = clamp(geometry.width, minWidth, maxWidth);
  const height = geometry.height === "auto" ? "auto" : clamp(geometry.height, minHeight, maxHeight);
  const boundedHeight = height === "auto" ? (measuredAutoHeight ?? 0) : height;
  return {
    left: clamp(
      geometry.left,
      FLOATING_WINDOW_MARGIN,
      Math.max(FLOATING_WINDOW_MARGIN, window.innerWidth - width - FLOATING_WINDOW_MARGIN),
    ),
    top: clamp(
      geometry.top,
      FLOATING_WINDOW_MARGIN,
      Math.max(FLOATING_WINDOW_MARGIN, window.innerHeight - boundedHeight - FLOATING_WINDOW_MARGIN),
    ),
    width,
    height,
  };
}

/** Geometry that fills the window: the floating window's full-screen mode. */
export function maximizedFloatingWindowGeometry(): FloatingWindowGeometry {
  return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
}

export interface FloatingWindowProps {
  surfaceRef: RefObject<HTMLDivElement | null>;
  geometry: FloatingWindowGeometry;
  maximized: boolean;
  title: string;
  eyebrow?: string;
  /** Applied while the height is content-sized; e.g. a max-height cap. */
  autoHeightClassName?: string;
  onClose(): void;
  onToggleMaximize(): void;
  onGeometryChange(geometry: FloatingWindowGeometry): void;
  children: ReactNode;
}

/**
 * A floating window surface: draggable title bar with traffic lights, free
 * edge and corner resizing, and a maximized full-window mode. Geometry is
 * controlled; the owner stores it and decides what it means.
 */
export function FloatingWindow({
  surfaceRef,
  geometry,
  maximized,
  title,
  eyebrow = "Chat",
  autoHeightClassName,
  onClose,
  onToggleMaximize,
  onGeometryChange,
  children,
}: FloatingWindowProps) {
  const captureStart = useCallback(
    (event: ReactPointerEvent) => {
      const surface = surfaceRef.current;
      if (!surface) return undefined;
      const rect = surface.getBoundingClientRect();
      return {
        pointerX: event.clientX,
        pointerY: event.clientY,
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      };
    },
    [surfaceRef],
  );

  const startDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 || maximized) return;
      if (event.target instanceof Element && event.target.closest("button")) return;
      const start = captureStart(event);
      if (!start) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      const move = (moveEvent: PointerEvent) => {
        onGeometryChange(
          clampFloatingWindowGeometry(
            {
              left: start.left + moveEvent.clientX - start.pointerX,
              top: start.top + moveEvent.clientY - start.pointerY,
              width: start.width,
              height: geometry.height,
            },
            start.height,
          ),
        );
      };
      const stop = () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", stop);
        document.removeEventListener("pointercancel", stop);
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", stop);
      document.addEventListener("pointercancel", stop);
      event.preventDefault();
    },
    [geometry.height, maximized, onGeometryChange, captureStart],
  );

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLElement>, direction: ResizeDirection) => {
      if (event.button !== 0 || maximized) return;
      const start = captureStart(event);
      if (!start) return;
      // A content-sized height becomes a fixed height the moment it is resized.
      onGeometryChange({
        left: start.left,
        top: start.top,
        width: start.width,
        height: start.height,
      });
      const north = direction.includes("n");
      const south = direction.includes("s");
      const west = direction.includes("w");
      const east = direction.includes("e");
      event.currentTarget.setPointerCapture(event.pointerId);
      const move = (moveEvent: PointerEvent) => {
        const dx = moveEvent.clientX - start.pointerX;
        const dy = moveEvent.clientY - start.pointerY;
        let { left, top, width, height } = start;
        if (east)
          width = clamp(
            start.width + dx,
            FLOATING_WINDOW_MIN_WIDTH,
            window.innerWidth - FLOATING_WINDOW_MARGIN - start.left,
          );
        if (south)
          height = clamp(
            start.height + dy,
            FLOATING_WINDOW_MIN_HEIGHT,
            window.innerHeight - FLOATING_WINDOW_MARGIN - start.top,
          );
        if (west) {
          left = clamp(
            start.left + dx,
            FLOATING_WINDOW_MARGIN,
            start.left + start.width - FLOATING_WINDOW_MIN_WIDTH,
          );
          width = start.width + start.left - left;
        }
        if (north) {
          top = clamp(
            start.top + dy,
            FLOATING_WINDOW_MARGIN,
            start.top + start.height - FLOATING_WINDOW_MIN_HEIGHT,
          );
          height = start.height + start.top - top;
        }
        onGeometryChange({ left, top, width, height });
      };
      const stop = () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", stop);
        document.removeEventListener("pointercancel", stop);
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", stop);
      document.addEventListener("pointercancel", stop);
      event.preventDefault();
    },
    [maximized, onGeometryChange, captureStart],
  );

  const headerDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (event.target instanceof Element && event.target.closest("button")) return;
      onToggleMaximize();
    },
    [onToggleMaximize],
  );

  const autoHeight = geometry.height === "auto" && !maximized;
  const style: CSSProperties = {
    left: geometry.left,
    top: geometry.top,
    width: geometry.width,
    height: geometry.height === "auto" ? undefined : geometry.height,
  };

  return (
    <div
      ref={surfaceRef}
      className={cn(
        "fixed z-50 flex flex-col overflow-hidden border border-border bg-popover text-popover-foreground shadow-2xl",
        maximized ? "rounded-none border-0" : "rounded-xl",
        autoHeight && autoHeightClassName,
      )}
      style={style}
      role="dialog"
      aria-label={title}
    >
      <header
        className="flex touch-none shrink-0 cursor-grab select-none items-center gap-2 border-b border-border bg-muted/70 pr-3 pl-1.5 active:cursor-grabbing"
        onPointerDown={startDrag}
        onDoubleClick={headerDoubleClick}
      >
        <TrafficLights
          title={title}
          maximized={maximized}
          onClose={onClose}
          onToggleMaximize={onToggleMaximize}
        />
        <div className="min-w-0 flex-1 pl-1">
          <span className="block text-xs font-medium text-muted-foreground">{eyebrow}</span>
          <strong className="block truncate text-xs font-semibold text-foreground">{title}</strong>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
      {!maximized &&
        resizeDirections.map((direction) => (
          <div
            key={direction}
            aria-hidden="true"
            className={cn("absolute z-10 touch-none", resizeEdgeClass[direction])}
            onPointerDown={(event) => startResize(event, direction)}
          />
        ))}
    </div>
  );
}
