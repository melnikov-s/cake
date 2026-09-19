/* oxlint-disable anti-slop/no-shape-in-symbol-names -- Shape is Cake's drawing-domain entity. */
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  exportToBlob,
  exportToSvg,
  getCommonBounds,
  newElementWith,
  restore,
  viewportCoordsToSceneCoords,
} from "@excalidraw/excalidraw";
import type {
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
import type {
  DrawCreateShape,
  DrawDocumentSnapshot,
  DrawEditorController,
  DrawOperation,
  DrawPlaybackOptions,
  DrawReadScope,
  DrawRelativeShape,
  DrawShapeSummary,
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
  readonly appState: Readonly<Pick<AppState, "viewBackgroundColor">>;
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

function nonDeleted(api: ExcalidrawImperativeAPI) {
  return api.getSceneElements().filter((element) => !element.isDeleted);
}

function elementMap(elements: readonly ExcalidrawElement[]) {
  return new Map(elements.map((element) => [element.id, element]));
}

function boundLabel(
  element: ExcalidrawElement,
  elements: readonly ExcalidrawElement[],
): ExcalidrawTextElement | undefined {
  return elements.find(
    (candidate): candidate is ExcalidrawTextElement =>
      candidate.type === "text" && candidate.containerId === element.id && !candidate.isDeleted,
  );
}

function visibleElements(elements: readonly ExcalidrawElement[]) {
  return elements.filter(
    (element) => !element.isDeleted && !(element.type === "text" && element.containerId),
  );
}

function boundsOf(element: ExcalidrawElement, elements: readonly ExcalidrawElement[]) {
  const related = [element];
  const label = boundLabel(element, elements);
  if (label) related.push(label);
  const [minX, minY, maxX, maxY] = getCommonBounds(related);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
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
  const appState = api.getAppState();
  const start = viewportCoordsToSceneCoords({ clientX: 0, clientY: 0 }, appState);
  const end = viewportCoordsToSceneCoords(
    { clientX: appState.width, clientY: appState.height },
    appState,
  );
  const viewport = {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
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

function requireTargets(known: ReadonlySet<string>, ids: readonly string[], operation: string) {
  for (const id of ids) {
    if (!known.has(id)) throw new Error(`Shape not found for ${operation}: ${id}`);
  }
}

function prepareOperations(
  api: ExcalidrawImperativeAPI,
  operations: readonly DrawOperation[],
): PreparedOperation[] {
  if (operations.length === 0 || operations.length > 500)
    throw new Error("A draw batch must contain between 1 and 500 operations");

  const known = new Set(visibleElements(nonDeleted(api)).map((element) => element.id));
  const prepared: PreparedOperation[] = [];
  for (const operation of operations) {
    switch (operation.type) {
      case "create": {
        validateCreateShape(operation.shape);
        const id = operation.shape.id ? shapeId(operation.shape.id) : generatedShapeId();
        if (known.has(id)) throw new Error(`Duplicate shape ID: ${id}`);
        known.add(id);
        prepared.push({ ...operation, id });
        break;
      }
      case "create-relative": {
        validateRelativeShape(operation.shape);
        const id = operation.shape.id ? shapeId(operation.shape.id) : generatedShapeId();
        const relativeTo = shapeId(operation.shape.placement.relativeTo);
        if (known.has(id)) throw new Error(`Duplicate shape ID: ${id}`);
        requireTargets(known, [relativeTo], "create-relative");
        known.add(id);
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
        known.add(id);
        prepared.push({ ...operation, id, fromId, toId });
        break;
      }
      case "update": {
        const id = shapeId(operation.id);
        requireTargets(known, [id], "update");
        if (operation.x !== undefined) finite(operation.x, "x");
        if (operation.y !== undefined) finite(operation.y, "y");
        if (operation.rotation !== undefined) finite(operation.rotation, "rotation");
        if (
          operation.opacity !== undefined &&
          (!Number.isFinite(operation.opacity) || operation.opacity < 0 || operation.opacity > 1)
        )
          throw new Error("opacity must be between 0 and 1");
        if (operation.text !== undefined) text(operation.text);
        prepared.push(operation);
        break;
      }
      case "delete": {
        const ids = uniqueTargetIds(operation.ids, "delete");
        requireTargets(known, ids, "delete");
        for (const id of ids) known.delete(id);
        prepared.push(operation);
        break;
      }
      case "move": {
        const ids = uniqueTargetIds(operation.ids, "move");
        requireTargets(known, ids, "move");
        finite(operation.deltaX, "deltaX");
        finite(operation.deltaY, "deltaY");
        prepared.push(operation);
        break;
      }
      case "align":
      case "distribute":
      case "bring-to-front":
      case "send-to-back":
      case "select":
      case "zoom-to": {
        const ids = uniqueTargetIds(operation.ids, operation.type);
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
      };
    case "text":
      return { id: shape.id, type: "text", x, y, text: shape.text, width: shape.width };
    case "note":
      return { id: shape.id, type: "note", x, y, text: shape.text, color: shape.color };
  }
}

function createElements(shape: DrawCreateShape, id: string): OrderedExcalidrawElement[] {
  switch (shape.type) {
    case "geo": {
      const type = shape.geo ?? "rectangle";
      return convertToExcalidrawElements(
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
            ...(shape.text ? { label: { text: shape.text } } : null),
          },
        ],
        { regenerateIds: false },
      );
    }
    case "note":
      return convertToExcalidrawElements(
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
            label: { text: shape.text },
          },
        ],
        { regenerateIds: false },
      );
    case "text":
      return convertToExcalidrawElements(
        [{ id, type: "text", x: shape.x, y: shape.y, text: shape.text, width: shape.width }],
        { regenerateIds: false },
      );
    case "line":
    case "arrow":
      return convertToExcalidrawElements(
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
            ...(shape.text ? { label: { text: shape.text } } : null),
          },
        ],
        { regenerateIds: false },
      );
  }
}

