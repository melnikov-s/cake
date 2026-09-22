/* oxlint-disable anti-slop/no-shape-in-symbol-names -- Shape is Cake's drawing-domain entity. */
import { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";
import { Option, Schema } from "effect";
import { flushSync } from "react-dom";
import {
  CaptureUpdateAction,
  FONT_FAMILY,
  ROUNDNESS,
  convertToExcalidrawElements,
  exportToBlob,
  exportToSvg,
  getCommonBounds,
  newElementWith,
  restore,
  viewportCoordsToSceneCoords,
} from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type {
  Arrowhead,
  ExcalidrawElement,
  ExcalidrawTextElement,
  OrderedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import {
  assertPersistableDrawDocument,
  DRAW_SNAPSHOT_TYPE,
  DRAW_SNAPSHOT_VERSION,
} from "./DrawDocumentValidation";
import { serializeExcalidrawDocument } from "./DrawExportSerializer";
import { formatDrawSourceLink, parseDrawSourceLink } from "../../domain/draw/draw-source-link";
import type {
  DrawArrowhead,
  DrawCreateShape,
  DrawDocumentSnapshot,
  DrawEditorController,
  DrawMermaidReceipt,
  DrawOperation,
  DrawPlaybackOptions,
  DrawReadScope,
  DrawSemanticShapeMapping,
  DrawRelativeShape,
  DrawShapeStyle,
  DrawShapeSummary,
  DrawStyleUpdate,
} from "../../domain/draw/draw-editor";

export interface DrawEditorAdapter extends DrawEditorController {
  loadDocument(snapshot: DrawDocumentSnapshot): void;
  snapshotDocument(): DrawDocumentSnapshot;
  onDocumentChange(listener: () => void): () => void;
}

const MAX_ABSOLUTE_COORDINATE = 1_000_000;
const MAX_RENDER_SCALE = 4;
const MAX_RENDER_BYTES = 8_000_000;
const MAX_READ_SHAPES = 200;
const MAX_RENDER_DIMENSION = 4_096;
const MAX_TEXT_LENGTH = 16_384;
const MAX_SUMMARY_TEXT_LENGTH = 4_000;
const MAX_MERMAID_ELEMENTS = 1_000;
const MERMAID_FONT_SIZE = 20;
const MERMAID_INSERTION_GAP = 80;
const MERMAID_PARALLEL_CONNECTOR_GAP = 18;
const MERMAID_LABEL_HORIZONTAL_PADDING = 24;
const MERMAID_LABEL_VERTICAL_PADDING = 16;
const MERMAID_NODE_GAP = 96;

const colorPalette = new Map([
  ["black", "#1b1b1f"],
  ["blue", "#1971c2"],
  ["green", "#2f9e44"],
  ["grey", "#868e96"],
  ["light-blue", "#4dabf7"],
  ["light-green", "#69db7c"],
  ["light-red", "#ff8787"],
  ["light-violet", "#b197fc"],
  ["orange", "#f08c00"],
  ["red", "#e03131"],
  ["violet", "#7048e8"],
  ["white", "#ffffff"],
  ["yellow", "#f59f00"],
]);

interface DrawSnapshot {
  readonly type: typeof DRAW_SNAPSHOT_TYPE;
  readonly version: typeof DRAW_SNAPSHOT_VERSION;
  readonly source: "cake";
  readonly elements: readonly ExcalidrawElement[];
  readonly appState: Readonly<
    Pick<AppState, "viewBackgroundColor" | "scrollX" | "scrollY" | "zoom">
  >;
  readonly files: BinaryFiles;
}

interface PreparedCreateOperation {
  readonly type: "create";
  readonly shape: DrawCreateShape;
  readonly id: string;
}

interface MutableDrawApplyReceipt {
  createdIds: string[];
  updatedIds: string[];
  deletedIds: string[];
}

interface PreparedRelativeCreateOperation {
  readonly type: "create-relative";
  readonly shape: DrawRelativeShape;
  readonly id: string;
  readonly relativeTo: string;
}

interface PreparedConnectOperation {
  readonly type: "connect";
  readonly id: string;
  readonly fromId: string;
  readonly toId: string;
  readonly text?: string;
  readonly fromPort?: "top" | "right" | "bottom" | "left" | "auto";
  readonly toPort?: "top" | "right" | "bottom" | "left" | "auto";
  readonly routing?: "straight" | "orthogonal";
}

type PreparedOperation =
  | PreparedCreateOperation
  | PreparedRelativeCreateOperation
  | PreparedConnectOperation
  | Exclude<DrawOperation, { type: "create" | "create-relative" | "connect" }>;

function finite(value: number, name: string) {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_ABSOLUTE_COORDINATE)
    throw new Error(`${name} must be a finite canvas coordinate`);
  return value;
}

function positive(value: number, name: string) {
  finite(value, name);
  if (value <= 0) throw new Error(`${name} must be greater than zero`);
  return value;
}

function text(value: string, name = "text") {
  if (value.length > MAX_TEXT_LENGTH)
    throw new Error(`${name} must contain at most ${MAX_TEXT_LENGTH} characters`);
  return value;
}

function shapeId(value: string) {
  const id = value.startsWith("shape:") ? value : `shape:${value}`;
  if (!/^shape:[A-Za-z0-9_-]{1,256}$/.test(id)) throw new Error(`Invalid shape ID: ${value}`);
  return id;
}

function generatedShapeId() {
  return `shape:${crypto.randomUUID().replaceAll("-", "")}`;
}

function color(value: string | undefined, fallback = colorPalette.get("black")!) {
  if (value === undefined) return fallback;
  const resolved = colorPalette.get(value) ?? value;
  if (!colorPalette.has(value) && !/^#[0-9a-f]{3,8}$/i.test(value))
    throw new Error(`Unsupported shape color: ${value}`);
  return resolved;
}

const fontFamilies = {
  "hand-drawn": FONT_FAMILY.Excalifont,
  "sans-serif": FONT_FAMILY.Helvetica,
  monospace: FONT_FAMILY.Cascadia,
} as const;

function fontFamilyName(value: number) {
  if (value === fontFamilies["hand-drawn"]) return "hand-drawn" as const;
  if (value === fontFamilies["sans-serif"]) return "sans-serif" as const;
  if (value === fontFamilies.monospace) return "monospace" as const;
  return undefined;
}

function arrowhead(value: DrawArrowhead): Arrowhead | null {
  return value === "none" ? null : value;
}

function arrowheadName(value: Arrowhead | null): DrawArrowhead {
  if (
    value === "arrow" ||
    value === "bar" ||
    value === "dot" ||
    value === "circle" ||
    value === "triangle" ||
    value === "diamond"
  )
    return value;
  return "none";
}

function fillStyle(fill: DrawStyleUpdate["fill"]) {
  return fill === "solid"
    ? "solid"
    : fill === "pattern"
      ? "cross-hatch"
      : fill === "semi"
        ? "hachure"
        : undefined;
}

function nonDeleted(api: ExcalidrawImperativeAPI) {
  return api.getSceneElements().filter((element) => !element.isDeleted);
}

function elementMap(elements: readonly ExcalidrawElement[]) {
  return new Map(elements.map((element) => [element.id, element]));
}

const CakeGeneratedCompanionDataSchema = Schema.Struct({
  cakeGeneratedCompanionFor: Schema.String,
  cakeGeneratedCompanionKind: Schema.Literals(["title", "connector"]),
});

function generatedCompanionData(element: ExcalidrawElement) {
  return Option.getOrUndefined(
    Schema.decodeUnknownOption(CakeGeneratedCompanionDataSchema)(element.customData),
  );
}

function generatedCompanionFor(element: ExcalidrawElement) {
  return generatedCompanionData(element)?.cakeGeneratedCompanionFor;
}

function boundLabel(
  element: ExcalidrawElement,
  elements: readonly ExcalidrawElement[],
): ExcalidrawTextElement | undefined {
  return elements.find(
    (candidate): candidate is ExcalidrawTextElement =>
      candidate.type === "text" &&
      (candidate.containerId === element.id || generatedCompanionFor(candidate) === element.id) &&
      !candidate.isDeleted,
  );
}

function isGeneratedLabelFor(element: ExcalidrawElement, ids: ReadonlySet<string>) {
  if (element.type !== "text") return false;
  const relatedId = element.containerId ?? generatedCompanionFor(element);
  return !!relatedId && ids.has(relatedId);
}

function visibleElements(elements: readonly ExcalidrawElement[]) {
  return elements.filter(
    (element) =>
      !element.isDeleted &&
      !(element.type === "text" && (element.containerId || generatedCompanionFor(element))),
  );
}

interface CakeDiagramElementData {
  readonly diagramId: string;
  readonly semanticId: string;
  readonly role: "node" | "group" | "edge";
}

interface CakeConnectorData {
  readonly fromPort: "top" | "right" | "bottom" | "left" | "auto";
  readonly toPort: "top" | "right" | "bottom" | "left" | "auto";
  readonly routing: "straight" | "orthogonal";
}

const CakeDiagramElementDataSchema = Schema.Struct({
  diagramId: Schema.String,
  semanticId: Schema.String,
  role: Schema.Literals(["node", "group", "edge"]),
});
const CakeConnectorDataSchema = Schema.Struct({
  fromPort: Schema.Literals(["top", "right", "bottom", "left", "auto"]),
  toPort: Schema.Literals(["top", "right", "bottom", "left", "auto"]),
  routing: Schema.Literals(["straight", "orthogonal"]),
});

function diagramData(element: ExcalidrawElement): CakeDiagramElementData | undefined {
  return Option.getOrUndefined(
    Schema.decodeUnknownOption(CakeDiagramElementDataSchema)(element.customData?.cakeDiagram),
  );
}

function connectorData(element: ExcalidrawElement): CakeConnectorData | undefined {
  return Option.getOrUndefined(
    Schema.decodeUnknownOption(CakeConnectorDataSchema)(element.customData?.cakeConnector),
  );
}

function withDiagramData(
  element: ExcalidrawElement,
  data: CakeDiagramElementData,
): ExcalidrawElement {
  return newElementWith(element, {
    customData: { ...element.customData, cakeDiagram: data },
  });
}

function boundsOf(element: ExcalidrawElement, elements: readonly ExcalidrawElement[]) {
  const related = [element];
  const label = boundLabel(element, elements);
  if (label) related.push(label);
  const [minX, minY, maxX, maxY] = getCommonBounds(related);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function viewportBounds(appState: AppState) {
  // Excalidraw converts window-client coordinates, not pane-local coordinates.
  const start = viewportCoordsToSceneCoords(
    { clientX: appState.offsetLeft, clientY: appState.offsetTop },
    appState,
  );
  return {
    x: start.x,
    y: start.y,
    width: appState.width / appState.zoom.value,
    height: appState.height / appState.zoom.value,
  };
}

function fitElements(api: ExcalidrawImperativeAPI, elements: readonly ExcalidrawElement[]) {
  if (elements.length === 0) return;
  // scrollToContent uses React setState even with animation disabled. Commit it before
  // the tool reads the camera or DrawStore snapshots and persists the completed stage.
  flushSync(() =>
    api.scrollToContent(elements, {
      animate: false,
      fitToViewport: true,
      viewportZoomFactor: 0.85,
      maxZoom: 1,
    }),
  );
}

function compositionElements(api: ExcalidrawImperativeAPI, receipt: MutableDrawApplyReceipt) {
  const elements = nonDeleted(api);
  const ids = new Set([...receipt.createdIds, ...receipt.updatedIds]);
  for (const element of elements) {
    if (!ids.has(element.id) || element.type !== "arrow") continue;
    if (element.startBinding) ids.add(element.startBinding.elementId);
    if (element.endBinding) ids.add(element.endBinding.elementId);
  }
  return elements.filter((element) => ids.has(element.id) || isGeneratedLabelFor(element, ids));
}

function changesLayout(operation: PreparedOperation) {
  return (
    operation.type === "create" ||
    operation.type === "create-relative" ||
    operation.type === "connect" ||
    operation.type === "update" ||
    operation.type === "move" ||
    operation.type === "align" ||
    operation.type === "distribute" ||
    (operation.type === "style" &&
      (operation.style.fontSize !== undefined || operation.style.fontFamily !== undefined))
  );
}

function idsForScope(
  api: ExcalidrawImperativeAPI,
  elements: readonly ExcalidrawElement[],
  scope: DrawReadScope,
) {
  const visible = visibleElements(elements);
  if (scope === "selection") {
    const selected = api.getAppState().selectedElementIds;
    return visible.filter((element) => selected[element.id]).map((element) => element.id);
  }
  if (scope === "page") return visible.map((element) => element.id);
  const viewport = viewportBounds(api.getAppState());
  return visible
    .filter((element) => {
      const bounds = boundsOf(element, elements);
      return (
        bounds.x <= viewport.x + viewport.width &&
        bounds.x + bounds.width >= viewport.x &&
        bounds.y <= viewport.y + viewport.height &&
        bounds.y + bounds.height >= viewport.y
      );
    })
    .map((element) => element.id);
}

function validateCreateShape(shape: DrawCreateShape) {
  finite(shape.x, "x");
  if (shape.sourceLink) formatDrawSourceLink(shape.sourceLink);
  finite(shape.y, "y");
  switch (shape.type) {
    case "geo":
      positive(shape.width, "width");
      positive(shape.height, "height");
      if (shape.text !== undefined) text(shape.text);
      color(shape.color);
      break;
    case "text":
      text(shape.text);
      if (shape.width !== undefined) positive(shape.width, "width");
      break;
    case "note":
      text(shape.text);
      color(shape.color, colorPalette.get("yellow")!);
      break;
    case "line":
    case "arrow":
      finite(shape.endX, "endX");
      finite(shape.endY, "endY");
      if (shape.text !== undefined) text(shape.text);
      break;
  }
}

function validateRelativeShape(shape: DrawRelativeShape) {
  const { placement } = shape;
  if (shape.sourceLink) formatDrawSourceLink(shape.sourceLink);
  if (placement.gap !== undefined && (!Number.isFinite(placement.gap) || placement.gap < 0))
    throw new Error("gap must be a non-negative canvas distance");
  switch (shape.type) {
    case "geo":
      positive(shape.width, "width");
      positive(shape.height, "height");
      if (shape.text !== undefined) text(shape.text);
      color(shape.color);
      break;
    case "text":
      text(shape.text);
      if (shape.width !== undefined) positive(shape.width, "width");
      break;
    case "note":
      text(shape.text);
      color(shape.color, colorPalette.get("yellow")!);
      break;
  }
}

function uniqueTargetIds(values: readonly string[], operation: string) {
  const ids = values.map(shapeId);
  if (new Set(ids).size !== ids.length)
    throw new Error(`${operation} contains a duplicate shape target`);
  return ids;
}

function requireTargetCount(ids: readonly string[], operation: string, minimum: number) {
  if (ids.length < minimum)
    throw new Error(
      `${operation} requires at least ${minimum} shape target${minimum === 1 ? "" : "s"}`,
    );
}

interface KnownShape {
  readonly type: ExcalidrawElement["type"];
  readonly hasText: boolean;
}

function requireTargets(
  known: ReadonlyMap<string, KnownShape>,
  ids: readonly string[],
  operation: string,
) {
  for (const id of ids) {
    if (!known.has(id)) throw new Error(`Shape not found for ${operation}: ${id}`);
  }
}

function knownCreatedShape(shape: DrawCreateShape | DrawRelativeShape): KnownShape {
  if (shape.type === "geo")
    return { type: shape.geo ?? "rectangle", hasText: shape.text !== undefined };
  if (shape.type === "note") return { type: "rectangle", hasText: true };
  return { type: shape.type, hasText: shape.type === "text" || shape.text !== undefined };
}

function validateStyleUpdate(style: DrawStyleUpdate, targets: readonly KnownShape[]) {
  if (Object.values(style).every((value) => value === undefined))
    throw new Error("style must change at least one property");
  if (style.strokeColor !== undefined) color(style.strokeColor);
  if (style.backgroundColor !== undefined) color(style.backgroundColor);
  if (
    style.strokeWidth !== undefined &&
    (!Number.isFinite(style.strokeWidth) || style.strokeWidth <= 0 || style.strokeWidth > 20)
  )
    throw new Error("strokeWidth must be greater than zero and at most 20");
  if (
    style.fontSize !== undefined &&
    (!Number.isFinite(style.fontSize) || style.fontSize < 1 || style.fontSize > 512)
  )
    throw new Error("fontSize must be between 1 and 512");
  if (
    style.opacity !== undefined &&
    (!Number.isFinite(style.opacity) || style.opacity < 0 || style.opacity > 1)
  )
    throw new Error("opacity must be between 0 and 1");
  const needsFillable =
    style.backgroundColor !== undefined ||
    style.fill !== undefined ||
    style.roundness !== undefined;
  if (
    needsFillable &&
    targets.some(({ type }) => type !== "rectangle" && type !== "ellipse" && type !== "diamond")
  )
    throw new Error(
      "backgroundColor, fill, and roundness require rectangle, ellipse, or diamond shapes",
    );
  const needsText =
    style.fontSize !== undefined ||
    style.fontFamily !== undefined ||
    style.textAlign !== undefined ||
    style.verticalAlign !== undefined;
  if (needsText && targets.some(({ hasText }) => !hasText))
    throw new Error("Typography requires text or a labeled shape");
  const needsArrow = style.startArrowhead !== undefined || style.endArrowhead !== undefined;
  if (needsArrow && targets.some(({ type }) => type !== "line" && type !== "arrow"))
    throw new Error("Arrowheads require line or arrow shapes");
}

function prepareOperations(
  api: ExcalidrawImperativeAPI,
  operations: readonly DrawOperation[],
): PreparedOperation[] {
  if (operations.length === 0 || operations.length > 500)
    throw new Error("A draw batch must contain between 1 and 500 operations");

  const sceneElements = nonDeleted(api);
  const known = new Map(
    visibleElements(sceneElements).map((element) => [
      element.id,
      {
        type: element.type,
        hasText: element.type === "text" || !!boundLabel(element, sceneElements),
      },
    ]),
  );
  const prepared: PreparedOperation[] = [];
  for (const operation of operations) {
    switch (operation.type) {
      case "create": {
        validateCreateShape(operation.shape);
        const id = operation.shape.id ? shapeId(operation.shape.id) : generatedShapeId();
        if (known.has(id)) throw new Error(`Duplicate shape ID: ${id}`);
        known.set(id, knownCreatedShape(operation.shape));
        prepared.push({ ...operation, id });
        break;
      }
      case "create-relative": {
        validateRelativeShape(operation.shape);
        const id = operation.shape.id ? shapeId(operation.shape.id) : generatedShapeId();
        const relativeTo = shapeId(operation.shape.placement.relativeTo);
        if (known.has(id)) throw new Error(`Duplicate shape ID: ${id}`);
        requireTargets(known, [relativeTo], "create-relative");
        known.set(id, knownCreatedShape(operation.shape));
        prepared.push({ ...operation, id, relativeTo });
        break;
      }
      case "connect": {
        const id = operation.id ? shapeId(operation.id) : generatedShapeId();
        const fromId = shapeId(operation.fromId);
        const toId = shapeId(operation.toId);
        if (known.has(id)) throw new Error(`Duplicate shape ID: ${id}`);
        requireTargets(known, [fromId, toId], "connect");
        if (operation.text !== undefined) text(operation.text);
        known.set(id, { type: "arrow", hasText: operation.text !== undefined });
        prepared.push({ ...operation, id, fromId, toId });
        break;
      }
      case "update": {
        const id = shapeId(operation.id);
        requireTargets(known, [id], "update");
        const target = known.get(id)!;
        if (
          operation.x === undefined &&
          operation.y === undefined &&
          operation.width === undefined &&
          operation.height === undefined &&
          operation.endX === undefined &&
          operation.endY === undefined &&
          operation.rotation === undefined &&
          operation.opacity === undefined &&
          operation.text === undefined &&
          operation.geo === undefined &&
          operation.sourceLink === undefined
        )
          throw new Error("update must change at least one property");
        if (operation.x !== undefined) finite(operation.x, "x");
        if (operation.y !== undefined) finite(operation.y, "y");
        if (operation.width !== undefined) positive(operation.width, "width");
        if (operation.height !== undefined) positive(operation.height, "height");
        if (operation.endX !== undefined) finite(operation.endX, "endX");
        if (operation.endY !== undefined) finite(operation.endY, "endY");
        if (operation.rotation !== undefined) finite(operation.rotation, "rotation");
        if (
          operation.opacity !== undefined &&
          (!Number.isFinite(operation.opacity) || operation.opacity < 0 || operation.opacity > 1)
        )
          throw new Error("opacity must be between 0 and 1");
        if (operation.text !== undefined) {
          text(operation.text);
          if (!target.hasText) throw new Error(`Shape does not support text: ${id}`);
        }
        const linear = target.type === "line" || target.type === "arrow";
        if (
          (operation.width !== undefined || operation.height !== undefined) &&
          (linear || target.type === "freedraw")
        )
          throw new Error(
            "width and height cannot resize line, arrow, or free-draw shapes; use endX/endY for linear shapes",
          );
        if ((operation.endX !== undefined || operation.endY !== undefined) && !linear)
          throw new Error("endX and endY require a line or arrow shape");
        if (
          operation.geo !== undefined &&
          target.type !== "rectangle" &&
          target.type !== "ellipse" &&
          target.type !== "diamond"
        )
          throw new Error("geo conversion requires a rectangle, ellipse, or diamond shape");
        if (operation.geo !== undefined) known.set(id, { ...target, type: operation.geo });
        if (operation.sourceLink) formatDrawSourceLink(operation.sourceLink);
        prepared.push(operation);
        break;
      }
      case "style": {
        const ids = uniqueTargetIds(operation.ids, "style");
        requireTargetCount(ids, "style", 1);
        requireTargets(known, ids, "style");
        validateStyleUpdate(
          operation.style,
          ids.map((id) => known.get(id)!),
        );
        prepared.push(operation);
        break;
      }
      case "delete": {
        const ids = uniqueTargetIds(operation.ids, "delete");
        requireTargetCount(ids, "delete", 1);
        requireTargets(known, ids, "delete");
        for (const id of ids) known.delete(id);
        prepared.push(operation);
        break;
      }
      case "delete-diagram": {
        const ids = visibleElements(sceneElements)
          .filter((element) => diagramData(element)?.diagramId === operation.id)
          .map(({ id }) => id);
        if (ids.length === 0) throw new Error(`Named diagram not found: ${operation.id}`);
        for (const id of ids) known.delete(id);
        prepared.push(operation);
        break;
      }
      case "move": {
        const ids = uniqueTargetIds(operation.ids, "move");
        requireTargetCount(ids, "move", 1);
        requireTargets(known, ids, "move");
        finite(operation.deltaX, "deltaX");
        finite(operation.deltaY, "deltaY");
        prepared.push(operation);
        break;
      }
      case "align":
      case "distribute":
      case "bring-to-front":
      case "bring-forward":
      case "send-backward":
      case "send-to-back":
      case "set-locked":
      case "select":
      case "zoom-to": {
        const ids = uniqueTargetIds(operation.ids, operation.type);
        const minimum =
          operation.type === "select"
            ? 0
            : operation.type === "align"
              ? 2
              : operation.type === "distribute"
                ? 3
                : 1;
        requireTargetCount(ids, operation.type, minimum);
        requireTargets(known, ids, operation.type);
        prepared.push(operation);
        break;
      }
    }
  }
  return prepared;
}

function relativeSize(shape: DrawRelativeShape) {
  switch (shape.type) {
    case "geo":
      return { width: shape.width, height: shape.height };
    case "note":
      return { width: 200, height: 200 };
    case "text":
      return {
        width: shape.width ?? Math.min(480, Math.max(80, shape.text.length * 10)),
        height: 32,
      };
  }
}

function resolveRelativeShape(
  shape: DrawRelativeShape,
  relativeTo: string,
  elements: readonly ExcalidrawElement[],
): DrawCreateShape {
  const target = elementMap(elements).get(relativeTo);
  if (!target) throw new Error(`Relative placement target disappeared: ${relativeTo}`);
  const targetBounds = boundsOf(target, elements);
  const size = relativeSize(shape);
  const gap = shape.placement.gap ?? 80;
  const align = shape.placement.align ?? "center";
  const crossPosition = (start: number, span: number, ownSpan: number) =>
    align === "start"
      ? start
      : align === "end"
        ? start + span - ownSpan
        : start + (span - ownSpan) / 2;
  const x =
    shape.placement.side === "left"
      ? targetBounds.x - gap - size.width
      : shape.placement.side === "right"
        ? targetBounds.x + targetBounds.width + gap
        : crossPosition(targetBounds.x, targetBounds.width, size.width);
  const y =
    shape.placement.side === "above"
      ? targetBounds.y - gap - size.height
      : shape.placement.side === "below"
        ? targetBounds.y + targetBounds.height + gap
        : crossPosition(targetBounds.y, targetBounds.height, size.height);
  switch (shape.type) {
    case "geo":
      return {
        id: shape.id,
        type: "geo",
        x,
        y,
        width: shape.width,
        height: shape.height,
        text: shape.text,
        geo: shape.geo,
        color: shape.color,
        fill: shape.fill,
        sourceLink: shape.sourceLink,
      };
    case "text":
      return {
        id: shape.id,
        type: "text",
        x,
        y,
        text: shape.text,
        width: shape.width,
        sourceLink: shape.sourceLink,
      };
    case "note":
      return {
        id: shape.id,
        type: "note",
        x,
        y,
        text: shape.text,
        color: shape.color,
        sourceLink: shape.sourceLink,
      };
  }
}

function createElements(shape: DrawCreateShape, id: string): OrderedExcalidrawElement[] {
  const sourceLink = shape.sourceLink;
  const withSourceLink = (elements: OrderedExcalidrawElement[]) =>
    sourceLink
      ? elements.map((element) =>
          element.id === id
            ? newElementWith(element, { link: formatDrawSourceLink(sourceLink) })
            : element,
        )
      : elements;
  switch (shape.type) {
    case "geo": {
      const type = shape.geo ?? "rectangle";
      return withSourceLink(
        convertToExcalidrawElements(
          [
            {
              id,
              type,
              x: shape.x,
              y: shape.y,
              width: shape.width,
              height: shape.height,
              strokeColor: color(shape.color),
              backgroundColor:
                shape.fill === "none" || !shape.fill ? "transparent" : color(shape.color),
              fillStyle:
                shape.fill === "solid"
                  ? "solid"
                  : shape.fill === "pattern"
                    ? "cross-hatch"
                    : "hachure",
              ...(shape.text
                ? {
                    label: {
                      text: shape.text,
                      strokeColor:
                        shape.fill &&
                        shape.fill !== "none" &&
                        color(shape.color) === colorPalette.get("black")
                          ? colorPalette.get("white")
                          : colorPalette.get("black"),
                    },
                  }
                : null),
            },
          ],
          { regenerateIds: false },
        ),
      );
    }
    case "note":
      return withSourceLink(
        convertToExcalidrawElements(
          [
            {
              id,
              type: "rectangle",
              x: shape.x,
              y: shape.y,
              width: 200,
              height: 200,
              strokeColor: color(shape.color, colorPalette.get("yellow")!),
              backgroundColor: color(shape.color, colorPalette.get("yellow")!),
              fillStyle: "solid",
              label: { text: shape.text, strokeColor: colorPalette.get("black") },
            },
          ],
          { regenerateIds: false },
        ),
      );
    case "text":
      return withSourceLink(
        convertToExcalidrawElements(
          [{ id, type: "text", x: shape.x, y: shape.y, text: shape.text, width: shape.width }],
          { regenerateIds: false },
        ),
      );
    case "line":
    case "arrow":
      return withSourceLink(
        convertToExcalidrawElements(
          [
            {
              id,
              type: shape.type,
              x: shape.x,
              y: shape.y,
              points: [
                [0, 0],
                [shape.endX - shape.x, shape.endY - shape.y],
              ],
              ...(shape.text
                ? { label: { text: shape.text, strokeColor: colorPalette.get("black") } }
                : null),
            },
          ],
          { regenerateIds: false },
        ),
      );
  }
}

function center(element: ExcalidrawElement, elements: readonly ExcalidrawElement[]) {
  const bounds = boundsOf(element, elements);
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

function automaticPort(
  from: ExcalidrawElement,
  to: ExcalidrawElement,
  elements: readonly ExcalidrawElement[],
) {
  const source = center(from, elements);
  const target = center(to, elements);
  if (Math.abs(target.x - source.x) >= Math.abs(target.y - source.y))
    return target.x >= source.x ? ("right" as const) : ("left" as const);
  return target.y >= source.y ? ("bottom" as const) : ("top" as const);
}

function attachmentPoint(
  element: ExcalidrawElement,
  side: CakeConnectorData["fromPort"],
  toward: ExcalidrawElement,
  elements: readonly ExcalidrawElement[],
) {
  const bounds = boundsOf(element, elements);
  const resolved = side === "auto" ? automaticPort(element, toward, elements) : side;
  if (resolved === "top") return { x: bounds.x + bounds.width / 2, y: bounds.y };
  if (resolved === "right") return { x: bounds.x + bounds.width, y: bounds.y + bounds.height / 2 };
  if (resolved === "bottom") return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height };
  return { x: bounds.x, y: bounds.y + bounds.height / 2 };
}

function segmentHitsBounds(
  start: { readonly x: number; readonly y: number },
  end: { readonly x: number; readonly y: number },
  bounds: ElementBounds,
) {
  const margin = 12;
  const left = bounds.x - margin;
  const right = bounds.x + bounds.width + margin;
  const top = bounds.y - margin;
  const bottom = bounds.y + bounds.height + margin;
  if (start.x === end.x)
    return (
      start.x > left &&
      start.x < right &&
      Math.max(start.y, end.y) > top &&
      Math.min(start.y, end.y) < bottom
    );
  if (start.y === end.y)
    return (
      start.y > top &&
      start.y < bottom &&
      Math.max(start.x, end.x) > left &&
      Math.min(start.x, end.x) < right
    );
  return false;
}

function connectorPoints(
  start: { readonly x: number; readonly y: number },
  end: { readonly x: number; readonly y: number },
  routing: CakeConnectorData["routing"],
  obstacles: readonly ElementBounds[] = [],
) {
  if (routing === "straight")
    return [
      [0, 0],
      [end.x - start.x, end.y - start.y],
    ] as const;
  const horizontal = [
    start,
    { x: (start.x + end.x) / 2, y: start.y },
    { x: (start.x + end.x) / 2, y: end.y },
    end,
  ];
  const vertical = [
    start,
    { x: start.x, y: (start.y + end.y) / 2 },
    { x: end.x, y: (start.y + end.y) / 2 },
    end,
  ];
  const collisions = (points: readonly { readonly x: number; readonly y: number }[]) =>
    points
      .slice(1)
      .reduce(
        (count, point, index) =>
          count +
          obstacles.filter((bounds) => segmentHitsBounds(points[index]!, point, bounds)).length,
        0,
      );
  let route = collisions(horizontal) <= collisions(vertical) ? horizontal : vertical;
  if (collisions(route) > 0) {
    if (Math.abs(end.y - start.y) >= Math.abs(end.x - start.x)) {
      const detourX = Math.min(start.x, end.x, ...obstacles.map(({ x }) => x)) - 180;
      route = [start, { x: detourX, y: start.y }, { x: detourX, y: end.y }, end];
    } else {
      const detourY = Math.min(start.y, end.y, ...obstacles.map(({ y }) => y)) - 80;
      route = [start, { x: start.x, y: detourY }, { x: end.x, y: detourY }, end];
    }
  }
  // Aligned ports can collapse a dogleg's first or last segment to zero length.
  // Excalidraw derives arrowhead direction from those segments, so remove duplicates.
  return route
    .filter(
      (point, index) =>
        index === 0 || point.x !== route[index - 1]!.x || point.y !== route[index - 1]!.y,
    )
    .map(({ x, y }) => [x - start.x, y - start.y] as const);
}

function connectElements(
  elements: readonly ExcalidrawElement[],
  operation: PreparedConnectOperation,
): ExcalidrawElement[] {
  const byId = elementMap(elements);
  const from = byId.get(operation.fromId);
  const to = byId.get(operation.toId);
  if (!from || !to) throw new Error("Connection target disappeared");
  const connector: CakeConnectorData = {
    fromPort: operation.fromPort ?? "auto",
    toPort: operation.toPort ?? "auto",
    routing: operation.routing ?? "orthogonal",
  };
  const start = attachmentPoint(from, connector.fromPort, to, elements);
  const end = attachmentPoint(to, connector.toPort, from, elements);
  const obstacles = visibleElements(elements)
    .filter((element) => element.id !== from.id && element.id !== to.id)
    .filter((element) => element.type !== "arrow" && element.type !== "line")
    .filter((element) => diagramData(element)?.role !== "group")
    .map((element) => boundsOf(element, elements));
  const created = convertToExcalidrawElements(
    [
      {
        id: operation.id,
        type: "arrow",
        x: start.x,
        y: start.y,
        points: [...connectorPoints(start, end, connector.routing, obstacles)],
        startBinding: { elementId: operation.fromId, focus: 0, gap: 1 },
        endBinding: { elementId: operation.toId, focus: 0, gap: 1 },
        ...(operation.text
          ? { label: { text: operation.text, strokeColor: colorPalette.get("black") } }
          : null),
      },
    ],
    { regenerateIds: false },
  );
  const arrow = created.find((element) => element.id === operation.id);
  if (!arrow || arrow.type !== "arrow") throw new Error("Could not create connected arrow");
  const boundArrow = newElementWith(arrow, {
    startBinding: { elementId: operation.fromId, focus: 0, gap: 1 },
    endBinding: { elementId: operation.toId, focus: 0, gap: 1 },
    customData: { ...arrow.customData, cakeConnector: connector },
  });
  const createdWithBindings = created.map((element) =>
    element.id === operation.id ? boundArrow : element,
  );
  const withBindings = elements.map((element) => {
    if (element.id !== operation.fromId && element.id !== operation.toId) return element;
    const boundElements = [
      ...(element.boundElements ?? []),
      { id: operation.id, type: "arrow" as const },
    ];
    return newElementWith(element, { boundElements });
  });
  return [...withBindings, ...createdWithBindings];
}

function withPosition(element: ExcalidrawElement, x: number, y: number) {
  return newElementWith(element, { x, y });
}

function moveRelated(
  elements: readonly ExcalidrawElement[],
  ids: ReadonlySet<string>,
  dx: number,
  dy: number,
) {
  return elements.map((element) => {
    const companionId = generatedCompanionFor(element);
    const related =
      ids.has(element.id) ||
      (element.type === "text" &&
        ((!!element.containerId && ids.has(element.containerId)) ||
          (!!companionId && ids.has(companionId))));
    return related ? withPosition(element, element.x + dx, element.y + dy) : element;
  });
}

function updateConnections(elements: readonly ExcalidrawElement[]) {
  const byId = elementMap(elements);
  return elements.map((element) => {
    if (element.type !== "arrow" || !element.startBinding || !element.endBinding) return element;
    const from = byId.get(element.startBinding.elementId);
    const to = byId.get(element.endBinding.elementId);
    if (!from || !to) return element;
    const connector = connectorData(element) ?? {
      fromPort: "auto" as const,
      toPort: "auto" as const,
      routing: "straight" as const,
    };
    const start = attachmentPoint(from, connector.fromPort, to, elements);
    const end = attachmentPoint(to, connector.toPort, from, elements);
    const obstacles = visibleElements(elements)
      .filter((candidate) => candidate.id !== from.id && candidate.id !== to.id)
      .filter((candidate) => candidate.type !== "arrow" && candidate.type !== "line")
      .filter((candidate) => diagramData(candidate)?.role !== "group")
      .map((candidate) => boundsOf(candidate, elements));
    return newElementWith(element, {
      x: start.x,
      y: start.y,
      points: [...connectorPoints(start, end, connector.routing, obstacles)],
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
    });
  });
}

function updateElementText(
  elements: readonly ExcalidrawElement[],
  target: ExcalidrawElement,
  value: string,
) {
  const label = boundLabel(target, elements);
  if (target.type === "text")
    return elements.map((element) =>
      element.id === target.id
        ? newElementWith(target, { text: value, originalText: value })
        : element,
    );
  if (label)
    return elements.map((element) =>
      element.id === label.id
        ? newElementWith(label, { text: value, originalText: value })
        : element,
    );
  throw new Error(`Shape does not support text: ${target.id}`);
}

function recenterBoundLabel(
  elements: readonly ExcalidrawElement[],
  containerId: string,
): readonly ExcalidrawElement[] {
  const container = elementMap(elements).get(containerId);
  if (!container) return elements;
  const label = boundLabel(container, elements);
  if (!label) return elements;
  return elements.map((element) =>
    element.id === label.id
      ? newElementWith(label, {
          x: container.x + (container.width - label.width) / 2,
          y: container.y + (container.height - label.height) / 2,
          angle: container.angle,
        })
      : element,
  );
}

function updateElementGeometry(
  elements: readonly ExcalidrawElement[],
  id: string,
  operation: Extract<DrawOperation, { type: "update" }>,
) {
  let target = elementMap(elements).get(id);
  if (!target) throw new Error(`Shape not found: ${id}`);
  const nextX = operation.x ?? target.x;
  const nextY = operation.y ?? target.y;
  let next = moveRelated(elements, new Set([id]), nextX - target.x, nextY - target.y);
  target = elementMap(next).get(id)!;
  if (
    (target.type === "line" || target.type === "arrow") &&
    (operation.endX !== undefined || operation.endY !== undefined)
  ) {
    const points = [...target.points];
    const last = points.at(-1) ?? [0, 0];
    points[points.length - 1] = [
      (operation.endX ?? target.x + last[0]) - target.x,
      (operation.endY ?? target.y + last[1]) - target.y,
    ];
    next = next.map((element) =>
      element.id === id
        ? newElementWith(target, {
            points,
            width: Math.abs(points.at(-1)![0]),
            height: Math.abs(points.at(-1)![1]),
            ...(operation.rotation === undefined ? null : { angle: operation.rotation }),
            ...(operation.opacity === undefined ? null : { opacity: operation.opacity * 100 }),
          })
        : element,
    );
  } else {
    next = next.map((element) => {
      if (element.id !== id) return element;
      return newElementWith(target!, {
        ...(operation.width === undefined ? null : { width: operation.width }),
        ...(operation.height === undefined ? null : { height: operation.height }),
        ...(operation.rotation === undefined ? null : { angle: operation.rotation }),
        ...(operation.opacity === undefined ? null : { opacity: operation.opacity * 100 }),
        ...(operation.geo === undefined ? null : { type: operation.geo }),
        ...(target!.type === "text" && operation.width !== undefined
          ? { autoResize: false }
          : null),
      });
    });
  }
  return recenterBoundLabel(next, id);
}

function styleTextElement(element: ExcalidrawTextElement, style: DrawStyleUpdate) {
  return newElementWith(element, {
    ...(style.strokeColor === undefined ? null : { strokeColor: color(style.strokeColor) }),
    ...(style.opacity === undefined ? null : { opacity: style.opacity * 100 }),
    ...(style.fontSize === undefined ? null : { fontSize: style.fontSize }),
    ...(style.fontFamily === undefined ? null : { fontFamily: fontFamilies[style.fontFamily] }),
    ...(style.textAlign === undefined ? null : { textAlign: style.textAlign }),
    ...(style.verticalAlign === undefined ? null : { verticalAlign: style.verticalAlign }),
  });
}

function styleElements(
  elements: readonly ExcalidrawElement[],
  ids: ReadonlySet<string>,
  style: DrawStyleUpdate,
) {
  let next = elements.map((element) => {
    if (element.type === "text" && isGeneratedLabelFor(element, ids))
      return styleTextElement(element, style);
    if (!ids.has(element.id)) return element;
    if (element.type === "text") return styleTextElement(element, style);
    const nextFill = fillStyle(style.fill);
    const backgroundColor =
      style.fill === "none"
        ? "transparent"
        : style.backgroundColor !== undefined
          ? color(style.backgroundColor)
          : style.fill !== undefined && element.backgroundColor === "transparent"
            ? color(style.strokeColor, element.strokeColor)
            : element.backgroundColor;
    return newElementWith(element, {
      ...(style.strokeColor === undefined ? null : { strokeColor: color(style.strokeColor) }),
      ...(style.backgroundColor === undefined && style.fill === undefined
        ? null
        : { backgroundColor }),
      ...(nextFill === undefined ? null : { fillStyle: nextFill }),
      ...(style.strokeWidth === undefined ? null : { strokeWidth: style.strokeWidth }),
      ...(style.strokeStyle === undefined ? null : { strokeStyle: style.strokeStyle }),
      ...(style.roughness === undefined ? null : { roughness: style.roughness }),
      ...(style.opacity === undefined ? null : { opacity: style.opacity * 100 }),
      ...(style.roundness === undefined
        ? null
        : {
            roundness: style.roundness === "round" ? { type: ROUNDNESS.PROPORTIONAL_RADIUS } : null,
          }),
      ...(style.startArrowhead === undefined
        ? null
        : { startArrowhead: arrowhead(style.startArrowhead) }),
      ...(style.endArrowhead === undefined
        ? null
        : { endArrowhead: arrowhead(style.endArrowhead) }),
    });
  });
  for (const id of ids) next = [...recenterBoundLabel(next, id)];
  return next;
}

function alignElements(
  elements: readonly ExcalidrawElement[],
  ids: readonly string[],
  alignment: Extract<DrawOperation, { type: "align" }>["alignment"],
) {
  const byId = elementMap(elements);
  const selected = ids.map((id) => byId.get(id)!);
  const bounds = selected.map((element) => boundsOf(element, elements));
  const minX = Math.min(...bounds.map((value) => value.x));
  const maxX = Math.max(...bounds.map((value) => value.x + value.width));
  const minY = Math.min(...bounds.map((value) => value.y));
  const maxY = Math.max(...bounds.map((value) => value.y + value.height));
  let next = elements;
  selected.forEach((element, index) => {
    const bound = bounds[index]!;
    const dx =
      alignment === "left"
        ? minX - bound.x
        : alignment === "right"
          ? maxX - bound.x - bound.width
          : alignment === "center-horizontal"
            ? (minX + maxX - bound.width) / 2 - bound.x
            : 0;
    const dy =
      alignment === "top"
        ? minY - bound.y
        : alignment === "bottom"
          ? maxY - bound.y - bound.height
          : alignment === "center-vertical"
            ? (minY + maxY - bound.height) / 2 - bound.y
            : 0;
    next = moveRelated(next, new Set([element.id]), dx, dy);
  });
  return next;
}

function distributeElements(
  elements: readonly ExcalidrawElement[],
  ids: readonly string[],
  direction: Extract<DrawOperation, { type: "distribute" }>["direction"],
) {
  if (ids.length < 3) return elements;
  const byId = elementMap(elements);
  const entries = ids
    .map((id) => ({ element: byId.get(id)!, bounds: boundsOf(byId.get(id)!, elements) }))
    .sort((left, right) =>
      direction === "horizontal" ? left.bounds.x - right.bounds.x : left.bounds.y - right.bounds.y,
    );
  const first = entries[0]!.bounds;
  const last = entries.at(-1)!.bounds;
  const totalSize = entries.reduce(
    (sum, entry) => sum + (direction === "horizontal" ? entry.bounds.width : entry.bounds.height),
    0,
  );
  const span =
    direction === "horizontal" ? last.x + last.width - first.x : last.y + last.height - first.y;
  const gap = (span - totalSize) / (entries.length - 1);
  let cursor = direction === "horizontal" ? first.x : first.y;
  let next = elements;
  for (const entry of entries) {
    const position = direction === "horizontal" ? entry.bounds.x : entry.bounds.y;
    const delta = cursor - position;
    next = moveRelated(
      next,
      new Set([entry.element.id]),
      direction === "horizontal" ? delta : 0,
      direction === "vertical" ? delta : 0,
    );
    cursor += (direction === "horizontal" ? entry.bounds.width : entry.bounds.height) + gap;
  }
  return next;
}

type DiagramLayer = "background" | "connector" | "node" | "foreground";

function containsElement(container: ExcalidrawElement, child: ExcalidrawElement) {
  return (
    child.id !== container.id &&
    child.x >= container.x &&
    child.y >= container.y &&
    child.x + child.width <= container.x + container.width &&
    child.y + child.height <= container.y + container.height
  );
}

function diagramBackgroundIds(
  elements: readonly ExcalidrawElement[],
  diagramIds: ReadonlySet<string>,
) {
  const candidates = elements.filter(
    (element) =>
      diagramIds.has(element.id) &&
      !element.isDeleted &&
      element.type !== "text" &&
      element.type !== "line" &&
      element.type !== "arrow",
  );
  const backgrounds = new Set(
    candidates
      .filter((element) => element.type === "frame" || element.type === "magicframe")
      .map(({ id }) => id),
  );
  for (const candidate of candidates) {
    if (candidate.type !== "rectangle" || candidate.groupIds.length === 0) continue;
    const groups = new Set(candidate.groupIds);
    if (
      candidates.some(
        (child) =>
          child.id !== candidate.id &&
          child.groupIds.some((groupId) => groups.has(groupId)) &&
          containsElement(candidate, child),
      )
    )
      backgrounds.add(candidate.id);
  }
  return backgrounds;
}

function diagramLayer(element: ExcalidrawElement, backgrounds: ReadonlySet<string>): DiagramLayer {
  if (backgrounds.has(element.id)) return "background";
  if (element.type === "line" || element.type === "arrow") return "connector";
  if (element.type === "text" && !element.containerId) return "foreground";
  return "node";
}

/**
 * Applies Cake Draw's creation-time diagram order without sorting existing artwork. Bound text
 * travels with its container because Excalidraw requires the text to immediately follow it.
 * Excalidraw's updateScene boundary subsequently synchronizes fractional indices with this order.
 */
function normalizeCreatedDiagramOrder(
  elements: readonly ExcalidrawElement[],
  createdIds: ReadonlySet<string>,
) {
  if (createdIds.size === 0) return elements;
  const movableIds = new Set(createdIds);
  for (const element of elements) {
    if (element.type === "text" && element.containerId && createdIds.has(element.containerId))
      movableIds.add(element.id);
  }
  const backgrounds = diagramBackgroundIds(
    elements,
    new Set(elements.filter((element) => !element.isDeleted).map(({ id }) => id)),
  );
  const moved = new Set<string>();
  const blocks = {
    background: new Array<ExcalidrawElement[]>(),
    connector: new Array<ExcalidrawElement[]>(),
    node: new Array<ExcalidrawElement[]>(),
    foreground: new Array<ExcalidrawElement[]>(),
  } satisfies Record<DiagramLayer, ExcalidrawElement[][]>;
  for (const element of elements) {
    if (!movableIds.has(element.id) || moved.has(element.id)) continue;
    if (element.type === "text" && element.containerId && movableIds.has(element.containerId))
      continue;
    const companions = elements.filter(
      (candidate) =>
        candidate.type === "text" &&
        candidate.containerId === element.id &&
        movableIds.has(candidate.id),
    );
    const block = [element, ...companions];
    for (const member of block) moved.add(member.id);
    blocks[diagramLayer(element, backgrounds)].push(block);
  }
  // Retain malformed/orphan imported companions rather than dropping them.
  for (const element of elements) {
    if (movableIds.has(element.id) && !moved.has(element.id)) {
      blocks[diagramLayer(element, backgrounds)].push([element]);
      moved.add(element.id);
    }
  }

  blocks.background.sort(
    (left, right) => right[0]!.width * right[0]!.height - left[0]!.width * left[0]!.height,
  );
  const untouched = elements.filter((element) => !movableIds.has(element.id));
  const ordered = [...blocks.background.flat(), ...untouched];
  const connectorAnchor = ordered.findIndex(
    (element) =>
      !element.isDeleted &&
      !(element.type === "text" && element.containerId) &&
      diagramLayer(element, backgrounds) !== "background" &&
      diagramLayer(element, backgrounds) !== "connector",
  );
  ordered.splice(
    connectorAnchor < 0 ? ordered.length : connectorAnchor,
    0,
    ...blocks.connector.flat(),
  );

  let nodeAnchor = ordered.length;
  while (nodeAnchor > 0) {
    const previous = ordered[nodeAnchor - 1]!;
    if (previous.type !== "text" || previous.containerId) break;
    nodeAnchor -= 1;
  }
  ordered.splice(nodeAnchor, 0, ...blocks.node.flat());
  ordered.push(...blocks.foreground.flat());
  return ordered;
}

function reorder(elements: readonly ExcalidrawElement[], ids: ReadonlySet<string>, front: boolean) {
  const selected = elements.filter(
    (element) => ids.has(element.id) || isGeneratedLabelFor(element, ids),
  );
  const rest = elements.filter((element) => !selected.includes(element));
  return front ? [...rest, ...selected] : [...selected, ...rest];
}

function reorderOneStep(
  elements: readonly ExcalidrawElement[],
  ids: ReadonlySet<string>,
  forward: boolean,
) {
  const blocks = elements.map((element) => ({
    element,
    selected: ids.has(element.id) || isGeneratedLabelFor(element, ids),
  }));
  if (forward) {
    for (let index = blocks.length - 2; index >= 0; index -= 1) {
      if (blocks[index]!.selected && !blocks[index + 1]!.selected)
        [blocks[index], blocks[index + 1]] = [blocks[index + 1]!, blocks[index]!];
    }
  } else {
    for (let index = 1; index < blocks.length; index += 1) {
      if (blocks[index]!.selected && !blocks[index - 1]!.selected)
        [blocks[index], blocks[index - 1]] = [blocks[index - 1]!, blocks[index]!];
    }
  }
  return blocks.map(({ element }) => element);
}

function plainSnapshot(api: ExcalidrawImperativeAPI): DrawSnapshot {
  const appState = api.getAppState();
  return {
    type: DRAW_SNAPSHOT_TYPE,
    version: DRAW_SNAPSHOT_VERSION,
    source: "cake",
    elements: api.getSceneElementsIncludingDeleted(),
    appState: {
      viewBackgroundColor: appState.viewBackgroundColor,
      scrollX: appState.scrollX,
      scrollY: appState.scrollY,
      zoom: appState.zoom,
    },
    files: api.getFiles(),
  };
}

interface RestoredDrawDocument {
  readonly elements: readonly ExcalidrawElement[];
  readonly appState: Readonly<
    Pick<AppState, "viewBackgroundColor" | "scrollX" | "scrollY" | "zoom">
  >;
  readonly files: BinaryFiles;
}

export function restoreDrawDocument(snapshot: DrawDocumentSnapshot): RestoredDrawDocument {
  assertPersistableDrawDocument(snapshot);
  // Excalidraw's restore function is the schema/migration boundary for its JSON document format.
  const elements: readonly ExcalidrawElement[] = JSON.parse(JSON.stringify(snapshot.elements));
  const appState: Partial<AppState> = JSON.parse(JSON.stringify(snapshot.appState));
  const files: BinaryFiles = JSON.parse(JSON.stringify(snapshot.files));
  const restored = restore(
    {
      elements,
      appState,
      files,
    },
    null,
    null,
    { repairBindings: true },
  );
  return {
    elements: restored.elements,
    appState: {
      viewBackgroundColor: restored.appState.viewBackgroundColor,
      scrollX: restored.appState.scrollX,
      scrollY: restored.appState.scrollY,
      zoom: restored.appState.zoom,
    },
    files: restored.files,
  };
}

function asDrawDocumentSnapshot(snapshot: DrawSnapshot): DrawDocumentSnapshot {
  const document: DrawDocumentSnapshot = JSON.parse(JSON.stringify(snapshot));
  return document;
}

interface ShapeSummaryResult {
  readonly summary: DrawShapeSummary;
  readonly textTruncated: boolean;
}

function summaryFill(element: ExcalidrawElement) {
  if (element.backgroundColor === "transparent") return "none" as const;
  if (element.fillStyle === "solid") return "solid" as const;
  if (element.fillStyle === "hachure") return "semi" as const;
  return "pattern" as const;
}

function textAlignName(value: string): "left" | "center" | "right" {
  return value === "center" || value === "right" ? value : "left";
}

function verticalAlignName(value: string): "top" | "middle" | "bottom" {
  return value === "middle" || value === "bottom" ? value : "top";
}

function summaryStyle(element: ExcalidrawElement, label?: ExcalidrawTextElement): DrawShapeStyle {
  const typography = element.type === "text" ? element : label;
  const linear = element.type === "line" || element.type === "arrow" ? element : undefined;
  const family = typography ? fontFamilyName(typography.fontFamily) : undefined;
  return {
    strokeColor: element.strokeColor,
    backgroundColor: element.backgroundColor,
    fill: summaryFill(element),
    strokeWidth: element.strokeWidth,
    strokeStyle: element.strokeStyle,
    roughness: element.roughness,
    opacity: element.opacity / 100,
    roundness: element.roundness ? ("round" as const) : ("sharp" as const),
    ...(typography
      ? {
          fontSize: typography.fontSize,
          ...(family ? { fontFamily: family } : null),
          textAlign: textAlignName(typography.textAlign),
          verticalAlign: verticalAlignName(typography.verticalAlign),
        }
      : null),
    ...(linear
      ? {
          startArrowhead: arrowheadName(linear.startArrowhead),
          endArrowhead: arrowheadName(linear.endArrowhead),
        }
      : null),
    locked: element.locked,
  };
}

function summaryFor(
  element: ExcalidrawElement,
  elements: readonly ExcalidrawElement[],
): ShapeSummaryResult {
  const label = boundLabel(element, elements);
  const fullText =
    element.type === "text"
      ? element.originalText || element.text
      : label?.originalText || label?.text || "";
  const bounds = boundsOf(element, elements);
  const connections =
    element.type === "arrow"
      ? [
          ...(element.startBinding
            ? [{ terminal: "start" as const, shapeId: element.startBinding.elementId }]
            : []),
          ...(element.endBinding
            ? [{ terminal: "end" as const, shapeId: element.endBinding.elementId }]
            : []),
        ]
      : undefined;
  const sourceLink = element.link ? parseDrawSourceLink(element.link) : undefined;
  const diagram = diagramData(element);
  return {
    summary: {
      id: element.id,
      type: element.type,
      bounds,
      ...(fullText ? { text: fullText.slice(0, MAX_SUMMARY_TEXT_LENGTH) } : null),
      style: summaryStyle(element, label),
      ...(connections?.length ? { connections } : null),
      ...(sourceLink ? { sourceLink } : null),
      ...(diagram
        ? {
            diagramId: diagram.diagramId,
            semanticId: diagram.semanticId,
            diagramRole: diagram.role,
          }
        : null),
    },
    textTruncated: fullText.length > MAX_SUMMARY_TEXT_LENGTH,
  };
}

function dataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)), { once: true });
    reader.addEventListener("error", () => reject(reader.error), { once: true });
    reader.readAsDataURL(blob);
  });
}

