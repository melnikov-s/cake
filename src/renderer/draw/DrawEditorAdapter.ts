/* oxlint-disable anti-slop/no-shape-in-symbol-names -- Shape is tldraw's precise drawing-domain entity. */
import {
  DefaultColorStyle,
  createShapeId,
  createTLStore,
  getSnapshot,
  type Box,
  type Editor,
  type TLArrowBinding,
  type TLArrowShape,
  type TLDefaultColorStyle,
  type TLGeoShape,
  type IndexKey,
  type TLLineShape,
  type TLNoteShape,
  type TLShape,
  type TLShapeId,
  type TLStoreSnapshot,
  type TLTextShape,
  toRichText,
} from "tldraw";
import type { JsonObject, JsonValue } from "../../ipc/json-contract";
import type {
  DrawCreateShape,
  DrawDocumentSnapshot,
  DrawEditorController,
  DrawOperation,
  DrawReadScope,
  DrawShapeSummary,
} from "../../domain/draw/draw-editor";

export type { DrawDocumentSnapshot } from "../../domain/draw/draw-editor";

export interface DrawEditorAdapter extends DrawEditorController {
  undo(): void;
  redo(): void;
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

interface PreparedCreateOperation {
  readonly type: "create";
  readonly shape: DrawCreateShape;
  readonly id: TLShapeId;
}

interface MutableDrawApplyReceipt {
  createdIds: TLShapeId[];
  updatedIds: TLShapeId[];
  deletedIds: TLShapeId[];
}

interface PreparedConnectOperation {
  readonly type: "connect";
  readonly id: TLShapeId;
  readonly fromId: TLShapeId;
  readonly toId: TLShapeId;
  readonly text?: string;
}

type PreparedOperation =
  | PreparedCreateOperation
  | PreparedConnectOperation
  | Exclude<DrawOperation, { type: "create" | "connect" }>;

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

function shapeId(value: string): TLShapeId {
  const id = value.startsWith("shape:") ? value : `shape:${value}`;
  if (!/^shape:[A-Za-z0-9_-]{1,256}$/.test(id)) throw new Error(`Invalid shape ID: ${value}`);
  // SAFETY: The tldraw ID prefix and allowed identifier characters were validated above.
  return id as TLShapeId;
}

function idsForScope(editor: Editor, scope: DrawReadScope): TLShapeId[] {
  if (scope === "selection") return [...editor.getSelectedShapeIds()];
  const shapes = editor.getCurrentPageShapesSorted();
  if (scope === "page") return shapes.map((shape) => shape.id);
  const viewport = editor.getViewportPageBounds();
  return shapes
    .filter((shape) => {
      const bounds = editor.getShapePageBounds(shape);
      return bounds ? viewport.collides(bounds) : false;
    })
    .map((shape) => shape.id);
}

function validColor(value: string | undefined): TLDefaultColorStyle | undefined {
  if (value === undefined) return undefined;
  const color = DefaultColorStyle.values.find((candidate) => candidate === value);
  if (!color) throw new Error(`Unsupported shape color: ${value}`);
  return color;
}

function validateCreateShape(shape: DrawCreateShape) {
  finite(shape.x, "x");
  finite(shape.y, "y");
  switch (shape.type) {
    case "geo":
      positive(shape.width, "width");
      positive(shape.height, "height");
      if (shape.text !== undefined) text(shape.text);
      validColor(shape.color);
      break;
    case "text":
      text(shape.text);
      if (shape.width !== undefined) positive(shape.width, "width");
      break;
    case "note":
      text(shape.text);
      validColor(shape.color);
      break;
    case "line":
    case "arrow":
      finite(shape.endX, "endX");
      finite(shape.endY, "endY");
      if (shape.text !== undefined) text(shape.text);
      break;
  }
}

function uniqueTargetIds(values: readonly string[], operation: string) {
  const ids = values.map(shapeId);
  if (new Set(ids).size !== ids.length)
    throw new Error(`${operation} contains a duplicate shape target`);
  return ids;
}

function requireTargets(
  known: ReadonlySet<TLShapeId>,
  ids: readonly TLShapeId[],
  operation: string,
) {
  for (const id of ids) {
    if (!known.has(id)) throw new Error(`Shape not found for ${operation}: ${id}`);
  }
}

function prepareOperations(
  editor: Editor,
  operations: readonly DrawOperation[],
): PreparedOperation[] {
  if (operations.length === 0 || operations.length > 500)
    throw new Error("A draw batch must contain between 1 and 500 operations");

  const known = new Set(editor.getCurrentPageShapes().map((shape) => shape.id));
  const prepared: PreparedOperation[] = [];
  for (const operation of operations) {
    switch (operation.type) {
      case "create": {
        validateCreateShape(operation.shape);
        const id = operation.shape.id ? shapeId(operation.shape.id) : createShapeId();
        if (known.has(id)) throw new Error(`Duplicate shape ID: ${id}`);
        known.add(id);
        prepared.push({ ...operation, id });
        break;
      }
      case "connect": {
        const id = operation.id ? shapeId(operation.id) : createShapeId();
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
        if (operation.text !== undefined) {
          text(operation.text);
          const target = editor.getShape(id);
          if (target && !("richText" in target.props))
            throw new Error(`Shape does not support text: ${id}`);
        }
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

function createShape(editor: Editor, shape: DrawCreateShape, id: TLShapeId) {
  const x = shape.x;
  const y = shape.y;
  switch (shape.type) {
    case "geo":
      editor.createShape<TLGeoShape>({
        id,
        type: "geo",
        x,
        y,
        props: {
          w: shape.width,
          h: shape.height,
          geo: shape.geo ?? "rectangle",
          richText: toRichText(shape.text ?? ""),
          ...(shape.color ? { color: validColor(shape.color) } : null),
          ...(shape.fill ? { fill: shape.fill } : null),
        },
      });
      break;
    case "text":
      editor.createShape<TLTextShape>({
        id,
        type: "text",
        x,
        y,
        props: {
          richText: toRichText(shape.text),
          ...(shape.width === undefined ? { autoSize: true } : { autoSize: false, w: shape.width }),
        },
      });
      break;
    case "note":
      editor.createShape<TLNoteShape>({
        id,
        type: "note",
        x,
        y,
        props: {
          richText: toRichText(shape.text),
          ...(shape.color ? { color: validColor(shape.color) } : null),
        },
      });
      break;
    case "line":
      editor.createShape<TLLineShape>({
        id,
        type: "line",
        x,
        y,
        props: {
          points: {
            a1: {
              id: "a1",
              // SAFETY: "a1" is the canonical first fractional index used by tldraw.
              index: "a1" as IndexKey,
              x: 0,
              y: 0,
            },
            a2: {
              id: "a2",
              // SAFETY: "a2" is the canonical fractional index immediately after "a1".
              index: "a2" as IndexKey,
              x: shape.endX - x,
              y: shape.endY - y,
            },
          },
        },
      });
      break;
    case "arrow":
      editor.createShape<TLArrowShape>({
        id,
        type: "arrow",
        x,
        y,
        props: {
          start: { x: 0, y: 0 },
          end: { x: shape.endX - x, y: shape.endY - y },
          richText: toRichText(shape.text ?? ""),
        },
      });
      break;
  }
}

function centerOfShape(editor: Editor, id: TLShapeId) {
  const bounds = editor.getShapePageBounds(id);
  if (!bounds) throw new Error(`Shape has no page bounds: ${id}`);
  return bounds.center;
}

function connectShapes(editor: Editor, operation: PreparedConnectOperation) {
  const start = centerOfShape(editor, operation.fromId);
  const end = centerOfShape(editor, operation.toId);
  editor.createShape<TLArrowShape>({
    id: operation.id,
    type: "arrow",
    x: start.x,
    y: start.y,
    props: {
      start: { x: 0, y: 0 },
      end: { x: end.x - start.x, y: end.y - start.y },
      richText: toRichText(operation.text ?? ""),
    },
  });
  const bindingProps = {
    normalizedAnchor: { x: 0.5, y: 0.5 },
    isExact: false,
    isPrecise: false,
    snap: "none" as const,
  };
  editor.createBindings<TLArrowBinding>([
    {
      type: "arrow",
      fromId: operation.id,
      toId: operation.fromId,
      props: { ...bindingProps, terminal: "start" },
    },
    {
      type: "arrow",
      fromId: operation.id,
      toId: operation.toId,
      props: { ...bindingProps, terminal: "end" },
    },
  ]);
}

function updateShape(editor: Editor, operation: Extract<DrawOperation, { type: "update" }>) {
  const id = shapeId(operation.id);
  const current = editor.getShape(id);
  if (!current) throw new Error(`Shape not found: ${operation.id}`);
  const update: Partial<TLShape> & Pick<TLShape, "id" | "type"> = {
    id,
    type: current.type,
  };
  if (operation.x !== undefined) update.x = operation.x;
  if (operation.y !== undefined) update.y = operation.y;
  if (operation.rotation !== undefined) update.rotation = operation.rotation;
  if (operation.opacity !== undefined) update.opacity = operation.opacity;
  if (operation.text !== undefined) {
    if (!("richText" in current.props))
      throw new Error(`Shape does not support text: ${operation.id}`);
    update.props = { richText: toRichText(operation.text) };
  }
  editor.updateShape(update);
}

function dataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)), { once: true });
    reader.addEventListener("error", () => reject(reader.error), { once: true });
    reader.readAsDataURL(blob);
  });
}

