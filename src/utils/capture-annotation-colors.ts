/** Image annotation data, deliberately independent of Cake's UI/theme colors. */
export const CAPTURE_ANNOTATION_COLORS = [
  "yellow",
  "red",
  "cyan",
  "green",
  "pink",
  "white",
] as const;
export type CaptureAnnotationColor = (typeof CAPTURE_ANNOTATION_COLORS)[number];
export const DEFAULT_CAPTURE_ANNOTATION_COLOR: CaptureAnnotationColor = "yellow";
export const captureAnnotationInk = {
  yellow: "#ffdf00",
  red: "#ff3b30",
  cyan: "#00d9ff",
  green: "#46ef65",
  pink: "#ff55cc",
  white: "#ffffff",
} satisfies Record<CaptureAnnotationColor, string>;