function mergeReceipt(target: MutableDrawApplyReceipt, source: MutableDrawApplyReceipt) {
  for (const id of source.createdIds)
    if (!target.createdIds.includes(id)) target.createdIds.push(id);
  for (const id of source.updatedIds)
    if (!target.updatedIds.includes(id)) target.updatedIds.push(id);
  for (const id of source.deletedIds)
    if (!target.deletedIds.includes(id)) target.deletedIds.push(id);
}

function compactReceipt(receipt: MutableDrawApplyReceipt): MutableDrawApplyReceipt {
  return {
    createdIds: [...new Set(receipt.createdIds)],
    updatedIds: [...new Set(receipt.updatedIds)],
    deletedIds: [...new Set(receipt.deletedIds)],
  };
}

function applyPreparedOperations(
  api: ExcalidrawImperativeAPI,
  prepared: readonly PreparedOperation[],
  captureUpdate: NonNullable<
    Parameters<ExcalidrawImperativeAPI["updateScene"]>[0]["captureUpdate"]
  >,
  highlightActive: boolean,
) {
  let elements: readonly ExcalidrawElement[] = api.getSceneElementsIncludingDeleted();
  const receipt: MutableDrawApplyReceipt = {
    createdIds: [],
    updatedIds: [],
    deletedIds: [],
  };
  let selectedElementIds: Record<string, true> | undefined;
  let zoomIds: string[] | undefined;
  const createdDiagramIds = new Set<string>();
  for (const operation of prepared) {
    switch (operation.type) {
      case "create":
        elements = [...elements, ...createElements(operation.shape, operation.id)];
        createdDiagramIds.add(operation.id);
        elements = normalizeCreatedDiagramOrder(elements, createdDiagramIds);
        receipt.createdIds.push(operation.id);
        if (highlightActive) selectedElementIds = { [operation.id]: true };
        break;
      case "create-relative": {
        const shape = resolveRelativeShape(operation.shape, operation.relativeTo, elements);
        elements = [...elements, ...createElements(shape, operation.id)];
        createdDiagramIds.add(operation.id);
        elements = normalizeCreatedDiagramOrder(elements, createdDiagramIds);
        receipt.createdIds.push(operation.id);
        if (highlightActive) selectedElementIds = { [operation.id]: true };
        break;
      }
      case "connect":
        elements = connectElements(elements, operation);
        createdDiagramIds.add(operation.id);
        elements = normalizeCreatedDiagramOrder(elements, createdDiagramIds);
        receipt.createdIds.push(operation.id);
        if (highlightActive) selectedElementIds = { [operation.id]: true };
        break;
      case "update": {
        const id = shapeId(operation.id);
        const target = elementMap(elements).get(id);
        if (!target) throw new Error(`Shape not found: ${id}`);
        if (operation.text !== undefined)
          elements = updateElementText(elements, target, operation.text);
        elements = updateElementGeometry(elements, id, operation);
        if (operation.sourceLink !== undefined)
          elements = elements.map((element) =>
            element.id === id
              ? newElementWith(element, {
                  link: operation.sourceLink ? formatDrawSourceLink(operation.sourceLink) : null,
                })
              : element,
          );
        receipt.updatedIds.push(id);
        if (highlightActive) selectedElementIds = { [id]: true };
        break;
      }
      case "style": {
        const ids = new Set(operation.ids.map(shapeId));
        elements = styleElements(elements, ids, operation.style);
        receipt.updatedIds.push(...ids);
        if (highlightActive)
          selectedElementIds = Object.fromEntries([...ids].map((id) => [id, true]));
        break;
      }
      case "delete": {
        const ids = new Set(operation.ids.map(shapeId));
        elements = elements.map((element) =>
          ids.has(element.id) || isGeneratedLabelFor(element, ids)
            ? newElementWith(element, { isDeleted: true })
            : element,
        );
        receipt.deletedIds.push(...ids);
        if (highlightActive) selectedElementIds = {};
        break;
      }
      case "delete-diagram": {
        const deletedIds = visibleElements(elements)
          .filter((element) => diagramData(element)?.diagramId === operation.id)
          .map(({ id }) => id);
        elements = elements.map((element) =>
          diagramData(element)?.diagramId === operation.id
            ? newElementWith(element, { isDeleted: true })
            : element,
        );
        receipt.deletedIds.push(...deletedIds);
        if (highlightActive) selectedElementIds = {};
        break;
      }
      case "move": {
        const ids = new Set(operation.ids.map(shapeId));
        elements = moveRelated(elements, ids, operation.deltaX, operation.deltaY);
        receipt.updatedIds.push(...ids);
        if (highlightActive)
          selectedElementIds = Object.fromEntries([...ids].map((id) => [id, true]));
        break;
      }
      case "align": {
        const ids = operation.ids.map(shapeId);
        elements = alignElements(elements, ids, operation.alignment);
        receipt.updatedIds.push(...ids);
        if (highlightActive) selectedElementIds = Object.fromEntries(ids.map((id) => [id, true]));
        break;
      }
      case "distribute": {
        const ids = operation.ids.map(shapeId);
        elements = distributeElements(elements, ids, operation.direction);
        receipt.updatedIds.push(...ids);
        if (highlightActive) selectedElementIds = Object.fromEntries(ids.map((id) => [id, true]));
        break;
      }
      case "bring-to-front":
      case "bring-forward":
      case "send-backward":
      case "send-to-back": {
        const ids = new Set(operation.ids.map(shapeId));
        elements =
          operation.type === "bring-to-front"
            ? reorder(elements, ids, true)
            : operation.type === "send-to-back"
              ? reorder(elements, ids, false)
              : reorderOneStep(elements, ids, operation.type === "bring-forward");
        receipt.updatedIds.push(...ids);
        if (highlightActive)
          selectedElementIds = Object.fromEntries([...ids].map((id) => [id, true]));
        break;
      }
      case "set-locked": {
        const ids = new Set(operation.ids.map(shapeId));
        elements = elements.map((element) =>
          ids.has(element.id) || isGeneratedLabelFor(element, ids)
            ? newElementWith(element, { locked: operation.locked })
            : element,
        );
        receipt.updatedIds.push(...ids);
        if (highlightActive)
          selectedElementIds = Object.fromEntries([...ids].map((id) => [id, true]));
        break;
      }
      case "select":
        selectedElementIds = Object.fromEntries(operation.ids.map((id) => [shapeId(id), true]));
        break;
      case "zoom-to":
        selectedElementIds = Object.fromEntries(operation.ids.map((id) => [shapeId(id), true]));
        zoomIds = operation.ids.map(shapeId);
        break;
    }
  }
  elements = fitGeneratedText(elements);
  elements = updateConnections(elements);
  elements = fitGeneratedText(elements);
  api.updateScene({
    elements,
    ...(selectedElementIds ? { appState: { selectedElementIds } } : null),
    captureUpdate,
  });
  if (zoomIds) {
    const ids = new Set(zoomIds);
    fitElements(
      api,
      elements.filter(
        (element) =>
          !element.isDeleted && (ids.has(element.id) || isGeneratedLabelFor(element, ids)),
      ),
    );
  }
  return compactReceipt(receipt);
}