function plainBounds(box: Box) {
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

function shapeSummary(editor: Editor, id: TLShapeId) {
  const shape = editor.getShape(id);
  if (!shape) return undefined;
  const bounds = editor.getShapePageBounds(shape);
  const fullText = editor.getShapeUtil(shape).getText(shape) ?? "";
  const connections =
    shape.type === "arrow"
      ? editor
          .getBindingsFromShape(shape, "arrow")
          .map((binding) => ({
            terminal: binding.props.terminal,
            shapeId: binding.toId,
          }))
          .sort((left, right) =>
            left.terminal === right.terminal ? 0 : left.terminal === "start" ? -1 : 1,
          )
      : undefined;
  const summary: DrawShapeSummary = {
    id: shape.id,
    type: shape.type,
    ...(bounds ? { bounds: plainBounds(bounds) } : null),
    ...(fullText ? { text: fullText.slice(0, MAX_SUMMARY_TEXT_LENGTH) } : null),
    ...(connections?.length ? { connections } : null),
  };
  return { summary, textTruncated: fullText.length > MAX_SUMMARY_TEXT_LENGTH };
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return (
    value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)
  );
}

function isString(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}

function asStoreSnapshot(snapshot: DrawDocumentSnapshot): TLStoreSnapshot {
  if (!isJsonObject(snapshot) || !isJsonObject(snapshot.store) || !isJsonObject(snapshot.schema))
    throw new Error("Invalid Cake Draw document snapshot");
  // The isolated tldraw Store created by validateDocumentSnapshot performs migration and validates
  // every nested record and property. tldraw's records use `any` for extensible JSON metadata, so
  // TypeScript cannot prove their compatibility with Cake's stricter JsonValue contract.
  // @ts-expect-error -- Deliberately entering tldraw's validator from checked Cake JSON.
  return snapshot;
}

