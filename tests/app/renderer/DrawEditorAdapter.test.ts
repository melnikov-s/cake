/* oxlint-disable anti-slop/no-shape-in-symbol-names -- Shape is tldraw's precise drawing-domain entity. */
/**
 * @vitest-environment jsdom
 */
import {
  Box,
  Editor,
  createShapeId,
  createTLStore,
  defaultAddFontsFromNode,
  defaultBindingUtils,
  defaultShapeTools,
  defaultShapeUtils,
  defaultTools,
  tipTapDefaultExtensions,
  type TLAssetId,
  type TLImageAsset,
  type TLImageShape,
} from "tldraw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertPersistableDrawDocument,
  createDrawEditorAdapter,
  type DrawEditorAdapter,
} from "../../../src/renderer/draw/DrawEditorAdapter";

const sid = (id: string) => createShapeId(id);

function createEditor() {
  const container = document.createElement("div");
  container.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
  document.body.appendChild(container);
  const editor = new Editor({
    store: createTLStore({ shapeUtils: defaultShapeUtils, bindingUtils: defaultBindingUtils }),
    shapeUtils: defaultShapeUtils,
    bindingUtils: defaultBindingUtils,
    tools: [...defaultTools, ...defaultShapeTools],
    initialState: "select",
    getContainer: () => container,
    options: {
      text: {
        addFontsFromNode: defaultAddFontsFromNode,
        tipTapConfig: { extensions: tipTapDefaultExtensions },
      },
    },
  });
  editor.updateViewportScreenBounds(new Box(0, 0, 800, 600));
  return { editor, container };
}