const mermaidBreakPattern = /<br\s*\/?>/giu;
const mermaidHtmlPattern = /<\/?[A-Za-z][^>\n]*>/u;

function assertSupportedMermaidLabelMarkup(value: string) {
  if (mermaidHtmlPattern.test(value))
    throw new Error(
      "Cake Draw Mermaid labels support plain text and line breaks (\\n, <br>, <br/>, or <br />); other HTML markup is not supported",
    );
  return value;
}

function normalizeMermaidSource(value: string) {
  return assertSupportedMermaidLabelMarkup(value.replace(mermaidBreakPattern, "\\n"));
}

function normalizeConvertedMermaidLabel(value: string) {
  return assertSupportedMermaidLabelMarkup(
    value.replace(mermaidBreakPattern, "\n").replaceAll("\\n", "\n"),
  );
}

function normalizeMermaidSkeletonLabels(
  skeletons: readonly ExcalidrawElementSkeleton[],
): ExcalidrawElementSkeleton[] {
  return skeletons.map((skeleton) => {
    const label = "label" in skeleton ? skeleton.label : undefined;
    const normalized = {
      ...skeleton,
      ...(skeleton.type === "text"
        ? { text: normalizeConvertedMermaidLabel(skeleton.text) }
        : null),
      ...(label ? { label: { ...label, text: normalizeConvertedMermaidLabel(label.text) } } : null),
    };
    // SAFETY: only the text fields of the converter's validated skeleton union are replaced.
    return normalized as ExcalidrawElementSkeleton;
  });
}

