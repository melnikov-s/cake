import { useEffect, useRef } from "react";
import type { CapturePoint, CaptureRect } from "../../../contracts/desktop/screen-capture-data";
import { adjustCaptureBounds, type CaptureBoundsHandle } from "../../screen-capture/capture-bounds";
import { cn } from "../../lib/utils";
import { Button } from "./button";

const handles = [
  ["nw", "top-0 left-0", "cursor-nwse-resize"],
  ["n", "top-0 left-1/2", "cursor-ns-resize"],
  ["ne", "top-0 left-full", "cursor-nesw-resize"],
  ["e", "top-1/2 left-full", "cursor-ew-resize"],
  ["se", "top-full left-full", "cursor-nwse-resize"],
  ["s", "top-full left-1/2", "cursor-ns-resize"],
  ["sw", "top-full left-0", "cursor-nesw-resize"],
  ["w", "top-1/2 left-0", "cursor-ew-resize"],
] as const;

/** Capture-only chrome. Geometry and pointer routing use screenshot pixels, not screen origin. */
export function CaptureBounds({
  rect,
  width,
  height,
  onChange,
}: {
  rect: CaptureRect;
  width: number;
  height: number;
  onChange(rect: CaptureRect): void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const drag = useRef<
    | {
        pointerId: number;
        start: CapturePoint;
        rect: CaptureRect;
        handle: CaptureBoundsHandle;
      }
    | undefined
  >(undefined);
  const callbacks = useRef({ onChange });
  callbacks.current = { onChange };
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const current = drag.current;
      const bounds = surface.current?.getBoundingClientRect();
      if (!current || !bounds || current.pointerId !== event.pointerId) return;
      callbacks.current.onChange(
        adjustCaptureBounds(
          current.rect,
          current.handle,
          {
            x: ((event.clientX - current.start.x) * width) / bounds.width,
            y: ((event.clientY - current.start.y) * height) / bounds.height,
          },
          width,
          height,
        ),
      );
    };
    const end = (event: PointerEvent) => {
      if (drag.current?.pointerId !== event.pointerId) return;
      if (event.type === "pointerup") move(event);
      drag.current = undefined;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [width, height]);
  const begin = (event: React.PointerEvent<HTMLButtonElement>, handle: CaptureBoundsHandle) => {
    if (event.button !== 0 || drag.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      rect,
      handle,
    };
  };
  return (
    <div ref={surface} className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      <div
        role="group"
        aria-label="Capture bounds"
        className="absolute"
        style={{
          left: `${(rect.x / width) * 100}%`,
          top: `${(rect.y / height) * 100}%`,
          width: `${(rect.width / width) * 100}%`,
          height: `${(rect.height / height) * 100}%`,
        }}
      >
        <Button
          variant="ghost"
          aria-label="Move capture bounds"
          tabIndex={-1}
          className="pointer-events-auto absolute inset-0 h-full w-full cursor-move touch-none rounded-none border-2 border-ring p-0 hover:bg-transparent active:scale-100 active:bg-transparent"
          onPointerDown={(event) => begin(event, "move")}
        />
        {handles.map(([handle, position, cursor]) => (
          <Button
            key={handle}
            variant="outline"
            aria-label={`Resize capture bounds ${handle}`}
            tabIndex={-1}
            className={cn(
              "pointer-events-auto absolute size-4 min-h-0 -translate-x-1/2 -translate-y-1/2 touch-none rounded-sm border-ring bg-background p-0 active:scale-100",
              position,
              cursor,
            )}
            onPointerDown={(event) => begin(event, handle)}
          />
        ))}
      </div>
    </div>
  );
}
