import { useEffect, useRef, useState } from "react";
import type {
  CaptureArrow,
  CapturePoint,
  CaptureRect,
} from "../../../contracts/desktop/screen-capture-data";
import {
  loadCaptureImage,
  paintCapture,
  type CapturePalette,
} from "../../screen-capture/render-capture";
import { cn } from "../../lib/utils";

/** Controlled screenshot editing surface. DOM measurements and pointer capture stay here;
 * the workflow owner decides whether a gesture crops or creates an annotation.
 */
export function CaptureCanvas({
  image,
  arrows,
  selection,
  mode,
  disabled,
  onBegin,
  onMove,
  onEnd,
  onAbandon,
  onPalette,
  onError,
}: {
  image: string;
  arrows: readonly CaptureArrow[];
  selection?: CaptureRect;
  mode: "crop" | "annotate";
  disabled?: boolean;
  onBegin(point: CapturePoint): void;
  onMove(point: CapturePoint): void;
  onEnd(point: CapturePoint): void;
  onAbandon(): void;
  onPalette(palette: CapturePalette): void;
  onError(error: unknown): void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loaded, setLoaded] = useState<HTMLImageElement>();
  const activePointer = useRef<number | undefined>(undefined);
  const callbacks = useRef({ onPalette, onError });
  callbacks.current = { onPalette, onError };
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
    const style = getComputedStyle(canvas);
    const palette = {
      ink: style.color,
      background: style.backgroundColor,
      foreground: getComputedStyle(canvas.parentElement ?? canvas).color,
    };
    callbacks.current.onPalette(palette);
    paintCapture(context, loaded, arrows, palette);
    if (selection) {
      context.strokeStyle = palette.ink;
      context.lineWidth = 2 * Math.max(1, canvas.width / canvas.getBoundingClientRect().width);
      context.setLineDash([6 * context.lineWidth, 3 * context.lineWidth]);
      context.strokeRect(selection.x, selection.y, selection.width, selection.height);
    }
  }, [loaded, arrows, selection]);
  const point = (event: React.PointerEvent<HTMLCanvasElement>): CapturePoint => {
    const canvas = event.currentTarget;
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
  };
  return (
    <canvas
      ref={canvasRef}
      aria-label={mode === "crop" ? "Drag to capture a region" : "Drag to draw an arrow"}
      data-slot="capture-canvas"
      className={cn(
        "block h-full w-full touch-none bg-background text-accent",
        mode === "crop" ? "cursor-crosshair" : "cursor-cell",
        disabled && "pointer-events-none",
      )}
      onPointerDown={(event) => {
        if (event.button !== 0 || !loaded || disabled || activePointer.current !== undefined)
          return;
        event.preventDefault();
        activePointer.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
        onBegin(point(event));
      }}
      onPointerMove={(event) => {
        if (activePointer.current === event.pointerId) onMove(point(event));
      }}
      onPointerUp={(event) => {
        if (activePointer.current !== event.pointerId) return;
        activePointer.current = undefined;
        event.currentTarget.releasePointerCapture(event.pointerId);
        onEnd(point(event));
      }}
      onPointerCancel={() => {
        activePointer.current = undefined;
        onAbandon();
      }}
      onLostPointerCapture={() => {
        if (activePointer.current !== undefined) {
          activePointer.current = undefined;
          onAbandon();
        }
      }}
    />
  );
}
