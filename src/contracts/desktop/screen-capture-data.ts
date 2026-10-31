import { Schema } from "effect";
import { SpeechRecognitionSettings, TextProcessingMode } from "../dictation/dictation-data";
import { ProjectIcon, SessionLabel } from "../application/application-data";
import { WorktreeRecord } from "../worktrees/managed-worktree-data";

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

/** Frozen sidebar presentation facts; the overlay does not create another session catalog. */
export const CaptureSessionOption = Schema.Struct({
  sessionId: Schema.String,
  title: Schema.String,
  modifiedAt: Schema.String,
  activityTime: Schema.String,
  labels: Schema.Array(SessionLabel),
  activity: Schema.optionalKey(
    Schema.Literals(["waiting", "running", "blocked", "unread", "error", "stopped"]),
  ),
  draft: Schema.optionalKey(Schema.Boolean),
  worktreeName: Schema.optionalKey(Schema.String),
  familyParentSessionId: Schema.optionalKey(Schema.String),
  familyChildSessionIds: Schema.optionalKey(Schema.Array(Schema.String)),
  familyDepth: Schema.optionalKey(Schema.Int),
  familyCollapsed: Schema.Boolean,
  managedWorktree: Schema.optionalKey(
    Schema.Struct({
      branch: WorktreeRecord.fields.branch,
      baseBranch: WorktreeRecord.fields.baseBranch,
      parentWorktreePath: WorktreeRecord.fields.parentWorktreePath,
      state: WorktreeRecord.fields.state,
    }),
  ),
});
export interface CaptureSessionOption extends Schema.Schema.Type<typeof CaptureSessionOption> {}
export const CaptureRouting = Schema.Struct({
  projects: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      name: Schema.String,
      icon: Schema.optionalKey(ProjectIcon),
      sessions: Schema.Array(CaptureSessionOption),
    }),
  ),
  cakeChats: Schema.Array(CaptureSessionOption),
  appearance: Schema.Struct({
    theme: Schema.Literals(["system", "light", "dark"]),
    projectAvatarsEnabled: Schema.Boolean,
    sessionAvatarsEnabled: Schema.Boolean,
    sidebarCharactersEnabled: Schema.Boolean,
  }),
  dictation: Schema.Struct({
    enabled: Schema.Boolean,
    deviceId: Schema.String,
    textProcessingMode: TextProcessingMode,
    recognition: SpeechRecognitionSettings,
  }),
  defaultDestination: CaptureDestination,
});
export interface CaptureRouting extends Schema.Schema.Type<typeof CaptureRouting> {}

const CaptureAnnotationText = Schema.String;
export const CaptureResult = Schema.Struct({
  data: Schema.String.check(Schema.isMaxLength(20_000_000)),
  annotationText: CaptureAnnotationText,
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
