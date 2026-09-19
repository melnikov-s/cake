/* oxlint-disable anti-slop/no-shape-in-symbol-names -- Shape is the drawing-domain entity. */
import { Schema } from "effect";
import { DrawBoardId, DrawBoardMetadata } from "./draw-board-data";

const boundedString = (maximum: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));
const coordinate = Schema.Number.check(
  Schema.isFinite(),
  Schema.isBetween({ minimum: -1_000_000, maximum: 1_000_000 }),
);
const shapeId = boundedString(262);
const shapeIds = Schema.Array(shapeId).check(Schema.isMaxLength(500));
const nonEmptyShapeIds = shapeIds.check(Schema.isMinLength(1));
const atLeastTwoShapeIds = shapeIds.check(Schema.isMinLength(2));
const atLeastThreeShapeIds = shapeIds.check(Schema.isMinLength(3));
const positiveDimension = coordinate.check(Schema.isGreaterThan(0));
const drawColor = boundedString(64);
const opacity = Schema.Number.check(
  Schema.isFinite(),
  Schema.isBetween({ minimum: 0, maximum: 1 }),
);
const summarizedShapeIds = Schema.Array(shapeId).check(Schema.isMaxLength(200));
const mermaidDiagram = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(50_000));

export const DrawReadScope = Schema.Literals(["selection", "viewport", "page"]);
export type DrawReadScope = typeof DrawReadScope.Type;

const DrawBounds = Schema.Struct({
  x: coordinate,
  y: coordinate,
  width: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  height: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
});

const DrawFill = Schema.Literals(["none", "semi", "solid", "pattern"]);
const DrawFontFamily = Schema.Literals(["hand-drawn", "sans-serif", "monospace"]);
const DrawArrowhead = Schema.Literals([
  "none",
  "arrow",
  "bar",
  "dot",
  "circle",
  "triangle",
  "diamond",
]);
const DrawShapeStyle = Schema.Struct({
  strokeColor: drawColor,
  backgroundColor: drawColor,
  fill: DrawFill,
  strokeWidth: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0)),
  strokeStyle: Schema.Literals(["solid", "dashed", "dotted"]),
  roughness: Schema.Number.check(Schema.isFinite(), Schema.isBetween({ minimum: 0, maximum: 2 })),
  opacity,
  roundness: Schema.Literals(["round", "sharp"]),
  fontSize: Schema.optionalKey(positiveDimension),
  fontFamily: Schema.optionalKey(DrawFontFamily),
  textAlign: Schema.optionalKey(Schema.Literals(["left", "center", "right"])),
  verticalAlign: Schema.optionalKey(Schema.Literals(["top", "middle", "bottom"])),
  startArrowhead: Schema.optionalKey(DrawArrowhead),
  endArrowhead: Schema.optionalKey(DrawArrowhead),
  locked: Schema.Boolean,
});

const DrawShapeSummary = Schema.Struct({
  id: shapeId,
  type: boundedString(128),
  bounds: Schema.optionalKey(DrawBounds),
  text: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16_384))),
  style: DrawShapeStyle,
  connections: Schema.optionalKey(
    Schema.Array(Schema.Struct({ terminal: Schema.Literals(["start", "end"]), shapeId })).check(
      Schema.isMaxLength(100),
    ),
  ),
});

const DrawScene = Schema.Struct({
  pageId: boundedString(262),
  viewportBounds: DrawBounds,
  selectedShapeIds: summarizedShapeIds,
  shapes: Schema.Array(DrawShapeSummary).check(Schema.isMaxLength(200)),
  truncated: Schema.Boolean,
});
interface DrawScene extends Schema.Schema.Type<typeof DrawScene> {}

const optionalShapeFields = {
  id: Schema.optionalKey(shapeId),
};
const DrawRelativePlacement = Schema.Struct({
  relativeTo: shapeId,
  side: Schema.Literals(["left", "right", "above", "below"]),
  gap: Schema.optionalKey(Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))),
  align: Schema.optionalKey(Schema.Literals(["start", "center", "end"])),
});

const DrawCreateShape = Schema.Union([
  Schema.Struct({
    ...optionalShapeFields,
    type: Schema.Literal("geo"),
    x: coordinate,
    y: coordinate,
    width: positiveDimension,
    height: positiveDimension,
    text: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16_384))),
    geo: Schema.optionalKey(Schema.Literals(["rectangle", "ellipse", "diamond"])),
    color: Schema.optionalKey(boundedString(64)),
    fill: Schema.optionalKey(Schema.Literals(["none", "semi", "solid", "pattern"])),
  }),
  Schema.Struct({
    ...optionalShapeFields,
    type: Schema.Literal("text"),
    x: coordinate,
    y: coordinate,
    text: Schema.String.check(Schema.isMaxLength(16_384)),
    width: Schema.optionalKey(positiveDimension),
  }),
  Schema.Struct({
    ...optionalShapeFields,
    type: Schema.Literal("note"),
    x: coordinate,
    y: coordinate,
    text: Schema.String.check(Schema.isMaxLength(16_384)),
    color: Schema.optionalKey(boundedString(64)),
  }),
  Schema.Struct({
    ...optionalShapeFields,
    type: Schema.Literals(["line", "arrow"]),
    x: coordinate,
    y: coordinate,
    endX: coordinate,
    endY: coordinate,
    text: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16_384))),
  }),
]);

