/* oxlint-disable anti-slop/no-shape-in-symbol-names -- Shape is the drawing-domain entity. */
/**
 * @vitest-environment jsdom
 */
import { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDrawEditorAdapter,
  type DrawEditorAdapter,
} from "../../../src/renderer/draw/DrawEditorAdapter";
import { assertPersistableDrawDocument } from "../../../src/renderer/draw/DrawDocumentValidation";

vi.mock("@excalidraw/mermaid-to-excalidraw", () => ({
  parseMermaidToExcalidraw: vi.fn(async () => ({
    elements: [
      { id: "mermaid-a", type: "rectangle", x: 0, y: 0, width: 120, height: 80 },
      { id: "mermaid-b", type: "rectangle", x: 240, y: 0, width: 120, height: 80 },
      {
        id: "mermaid-edge",
        type: "arrow",
        x: 120,
        y: 40,
        points: [
          [0, 0],
          [120, 0],
        ],
      },
    ],
  })),
}));

function editorHarness() {
  let elements: readonly ExcalidrawElement[] = [];
  let files: BinaryFiles = {};
  let appState = {
    selectedElementIds: {},
    viewBackgroundColor: "#ffffff",
    width: 800,
    height: 600,
    offsetLeft: 0,
    offsetTop: 0,
    scrollX: 0,
    scrollY: 0,
    zoom: { value: 1 },
  } as unknown as AppState;
  const listeners = new Set<() => void>();
  const sceneUpdates: string[][] = [];
  const api = {
    getSceneElements: () => elements.filter((element) => !element.isDeleted),
    getSceneElementsIncludingDeleted: () => elements,
    getAppState: () => appState,
    getFiles: () => files,
    updateScene: (scene: {
      elements?: readonly ExcalidrawElement[] | null;
      appState?: Partial<AppState> | null;
    }) => {
      if (scene.elements) elements = scene.elements;
      if (scene.appState) appState = { ...appState, ...scene.appState };
      sceneUpdates.push(
        elements.filter((element) => !element.isDeleted).map((element) => element.id),
      );
      for (const listener of listeners) listener();
    },
    addFiles: (nextFiles: BinaryFileData[]) => {
      files = { ...files, ...Object.fromEntries(nextFiles.map((file) => [file.id, file])) };
    },
    onChange: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    history: { clear: vi.fn() },
    scrollToContent: vi.fn(),
  } as unknown as ExcalidrawImperativeAPI;
  return {
    api,
    elements: () => elements,
    sceneUpdates: () => sceneUpdates,
    setElements(next: readonly ExcalidrawElement[]) {
      elements = next;
    },
  };
}

