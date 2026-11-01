import { useEffect, useRef, useState } from "react";
import {
  captureDrawingAnchor,
  type CaptureDrawing,
  type CaptureMode,
  type CapturePoint,
  type CaptureRect,
} from "../../../contracts/desktop/screen-capture-data";
import {
  captureMarker,
  loadCaptureImage,
  paintCapture,
  paintCaptureSelection,
} from "../../screen-capture/render-capture";
import type { CaptureAnnotationColor } from "../../../utils/capture-annotation-colors";
import { Button } from "./button";
import { cn } from "../../lib/utils";

/** Controlled screenshot editing surface. DOM measurements and pointer capture stay here;
 * the workflow owner decides whether a gesture crops or creates an annotation.
 */
export function CaptureCanvas({
  image,
  drawings,
  selection,
  mode,
  disabled,
  onEdit,
  onBegin,
  onMove,
  onEnd,
  onAbandon,
  color,
  onError,
}: {
  image: string;
  drawings: readonly CaptureDrawing[];
  selection?: CaptureRect;
  mode: CaptureMode;
  disabled?: boolean;
  onEdit(index: number): void;
  onBegin(point: CapturePoint): void;
  onMove(point: CapturePoint): void;
  onEnd(point: CapturePoint): void;
  onAbandon(): void;
  color: CaptureAnnotationColor;
  onError(error: unknown): void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loaded, setLoaded] = useState<HTMLImageElement>();
  const activePointer = useRef<number | undefined>(undefined);
  const callbacks = useRef({ onMove, onEnd, onAbandon, onError });
  callbacks.current = { onMove, onEnd, onAbandon, onError };
  useEffect(() => {
    // Losing pointer capture only changes event routing. Keep the gesture until release
    // or an actual pointercancel, including when the pointer ends over the toolbar.
    const move = (event: PointerEvent) => {
      const canvas = canvasRef.current;
      if (canvas && activePointer.current === event.pointerId)
        callbacks.current.onMove(capturePoint(canvas, event));
    };
    const end = (event: PointerEvent) => {
      const canvas = canvasRef.current;
      if (!canvas || activePointer.current !== event.pointerId) return;
      activePointer.current = undefined;
      const point = capturePoint(canvas, event);
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      callbacks.current.onEnd(point);
    };
    const cancel = (event: PointerEvent) => {
      if (activePointer.current !== event.pointerId) return;
      activePointer.current = undefined;
      callbacks.current.onAbandon();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", cancel);
      activePointer.current = undefined;
    };
  }, []);
  useEffect(() => {
    let active = true;
    void loadCaptureImage(image)
      .then((result) => {
        if (active) setLoaded(result);
      })
      .catch((error: unknown) => {
        if (active) callbacks.current.onError(error);
      });
    return () => {
      active = false;
    };
  }, [image]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !loaded) return;
    canvas.width = loaded.naturalWidth;
    canvas.height = loaded.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) return;
    paintCapture(context, loaded, drawings, color);
    if (selection) {
      paintCaptureSelection(
        context,
        selection,
        color,
        Math.max(1, Math.max(canvas.width, canvas.height) / 1800),
      );
    }
  }, [loaded, drawings, selection, color]);
  return (
    <div className="relative h-full w-full">
      <canvas
        ref={canvasRef}
        aria-label={
          mode === "crop"
            ? "Drag to capture a region"
            : mode === "freehand"
              ? "Drag to draw freehand"
              : "Drag to draw an arrow"
        }
        data-slot="capture-canvas"
        className={cn(
          "block h-full w-full touch-none",
          mode === "crop" ? "cursor-crosshair" : "cursor-cell",
          disabled && "pointer-events-none",
        )}
        onPointerDown={(event) => {
          if (event.button !== 0 || !loaded || disabled || activePointer.current !== undefined)
            return;
          event.preventDefault();
          activePointer.current = event.pointerId;
          event.currentTarget.setPointerCapture(event.pointerId);
          onBegin(capturePoint(event.currentTarget, event));
        }}
      />
      {loaded &&
        drawings.map((drawing, index) => {
          const marker = captureMarker(
            captureDrawingAnchor(drawing),
            loaded.naturalWidth,
            loaded.naturalHeight,
          );
          return (
            <Button
              key={index}
              variant="ghost"
              aria-label={`Edit annotation ${index + 1}`}
              disabled={disabled}
              className="absolute z-10 min-h-6 min-w-6 -translate-x-1/2 -translate-y-1/2 rounded-full p-0 opacity-0 focus-visible:opacity-100"
              style={{
                left: `${(marker.x / loaded.naturalWidth) * 100}%`,
                top: `${(marker.y / loaded.naturalHeight) * 100}%`,
                width: `${((marker.radius * 2) / loaded.naturalWidth) * 100}%`,
                height: `${((marker.radius * 2) / loaded.naturalHeight) * 100}%`,
              }}
              onClick={() => onEdit(index)}
            >
              {index + 1}
            </Button>
          );
        })}
    </div>
  );
}

function capturePoint(
  canvas: HTMLCanvasElement,
  event: { clientX: number; clientY: number },
): CapturePoint {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: Math.max(
      0,
      Math.min(canvas.width, ((event.clientX - bounds.left) * canvas.width) / bounds.width),
    ),
    y: Math.max(
      0,
      Math.min(canvas.height, ((event.clientY - bounds.top) * canvas.height) / bounds.height),
    ),
  };
}