function namedDiagramShapeId(
  diagramId: string,
  role: DrawSemanticShapeMapping["role"],
  semanticId: string,
) {
  const suffix = `${diagramId}--${role}--${semanticId}`;
  if (suffix.length > 256) throw new Error("Diagram and semantic IDs are too long when combined");
  return `shape:${suffix}`;
}

function semanticMermaidId(value: string, used: Set<string>) {
  const base = value.replace(/[^A-Za-z0-9_-]/gu, "_").replace(/^[_-]+/u, "") || "item";
  let candidate = base.slice(0, 96);
  let suffix = 2;
  while (used.has(candidate)) candidate = `${base.slice(0, 88)}_${suffix++}`;
  used.add(candidate);
  return candidate;
}

function remapMermaidElementIds(
  elements: readonly ExcalidrawElement[],
  reservedIds: ReadonlySet<string>,
  diagramId?: string,
) {
  const usedIds = new Set(reservedIds);
  const semanticIds = new Set<string>();
  const roots = visibleElements(elements);
  const rootSemantics = new Map(
    roots.map((element) => [element.id, semanticMermaidId(element.id, semanticIds)]),
  );
  const idMap = new Map<string, string>();
  for (const element of elements) {
    const semantic = rootSemantics.get(element.id);
    let id =
      diagramId && semantic
        ? namedDiagramShapeId(
            diagramId,
            element.type === "arrow" || element.type === "line" ? "edge" : "node",
            semantic,
          )
        : generatedShapeId();
    while (usedIds.has(id)) id = generatedShapeId();
    usedIds.add(id);
    idMap.set(element.id, id);
  }
  const remap = (id: string | null) => (id === null ? null : (idMap.get(id) ?? id));
  const remapped = elements.map((element): ExcalidrawElement => {
    const common = {
      id: idMap.get(element.id)!,
      frameId: remap(element.frameId),
      boundElements:
        element.boundElements?.map((binding) => ({ ...binding, id: remap(binding.id)! })) ?? null,
    };
    let next: ExcalidrawElement;
    if (element.type === "text")
      next = { ...element, ...common, containerId: remap(element.containerId) };
    else if (element.type === "line" || element.type === "arrow")
      next = {
        ...element,
        ...common,
        startBinding: element.startBinding
          ? { ...element.startBinding, elementId: remap(element.startBinding.elementId)! }
          : null,
        endBinding: element.endBinding
          ? { ...element.endBinding, elementId: remap(element.endBinding.elementId)! }
          : null,
      };
    else next = { ...element, ...common };
    if (!diagramId) return next;
    const rootId =
      element.type === "text" && element.containerId ? element.containerId : element.id;
    const semantic = rootSemantics.get(rootId);
    if (!semantic) return next;
    return withDiagramData(next, {
      diagramId,
      semanticId: semantic,
      role:
        elementMap(elements).get(rootId)?.type === "arrow" ||
        elementMap(elements).get(rootId)?.type === "line"
          ? "edge"
          : "node",
    });
  });
  return {
    elements: remapped,
    mappings: roots.map((element) => ({
      semanticId: rootSemantics.get(element.id)!,
      shapeId: idMap.get(element.id)!,
      role:
        element.type === "arrow" || element.type === "line" ? ("edge" as const) : ("node" as const),
    })),
  };
}

