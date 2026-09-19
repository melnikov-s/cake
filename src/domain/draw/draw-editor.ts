/* oxlint-disable anti-slop/no-shape-in-symbol-names -- Shape is the drawing-domain entity. */
import type { JsonValue } from "../../ipc/json-contract";

/** JSON-safe Cake Draw contracts shared by renderer presentation and explicit agent controls. */

export type DrawReadScope = "selection" | "viewport" | "page";

interface DrawBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface DrawShapeConnection {
  readonly terminal: "start" | "end";
  readonly shapeId: string;
}

type DrawFill = "none" | "semi" | "solid" | "pattern";
type DrawGeoType = "rectangle" | "ellipse" | "diamond";
type DrawFontFamily = "hand-drawn" | "sans-serif" | "monospace";
export type DrawArrowhead = "none" | "arrow" | "bar" | "dot" | "circle" | "triangle" | "diamond";

export interface DrawShapeStyle {
  readonly strokeColor: string;
  readonly backgroundColor: string;
  readonly fill: DrawFill;
  readonly strokeWidth: number;
  readonly strokeStyle: "solid" | "dashed" | "dotted";
  readonly roughness: number;
  readonly opacity: number;
  readonly roundness: "round" | "sharp";
  readonly fontSize?: number;
  readonly fontFamily?: DrawFontFamily;
  readonly textAlign?: "left" | "center" | "right";
  readonly verticalAlign?: "top" | "middle" | "bottom";
  readonly startArrowhead?: DrawArrowhead;
  readonly endArrowhead?: DrawArrowhead;
  readonly locked: boolean;
}

/** Compact summary only; raw Excalidraw elements and freehand point arrays never cross the control boundary. */
export interface DrawShapeSummary {
  readonly id: string;
  readonly type: string;
  readonly bounds?: DrawBounds;
  readonly text?: string;
  readonly style: DrawShapeStyle;
  readonly connections?: readonly DrawShapeConnection[];
}

interface DrawReadInput {
  readonly scope: DrawReadScope;
}

export interface DrawScene {
  readonly pageId: string;
  readonly viewportBounds: DrawBounds;
  readonly selectedShapeIds: readonly string[];
  readonly shapes: readonly DrawShapeSummary[];
  readonly truncated: boolean;
}

type DrawRelativeSide = "left" | "right" | "above" | "below";
type DrawRelativeAlignment = "start" | "center" | "end";

interface DrawRelativePlacement {
  readonly relativeTo: string;
  readonly side: DrawRelativeSide;
  readonly gap?: number;
  readonly align?: DrawRelativeAlignment;
}

export type DrawCreateShape =
  | {
      readonly id?: string;
      readonly type: "geo";
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly text?: string;
      readonly geo?: DrawGeoType;
      readonly color?: string;
      readonly fill?: DrawFill;
    }
  | {
      readonly id?: string;
      readonly type: "text";
      readonly x: number;
      readonly y: number;
      readonly text: string;
      readonly width?: number;
    }
  | {
      readonly id?: string;
      readonly type: "note";
      readonly x: number;
      readonly y: number;
      readonly text: string;
      readonly color?: string;
    }
  | {
      readonly id?: string;
      readonly type: "line" | "arrow";
      readonly x: number;
      readonly y: number;
      readonly endX: number;
      readonly endY: number;
      readonly text?: string;
    };

export type DrawRelativeShape =
  | {
      readonly id?: string;
      readonly type: "geo";
      readonly width: number;
      readonly height: number;
      readonly text?: string;
      readonly geo?: DrawGeoType;
      readonly color?: string;
      readonly fill?: DrawFill;
      readonly placement: DrawRelativePlacement;
    }
  | {
      readonly id?: string;
      readonly type: "text";
      readonly text: string;
      readonly width?: number;
      readonly placement: DrawRelativePlacement;
    }
  | {
      readonly id?: string;
      readonly type: "note";
      readonly text: string;
      readonly color?: string;
      readonly placement: DrawRelativePlacement;
    };

