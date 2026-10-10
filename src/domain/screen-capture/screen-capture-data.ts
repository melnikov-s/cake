import { Schema } from "effect";

export const DEFAULT_CAPTURE_SHORTCUT = "Mod+Shift+6";
export const DEFAULT_CAPTURE_MAX_DIMENSION = 2048;

export const ScreenCaptureSettings = Schema.Struct({
  shortcut: Schema.String.check(Schema.isMaxLength(128)),
  maxDimension: Schema.Int.check(Schema.isBetween({ minimum: 256, maximum: 8192 })),
});
export interface ScreenCaptureSettings extends Schema.Schema.Type<typeof ScreenCaptureSettings> {}

export const CaptureDestination = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("project-session"), sessionId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("cake-chat"), sessionId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("new-session"), projectPath: Schema.String }),
]);
export type CaptureDestination = Schema.Schema.Type<typeof CaptureDestination>;

const CaptureSessionOption = Schema.Struct({ sessionId: Schema.String, title: Schema.String });
export const CaptureRouting = Schema.Struct({
  projects: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      name: Schema.String,
      sessions: Schema.Array(CaptureSessionOption),
    }),
  ),
  cakeChats: Schema.Array(CaptureSessionOption),
  defaultDestination: CaptureDestination,
});
export interface CaptureRouting extends Schema.Schema.Type<typeof CaptureRouting> {}

export const CaptureResult = Schema.Struct({
  data: Schema.String.check(Schema.isMaxLength(20_000_000)),
  destination: CaptureDestination,
});
export interface CaptureResult extends Schema.Schema.Type<typeof CaptureResult> {}

export const CaptureImage = Schema.String.check(Schema.isMaxLength(48_000_000));
export const ScreenCaptureSnapshot = Schema.Struct({
  image: CaptureImage,
  routing: CaptureRouting,
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
export interface CaptureArrow {
  readonly start: CapturePoint;
  readonly end: CapturePoint;
  readonly label: string;
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