function fontCss(element: ExcalidrawTextElement) {
  const family =
    element.fontFamily === FONT_FAMILY.Cascadia
      ? "Cascadia, monospace"
      : element.fontFamily === FONT_FAMILY.Helvetica
        ? "Helvetica, Arial, sans-serif"
        : "Excalifont, Virgil, sans-serif";
  return `${element.fontSize}px ${family}`;
}

function measuredLineWidth(value: string, element: ExcalidrawTextElement) {
  const context = document.createElement("canvas").getContext("2d");
  if (context) {
    context.font = fontCss(element);
    const measured = context.measureText(value || " ").width;
    if (Number.isFinite(measured) && measured > 0) return measured;
  }
  const familyFactor = element.fontFamily === FONT_FAMILY.Cascadia ? 0.62 : 0.58;
  return Math.max(
    element.fontSize * familyFactor,
    Array.from(value).length * element.fontSize * familyFactor,
  );
}

function wrapMeasuredText(value: string, maximumWidth: number, element: ExcalidrawTextElement) {
  const output: string[] = [];
  const pushToken = (token: string) => {
    if (measuredLineWidth(token, element) <= maximumWidth) {
      output.push(token);
      return;
    }
    let line = "";
    for (const character of Array.from(token)) {
      if (line && measuredLineWidth(line + character, element) > maximumWidth) {
        output.push(line);
        line = character;
      } else line += character;
    }
    output.push(line);
  };
  for (const sourceLine of value.split("\n")) {
    const words = sourceLine.split(/\s+/u).filter(Boolean);
    if (words.length === 0) {
      output.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && measuredLineWidth(candidate, element) > maximumWidth) {
        pushToken(line);
        line = word;
      } else line = candidate;
    }
    pushToken(line);
  }
  return output.join("\n");
}