describe("DrawEditorAdapter", () => {
  let editor: Editor;
  let container: HTMLDivElement;
  let adapter: DrawEditorAdapter;

  beforeEach(() => {
    ({ editor, container } = createEditor());
    adapter = createDrawEditorAdapter(editor);
  });

  afterEach(() => {
    editor.dispose();
    container.remove();
  });

  it("creates native shapes and a bound arrow to shapes created earlier in the batch", () => {
    const receipt = adapter.apply({
      operations: [
        {
          type: "create",
          shape: { id: "left", type: "geo", x: 20, y: 20, width: 100, height: 80 },
        },
        {
          type: "create",
          shape: { id: "right", type: "note", x: 300, y: 30, text: "Target" },
        },
        { type: "connect", id: "link", fromId: "left", toId: "right", text: "bound" },
      ],
    });

    expect(receipt.createdIds).toEqual(["shape:left", "shape:right", "shape:link"]);
    expect(editor.getShape(sid("left"))).toMatchObject({ type: "geo" });
    expect(editor.getShape(sid("right"))).toMatchObject({ type: "note" });
    expect(editor.getShape(sid("link"))).toMatchObject({ type: "arrow" });
    expect(
      adapter.read({ scope: "page" }).shapes.find(({ id }) => id === "shape:link")?.connections,
    ).toEqual([
      { terminal: "start", shapeId: "shape:left" },
      { terminal: "end", shapeId: "shape:right" },
    ]);

    const before = editor.getShapePageBounds(sid("link"));
    adapter.apply({ operations: [{ type: "move", ids: ["right"], deltaX: 200, deltaY: 0 }] });
    const after = editor.getShapePageBounds(sid("link"));
    expect(after?.maxX).toBeGreaterThan(before?.maxX ?? 0);
    expect(editor.getBindingsFromShape(sid("link"), "arrow")).toHaveLength(2);
  });

  it("creates standalone line and arrow shapes with native properties", () => {
    adapter.apply({
      operations: [
        {
          type: "create",
          shape: { id: "line", type: "line", x: 5, y: 10, endX: 105, endY: 60 },
        },
        {
          type: "create",
          shape: {
            id: "arrow",
            type: "arrow",
            x: 20,
            y: 30,
            endX: 220,
            endY: 130,
            text: "standalone",
          },
        },
      ],
    });

    expect(editor.getShape(sid("line"))).toMatchObject({ type: "line", x: 5, y: 10 });
    expect(editor.getShape(sid("arrow"))).toMatchObject({ type: "arrow", x: 20, y: 30 });
    expect(
      adapter.read({ scope: "page" }).shapes.find(({ id }) => id === "shape:arrow")?.text,
    ).toBe("standalone");
  });

  it("validates the full batch before mutation", () => {
    expect(() =>
      adapter.apply({
        operations: [
          {
            type: "create",
            shape: { id: "would-have-existed", type: "geo", x: 0, y: 0, width: 20, height: 20 },
          },
          { type: "move", ids: ["missing"], deltaX: 1, deltaY: 1 },
        ],
      }),
    ).toThrow("Shape not found");
    expect(editor.getCurrentPageShapes()).toHaveLength(0);

    expect(() =>
      adapter.apply({
        operations: [
          {
            type: "create",
            shape: { id: "duplicate", type: "geo", x: 0, y: 0, width: 20, height: 20 },
          },
          {
            type: "create",
            shape: { id: "duplicate", type: "note", x: 30, y: 0, text: "duplicate" },
          },
        ],
      }),
    ).toThrow("Duplicate shape ID");
    expect(editor.getCurrentPageShapes()).toHaveLength(0);

    expect(() =>
      adapter.apply({
        operations: [
          {
            type: "create",
            shape: {
              id: "invalid-color",
              type: "geo",
              x: 0,
              y: 0,
              width: 20,
              height: 20,
              color: "not-a-tldraw-color",
            },
          },
        ],
      }),
    ).toThrow("Unsupported shape color");
    expect(editor.getCurrentPageShapes()).toHaveLength(0);
  });

  it("records one native undo step for the whole batch", () => {
    adapter.apply({
      operations: [
        {
          type: "create",
          shape: { id: "one", type: "geo", x: 0, y: 0, width: 20, height: 20 },
        },
        {
          type: "create",
          shape: { id: "two", type: "text", x: 50, y: 0, text: "two" },
        },
      ],
    });
    expect(editor.getCurrentPageShapes()).toHaveLength(2);

    adapter.undo();
    expect(editor.getCurrentPageShapes()).toHaveLength(0);
    adapter.redo();
    expect(editor.getCurrentPageShapes()).toHaveLength(2);
  });

  it("reads selection and viewport scopes and marks truncated text", () => {
    adapter.apply({
      operations: [
        {
          type: "create",
          shape: { id: "near", type: "text", x: 10, y: 10, text: "x".repeat(5_000) },
        },
        {
          type: "create",
          shape: { id: "far", type: "geo", x: 10_000, y: 10_000, width: 50, height: 50 },
        },
        { type: "select", ids: ["far"] },
      ],
    });

    const selection = adapter.read({ scope: "selection" });
    expect(selection.shapes.map(({ id }) => id)).toEqual(["shape:far"]);
    expect(selection.selectedShapeIds).toEqual(["shape:far"]);

    const viewport = adapter.read({ scope: "viewport" });
    expect(viewport.shapes.map(({ id }) => id)).toContain("shape:near");
    expect(viewport.shapes.map(({ id }) => id)).not.toContain("shape:far");
    expect(viewport.shapes[0]?.text).toHaveLength(4_000);
    expect(viewport.truncated).toBe(true);
  });

  it("caps read results at 200 compact summaries", () => {
    adapter.apply({
      operations: Array.from({ length: 201 }, (_, index) => ({
        type: "create" as const,
        shape: {
          id: `item-${index}`,
          type: "geo" as const,
          x: index * 2,
          y: 0,
          width: 1,
          height: 1,
        },
      })),
    });

    const scene = adapter.read({ scope: "page" });
    expect(scene.shapes).toHaveLength(200);
    expect(scene.truncated).toBe(true);
  });

  it("bounds PNGs by decoded blob bytes before creating a data URL", async () => {
    adapter.apply({
      operations: [
        {
          type: "create",
          shape: { id: "box", type: "geo", x: 0, y: 0, width: 20, height: 20 },
        },
      ],
    });
    vi.spyOn(editor, "toImage").mockResolvedValue({
      blob: new Blob([new Uint8Array(8_000_001)], { type: "image/png" }),
      width: 20,
      height: 20,
    });

    await expect(adapter.render({ scope: "page", format: "png" })).rejects.toThrow(
      "Rendered PNG is too large",
    );

    vi.mocked(editor.toImage).mockResolvedValue({
      blob: new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }),
      width: 20,
      height: 20,
    });
    const rendered = await adapter.render({ scope: "page", format: "png" });
    expect(rendered.data).toMatch(/^data:image\/png;base64,/);
  });

  it("round-trips validated documents with inline image assets", () => {
    // SAFETY: tldraw asset IDs use this validated namespace-prefixed format.
    const assetId = "asset:inline" as TLAssetId;
    editor.createAssets([
      {
        id: assetId,
        typeName: "asset",
        type: "image",
        meta: {},
        props: {
          name: "pixel.png",
          src: "data:image/png;base64,iVBORw0KGgo=",
          mimeType: "image/png",
          w: 1,
          h: 1,
          isAnimated: false,
        },
      } satisfies TLImageAsset,
    ]);
    editor.createShape<TLImageShape>({
      type: "image",
      x: 10,
      y: 10,
      props: { assetId, w: 1, h: 1 },
    });
    const snapshot = adapter.snapshotDocument();
    assertPersistableDrawDocument(snapshot);

    const second = createEditor();
    try {
      const secondAdapter = createDrawEditorAdapter(second.editor);
      secondAdapter.loadDocument(snapshot);
      expect(second.editor.getAssets()).toHaveLength(1);
      expect(second.editor.getCurrentPageShapes()).toHaveLength(1);
    } finally {
      second.editor.dispose();
      second.container.remove();
    }

    const serialized = JSON.stringify(snapshot).replace(
      "data:image/png;base64,iVBORw0KGgo=",
      "blob:https://cake.invalid/image",
    );
    expect(() => adapter.loadDocument(JSON.parse(serialized))).toThrow(
      "Draw images must be inline PNG, JPEG, or WebP data URLs",
    );
  });
});