const DrawRelativeShape = Schema.Union([
  Schema.Struct({
    ...optionalShapeFields,
    type: Schema.Literal("geo"),
    width: positiveDimension,
    height: positiveDimension,
    text: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16_384))),
    geo: Schema.optionalKey(Schema.Literals(["rectangle", "ellipse", "diamond"])),
    color: Schema.optionalKey(boundedString(64)),
    fill: Schema.optionalKey(Schema.Literals(["none", "semi", "solid", "pattern"])),
    placement: DrawRelativePlacement,
  }),
  Schema.Struct({
    ...optionalShapeFields,
    type: Schema.Literal("text"),
    text: Schema.String.check(Schema.isMaxLength(16_384)),
    width: Schema.optionalKey(positiveDimension),
    placement: DrawRelativePlacement,
  }),
  Schema.Struct({
    ...optionalShapeFields,
    type: Schema.Literal("note"),
    text: Schema.String.check(Schema.isMaxLength(16_384)),
    color: Schema.optionalKey(boundedString(64)),
    placement: DrawRelativePlacement,
  }),
]);

const DrawStyleUpdate = Schema.Struct({
  strokeColor: Schema.optionalKey(drawColor),
  backgroundColor: Schema.optionalKey(drawColor),
  fill: Schema.optionalKey(DrawFill),
  strokeWidth: Schema.optionalKey(
    Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(20)),
  ),
  strokeStyle: Schema.optionalKey(Schema.Literals(["solid", "dashed", "dotted"])),
  roughness: Schema.optionalKey(Schema.Literals([0, 1, 2])),
  opacity: Schema.optionalKey(opacity),
  roundness: Schema.optionalKey(Schema.Literals(["round", "sharp"])),
  fontSize: Schema.optionalKey(
    Schema.Number.check(
      Schema.isFinite(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(512),
    ),
  ),
  fontFamily: Schema.optionalKey(DrawFontFamily),
  textAlign: Schema.optionalKey(Schema.Literals(["left", "center", "right"])),
  verticalAlign: Schema.optionalKey(Schema.Literals(["top", "middle", "bottom"])),
  startArrowhead: Schema.optionalKey(DrawArrowhead),
  endArrowhead: Schema.optionalKey(DrawArrowhead),
}).check(
  Schema.makeFilter((style) => Object.values(style).some((value) => value !== undefined), {
    expected: "at least one shape style property",
  }),
);

export const DrawOperation = Schema.Union([
  Schema.Struct({ type: Schema.Literal("create"), shape: DrawCreateShape }),
  Schema.Struct({ type: Schema.Literal("create-relative"), shape: DrawRelativeShape }),
  Schema.Struct({
    type: Schema.Literal("update"),
    id: shapeId,
    x: Schema.optionalKey(coordinate),
    y: Schema.optionalKey(coordinate),
    width: Schema.optionalKey(positiveDimension),
    height: Schema.optionalKey(positiveDimension),
    endX: Schema.optionalKey(coordinate),
    endY: Schema.optionalKey(coordinate),
    rotation: Schema.optionalKey(coordinate),
    opacity: Schema.optionalKey(opacity),
    text: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16_384))),
    geo: Schema.optionalKey(Schema.Literals(["rectangle", "ellipse", "diamond"])),
  }).check(
    Schema.makeFilter(
      (update) =>
        Object.entries(update).some(
          ([key, value]) => key !== "type" && key !== "id" && value !== undefined,
        ),
      { expected: "at least one shape update property" },
    ),
  ),
  Schema.Struct({ type: Schema.Literal("style"), ids: nonEmptyShapeIds, style: DrawStyleUpdate }),
  Schema.Struct({ type: Schema.Literal("delete"), ids: nonEmptyShapeIds }),
  Schema.Struct({
    type: Schema.Literal("move"),
    ids: nonEmptyShapeIds,
    deltaX: coordinate,
    deltaY: coordinate,
  }),
  Schema.Struct({
    type: Schema.Literal("align"),
    ids: atLeastTwoShapeIds,
    alignment: Schema.Literals([
      "left",
      "center-horizontal",
      "right",
      "top",
      "center-vertical",
      "bottom",
    ]),
  }),
  Schema.Struct({
    type: Schema.Literal("distribute"),
    ids: atLeastThreeShapeIds,
    direction: Schema.Literals(["horizontal", "vertical"]),
  }),
  Schema.Struct({
    type: Schema.Literals(["bring-to-front", "bring-forward", "send-backward", "send-to-back"]),
    ids: nonEmptyShapeIds,
  }),
  Schema.Struct({
    type: Schema.Literal("set-locked"),
    ids: nonEmptyShapeIds,
    locked: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("select"), ids: shapeIds }),
  Schema.Struct({ type: Schema.Literal("zoom-to"), ids: nonEmptyShapeIds }),
  Schema.Struct({
    type: Schema.Literal("connect"),
    id: Schema.optionalKey(shapeId),
    fromId: shapeId,
    toId: shapeId,
    text: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16_384))),
  }),
]);
export type DrawOperation = typeof DrawOperation.Type;