/** Fits every generated text kind before geometry, routing, selection fitting, or rendering. */
function fitGeneratedText(elements: readonly ExcalidrawElement[]) {
  let fitted = [...elements];
  const textElements = fitted.filter(
    (element): element is ExcalidrawTextElement => element.type === "text" && !element.isDeleted,
  );
  for (const original of textElements) {
    const current = elementMap(fitted).get(original.id);
    if (!current || current.type !== "text") continue;
    const companion = generatedCompanionData(current);
    const companionContainerId =
      companion?.cakeGeneratedCompanionKind === "connector"
        ? companion.cakeGeneratedCompanionFor
        : undefined;
    const containerId = current.containerId ?? companionContainerId;
    const container = containerId ? elementMap(fitted).get(containerId) : undefined;
    const sourceText = current.originalText || current.text;
    const fixedContainer =
      container && container.type !== "arrow" && container.type !== "line" ? container : undefined;
    const autoContainer = fixedContainer?.customData?.cakeAutoSizeText === true;
    const linearContainer = container?.type === "arrow" || container?.type === "line";
    const maximumWidth = fixedContainer
      ? autoContainer
        ? 600
        : Math.max(40, fixedContainer.width - MERMAID_LABEL_HORIZONTAL_PADDING * 2)
      : linearContainer
        ? 360
        : current.autoResize === false
          ? Math.max(40, current.width)
          : 600;
    const wrapped = wrapMeasuredText(sourceText, maximumWidth, current);
    const lines = wrapped.split("\n");
    const lineHeight = current.lineHeight || 1.25;
    const measuredWidth = Math.ceil(
      Math.max(...lines.map((line) => measuredLineWidth(line, current))),
    );
    const measuredHeight = Math.ceil(Math.max(1, lines.length) * current.fontSize * lineHeight);
    let nextText = newElementWith(current, {
      text: wrapped,
      originalText: sourceText,
      width: Math.max(1, Math.min(maximumWidth, measuredWidth)),
      height: measuredHeight,
      autoResize: !fixedContainer && current.autoResize !== false,
    });
    fitted = fitted.map((element) => (element.id === current.id ? nextText : element));
    if (fixedContainer) {
      const scale =
        fixedContainer.type === "ellipse" ? Math.SQRT2 : fixedContainer.type === "diamond" ? 2 : 1;
      const requiredHeight = (measuredHeight + MERMAID_LABEL_VERTICAL_PADDING * 2) * scale;
      const requiredWidth = (measuredWidth + MERMAID_LABEL_HORIZONTAL_PADDING * 2) * scale;
      const autoWidth = autoContainer || diagramData(fixedContainer)?.role === "group";
      const width = autoWidth
        ? Math.max(fixedContainer.width, requiredWidth)
        : fixedContainer.width;
      const height = Math.max(fixedContainer.height, requiredHeight);
      const resized = newElementWith(fixedContainer, { width, height });
      nextText = newElementWith(nextText, {
        x: resized.x + (width - nextText.width) / 2,
        y: resized.y + (height - nextText.height) / 2,
      });
      fitted = fitted.map((element) =>
        element.id === resized.id ? resized : element.id === nextText.id ? nextText : element,
      );
    } else if (container && (container.type === "arrow" || container.type === "line")) {
      const points = container.points;
      let segment = {
        start: points[0] ?? [0, 0],
        end: points.at(-1) ?? points[0] ?? [0, 0],
        length: 0,
      };
      for (let index = 1; index < points.length; index += 1) {
        const start = points[index - 1]!;
        const end = points[index]!;
        const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
        if (length > segment.length) segment = { start, end, length };
      }
      const vertical =
        Math.abs(segment.end[1] - segment.start[1]) > Math.abs(segment.end[0] - segment.start[0]);
      const centerX = container.x + segment.start[0] * 0.75 + segment.end[0] * 0.25;
      const centerY = container.y + segment.start[1] * 0.75 + segment.end[1] * 0.25;
      const candidates = vertical
        ? [
            { x: centerX - nextText.width - 12, y: centerY - nextText.height / 2 },
            { x: centerX + 12, y: centerY - nextText.height / 2 },
          ]
        : [
            { x: centerX - nextText.width / 2, y: centerY - nextText.height - 8 },
            { x: centerX - nextText.width / 2, y: centerY + 8 },
          ];
      const obstacles = fitted.filter(
        (element) =>
          element.id !== nextText.id &&
          element.id !== container.id &&
          !element.isDeleted &&
          element.type !== "arrow" &&
          element.type !== "line" &&
          !(element.type !== "text" && diagramData(element)?.role === "group"),
      );
      const position =
        candidates.find((candidate) =>
          obstacles.every(
            (obstacle) =>
              !boundsOverlap(
                { ...candidate, width: nextText.width, height: nextText.height },
                boundsOf(obstacle, fitted),
                6,
              ),
          ),
        ) ?? candidates[0]!;
      nextText = newElementWith(nextText, position);
      fitted = fitted.map((element) => (element.id === nextText.id ? nextText : element));
    }
  }
  return fitted;
}