function center(element: ExcalidrawElement, elements: readonly ExcalidrawElement[]) {
  const bounds = boundsOf(element, elements);
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

function connectElements(
  elements: readonly ExcalidrawElement[],
  operation: PreparedConnectOperation,
): ExcalidrawElement[] {
  const byId = elementMap(elements);
  const from = byId.get(operation.fromId);
  const to = byId.get(operation.toId);
  if (!from || !to) throw new Error("Connection target disappeared");
  const start = center(from, elements);
  const end = center(to, elements);
  const created = convertToExcalidrawElements(
    [
      {
        id: operation.id,
        type: "arrow",
        x: start.x,
        y: start.y,
        points: [
          [0, 0],
          [end.x - start.x, end.y - start.y],
        ],
        startBinding: { elementId: operation.fromId, focus: 0, gap: 1 },
        endBinding: { elementId: operation.toId, focus: 0, gap: 1 },
        ...(operation.text ? { label: { text: operation.text } } : null),
      },
    ],
    { regenerateIds: false },
  );
  const arrow = created.find((element) => element.id === operation.id);
  if (!arrow || arrow.type !== "arrow") throw new Error("Could not create connected arrow");
  const boundArrow = newElementWith(arrow, {
    startBinding: { elementId: operation.fromId, focus: 0, gap: 1 },
    endBinding: { elementId: operation.toId, focus: 0, gap: 1 },
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
    const related =
      ids.has(element.id) ||
      (element.type === "text" && !!element.containerId && ids.has(element.containerId));
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
    const start = center(from, elements);
    const end = center(to, elements);
    return newElementWith(element, {
      x: start.x,
      y: start.y,
      points: [
        [0, 0],
        [end.x - start.x, end.y - start.y],
      ],
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

function reorder(elements: readonly ExcalidrawElement[], ids: ReadonlySet<string>, front: boolean) {
  const selected = elements.filter(
    (element) =>
      ids.has(element.id) ||
      (element.type === "text" && !!element.containerId && ids.has(element.containerId)),
  );
  const rest = elements.filter((element) => !selected.includes(element));
  return front ? [...rest, ...selected] : [...selected, ...rest];
}

function plainSnapshot(api: ExcalidrawImperativeAPI): DrawSnapshot {
  return {
    type: DRAW_SNAPSHOT_TYPE,
    version: DRAW_SNAPSHOT_VERSION,
    source: "cake",
    elements: api.getSceneElementsIncludingDeleted(),
    appState: { viewBackgroundColor: api.getAppState().viewBackgroundColor },
    files: api.getFiles(),
  };
}

function validatedSnapshot(snapshot: DrawDocumentSnapshot): DrawSnapshot {
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
    type: DRAW_SNAPSHOT_TYPE,
    version: DRAW_SNAPSHOT_VERSION,
    source: "cake",
    elements: restored.elements,
    appState: { viewBackgroundColor: restored.appState.viewBackgroundColor },
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

function summaryFor(
  element: ExcalidrawElement,
  elements: readonly ExcalidrawElement[],
): ShapeSummaryResult {
  const label = boundLabel(element, elements);
  const fullText = element.type === "text" ? element.text : (label?.text ?? "");
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
  return {
    summary: {
      id: element.id,
      type: element.type,
      bounds,
      ...(fullText ? { text: fullText.slice(0, MAX_SUMMARY_TEXT_LENGTH) } : null),
      ...(connections?.length ? { connections } : null),
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
  target.createdIds.push(...source.createdIds);
  target.updatedIds.push(...source.updatedIds);
  target.deletedIds.push(...source.deletedIds);
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
  for (const operation of prepared) {
    switch (operation.type) {
      case "create":
        elements = [...elements, ...createElements(operation.shape, operation.id)];
        receipt.createdIds.push(operation.id);
        if (highlightActive) selectedElementIds = { [operation.id]: true };
        break;
      case "create-relative": {
        const shape = resolveRelativeShape(operation.shape, operation.relativeTo, elements);
        elements = [...elements, ...createElements(shape, operation.id)];
        receipt.createdIds.push(operation.id);
        if (highlightActive) selectedElementIds = { [operation.id]: true };
        break;
      }
      case "connect":
        elements = connectElements(elements, operation);
        receipt.createdIds.push(operation.id);
        if (highlightActive) selectedElementIds = { [operation.id]: true };
        break;
      case "update": {
        const id = shapeId(operation.id);
        const target = elementMap(elements).get(id);
        if (!target) throw new Error(`Shape not found: ${id}`);
        if (operation.text !== undefined)
          elements = updateElementText(elements, target, operation.text);
        elements = elements.map((element) => {
          if (element.id !== id) return element;
          return newElementWith(element, {
            ...(operation.x === undefined ? null : { x: operation.x }),
            ...(operation.y === undefined ? null : { y: operation.y }),
            ...(operation.rotation === undefined ? null : { angle: operation.rotation }),
            ...(operation.opacity === undefined ? null : { opacity: operation.opacity * 100 }),
          });
        });
        receipt.updatedIds.push(id);
        if (highlightActive) selectedElementIds = { [id]: true };
        break;
      }
      case "delete": {
        const ids = new Set(operation.ids.map(shapeId));
        elements = elements.map((element) =>
          ids.has(element.id) ||
          (element.type === "text" && !!element.containerId && ids.has(element.containerId))
            ? newElementWith(element, { isDeleted: true })
            : element,
        );
        receipt.deletedIds.push(...ids);
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
      case "bring-to-front": {
        const ids = new Set(operation.ids.map(shapeId));
        elements = reorder(elements, ids, true);
        receipt.updatedIds.push(...ids);
        if (highlightActive)
          selectedElementIds = Object.fromEntries([...ids].map((id) => [id, true]));
        break;
      }
      case "send-to-back": {
        const ids = new Set(operation.ids.map(shapeId));
        elements = reorder(elements, ids, false);
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
  elements = updateConnections(elements);
  api.updateScene({
    elements,
    ...(selectedElementIds ? { appState: { selectedElementIds } } : null),
    captureUpdate,
  });
  if (zoomIds) {
    const ids = new Set(zoomIds);
    api.scrollToContent(
      elements.filter((element) => ids.has(element.id)),
      { animate: true, fitToContent: true },
    );
  } else if (highlightActive && selectedElementIds) {
    const activeIds = Object.keys(selectedElementIds);
    const visibleIds = new Set(idsForScope(api, elements, "viewport"));
    if (activeIds.some((id) => !visibleIds.has(id))) {
      const ids = new Set(activeIds);
      api.scrollToContent(
        elements.filter((element) => ids.has(element.id)),
        { animate: true, fitToContent: false },
      );
    }
  }
  return receipt;
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
      const appState = api.getAppState();
      const start = viewportCoordsToSceneCoords({ clientX: 0, clientY: 0 }, appState);
      const end = viewportCoordsToSceneCoords(
        { clientX: appState.width, clientY: appState.height },
        appState,
      );
      return {
        pageId: "page:default",
        viewportBounds: {
          x: Math.min(start.x, end.x),
          y: Math.min(start.y, end.y),
          width: Math.abs(end.x - start.x),
          height: Math.abs(end.y - start.y),
        },
        selectedShapeIds: selectedShapeIds.slice(0, MAX_READ_SHAPES),
        shapes,
        truncated:
          ids.length > MAX_READ_SHAPES ||
          selectedShapeIds.length > MAX_READ_SHAPES ||
          summaryTextTruncated,
      };
    },
    async render({ scope, format, background = true, scale = 1 }) {
      const allElements = nonDeleted(api);
      const ids = new Set(idsForScope(api, allElements, scope));
      const elements = allElements.filter(
        (element) =>
          ids.has(element.id) ||
          (element.type === "text" && !!element.containerId && ids.has(element.containerId)),
      );
      if (elements.length === 0) throw new Error("There are no shapes to render");
      if (!Number.isFinite(scale) || scale <= 0 || scale > MAX_RENDER_SCALE)
        throw new Error(`scale must be between 0 and ${MAX_RENDER_SCALE}`);
      const [minX, minY, maxX, maxY] = getCommonBounds(elements);
      const width = Math.ceil((maxX - minX + 20) * scale);
      const height = Math.ceil((maxY - minY + 20) * scale);
      if (width > MAX_RENDER_DIMENSION || height > MAX_RENDER_DIMENSION)
        throw new Error(`Rendered ${format.toUpperCase()} is too large`);
      const appState = {
        exportBackground: background,
        exportWithDarkMode: false,
        viewBackgroundColor: background ? api.getAppState().viewBackgroundColor : "transparent",
      };
      if (format === "svg") {
        const svg = await exportToSvg({
          elements,
          appState,
          files: api.getFiles(),
          exportPadding: 10,
          exportingFrame: null,
        });
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
        exportPadding: 10,
        getDimensions: (sourceWidth: number, sourceHeight: number) => ({
          width: sourceWidth * scale,
          height: sourceHeight * scale,
          scale,
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
    apply({ operations }) {
      const prepared = prepareOperations(api, operations);
      return applyPreparedOperations(api, prepared, CaptureUpdateAction.IMMEDIATELY, false);
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
      for (let index = 0; index < prepared.length; index += 1) {
        const step = applyPreparedOperations(
          api,
          [prepared[index]!],
          CaptureUpdateAction.NEVER,
          true,
        );
        mergeReceipt(receipt, step);
        if (index < prepared.length - 1) await playbackDelay(delay, options.signal);
      }
      api.updateScene({
        elements: api.getSceneElementsIncludingDeleted(),
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      return receipt;
    },
    loadDocument(snapshot) {
      const validated = validatedSnapshot(snapshot);
      api.addFiles(Object.values(validated.files));
      api.updateScene({
        elements: validated.elements,
        appState: validated.appState,
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