function asDrawDocumentSnapshot(snapshot: TLStoreSnapshot): DrawDocumentSnapshot {
  // tldraw serializes store snapshots as JSON, but its extensible metadata is typed as `any`.
  // @ts-expect-error -- The SDK-produced snapshot is JSON-safe by its persistence contract.
  return snapshot;
}

function assertInlineImageAssets(snapshot: DrawDocumentSnapshot) {
  if (!isJsonObject(snapshot) || !isJsonObject(snapshot.store))
    throw new Error("Invalid Cake Draw document snapshot");
  for (const record of Object.values(snapshot.store)) {
    if (!isJsonObject(record) || record.typeName !== "asset") continue;
    if (record.type === "video") throw new Error("Video assets are not supported in Cake Draw");
    if (record.type !== "image" || !isJsonObject(record.props)) continue;
    const src = record.props.src;
    const mimeType = record.props.mimeType;
    if (
      !isString(src) ||
      !isString(mimeType) ||
      !["image/png", "image/jpeg", "image/webp"].includes(mimeType) ||
      !src.startsWith(`data:${mimeType};base64,`)
    )
      throw new Error("Draw images must be inline PNG, JPEG, or WebP data URLs");
  }
}

function validateDocumentSnapshot(editor: Editor, snapshot: DrawDocumentSnapshot) {
  assertInlineImageAssets(snapshot);
  const validationStore = createTLStore({
    schema: editor.store.schema,
    snapshot: asStoreSnapshot(snapshot),
  });
  const document = getSnapshot(validationStore).document;
  const validated = asDrawDocumentSnapshot(document);
  assertInlineImageAssets(validated);
  return document;
}