function shiftMermaidRoot(
  elements: readonly ExcalidrawElement[],
  id: string,
  dx: number,
  dy: number,
) {
  return moveRelated(elements, new Set([id]), dx, dy);
}

/** Reflows converted nodes after final text measurement, then reserves a title band in subgraphs. */
function reflowMeasuredMermaid(
  elements: readonly ExcalidrawElement[],
  backgrounds: ReadonlySet<string>,
) {
  let reflowed = [...elements];
  const nodes = visibleElements(reflowed).filter(
    (element) =>
      !backgrounds.has(element.id) &&
      element.type !== "arrow" &&
      element.type !== "line" &&
      element.type !== "text",
  );
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let moved = false;
    for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
        const byId = elementMap(reflowed);
        const left = byId.get(nodes[leftIndex]!.id);
        const right = byId.get(nodes[rightIndex]!.id);
        if (!left || !right) continue;
        const leftBounds = boundsOf(left, reflowed);
        const rightBounds = boundsOf(right, reflowed);
        if (!boundsOverlap(leftBounds, rightBounds, MERMAID_NODE_GAP)) continue;
        const originalLeft = nodes[leftIndex]!;
        const originalRight = nodes[rightIndex]!;
        const horizontal =
          Math.abs(originalRight.x - originalLeft.x) >= Math.abs(originalRight.y - originalLeft.y);
        let dx = 0;
        let dy = 0;
        if (horizontal) {
          dx =
            originalRight.x >= originalLeft.x
              ? leftBounds.x + leftBounds.width + MERMAID_NODE_GAP - rightBounds.x
              : leftBounds.x - MERMAID_NODE_GAP - (rightBounds.x + rightBounds.width);
        } else {
          dy =
            originalRight.y >= originalLeft.y
              ? leftBounds.y + leftBounds.height + MERMAID_NODE_GAP - rightBounds.y
              : leftBounds.y - MERMAID_NODE_GAP - (rightBounds.y + rightBounds.height);
        }
        reflowed = shiftMermaidRoot(reflowed, right.id, dx, dy);
        moved = true;
      }
    }
    if (!moved) break;
  }

  const orderedBackgrounds = [...backgrounds].sort((left, right) => {
    const byId = elementMap(reflowed);
    const leftElement = byId.get(left);
    const rightElement = byId.get(right);
    return (
      (leftElement?.width ?? 0) * (leftElement?.height ?? 0) -
      (rightElement?.width ?? 0) * (rightElement?.height ?? 0)
    );
  });
  for (const id of orderedBackgrounds) {
    const byId = elementMap(reflowed);
    const container = byId.get(id);
    if (!container) continue;
    const label = reflowed.find(
      (element): element is ExcalidrawTextElement =>
        element.type === "text" && element.containerId === id,
    );
    const groupIds = new Set(container.groupIds);
    const children = visibleElements(reflowed).filter(
      (element) =>
        element.id !== id &&
        !backgrounds.has(element.id) &&
        element.type !== "arrow" &&
        element.type !== "line" &&
        (element.frameId === id || element.groupIds.some((groupId) => groupIds.has(groupId))),
    );
    if (children.length === 0) continue;
    const [minX, minY, maxX, maxY] = getCommonBounds(children);
    let nextLabel = label;
    if (nextLabel) {
      const maximumTitleWidth = Math.max(160, maxX - minX + 24);
      const wrapped = wrapMeasuredText(
        nextLabel.originalText || nextLabel.text,
        maximumTitleWidth,
        nextLabel,
      );
      const lines = wrapped.split("\n");
      nextLabel = newElementWith(nextLabel, {
        containerId: null,
        customData: {
          ...nextLabel.customData,
          cakeGeneratedCompanionFor: id,
          cakeGeneratedCompanionKind: "title",
        },
        text: wrapped,
        originalText: nextLabel.originalText || nextLabel.text,
        width: Math.ceil(Math.max(...lines.map((line) => measuredLineWidth(line, nextLabel!)))),
        height: Math.ceil(lines.length * nextLabel.fontSize * (nextLabel.lineHeight || 1.25)),
        autoResize: true,
      });
    }
    const titleHeight = nextLabel?.height ?? 0;
    const nextContainer = newElementWith(container, {
      x: minX - 36,
      y: minY - titleHeight - 48,
      width: maxX - minX + 72,
      height: maxY - minY + titleHeight + 84,
      boundElements:
        container.boundElements?.filter((binding) => binding.id !== nextLabel?.id) ?? null,
    });
    reflowed = reflowed.map((element) => {
      if (element.id === id) return nextContainer;
      if (nextLabel && element.id === nextLabel.id)
        return newElementWith(nextLabel, {
          x: nextContainer.x + 24,
          y: nextContainer.y + 18,
        });
      return element;
    });
  }
  const connectorLabels = reflowed.filter((element): element is ExcalidrawTextElement => {
    if (element.type !== "text" || !element.containerId) return false;
    const container = elementMap(reflowed).get(element.containerId);
    return container?.type === "arrow" || container?.type === "line";
  });
  for (const label of connectorLabels) {
    const connectorId = label.containerId!;
    reflowed = reflowed.map((element) => {
      if (element.id === connectorId)
        return newElementWith(element, {
          boundElements: element.boundElements?.filter(({ id }) => id !== label.id) ?? null,
        });
      if (element.id === label.id)
        return newElementWith(label, {
          containerId: null,
          customData: {
            ...label.customData,
            cakeGeneratedCompanionFor: connectorId,
            cakeGeneratedCompanionKind: "connector",
          },
        });
      return element;
    });
  }
  return fitGeneratedText(updateConnections(reflowed));
}

function assertUsableMermaidGeometry(elements: readonly ExcalidrawElement[]) {
  const backgrounds = diagramBackgroundIds(elements, new Set(elements.map(({ id }) => id)));
  for (const id of backgrounds) {
    const container = elementMap(elements).get(id);
    if (!container) continue;
    const shortSide = Math.max(1, Math.min(container.width, container.height));
    const longSide = Math.max(container.width, container.height);
    if (longSide / shortSide > 20 || container.width * container.height > 100_000_000)
      throw new Error(
        "Mermaid subgraph layout is excessively sparse, usually because of cross-subgraph edges; simplify the subgraph boundaries or split the diagram",
      );
  }
}

function absoluteArrowPoints(element: Extract<ExcalidrawElement, { type: "arrow" }>) {
  return element.points.map(([x, y]) => [element.x + x, element.y + y] as const);
}

function spreadOverlappingMermaidConnectors(elements: readonly ExcalidrawElement[]) {
  const arrows = elements.filter(
    (element): element is Extract<ExcalidrawElement, { type: "arrow" }> =>
      element.type === "arrow" && !!element.startBinding && !!element.endBinding,
  );
  const groups = new Map<string, typeof arrows>();
  for (const arrow of arrows) {
    const route = absoluteArrowPoints(arrow)
      .map(([x, y]) => `${Math.round(x / 4)},${Math.round(y / 4)}`)
      .join(";");
    const key = `${arrow.startBinding!.elementId}>${arrow.endBinding!.elementId}:${route}`;
    groups.set(key, [...(groups.get(key) ?? []), arrow]);
  }
  let spread = [...elements];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const first = group[0]!;
    const start = first.points[0]!;
    const end = first.points.at(-1)!;
    const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
    if (length === 0) continue;
    const normalX = -(end[1] - start[1]) / length;
    const normalY = (end[0] - start[0]) / length;
    group.forEach((arrow, index) => {
      const offset = (index - (group.length - 1) / 2) * MERMAID_PARALLEL_CONNECTOR_GAP;
      const sourcePoints = arrow.points;
      const points =
        sourcePoints.length === 2
          ? [
              sourcePoints[0]!,
              [
                sourcePoints[0]![0] +
                  (sourcePoints[1]![0] - sourcePoints[0]![0]) / 3 +
                  normalX * offset,
                sourcePoints[0]![1] +
                  (sourcePoints[1]![1] - sourcePoints[0]![1]) / 3 +
                  normalY * offset,
              ],
              [
                sourcePoints[0]![0] +
                  ((sourcePoints[1]![0] - sourcePoints[0]![0]) * 2) / 3 +
                  normalX * offset,
                sourcePoints[0]![1] +
                  ((sourcePoints[1]![1] - sourcePoints[0]![1]) * 2) / 3 +
                  normalY * offset,
              ],
              sourcePoints[1]!,
            ]
          : sourcePoints.map((point, pointIndex) =>
              pointIndex === 0 || pointIndex === sourcePoints.length - 1
                ? point
                : [point[0] + normalX * offset, point[1] + normalY * offset],
            );
      const minX = Math.min(...points.map((point) => point[0]));
      const minY = Math.min(...points.map((point) => point[1]));
      const maxX = Math.max(...points.map((point) => point[0]));
      const maxY = Math.max(...points.map((point) => point[1]));
      // SAFETY: every tuple is derived from a validated Excalidraw local point using finite arithmetic.
      const normalizedPoints = points.map(
        ([x, y]) => [x - minX, y - minY] as (typeof arrow.points)[number],
      );
      spread = spread.map((element) => {
        if (element.id === arrow.id)
          return newElementWith(arrow, {
            x: arrow.x + minX,
            y: arrow.y + minY,
            points: normalizedPoints,
            width: maxX - minX,
            height: maxY - minY,
          });
        if (
          element.type === "text" &&
          (element.containerId === arrow.id || generatedCompanionFor(element) === arrow.id)
        )
          return newElementWith(element, {
            x: element.x + normalX * offset,
            y: element.y + normalY * offset,
          });
        return element;
      });
    });
  }
  return spread;
}

interface ElementBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function boundsOverlap(left: ElementBounds, right: ElementBounds, gap: number) {
  return (
    left.x < right.x + right.width + gap &&
    left.x + left.width + gap > right.x &&
    left.y < right.y + right.height + gap &&
    left.y + left.height + gap > right.y
  );
}

function collisionAwareMermaidDelta(
  created: readonly ExcalidrawElement[],
  existing: readonly ExcalidrawElement[],
  viewportCenter: { readonly x: number; readonly y: number },
) {
  const [minX, minY, maxX, maxY] = getCommonBounds(created);
  const width = maxX - minX;
  const height = maxY - minY;
  const desired = {
    x: viewportCenter.x - width / 2,
    y: viewportCenter.y - height / 2,
    width,
    height,
  };
  const occupied = visibleElements(existing).map((element) => boundsOf(element, existing));
  const available = (candidate: ElementBounds) =>
    occupied.every((bounds) => !boundsOverlap(candidate, bounds, MERMAID_INSERTION_GAP));
  let target = desired;
  if (!available(target)) {
    const stepX = Math.max(width + MERMAID_INSERTION_GAP, 1);
    const stepY = Math.max(height + MERMAID_INSERTION_GAP, 1);
    let found: ElementBounds | undefined;
    for (let ring = 1; ring <= 32 && !found; ring += 1) {
      for (let y = -ring; y <= ring && !found; y += 1) {
        for (let x = -ring; x <= ring; x += 1) {
          if (Math.max(Math.abs(x), Math.abs(y)) !== ring) continue;
          const candidate = {
            ...desired,
            x: desired.x + x * stepX,
            y: desired.y + y * stepY,
          };
          if (available(candidate)) {
            found = candidate;
            break;
          }
        }
      }
    }
    if (found) target = found;
    else if (occupied.length > 0) {
      const rightEdge = Math.max(...occupied.map((bounds) => bounds.x + bounds.width));
      target = { ...desired, x: rightEdge + MERMAID_INSERTION_GAP };
    }
  }
  return { x: target.x - minX, y: target.y - minY };
}

