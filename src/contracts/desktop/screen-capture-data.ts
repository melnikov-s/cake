import { Schema } from "effect";
import { SpeechRecognitionSettings, TextProcessingMode } from "../dictation/dictation-data";
import { ImportedColorTheme } from "../themes/color-theme";

import { CAPTURE_ANNOTATION_COLORS } from "../../utils/capture-annotation-colors";

export const CaptureAnnotationColor = Schema.Literals(CAPTURE_ANNOTATION_COLORS);
export type CaptureAnnotationColor = Schema.Schema.Type<typeof CaptureAnnotationColor>;

export const DEFAULT_CAPTURE_SHORTCUT = "Mod+Shift+6";
export const DEFAULT_CAPTURE_MAX_DIMENSION = 2048;

export const ScreenCaptureSettings = Schema.Struct({
  shortcut: Schema.String.check(Schema.isMaxLength(128)),
  maxDimension: Schema.Int.check(Schema.isBetween({ minimum: 256, maximum: 8192 })),
});
export interface ScreenCaptureSettings extends Schema.Schema.Type<typeof ScreenCaptureSettings> {}

/** Native editing preferences; destinations stay in the owning renderer. */
export const CapturePreferences = Schema.Struct({
  annotationColor: CaptureAnnotationColor,
  appearance: Schema.Struct({
    theme: Schema.Literals(["system", "light", "dark"]),
    importedTheme: Schema.optional(ImportedColorTheme),
  }),
  dictation: Schema.Struct({
    enabled: Schema.Boolean,
    deviceId: Schema.String,
    textProcessingMode: TextProcessingMode,
    recognition: SpeechRecognitionSettings,
  }),
});
export interface CapturePreferences extends Schema.Schema.Type<typeof CapturePreferences> {}

const CaptureAnnotationText = Schema.String;
export const CaptureResult = Schema.Struct({
  data: Schema.String.check(Schema.isMaxLength(20_000_000)),
  annotationText: CaptureAnnotationText,
});
export interface CaptureResult extends Schema.Schema.Type<typeof CaptureResult> {}

/** Preferences return even when the overlay is cancelled, for the owner's window snapshot. */
export const CaptureCompletion = Schema.Struct({
  annotationColor: CaptureAnnotationColor,
  capture: Schema.optionalKey(CaptureResult),
});
export interface CaptureCompletion extends Schema.Schema.Type<typeof CaptureCompletion> {}

export const CaptureImage = Schema.String.check(Schema.isMaxLength(48_000_000));
export const ScreenCaptureSnapshot = Schema.Struct({
  image: CaptureImage,
  routing: CapturePreferences,
  width: Schema.Int.check(Schema.isGreaterThan(0)),
  height: Schema.Int.check(Schema.isGreaterThan(0)),
  maxDimension: ScreenCaptureSettings.fields.maxDimension,
});
export interface ScreenCaptureSnapshot extends Schema.Schema.Type<typeof ScreenCaptureSnapshot> {}

/** Electron accelerators use logical keys rather than DOM key names. */
export function captureAccelerator(shortcut: string): string {
  return shortcut
    .split("+")
    .map((key) => {
      if (key === "Mod") return "CommandOrControl";
      if (key === "Meta") return "Command";
      if (key === "Ctrl") return "Control";
      if (key.startsWith("Arrow")) return key.slice(5);
      if (key === " ") return "Space";
      return key;
    })
    .join("+");
}

export interface CapturePoint {
  readonly x: number;
  readonly y: number;
}
export interface CaptureRect extends CapturePoint {
  readonly width: number;
  readonly height: number;
}
export type CaptureDrawing =
  | {
      readonly kind: "arrow";
      readonly start: CapturePoint;
      readonly end: CapturePoint;
      readonly label: string;
    }
  | { readonly kind: "freehand"; readonly points: readonly CapturePoint[]; readonly label: string };

export type CaptureMode = "crop" | "annotate" | "freehand";

export function captureDrawingAnchor(drawing: CaptureDrawing): CapturePoint {
  return drawing.kind === "arrow" ? drawing.start : drawing.points[drawing.points.length - 1]!;
}

/** Keep original marker identities when a crop excludes other drawings. */
export function numberedCaptureDrawings(drawings: readonly CaptureDrawing[], rect?: CaptureRect) {
  return drawings
    .map((drawing, index) => ({ drawing, number: index + 1 }))
    .filter(({ drawing }) => {
      if (!rect) return true;
      const points = drawing.kind === "arrow" ? [drawing.start, drawing.end] : drawing.points;
      return points.some((point, index) =>
        captureSegmentIntersectsRect(points[Math.max(0, index - 1)]!, point, rect),
      );
    });
}

/** Clip a line's parameter range against the rectangle's two coordinate intervals. */
function captureSegmentIntersectsRect(start: CapturePoint, end: CapturePoint, rect: CaptureRect) {
  let enter = 0;
  let leave = 1;
  for (const [from, to, min, max] of [
    [start.x, end.x, rect.x, rect.x + rect.width],
    [start.y, end.y, rect.y, rect.y + rect.height],
  ] as const) {
    const delta = to - from;
    if (delta === 0) {
      if (from < min || from > max) return false;
    } else {
      const first = (min - from) / delta;
      const last = (max - from) / delta;
      enter = Math.max(enter, Math.min(first, last));
      leave = Math.min(leave, Math.max(first, last));
      if (enter > leave) return false;
    }
  }
  return true;
}

export function captureAnnotationText(
  drawings: readonly CaptureDrawing[],
  rect?: CaptureRect,
): string {
  return numberedCaptureDrawings(drawings, rect)
    .map(
      ({ drawing, number }) =>
        `${number}. ${drawing.label.trim().replace(/\n/g, `\n${" ".repeat(String(number).length + 2)}`) || "(No text)"}`,
    )
    .join("\n");
}

export function captureRect(start: CapturePoint, end: CapturePoint): CaptureRect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

export function captureOutputSize(width: number, height: number, maxDimension: number) {
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