export function createDrawEditorAdapter(editor: Editor): DrawEditorAdapter {
  return {
    read({ scope }) {
      const ids = idsForScope(editor, scope);
      const selectedShapeIds = [...editor.getSelectedShapeIds()];
      let summaryTextTruncated = false;
      const shapes = ids.slice(0, MAX_READ_SHAPES).flatMap((id) => {
        const result = shapeSummary(editor, id);
        if (!result) return [];
        summaryTextTruncated ||= result.textTruncated;
        return [result.summary];
      });
      return {
        pageId: editor.getCurrentPageId(),
        viewportBounds: plainBounds(editor.getViewportPageBounds()),
        selectedShapeIds: selectedShapeIds.slice(0, MAX_READ_SHAPES),
        shapes,
        truncated:
          ids.length > MAX_READ_SHAPES ||
          selectedShapeIds.length > MAX_READ_SHAPES ||
          summaryTextTruncated,
      };
    },
    async render({ scope, format, background = true, scale = 1 }) {
      const ids = idsForScope(editor, scope);
      if (ids.length === 0) throw new Error("There are no shapes to render");
      if (!Number.isFinite(scale) || scale <= 0 || scale > MAX_RENDER_SCALE)
        throw new Error(`scale must be between 0 and ${MAX_RENDER_SCALE}`);
      if (format === "svg") {
        const result = await editor.getSvgString(ids, { background, scale });
        if (!result) throw new Error("Canvas could not be rendered");
        if (
          result.width > MAX_RENDER_DIMENSION ||
          result.height > MAX_RENDER_DIMENSION ||
          new TextEncoder().encode(result.svg).byteLength > MAX_RENDER_BYTES
        )
          throw new Error("Rendered SVG is too large");
        return {
          format,
          mediaType: "image/svg+xml",
          width: result.width,
          height: result.height,
          data: result.svg,
        };
      }
      const result = await editor.toImage(ids, { format: "png", background, scale });
      if (
        result.width > MAX_RENDER_DIMENSION ||
        result.height > MAX_RENDER_DIMENSION ||
        result.blob.size > MAX_RENDER_BYTES
      )
        throw new Error("Rendered PNG is too large");
      return {
        format,
        mediaType: "image/png",
        width: result.width,
        height: result.height,
        data: await dataUrl(result.blob),
      };
    },
    apply({ operations }) {
      const prepared = prepareOperations(editor, operations);
      const receipt: MutableDrawApplyReceipt = {
        createdIds: [],
        updatedIds: [],
        deletedIds: [],
      };
      const mark = editor.markHistoryStoppingPoint("Cake Draw batch");
      try {
        editor.run(() => {
          for (const operation of prepared) {
            switch (operation.type) {
              case "create":
                createShape(editor, operation.shape, operation.id);
                receipt.createdIds.push(operation.id);
                break;
              case "connect":
                connectShapes(editor, operation);
                receipt.createdIds.push(operation.id);
                break;
              case "update":
                updateShape(editor, operation);
                receipt.updatedIds.push(shapeId(operation.id));
                break;
              case "delete": {
                const ids = operation.ids.map(shapeId);
                editor.deleteShapes(ids);
                receipt.deletedIds.push(...ids);
                break;
              }
              case "move": {
                const dx = operation.deltaX;
                const dy = operation.deltaY;
                const updates = operation.ids.map((value) => {
                  const target = editor.getShape(shapeId(value));
                  if (!target) throw new Error(`Shape not found: ${value}`);
                  return { id: target.id, type: target.type, x: target.x + dx, y: target.y + dy };
                });
                editor.updateShapes(updates);
                receipt.updatedIds.push(...updates.map((update) => update.id));
                break;
              }
              case "align": {
                const ids = operation.ids.map(shapeId);
                editor.alignShapes(ids, operation.alignment);
                receipt.updatedIds.push(...ids);
                break;
              }
              case "distribute": {
                const ids = operation.ids.map(shapeId);
                editor.distributeShapes(ids, operation.direction);
                receipt.updatedIds.push(...ids);
                break;
              }
              case "bring-to-front": {
                const ids = operation.ids.map(shapeId);
                editor.bringToFront(ids);
                receipt.updatedIds.push(...ids);
                break;
              }
              case "send-to-back": {
                const ids = operation.ids.map(shapeId);
                editor.sendToBack(ids);
                receipt.updatedIds.push(...ids);
                break;
              }
              case "select":
                editor.setSelectedShapes(operation.ids.map(shapeId));
                break;
              case "zoom-to":
                editor.setSelectedShapes(operation.ids.map(shapeId));
                editor.zoomToSelection({ animation: { duration: 0 } });
                break;
            }
          }
        });
        editor.squashToMark(mark);
      } catch (error) {
        editor.bailToMark(mark);
        throw error;
      }
      return receipt;
    },
    undo: () => editor.undo(),
    redo: () => editor.redo(),
    loadDocument(snapshot) {
      editor.loadSnapshot(validateDocumentSnapshot(editor, snapshot));
    },
    snapshotDocument() {
      const document = getSnapshot(editor.store).document;
      const snapshot = asDrawDocumentSnapshot(document);
      assertInlineImageAssets(snapshot);
      return snapshot;
    },
    onDocumentChange: (listener) =>
      editor.store.listen(listener, { source: "all", scope: "document" }),
  };
}

export function assertPersistableDrawDocument(snapshot: DrawDocumentSnapshot) {
  assertInlineImageAssets(snapshot);
}