async function insertMermaid(
  api: ExcalidrawImperativeAPI,
  diagram: string,
  options: { readonly id?: string; readonly replace?: boolean } = {},
): Promise<DrawMermaidReceipt> {
  const normalizedDiagram = normalizeMermaidSource(diagram);
  const { elements: parsedSkeletons, files } = await parseMermaidToExcalidraw(normalizedDiagram, {
    flowchart: { curve: "linear" },
    maxEdges: 500,
    maxTextSize: 50_000,
    themeVariables: { fontSize: `${MERMAID_FONT_SIZE}px` },
  });
  if (parsedSkeletons.length === 0) throw new Error("Mermaid diagram did not produce any elements");
  if (parsedSkeletons.length > MAX_MERMAID_ELEMENTS)
    throw new Error(`Mermaid diagram exceeds ${MAX_MERMAID_ELEMENTS} elements`);
  if (parsedSkeletons.some((skeleton) => skeleton.type === "image") || files)
    throw new Error(
      "This Mermaid diagram cannot be converted to native editable shapes; use flowchart, sequenceDiagram, classDiagram, stateDiagram, or erDiagram",
    );

  const skeletons = normalizeMermaidSkeletonLabels(parsedSkeletons);
  const converted = convertToExcalidrawElements(skeletons, { regenerateIds: false });
  const allExisting = api.getSceneElementsIncludingDeleted();
  const existingRegion = options.id
    ? allExisting.filter((element) => diagramData(element)?.diagramId === options.id)
    : [];
  if (existingRegion.length > 0 && !options.replace)
    throw new Error(
      `Named diagram ${options.id} already exists; set replace to true to replace it atomically`,
    );
  const existing = options.id
    ? allExisting.filter((element) => diagramData(element)?.diagramId !== options.id)
    : allExisting;
  const reservedIds = new Set(existing.map((element) => element.id));
  const remapped = remapMermaidElementIds(converted, reservedIds, options.id);
  const backgrounds = diagramBackgroundIds(
    remapped.elements,
    new Set(remapped.elements.map(({ id }) => id)),
  );
  const autoSized = remapped.elements.map((element) =>
    element.type === "text" || element.type === "arrow" || element.type === "line"
      ? element
      : newElementWith(element, {
          customData: { ...element.customData, cakeAutoSizeText: true },
        }),
  );
  let created = spreadOverlappingMermaidConnectors(
    reflowMeasuredMermaid(fitGeneratedText(autoSized), backgrounds),
  );
  assertUsableMermaidGeometry(created);
  if (options.id) {
    const finalBackgrounds = diagramBackgroundIds(created, new Set(created.map(({ id }) => id)));
    const groupSemantics = new Set(
      [...finalBackgrounds].flatMap((id) => {
        const data = diagramData(elementMap(created).get(id)!);
        return data ? [data.semanticId] : [];
      }),
    );
    created = created.map((element) => {
      const data = diagramData(element);
      return data && groupSemantics.has(data.semanticId)
        ? withDiagramData(element, { ...data, role: "group" })
        : element;
    });
  }
  const viewport = viewportBounds(api.getAppState());
  const replacementCenter =
    existingRegion.length > 0
      ? (() => {
          const [minX, minY, maxX, maxY] = getCommonBounds(existingRegion);
          return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
        })()
      : undefined;
  const delta = collisionAwareMermaidDelta(
    created,
    existing,
    replacementCenter ?? {
      x: viewport.x + viewport.width / 2,
      y: viewport.y + viewport.height / 2,
    },
  );
  const positioned = created.map((element) =>
    newElementWith(element, { x: element.x + delta.x, y: element.y + delta.y }),
  );
  const ordered = normalizeCreatedDiagramOrder(
    [...existing, ...positioned],
    new Set(positioned.map(({ id }) => id)),
  );
  const selectedElementIds = Object.fromEntries(
    positioned
      .filter((element) => !(element.type === "text" && element.containerId))
      .map((element) => [element.id, true as const]),
  );

  api.updateScene({
    elements: ordered,
    appState: { selectedElementIds },
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  fitElements(
    api,
    ordered.filter(
      (element) =>
        selectedElementIds[element.id] ||
        (element.type === "text" &&
          !!element.containerId &&
          selectedElementIds[element.containerId]),
    ),
  );
  return {
    diagramId: options.id,
    elementCount: positioned.length,
    mappings: remapped.mappings.map((mapping) => {
      const element = positioned.find(({ id }) => id === mapping.shapeId);
      return {
        ...mapping,
        role: element ? (diagramData(element)?.role ?? mapping.role) : mapping.role,
      };
    }),
  };
}

function playbackDelay(milliseconds: number, signal?: AbortSignal) {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      reject(new DOMException("Draw playback was cancelled", "AbortError"));
    }
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

export function createDrawEditorAdapter(api: ExcalidrawImperativeAPI): DrawEditorAdapter {
  return {
    read({ scope }) {
      const elements = nonDeleted(api);
      const ids = idsForScope(api, elements, scope);
      const selectedShapeIds = Object.keys(api.getAppState().selectedElementIds).filter((id) =>
        elements.some(
          (element) => element.id === id && !(element.type === "text" && element.containerId),
        ),
      );
      let summaryTextTruncated = false;
      const byId = elementMap(elements);
      const shapes = ids.slice(0, MAX_READ_SHAPES).flatMap((id) => {
        const element = byId.get(id);
        if (!element) return [];
        const result = summaryFor(element, elements);
        summaryTextTruncated ||= result.textTruncated;
        return [result.summary];
      });
      return {
        pageId: "page:default",
        viewportBounds: viewportBounds(api.getAppState()),
        selectedShapeIds: selectedShapeIds.slice(0, MAX_READ_SHAPES),
        shapes,
        truncated:
          ids.length > MAX_READ_SHAPES ||
          selectedShapeIds.length > MAX_READ_SHAPES ||
          summaryTextTruncated,
      };
    },
    async render({ scope, format, background = true, scale = 1, maxSize }) {
      const allElements = nonDeleted(api);
      const ids = new Set(idsForScope(api, allElements, scope));
      const elements = allElements.filter(
        (element) => ids.has(element.id) || isGeneratedLabelFor(element, ids),
      );
      if (elements.length === 0 && scope !== "viewport")
        throw new Error("There are no shapes to render");
      if (!Number.isFinite(scale) || scale <= 0 || scale > MAX_RENDER_SCALE)
        throw new Error(`scale must be between 0 and ${MAX_RENDER_SCALE}`);
      const camera = api.getAppState();
      const viewport = scope === "viewport" ? viewportBounds(camera) : undefined;
      // An export-only frame clips to the exact visible scene rectangle, including blank
      // space. It is never inserted into the board or included in saved history.
      const frame = viewport
        ? convertToExcalidrawElements([{ type: "frame", ...viewport, children: [] }])[0]
        : undefined;
      const exportingFrame = frame?.type === "frame" ? frame : null;
      const [minX, minY, maxX, maxY] = viewport
        ? [viewport.x, viewport.y, viewport.x + viewport.width, viewport.y + viewport.height]
        : getCommonBounds(elements);
      const exportPadding = viewport ? 0 : 10;
      const sourceWidth = maxX - minX + exportPadding * 2;
      const sourceHeight = maxY - minY + exportPadding * 2;
      const maximumWidth = Math.min(MAX_RENDER_DIMENSION, maxSize?.width ?? MAX_RENDER_DIMENSION);
      const maximumHeight = Math.min(MAX_RENDER_DIMENSION, maxSize?.height ?? MAX_RENDER_DIMENSION);
      const effectiveScale = Math.min(
        scale * (viewport ? camera.zoom.value : 1),
        maximumWidth / sourceWidth,
        maximumHeight / sourceHeight,
      );
      const width = Math.max(1, Math.ceil(sourceWidth * effectiveScale));
      const height = Math.max(1, Math.ceil(sourceHeight * effectiveScale));
      const appState = {
        exportBackground: background,
        exportWithDarkMode: scope === "viewport" && camera.theme === "dark",
        viewBackgroundColor: background ? camera.viewBackgroundColor : "transparent",
      };
      if (format === "svg") {
        const svg = await exportToSvg({
          elements,
          appState,
          files: api.getFiles(),
          exportPadding,
          exportingFrame,
        });
        svg.setAttribute("width", String(width));
        svg.setAttribute("height", String(height));
        const data = new XMLSerializer().serializeToString(svg);
        if (new TextEncoder().encode(data).byteLength > MAX_RENDER_BYTES)
          throw new Error("Rendered SVG is too large");
        return { format, mediaType: "image/svg+xml", width, height, data };
      }
      const blob = await exportToBlob({
        elements,
        appState,
        files: api.getFiles(),
        mimeType: "image/png",
        exportPadding,
        exportingFrame,
        getDimensions: () => ({
          width,
          height,
          scale: effectiveScale,
        }),
      });
      if (blob.size > MAX_RENDER_BYTES) throw new Error("Rendered PNG is too large");
      return {
        format,
        mediaType: "image/png",
        width,
        height,
        data: await dataUrl(blob),
      };
    },
    exportDocument() {
      return serializeExcalidrawDocument({
        elements: api.getSceneElementsIncludingDeleted(),
        appState: api.getAppState(),
        files: api.getFiles(),
      });
    },
    apply({ operations }) {
      const prepared = prepareOperations(api, operations);
      const receipt = applyPreparedOperations(
        api,
        prepared,
        CaptureUpdateAction.IMMEDIATELY,
        false,
      );
      if (
        !prepared.some((operation) => operation.type === "zoom-to") &&
        prepared.some(changesLayout)
      )
        fitElements(api, compositionElements(api, receipt));
      return receipt;
    },
    async applyAnimated({ operations }, options: DrawPlaybackOptions = {}) {
      const prepared = prepareOperations(api, operations);
      const receipt: MutableDrawApplyReceipt = {
        createdIds: [],
        updatedIds: [],
        deletedIds: [],
      };
      const requestedDelay = options.stepDelayMs ?? 160;
      const maxDuration = options.maxDurationMs ?? 3_500;
      const delay =
        prepared.length <= 1
          ? 0
          : Math.max(0, Math.min(requestedDelay, maxDuration / (prepared.length - 1)));
      const explicitCamera = prepared.some((operation) => operation.type === "zoom-to");
      for (let index = 0; index < prepared.length; index += 1) {
        const step = applyPreparedOperations(
          api,
          [prepared[index]!],
          CaptureUpdateAction.NEVER,
          true,
        );
        mergeReceipt(receipt, step);
        if (!explicitCamera && changesLayout(prepared[index]!)) {
          const composition = compositionElements(api, receipt);
          if (composition.length > 0) {
            const [left, top, right, bottom] = getCommonBounds(composition);
            const viewport = viewportBounds(api.getAppState());
            if (
              left < viewport.x ||
              top < viewport.y ||
              right > viewport.x + viewport.width ||
              bottom > viewport.y + viewport.height
            )
              fitElements(api, composition);
          }
        }
        if (index < prepared.length - 1) await playbackDelay(delay, options.signal);
      }
      if (!explicitCamera && prepared.some(changesLayout))
        fitElements(api, compositionElements(api, receipt));
      api.updateScene({
        elements: api.getSceneElementsIncludingDeleted(),
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      if (receipt.createdIds.length > 1) {
        const createdIds = new Set(receipt.createdIds);
        const elements = nonDeleted(api);
        api.scrollToContent(
          elements.filter(
            (element) => createdIds.has(element.id) || isGeneratedLabelFor(element, createdIds),
          ),
          { animate: false, fitToViewport: true, viewportZoomFactor: 0.85 },
        );
      }
      return receipt;
    },
    insertMermaid(diagram, options) {
      return insertMermaid(api, diagram, options);
    },
    clear() {
      const roots = visibleElements(nonDeleted(api));
      const deletedIds = roots.map(({ id }) => id);
      const ids = new Set(deletedIds);
      const elements = api
        .getSceneElementsIncludingDeleted()
        .map((element) =>
          ids.has(element.id) || isGeneratedLabelFor(element, ids)
            ? newElementWith(element, { isDeleted: true })
            : element,
        );
      api.updateScene({
        elements,
        appState: { selectedElementIds: {} },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      return { createdIds: [], updatedIds: [], deletedIds };
    },
    loadDocument(snapshot) {
      const restored = restoreDrawDocument(snapshot);
      api.addFiles(Object.values(restored.files));
      api.updateScene({
        elements: restored.elements,
        appState: restored.appState,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      api.history.clear();
    },
    snapshotDocument() {
      const snapshot = asDrawDocumentSnapshot(plainSnapshot(api));
      assertPersistableDrawDocument(snapshot);
      return snapshot;
    },
    onDocumentChange(listener) {
      let fingerprint = JSON.stringify(plainSnapshot(api));
      return api.onChange(() => {
        const nextFingerprint = JSON.stringify(plainSnapshot(api));
        if (nextFingerprint === fingerprint) return;
        fingerprint = nextFingerprint;
        listener();
      });
    },
  };
}