export const DRAW_APPLY_MAX_OPERATIONS = 8;

const DrawApplyReceipt = Schema.Struct({
  createdIds: shapeIds,
  updatedIds: shapeIds,
  deletedIds: shapeIds,
});
interface DrawApplyReceipt extends Schema.Schema.Type<typeof DrawApplyReceipt> {}

const DrawRender = Schema.Struct({
  format: Schema.Literals(["svg", "png"]),
  mediaType: Schema.Literals(["image/svg+xml", "image/png"]),
  width: Schema.Number.check(
    Schema.isFinite(),
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(4_096),
  ),
  height: Schema.Number.check(
    Schema.isFinite(),
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(4_096),
  ),
  data: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(11_000_000)),
});
interface DrawRender extends Schema.Schema.Type<typeof DrawRender> {}

export const DrawControlInvocation = Schema.TaggedUnion({
  Enter: {},
  Open: { boardId: DrawBoardId },
  Read: { boardId: Schema.optionalKey(DrawBoardId), scope: DrawReadScope },
  Render: {
    boardId: Schema.optionalKey(DrawBoardId),
    scope: DrawReadScope,
    format: Schema.Literals(["png", "svg"]),
    background: Schema.optionalKey(Schema.Boolean),
    scale: Schema.optionalKey(
      Schema.Number.check(
        Schema.isFinite(),
        Schema.isGreaterThan(0),
        Schema.isLessThanOrEqualTo(4),
      ),
    ),
  },
  ExportDocument: { boardId: Schema.optionalKey(DrawBoardId) },
  Apply: {
    boardId: Schema.optionalKey(DrawBoardId),
    operations: Schema.Array(DrawOperation).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(DRAW_APPLY_MAX_OPERATIONS),
    ),
  },
  Mermaid: {
    boardId: Schema.optionalKey(DrawBoardId),
    diagram: mermaidDiagram,
  },
});
export type DrawControlInvocation = typeof DrawControlInvocation.Type;

const DrawControlFailureCode = Schema.Literals([
  "DRAW_MODE_REQUIRED",
  "BOARD_NOT_OPEN",
  "SESSION_NOT_VISIBLE",
  "SESSION_RESOLVED",
  "REQUEST_CANCELLED",
  "APPLY_OUTCOME_UNKNOWN",
  "INVALID_REQUEST",
]);
type DrawControlFailureCode = typeof DrawControlFailureCode.Type;

export const DrawControlResponse = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(false),
    code: DrawControlFailureCode,
    message: boundedString(2_048),
  }),
  Schema.Struct({
    ok: Schema.Literal(true),
    kind: Schema.Literal("entered"),
    board: DrawBoardMetadata,
    scene: DrawScene,
  }),
  Schema.Struct({
    ok: Schema.Literal(true),
    kind: Schema.Literal("opened"),
    board: DrawBoardMetadata,
    scene: DrawScene,
  }),
  Schema.Struct({
    ok: Schema.Literal(true),
    kind: Schema.Literal("read"),
    boardId: DrawBoardId,
    scene: DrawScene,
  }),
  Schema.Struct({
    ok: Schema.Literal(true),
    kind: Schema.Literal("rendered"),
    boardId: DrawBoardId,
    render: DrawRender,
  }),
  Schema.Struct({
    ok: Schema.Literal(true),
    kind: Schema.Literal("exported-document"),
    boardId: DrawBoardId,
    document: boundedString(12_000_000),
  }),
  Schema.Struct({
    ok: Schema.Literal(true),
    kind: Schema.Literal("applied"),
    boardId: DrawBoardId,
    receipt: DrawApplyReceipt,
    scene: DrawScene,
  }),
  Schema.Struct({
    ok: Schema.Literal(true),
    kind: Schema.Literal("mermaid"),
    boardId: DrawBoardId,
    elementCount: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
    scene: DrawScene,
  }),
]);
export type DrawControlResponse = typeof DrawControlResponse.Type;

export const DrawControlRequest = Schema.Struct({
  sessionId: boundedString(256),
  drawRequestId: Schema.String.check(Schema.isUUID(4)),
  invocation: DrawControlInvocation,
});
export interface DrawControlRequest extends Schema.Schema.Type<typeof DrawControlRequest> {}

/** Renderer-owned handler registered with RootStore for the visible Project Session. */
export interface DrawControl {
  readonly sessionId: string;
  invoke(invocation: DrawControlInvocation, signal?: AbortSignal): Promise<DrawControlResponse>;
}