export interface DrawStyleUpdate {
  readonly strokeColor?: string;
  readonly backgroundColor?: string;
  readonly fill?: DrawFill;
  readonly strokeWidth?: number;
  readonly strokeStyle?: "solid" | "dashed" | "dotted";
  readonly roughness?: 0 | 1 | 2;
  readonly opacity?: number;
  readonly roundness?: "round" | "sharp";
  readonly fontSize?: number;
  readonly fontFamily?: DrawFontFamily;
  readonly textAlign?: "left" | "center" | "right";
  readonly verticalAlign?: "top" | "middle" | "bottom";
  readonly startArrowhead?: DrawArrowhead;
  readonly endArrowhead?: DrawArrowhead;
}

export type DrawOperation =
  | { readonly type: "create"; readonly shape: DrawCreateShape }
  | { readonly type: "create-relative"; readonly shape: DrawRelativeShape }
  | {
      readonly type: "connect";
      readonly id?: string;
      readonly fromId: string;
      readonly toId: string;
      readonly text?: string;
    }
  | {
      readonly type: "update";
      readonly id: string;
      readonly x?: number;
      readonly y?: number;
      readonly width?: number;
      readonly height?: number;
      readonly endX?: number;
      readonly endY?: number;
      readonly rotation?: number;
      readonly opacity?: number;
      readonly text?: string;
      readonly geo?: DrawGeoType;
    }
  | { readonly type: "style"; readonly ids: readonly string[]; readonly style: DrawStyleUpdate }
  | { readonly type: "delete"; readonly ids: readonly string[] }
  | {
      readonly type: "move";
      readonly ids: readonly string[];
      readonly deltaX: number;
      readonly deltaY: number;
    }
  | {
      readonly type: "align";
      readonly ids: readonly string[];
      readonly alignment:
        | "left"
        | "center-horizontal"
        | "right"
        | "top"
        | "center-vertical"
        | "bottom";
    }
  | {
      readonly type: "distribute";
      readonly ids: readonly string[];
      readonly direction: "horizontal" | "vertical";
    }
  | {
      readonly type: "bring-to-front" | "bring-forward" | "send-backward" | "send-to-back";
      readonly ids: readonly string[];
    }
  | { readonly type: "set-locked"; readonly ids: readonly string[]; readonly locked: boolean }
  | { readonly type: "select" | "zoom-to"; readonly ids: readonly string[] };

interface DrawApplyInput {
  readonly operations: readonly DrawOperation[];
}

export interface DrawPlaybackOptions {
  readonly maxDurationMs?: number;
  readonly stepDelayMs?: number;
  readonly signal?: AbortSignal;
}

export interface DrawApplyReceipt {
  readonly createdIds: readonly string[];
  readonly updatedIds: readonly string[];
  readonly deletedIds: readonly string[];
}

export interface DrawMermaidReceipt {
  readonly elementCount: number;
}

export interface DrawRenderInput {
  readonly scope: DrawReadScope;
  readonly format: "svg" | "png";
  readonly background?: boolean;
  readonly scale?: number;
}

export interface DrawRender {
  readonly format: "svg" | "png";
  readonly mediaType: "image/svg+xml" | "image/png";
  readonly width: number;
  readonly height: number;
  /** SVG source for svg, or a data URL for png. */
  readonly data: string;
}

/** Cake-owned, JSON-safe persisted Excalidraw scene snapshot. */
export type DrawDocumentSnapshot = JsonValue;

/** Mounted renderer capability. Callers must explicitly enter Draw before using it. */
export interface DrawEditorController {
  read(input: DrawReadInput): DrawScene;
  render(input: DrawRenderInput): Promise<DrawRender>;
  apply(input: DrawApplyInput): DrawApplyReceipt;
  applyAnimated(input: DrawApplyInput, options?: DrawPlaybackOptions): Promise<DrawApplyReceipt>;
  insertMermaid(diagram: string): Promise<DrawMermaidReceipt>;
}
