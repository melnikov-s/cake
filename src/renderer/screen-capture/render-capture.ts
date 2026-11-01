import {
  captureOutputSize,
  captureDrawingAnchor,
  numberedCaptureDrawings,
  type CaptureDrawing,
  type CapturePoint,
  type CaptureRect,
} from "../../contracts/desktop/screen-capture-data";

import {
  captureAnnotationInk,
  type CaptureAnnotationColor,
} from "../../utils/capture-annotation-colors";

/** Solid two-tone halo survives both light/dark imagery and PNG export/downsampling. */
function strokeAnnotation(
  context: CanvasRenderingContext2D,
  color: CaptureAnnotationColor,
  unit: number,
) {
  for (const [ink, width] of [
    ["#ffffff", 9],
    ["#000000", 6],
    [captureAnnotationInk[color], 3],
  ] as const) {
    context.strokeStyle = ink;
    context.lineWidth = width * unit;
    context.stroke();
  }
}

export function paintCaptureSelection(
  context: CanvasRenderingContext2D,
  selection: CaptureRect,
  color: CaptureAnnotationColor,
  unit: number,
) {
  context.beginPath();
  context.rect(selection.x, selection.y, selection.width, selection.height);
  context.setLineDash([12 * unit, 6 * unit]);
  strokeAnnotation(context, color, unit);
  context.setLineDash([]);
}

/** Shared by raster export and accessible marker hit targets, in screenshot pixels. */
export function captureMarker(
  point: CapturePoint,
  width: number,
  height: number,
  region?: CaptureRect,
) {
  const bounds = region ?? { x: 0, y: 0, width, height };
  const radius = Math.min(
    16 * Math.max(1, Math.max(width, height) / 1800),
    bounds.width / 2,
    bounds.height / 2,
  );
  return {
    x: Math.max(bounds.x + radius, Math.min(bounds.x + bounds.width - radius, point.x)),
    y: Math.max(bounds.y + radius, Math.min(bounds.y + bounds.height - radius, point.y)),
    radius,
  };
}

export function paintCapture(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  drawings: readonly CaptureDrawing[],
  color: CaptureAnnotationColor,
  region?: CaptureRect,
) {
  context.clearRect(0, 0, image.naturalWidth, image.naturalHeight);
  context.drawImage(image, 0, 0);
  const unit = Math.max(1, Math.max(image.naturalWidth, image.naturalHeight) / 1800);
  context.lineWidth = 3 * unit;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.font = `600 ${16 * unit}px system-ui`;
  for (const { drawing, number } of numberedCaptureDrawings(drawings, region)) {
    context.beginPath();
    if (drawing.kind === "freehand") {
      context.moveTo(drawing.points[0]!.x, drawing.points[0]!.y);
      for (const point of drawing.points.slice(1)) context.lineTo(point.x, point.y);
    } else {
      const angle = Math.atan2(drawing.end.y - drawing.start.y, drawing.end.x - drawing.start.x);
      context.moveTo(drawing.start.x, drawing.start.y);
      context.lineTo(drawing.end.x, drawing.end.y);
      context.moveTo(
        drawing.end.x - 14 * unit * Math.cos(angle - Math.PI / 6),
        drawing.end.y - 14 * unit * Math.sin(angle - Math.PI / 6),
      );
      context.lineTo(drawing.end.x, drawing.end.y);
      context.lineTo(
        drawing.end.x - 14 * unit * Math.cos(angle + Math.PI / 6),
        drawing.end.y - 14 * unit * Math.sin(angle + Math.PI / 6),
      );
    }
    strokeAnnotation(context, color, unit);
    const { x, y, radius } = captureMarker(
      captureDrawingAnchor(drawing),
      image.naturalWidth,
      image.naturalHeight,
      region,
    );
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fillStyle = "#ffffff";
    context.fill();
    strokeAnnotation(context, color, unit);
    context.fillStyle = "#000000";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(String(number), x, y, radius * 1.6);
  }
}

export function loadCaptureImage(data: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The screenshot could not be loaded"));
    image.src = data;
  });
}

/** Flatten only screenshot, drawings and numbers; prose and Cake controls stay out of pixels. */
export async function renderCaptureImage(
  data: string,
  drawings: readonly CaptureDrawing[],
  rect: CaptureRect | undefined,
  maxDimension: number,
  color: CaptureAnnotationColor,
): Promise<string> {
  const image = await loadCaptureImage(data);
  const source = document.createElement("canvas");
  source.width = image.naturalWidth;
  source.height = image.naturalHeight;
  const context = source.getContext("2d");
  if (!context) throw new Error("Canvas rendering is unavailable");
  paintCapture(context, image, drawings, color, rect);
  const region = rect ?? { x: 0, y: 0, width: source.width, height: source.height };
  const output = document.createElement("canvas");
  const size = captureOutputSize(region.width, region.height, maxDimension);
  output.width = size.width;
  output.height = size.height;
  const result = output.getContext("2d");
  if (!result) throw new Error("Canvas rendering is unavailable");
  result.imageSmoothingQuality = "high";
  result.drawImage(
    source,
    region.x,
    region.y,
    region.width,
    region.height,
    0,
    0,
    output.width,
    output.height,
  );
  return output.toDataURL("image/png");
}
