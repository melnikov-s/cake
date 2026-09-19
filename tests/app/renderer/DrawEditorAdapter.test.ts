/* oxlint-disable anti-slop/no-shape-in-symbol-names -- Shape is the drawing-domain entity. */
/**
 * @vitest-environment jsdom
 */
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
