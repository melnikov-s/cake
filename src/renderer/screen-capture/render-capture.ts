import {
  captureOutputSize,
  type CaptureArrow,
  type CaptureRect,
} from "../../contracts/desktop/screen-capture-data";

export interface CapturePalette {
  readonly ink: string;
  readonly background: string;
  readonly foreground: string;
}

export function paintCapture(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  arrows: readonly CaptureArrow[],
  palette: CapturePalette,
) {
  context.clearRect(0, 0, image.naturalWidth, image.naturalHeight);
  context.drawImage(image, 0, 0);
  const unit = Math.max(1, Math.max(image.naturalWidth, image.naturalHeight) / 1800);
  context.lineWidth = 3 * unit;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.font = `600 ${16 * unit}px system-ui`;
  for (const arrow of arrows) {
    const angle = Math.atan2(arrow.end.y - arrow.start.y, arrow.end.x - arrow.start.x);
    context.strokeStyle = palette.ink;
    context.shadowColor = palette.background;
    context.shadowBlur = 3 * unit;
    context.beginPath();
    context.moveTo(arrow.start.x, arrow.start.y);
    context.lineTo(arrow.end.x, arrow.end.y);
    context.moveTo(
      arrow.end.x - 14 * unit * Math.cos(angle - Math.PI / 6),
      arrow.end.y - 14 * unit * Math.sin(angle - Math.PI / 6),
    );
    context.lineTo(arrow.end.x, arrow.end.y);
    context.lineTo(
      arrow.end.x - 14 * unit * Math.cos(angle + Math.PI / 6),
      arrow.end.y - 14 * unit * Math.sin(angle + Math.PI / 6),
    );
    context.stroke();
    context.shadowBlur = 0;
    if (arrow.label) {
      const padding = 8 * unit;
      const textWidth = context.measureText(arrow.label).width;
      const width = Math.min(image.naturalWidth, textWidth + padding * 2);
      const height = 32 * unit;
      const x = Math.max(0, Math.min(image.naturalWidth - width, arrow.start.x + padding));
      const y = Math.max(
        0,
        Math.min(image.naturalHeight - height, arrow.start.y - height - padding),
      );
      context.fillStyle = palette.background;
      context.fillRect(x, y, width, height);
      context.strokeStyle = palette.ink;
      context.strokeRect(x, y, width, height);
      context.fillStyle = palette.foreground;
      context.fillText(arrow.label, x + padding, y + 22 * unit, Math.max(1, width - padding * 2));
    }
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

/** Flatten only screenshot + annotations; crop guides and Cake controls are never included. */
export async function renderCaptureImage(
  data: string,
  arrows: readonly CaptureArrow[],
  rect: CaptureRect | undefined,
  maxDimension: number,
  palette: CapturePalette,
): Promise<string> {
  const image = await loadCaptureImage(data);
  const source = document.createElement("canvas");
  source.width = image.naturalWidth;
  source.height = image.naturalHeight;
  const context = source.getContext("2d");
  if (!context) throw new Error("Canvas rendering is unavailable");
  paintCapture(context, image, arrows, palette);
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
