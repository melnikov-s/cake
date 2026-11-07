import type {
  CaptureDrawing,
  CapturePoint,
  CaptureRect,
} from "../../contracts/desktop/screen-capture-data";

export type CaptureBoundsHandle = "move" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

/** Screenshot coordinates, like drawing gestures and the export crop (not display DIPs). */
export function automaticCaptureBounds(
  drawings: readonly CaptureDrawing[],
  width: number,
  height: number,
): CaptureRect {
  const points = drawings.flatMap((drawing) =>
    drawing.kind === "arrow" ? [drawing.start, drawing.end] : [...drawing.points],
  );
  if (!points.length) return { x: 0, y: 0, width, height };
  let left = width;
  let top = height;
  let right = 0;
  let bottom = 0;
  for (const point of points) {
    left = Math.min(left, point.x);
    top = Math.min(top, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
  }
  left = Math.max(0, left - 150);
  top = Math.max(0, top - 150);
  right = Math.min(width, right + 150);
  bottom = Math.min(height, bottom + 150);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function adjustCaptureBounds(
  rect: CaptureRect,
  handle: CaptureBoundsHandle,
  delta: CapturePoint,
  width: number,
  height: number,
): CaptureRect {
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
  if (handle === "move")
    return {
      ...rect,
      x: clamp(rect.x + delta.x, 0, width - rect.width),
      y: clamp(rect.y + delta.y, 0, height - rect.height),
    };
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;
  if (handle.includes("w")) left = clamp(left + delta.x, 0, right - 2);
  if (handle.includes("e")) right = clamp(right + delta.x, left + 2, width);
  if (handle.includes("n")) top = clamp(top + delta.y, 0, bottom - 2);
  if (handle.includes("s")) bottom = clamp(bottom + delta.y, top + 2, height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}
