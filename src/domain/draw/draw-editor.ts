/* oxlint-disable anti-slop/no-shape-in-symbol-names -- Shape is tldraw's precise drawing-domain entity. */
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

/** Compact summary only; raw tldraw records and freehand point arrays never cross the control boundary. */
export interface DrawShapeSummary {
  readonly id: string;
  readonly type: string;
  readonly bounds?: DrawBounds;
  readonly text?: string;
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

type DrawGeoType = "rectangle" | "ellipse" | "triangle" | "diamond" | "hexagon" | "cloud" | "star";

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
      readonly fill?: "none" | "semi" | "solid" | "pattern";
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

export type DrawOperation =
  | { readonly type: "create"; readonly shape: DrawCreateShape }
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
      readonly rotation?: number;
      readonly opacity?: number;
      readonly text?: string;
    }
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
  | { readonly type: "bring-to-front" | "send-to-back"; readonly ids: readonly string[] }
  | { readonly type: "select" | "zoom-to"; readonly ids: readonly string[] };

interface DrawApplyInput {
  readonly operations: readonly DrawOperation[];
}

export interface DrawApplyReceipt {
  readonly createdIds: readonly string[];
  readonly updatedIds: readonly string[];
  readonly deletedIds: readonly string[];
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

/** Cake-owned, JSON-safe persisted form of a migrated tldraw document snapshot. */
export type DrawDocumentSnapshot = JsonValue;

/** Mounted renderer capability. Callers must explicitly enter Draw before using it. */
export interface DrawEditorController {
  read(input: DrawReadInput): DrawScene;
  render(input: DrawRenderInput): Promise<DrawRender>;
  apply(input: DrawApplyInput): DrawApplyReceipt;
}