describe("DrawEditorAdapter", () => {
  let harness: ReturnType<typeof editorHarness>;
  let adapter: DrawEditorAdapter;

  beforeEach(() => {
    harness = editorHarness();
    adapter = createDrawEditorAdapter(harness.api);
  });

  it("inserts Mermaid as native editable elements centered in the viewport", async () => {
    const receipt = await adapter.insertMermaid("flowchart LR\n  A --> B");

    expect(parseMermaidToExcalidraw).toHaveBeenCalledWith("flowchart LR\n  A --> B", {
      maxEdges: 500,
      maxTextSize: 50_000,
    });
    expect(receipt.elementCount).toBe(3);
    expect(harness.elements()).toHaveLength(3);
    expect(harness.elements().map(({ type }) => type)).toEqual(["rectangle", "rectangle", "arrow"]);
    expect(harness.api.scrollToContent).toHaveBeenCalledWith(harness.elements(), {
      animate: true,
      fitToContent: true,
    });
    const [minX, minY, maxX, maxY] = await import("@excalidraw/excalidraw").then(
      ({ getCommonBounds }) => getCommonBounds(harness.elements()),
    );
    expect((minX + maxX) / 2).toBeCloseTo(400);
    expect((minY + maxY) / 2).toBeCloseTo(300);
  });

  it("creates native shapes and a bound arrow", () => {
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
    expect(harness.elements().find(({ id }) => id === "shape:left")).toMatchObject({
      type: "rectangle",
    });
    expect(
      adapter.read({ scope: "page" }).shapes.find(({ id }) => id === "shape:link")?.connections,
    ).toEqual([
      { terminal: "start", shapeId: "shape:left" },
      { terminal: "end", shapeId: "shape:right" },
    ]);

    const before = harness
      .elements()
      .find(
        (element): element is Extract<ExcalidrawElement, { type: "arrow" }> =>
          element.id === "shape:link" && element.type === "arrow",
      );
    adapter.apply({ operations: [{ type: "move", ids: ["right"], deltaX: 200, deltaY: 0 }] });
    const after = harness
      .elements()
      .find(
        (element): element is Extract<ExcalidrawElement, { type: "arrow" }> =>
          element.id === "shape:link" && element.type === "arrow",
      );
    expect(after?.points.at(-1)?.[0]).toBeGreaterThan(before?.points.at(-1)?.[0] ?? 0);
  });

  it("plays operations progressively and resolves relative positions", async () => {
    const receipt = await adapter.applyAnimated(
      {
        operations: [
          {
            type: "create",
            shape: { id: "left", type: "geo", x: 20, y: 30, width: 100, height: 80 },
          },
          {
            type: "create-relative",
            shape: {
              id: "right",
              type: "geo",
              width: 120,
              height: 60,
              placement: { relativeTo: "left", side: "right", gap: 50 },
            },
          },
          { type: "connect", id: "link", fromId: "left", toId: "right" },
        ],
      },
      { stepDelayMs: 0 },
    );

    expect(receipt.createdIds).toEqual(["shape:left", "shape:right", "shape:link"]);
    expect(
      adapter.read({ scope: "page" }).shapes.find(({ id }) => id === "shape:right")?.bounds,
    ).toMatchObject({ x: 170, y: 40, width: 120, height: 60 });
    expect(harness.sceneUpdates().slice(0, 3)).toEqual([
      ["shape:left"],
      ["shape:left", "shape:right"],
      ["shape:left", "shape:right", "shape:link"],
    ]);
  });

  it("creates standalone line and arrow elements", () => {
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

    expect(harness.elements().find(({ id }) => id === "shape:line")).toMatchObject({
      type: "line",
      x: 5,
      y: 10,
    });
    expect(
      adapter.read({ scope: "page" }).shapes.find(({ id }) => id === "shape:arrow")?.text,
    ).toBe("standalone");

    adapter.apply({
      operations: [
        { type: "update", id: "arrow", endX: 320, endY: 180 },
        {
          type: "style",
          ids: ["arrow"],
          style: { startArrowhead: "dot", endArrowhead: "triangle", strokeStyle: "dotted" },
        },
      ],
    });
    const updatedArrow = harness
      .elements()
      .find(
        (element): element is Extract<ExcalidrawElement, { type: "arrow" }> =>
          element.id === "shape:arrow" && element.type === "arrow",
      );
    expect(updatedArrow).toMatchObject({
      id: "shape:arrow",
      startArrowhead: "dot",
      endArrowhead: "triangle",
      strokeStyle: "dotted",
    });
    expect(updatedArrow?.points.at(-1)).toEqual([300, 150]);
    expect(
      adapter.read({ scope: "page" }).shapes.find(({ id }) => id === "shape:arrow")?.style,
    ).toMatchObject({
      startArrowhead: "dot",
      endArrowhead: "triangle",
      strokeStyle: "dotted",
    });
  });

  it("resizes, converts, and restyles an existing labeled shape without replacing its ID", () => {
    adapter.apply({
      operations: [
        {
          type: "create",
          shape: {
            id: "card",
            type: "geo",
            x: 40,
            y: 50,
            width: 160,
            height: 90,
            text: "Editable",
          },
        },
      ],
    });
    const originalIds = harness.elements().map(({ id }) => id);

    const receipt = adapter.apply({
      operations: [
        {
          type: "update",
          id: "card",
          x: 80,
          y: 100,
          width: 280,
          height: 140,
          geo: "ellipse",
          text: "Still the same shape",
        },
        {
          type: "style",
          ids: ["card"],
          style: {
            strokeColor: "blue",
            backgroundColor: "light-blue",
            fill: "solid",
            strokeWidth: 4,
            strokeStyle: "dashed",
            roughness: 0,
            opacity: 0.75,
            roundness: "round",
            fontSize: 32,
            fontFamily: "monospace",
            textAlign: "center",
            verticalAlign: "middle",
          },
        },
      ],
    });

    expect(receipt.createdIds).toEqual([]);
    expect(receipt.deletedIds).toEqual([]);
    expect(receipt.updatedIds).toEqual(["shape:card"]);
    expect(harness.elements().map(({ id }) => id)).toEqual(originalIds);
    expect(harness.elements().find(({ id }) => id === "shape:card")).toMatchObject({
      id: "shape:card",
      type: "ellipse",
      x: 80,
      y: 100,
      width: 280,
      height: 140,
      strokeColor: "#1971c2",
      backgroundColor: "#4dabf7",
      fillStyle: "solid",
      strokeWidth: 4,
      strokeStyle: "dashed",
      roughness: 0,
      opacity: 75,
    });
    const summary = adapter.read({ scope: "page" }).shapes[0];
    expect(summary).toMatchObject({
      id: "shape:card",
      type: "ellipse",
      bounds: { x: 80, y: 100, width: 280, height: 140 },
      text: "Still the same shape",
      style: {
        strokeColor: "#1971c2",
        backgroundColor: "#4dabf7",
        fill: "solid",
        strokeWidth: 4,
        strokeStyle: "dashed",
        roughness: 0,
        opacity: 0.75,
        roundness: "round",
        fontSize: 32,
        fontFamily: "monospace",
        textAlign: "center",
        verticalAlign: "middle",
        locked: false,
      },
    });
  });

  it("applies selection, movement, shared style, layer, and locking workflows", () => {
    adapter.apply({
      operations: [
        {
          type: "create",
          shape: { id: "first", type: "geo", x: 0, y: 0, width: 80, height: 60 },
        },
        {
          type: "create",
          shape: { id: "second", type: "geo", x: 120, y: 0, width: 80, height: 60 },
        },
      ],
    });

    const receipt = adapter.apply({
      operations: [
        {
          type: "style",
          ids: ["first", "second"],
          style: { strokeColor: "red", backgroundColor: "yellow", fill: "pattern" },
        },
        { type: "move", ids: ["first", "second"], deltaX: 25, deltaY: 40 },
        { type: "bring-to-front", ids: ["first"] },
        { type: "set-locked", ids: ["first", "second"], locked: true },
        { type: "select", ids: ["first", "second"] },
      ],
    });

    expect(new Set(receipt.updatedIds)).toEqual(new Set(["shape:first", "shape:second"]));
    expect(adapter.read({ scope: "selection" }).selectedShapeIds).toEqual([
      "shape:first",
      "shape:second",
    ]);
    expect(
      adapter.read({ scope: "page" }).shapes.map(({ id, bounds, style }) => ({
        id,
        x: bounds?.x,
        y: bounds?.y,
        strokeColor: style.strokeColor,
        fill: style.fill,
        locked: style.locked,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          id: "shape:first",
          x: 25,
          y: 40,
          strokeColor: "#e03131",
          fill: "pattern",
          locked: true,
        },
        {
          id: "shape:second",
          x: 145,
          y: 40,
          strokeColor: "#e03131",
          fill: "pattern",
          locked: true,
        },
      ]),
    );
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
    expect(harness.elements()).toHaveLength(0);

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
    expect(harness.elements()).toHaveLength(0);

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
              color: "not-a-color",
            },
          },
        ],
      }),
    ).toThrow("Unsupported shape color");

    adapter.apply({
      operations: [
        {
          type: "create",
          shape: { id: "plain", type: "geo", x: 0, y: 0, width: 20, height: 20 },
        },
        {
          type: "create",
          shape: { id: "linear", type: "arrow", x: 50, y: 0, endX: 100, endY: 20 },
        },
      ],
    });
    const beforeInvalidEdit = JSON.stringify(harness.elements());
    expect(() =>
      adapter.apply({
        operations: [
          { type: "move", ids: ["plain"], deltaX: 100, deltaY: 0 },
          { type: "style", ids: ["plain"], style: { fontSize: 40 } },
        ],
      }),
    ).toThrow("Typography requires text or a labeled shape");
    expect(JSON.stringify(harness.elements())).toBe(beforeInvalidEdit);
    expect(() =>
      adapter.apply({
        operations: [{ type: "update", id: "linear", width: 200 }],
      }),
    ).toThrow("use endX/endY");
    expect(() =>
      adapter.apply({
        operations: [{ type: "update", id: "plain" }],
      }),
    ).toThrow("update must change at least one property");
    expect(() =>
      adapter.apply({
        operations: [{ type: "style", ids: ["plain"], style: {} }],
      }),
    ).toThrow("style must change at least one property");
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

  it("round-trips validated documents with inline image files", () => {
    adapter.apply({
      operations: [
        {
          type: "create",
          shape: { id: "image-placeholder", type: "geo", x: 10, y: 10, width: 1, height: 1 },
        },
      ],
    });
    harness.api.addFiles([
      {
        id: "file:inline" as never,
        dataURL: "data:image/png;base64,iVBORw0KGgo=" as never,
        mimeType: "image/png",
        created: 1,
      },
    ]);
    const snapshot = adapter.snapshotDocument();
    assertPersistableDrawDocument(snapshot);

    const second = editorHarness();
    createDrawEditorAdapter(second.api).loadDocument(snapshot);
    expect(second.elements()).toHaveLength(1);
    expect(Object.keys(second.api.getFiles())).toEqual(["file:inline"]);

    const serialized = JSON.stringify(snapshot).replace(
      "data:image/png;base64,iVBORw0KGgo=",
      "blob:https://cake.invalid/image",
    );
    expect(() => adapter.loadDocument(JSON.parse(serialized))).toThrow(
      "Draw images must be inline PNG, JPEG, or WebP data URLs",
    );
  });
});
