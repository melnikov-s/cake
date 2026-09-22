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
    setAppState(next: Partial<AppState>) {
      appState = { ...appState, ...next };
    },
  };
}

describe("DrawEditorAdapter", () => {
  let harness: ReturnType<typeof editorHarness>;
  let adapter: DrawEditorAdapter;

  beforeEach(() => {
    vi.mocked(parseMermaidToExcalidraw)
      .mockReset()
      .mockResolvedValue({
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
      });
    harness = editorHarness();
    adapter = createDrawEditorAdapter(harness.api);
  });

  it("inserts Mermaid as native editable elements centered in an empty viewport", async () => {
    const receipt = await adapter.insertMermaid("flowchart LR\n  A --> B");

    expect(parseMermaidToExcalidraw).toHaveBeenCalledWith("flowchart LR\n  A --> B", {
      flowchart: { curve: "linear" },
      maxEdges: 500,
      maxTextSize: 50_000,
      themeVariables: { fontSize: "20px" },
    });
    expect(receipt.elementCount).toBe(3);
    expect(harness.elements()).toHaveLength(3);
    expect(harness.elements().map(({ type }) => type)).toEqual(["arrow", "rectangle", "rectangle"]);
    expect(harness.api.scrollToContent).toHaveBeenCalledWith(harness.elements(), {
      animate: false,
      fitToViewport: true,
      viewportZoomFactor: 0.85,
      maxZoom: 1,
    });
    const [minX, minY, maxX, maxY] = await import("@excalidraw/excalidraw").then(
      ({ getCommonBounds }) => getCommonBounds(harness.elements()),
    );
    expect((minX + maxX) / 2).toBeCloseTo(400);
    expect((minY + maxY) / 2).toBeCloseTo(300);
  });

  it("atomically replaces a named Mermaid region with stable semantic mappings", async () => {
    const first = await adapter.insertMermaid("flowchart LR\n  A --> B", {
      id: "runtime-flow",
      replace: true,
    });
    expect(first.diagramId).toBe("runtime-flow");
    expect(first.mappings).toEqual([
      { semanticId: "mermaid-a", shapeId: "shape:runtime-flow--node--mermaid-a", role: "node" },
      { semanticId: "mermaid-b", shapeId: "shape:runtime-flow--node--mermaid-b", role: "node" },
      {
        semanticId: "mermaid-edge",
        shapeId: "shape:runtime-flow--edge--mermaid-edge",
        role: "edge",
      },
    ]);
    expect(
      adapter
        .read({ scope: "selection" })
        .shapes.every(({ diagramId }) => diagramId === "runtime-flow"),
    ).toBe(true);

    vi.mocked(parseMermaidToExcalidraw).mockResolvedValueOnce({
      elements: [
        {
          id: "mermaid-c",
          type: "rectangle",
          x: 0,
          y: 0,
          width: 160,
          height: 80,
          label: { text: "Replacement" },
        },
      ],
    } as never);
    const replacement = await adapter.insertMermaid("flowchart LR\n  C", {
      id: "runtime-flow",
      replace: true,
    });
    expect(replacement.mappings).toEqual([
      { semanticId: "mermaid-c", shapeId: "shape:runtime-flow--node--mermaid-c", role: "node" },
    ]);
    expect(adapter.read({ scope: "page" }).shapes.map(({ semanticId }) => semanticId)).toEqual([
      "mermaid-c",
    ]);
  });

  it("orders Mermaid backgrounds, connectors, nodes, and their bound labels", async () => {
    vi.mocked(parseMermaidToExcalidraw).mockResolvedValueOnce({
      elements: [
        {
          id: "subgraph",
          type: "rectangle",
          x: 0,
          y: 0,
          width: 500,
          height: 220,
          groupIds: ["subgraph-group"],
          label: { text: "System" },
        },
        {
          id: "node-a",
          type: "rectangle",
          x: 40,
          y: 70,
          width: 120,
          height: 80,
          groupIds: ["subgraph-group"],
          label: { text: "A" },
        },
        {
          id: "node-b",
          type: "rectangle",
          x: 340,
          y: 70,
          width: 120,
          height: 80,
          groupIds: ["subgraph-group"],
          label: { text: "B" },
        },
        {
          id: "edge",
          type: "arrow",
          x: 160,
          y: 110,
          points: [
            [0, 0],
            [180, 0],
          ],
          label: { text: "request" },
        },
      ],
    } as never);

    await adapter.insertMermaid("flowchart LR\n  subgraph System\n  A --> B\n  end");

    const elements = harness.elements();
    const background = elements.find(
      (element) =>
        element.type === "rectangle" &&
        element.customData?.cakeAutoSizeText === true &&
        element.groupIds.includes("subgraph-group"),
    )!;
    const title = elements.find(
      (element): element is Extract<ExcalidrawElement, { type: "text" }> =>
        element.type === "text" && element.originalText === "System",
    )!;
    const nodes = elements.filter(
      (element) => element.type === "rectangle" && element.id !== background.id,
    );
    expect(title.containerId).toBeNull();
    expect(title.y + title.height).toBeLessThan(Math.min(...nodes.map(({ y }) => y)));
    expect(background.y).toBeLessThanOrEqual(title.y);
    expect(background.y + background.height).toBeGreaterThan(
      Math.max(...nodes.map(({ y, height }) => y + height)),
    );
    const order = elements.map(({ id }) => id);
    const arrow = elements.find(({ type }) => type === "arrow")!;
    expect(order.indexOf(background.id)).toBeLessThan(order.indexOf(arrow.id));
    expect(nodes.every(({ id }) => order.indexOf(arrow.id) < order.indexOf(id))).toBe(true);
  });

  it("assigns shape IDs, preserves every binding, and supports read-to-apply edits", async () => {
    vi.mocked(parseMermaidToExcalidraw).mockResolvedValue({
      elements: [
        {
          id: "source",
          type: "rectangle",
          x: 0,
          y: 0,
          width: 140,
          height: 70,
          label: { text: "Source" },
        },
        {
          id: "target",
          type: "rectangle",
          x: 280,
          y: 0,
          width: 140,
          height: 70,
          label: { text: "Target" },
        },
        {
          id: "edge",
          type: "arrow",
          x: 140,
          y: 35,
          points: [
            [0, 0],
            [140, 0],
          ],
          start: { id: "source" },
          end: { id: "target" },
        },
      ],
    } as never);

    await adapter.insertMermaid("flowchart LR\n  source --> target");

    const imported = harness.elements();
    expect(imported.every(({ id }) => /^shape:[A-Za-z0-9_-]+$/.test(id))).toBe(true);
    const ids = new Set(imported.map(({ id }) => id));
    for (const element of imported) {
      expect(element.boundElements?.every(({ id }) => ids.has(id)) ?? true).toBe(true);
      if (element.type === "text" && element.containerId)
        expect(ids.has(element.containerId)).toBe(true);
      if (element.type === "arrow") {
        if (element.startBinding) expect(ids.has(element.startBinding.elementId)).toBe(true);
        if (element.endBinding) expect(ids.has(element.endBinding.elementId)).toBe(true);
      }
    }

    const scene = adapter.read({ scope: "page" });
    const rectangles = scene.shapes.filter(({ type }) => type === "rectangle");
    const arrow = scene.shapes.find(({ type }) => type === "arrow")!;
    const importedOrder = harness.elements().map(({ id }) => id);
    expect(importedOrder.indexOf(arrow.id)).toBeLessThan(
      Math.min(...rectangles.map(({ id }) => importedOrder.indexOf(id))),
    );
    for (const element of harness.elements()) {
      if (element.type === "text" && element.containerId)
        expect(importedOrder.indexOf(element.id)).toBe(
          importedOrder.indexOf(element.containerId) + 1,
        );
    }
    const source = rectangles.find(({ text }) => text === "Source")!;
    const target = rectangles.find(({ text }) => text === "Target")!;
    const receipt = adapter.apply({
      operations: [
        { type: "update", id: source.id, text: "Edited source" },
        { type: "move", ids: [target.id], deltaX: 50, deltaY: 20 },
        { type: "style", ids: [arrow.id], style: { strokeColor: "blue" } },
      ],
    });

    expect(new Set(receipt.updatedIds)).toEqual(new Set([source.id, target.id, arrow.id]));
    expect(adapter.read({ scope: "page" }).shapes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: source.id, text: "Edited source" }),
        expect.objectContaining({
          id: arrow.id,
          style: expect.objectContaining({ strokeColor: "#1971c2" }),
        }),
      ]),
    );
    expect(() =>
      adapter.apply({ operations: [{ type: "delete", ids: [source.id, target.id, arrow.id] }] }),
    ).not.toThrow();
  });

  it("normalizes safe HTML breaks, fits converted labels, and rejects other HTML", async () => {
    vi.mocked(parseMermaidToExcalidraw).mockResolvedValue({
      elements: [
        {
          id: "labelled",
          type: "rectangle",
          x: 0,
          y: 0,
          width: 40,
          height: 20,
          label: { text: "First\\nSecond line" },
        },
      ],
    } as never);

    await adapter.insertMermaid('flowchart LR\n  A["First<br/>Second line"]');

    expect(parseMermaidToExcalidraw).toHaveBeenCalledWith(
      'flowchart LR\n  A["First\\nSecond line"]',
      expect.anything(),
    );
    const container = harness.elements().find(({ type }) => type === "rectangle")!;
    const label = harness
      .elements()
      .find(
        (element): element is Extract<ExcalidrawElement, { type: "text" }> =>
          element.type === "text" && element.containerId === container.id,
      )!;
    expect(label.text).toBe("First\nSecond line");
    expect(container.width).toBeGreaterThanOrEqual(label.width + 24);
    expect(container.height).toBeGreaterThanOrEqual(label.height + 16);

    await expect(
      adapter.insertMermaid('flowchart LR\n  A["<strong>Unsafe</strong>"]'),
    ).rejects.toThrow("other HTML markup is not supported");
  });

  it("reflows Mermaid siblings after measured labels widen their containers", async () => {
    vi.mocked(parseMermaidToExcalidraw).mockResolvedValueOnce({
      elements: [
        {
          id: "left",
          type: "rectangle",
          x: 0,
          y: 0,
          width: 100,
          height: 60,
          label: { text: "Short" },
        },
        {
          id: "right",
          type: "rectangle",
          x: 150,
          y: 0,
          width: 100,
          height: 60,
          label: {
            text: "A substantially longer sibling label that exceeds the converter skeleton width",
          },
        },
      ],
    } as never);

    await adapter.insertMermaid("flowchart LR\n  A[Short] ~~~ B[Long label]");

    const nodes = harness.elements().filter((element) => element.type === "rectangle");
    expect(nodes).toHaveLength(2);
    const [left, right] = nodes.sort((a, b) => a.x - b.x);
    expect(left!.x + left!.width + 96).toBeLessThanOrEqual(right!.x);
    const rightLabel = harness
      .elements()
      .find((element) => element.type === "text" && element.containerId === right!.id);
    expect(right!.width).toBeGreaterThan(100);
    expect(rightLabel?.width).toBeLessThan(right!.width);
  });

  it("places a new Mermaid diagram away from existing content", async () => {
    adapter.apply({
      operations: [
        {
          type: "create",
          shape: { id: "existing", type: "geo", x: 300, y: 250, width: 200, height: 100 },
        },
      ],
    });

    await adapter.insertMermaid("flowchart LR\n  A --> B");

    const existing = adapter
      .read({ scope: "page" })
      .shapes.find(({ id }) => id === "shape:existing")!;
    const imported = adapter
      .read({ scope: "page" })
      .shapes.filter(({ id }) => id !== "shape:existing");
    const existingBounds = existing.bounds!;
    const overlapsExisting = imported.some(({ bounds }) =>
      bounds
        ? bounds.x < existingBounds.x + existingBounds.width + 80 &&
          bounds.x + bounds.width + 80 > existingBounds.x &&
          bounds.y < existingBounds.y + existingBounds.height + 80 &&
          bounds.y + bounds.height + 80 > existingBounds.y
        : false,
    );
    expect(overlapsExisting).toBe(false);
  });

  it("orders Mermaid subgraph backgrounds, connectors, nodes, and labels by visual role", async () => {
    vi.mocked(parseMermaidToExcalidraw).mockResolvedValue({
      elements: [
        {
          id: "frame",
          type: "frame",
          x: -30,
          y: -30,
          width: 560,
          height: 300,
          children: ["cluster", "left", "right", "edge"],
        },
        {
          id: "cluster",
          type: "rectangle",
          x: 0,
          y: 0,
          width: 500,
          height: 240,
          groupIds: ["subgraph_group_cluster"],
          label: { text: "Services", verticalAlign: "top" },
        },
        {
          id: "left",
          type: "rectangle",
          x: 60,
          y: 80,
          width: 120,
          height: 70,
          groupIds: ["subgraph_group_cluster"],
          label: { text: "API" },
        },
        {
          id: "right",
          type: "rectangle",
          x: 320,
          y: 80,
          width: 120,
          height: 70,
          groupIds: ["subgraph_group_cluster"],
          label: { text: "Worker" },
        },
        {
          id: "edge",
          type: "arrow",
          x: 180,
          y: 115,
          points: [
            [0, 0],
            [140, 0],
          ],
          start: { id: "left" },
          end: { id: "right" },
          label: { text: "dispatch" },
        },
      ],
    } as never);

    await adapter.insertMermaid("flowchart LR\n  subgraph Services\n  API --> Worker\n  end");

    const elements = harness.elements();
    const background = elements.find(
      (element) =>
        element.type === "rectangle" && element.groupIds.includes("subgraph_group_cluster"),
    )!;
    const frame = elements.find((element) => element.type === "frame")!;
    const connector = elements.find((element) => element.type === "arrow")!;
    const nodes = elements.filter(
      (element) => element.type === "rectangle" && element.id !== background.id,
    );
    const order = elements.map(({ id }) => id);
    expect(order.indexOf(frame.id)).toBeLessThan(order.indexOf(connector.id));
    expect(order.indexOf(background.id)).toBeLessThan(order.indexOf(connector.id));
    expect(nodes.every(({ id }) => order.indexOf(connector.id) < order.indexOf(id))).toBe(true);
    for (const element of elements) {
      if (element.type === "text" && element.containerId)
        expect(order.indexOf(element.id)).toBe(order.indexOf(element.containerId) + 1);
    }
    expect(
      connector.type === "arrow" && connector.startBinding && connector.endBinding,
    ).toBeTruthy();
    expect(background.boundElements?.every(({ id }) => order.includes(id))).toBe(true);
    expect(
      elements
        .filter(({ frameId }) => frameId === frame.id)
        .every(({ id }) => id !== frame.id && order.includes(id)),
    ).toBe(true);
  });

  it("separates coincident parallel Mermaid connectors deterministically", async () => {
    vi.mocked(parseMermaidToExcalidraw).mockResolvedValue({
      elements: [
        { id: "left", type: "rectangle", x: 0, y: 0, width: 100, height: 60 },
        { id: "right", type: "rectangle", x: 300, y: 0, width: 100, height: 60 },
        ...["first", "second"].map((id) => ({
          id,
          type: "arrow" as const,
          x: 100,
          y: 30,
          points: [
            [0, 0],
            [200, 0],
          ],
          start: { id: "left" },
          end: { id: "right" },
        })),
      ],
    } as never);

    await adapter.insertMermaid("flowchart LR\n  A --> B\n  A --> B");

    const arrows = harness
      .elements()
      .filter(
        (element): element is Extract<ExcalidrawElement, { type: "arrow" }> =>
          element.type === "arrow",
      );
    expect(arrows).toHaveLength(2);
    expect(arrows[0]!.points).not.toEqual(arrows[1]!.points);
    expect(arrows.every(({ points }) => points.length === 4)).toBe(true);
  });

  it("rejects Mermaid diagram kinds that only convert to an image", async () => {
    vi.mocked(parseMermaidToExcalidraw).mockResolvedValue({
      elements: [{ type: "image", x: 0, y: 0, width: 100, height: 100 }],
      files: { image: {} },
    } as never);

    await expect(adapter.insertMermaid("pie\n  title Unsupported")).rejects.toThrow(
      "cannot be converted to native editable shapes",
    );
    expect(harness.elements()).toHaveLength(0);
  });

  it("reflows fixed and auto-sized generated text after edits and typography changes", () => {
    adapter.apply({
      operations: [
        {
          type: "create",
          shape: {
            id: "shape:narrow",
            type: "geo",
            x: 0,
            y: 0,
            width: 140,
            height: 50,
            text: "A long fixed-width label that must wrap onto several lines",
          },
        },
        {
          type: "create",
          shape: {
            id: "shape:standalone",
            type: "text",
            x: 250,
            y: 0,
            text: "Standalone generated text with deterministic bounded auto sizing ".repeat(8),
          },
        },
        {
          type: "create",
          shape: {
            id: "shape:note",
            type: "note",
            x: 900,
            y: 0,
            text: "A generated note with enough content to require deterministic wrapping and vertical growth ".repeat(
              4,
            ),
          },
        },
      ],
    });
    adapter.apply({
      operations: [
        {
          type: "style",
          ids: ["shape:narrow", "shape:standalone"],
          style: { fontSize: 36, fontFamily: "monospace" },
        },
        {
          type: "update",
          id: "shape:narrow",
          text: "Updated\nmultiline label with a much larger font",
        },
      ],
    });

    const narrow = harness.elements().find(({ id }) => id === "shape:narrow")!;
    const narrowLabel = harness
      .elements()
      .find((element) => element.type === "text" && element.containerId === narrow.id) as Extract<
      ExcalidrawElement,
      { type: "text" }
    >;
    expect(narrowLabel.text).toContain("\n");
    expect(narrowLabel.width).toBeLessThanOrEqual(narrow.width - 48);
    expect(narrow.height).toBeGreaterThanOrEqual(narrowLabel.height + 32);
    const standalone = harness.elements().find(({ id }) => id === "shape:standalone") as Extract<
      ExcalidrawElement,
      { type: "text" }
    >;
    expect(standalone.width).toBeLessThanOrEqual(600);
    expect(standalone.height).toBeGreaterThan(standalone.fontSize);
    const note = harness.elements().find(({ id }) => id === "shape:note")!;
    const noteLabel = harness
      .elements()
      .find((element) => element.type === "text" && element.containerId === note.id) as Extract<
      ExcalidrawElement,
      { type: "text" }
    >;
    expect(noteLabel.text).toContain("\n");
    expect(noteLabel.width).toBeLessThan(note.width);
    expect(note.height).toBeGreaterThan(200);
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
    const order = harness.elements().map(({ id }) => id);
    expect(order.indexOf("shape:link")).toBeLessThan(order.indexOf("shape:left"));
    expect(order.indexOf("shape:link")).toBeLessThan(order.indexOf("shape:right"));
    const linkLabel = harness
      .elements()
      .find((element) => element.type === "text" && element.containerId === "shape:link");
    expect(order.indexOf(linkLabel!.id)).toBe(order.indexOf("shape:link") + 1);
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

  it("routes orthogonal connectors around intervening nodes and preserves ports after moves", () => {
    adapter.apply({
      operations: [
        {
          type: "create",
          shape: { id: "left", type: "geo", x: 0, y: 100, width: 100, height: 80 },
        },
        {
          type: "create",
          shape: { id: "blocker", type: "geo", x: 180, y: 80, width: 120, height: 120 },
        },
        {
          type: "create",
          shape: { id: "right", type: "geo", x: 400, y: 100, width: 100, height: 80 },
        },
        {
          type: "connect",
          id: "route",
          fromId: "left",
          toId: "right",
          fromPort: "right",
          toPort: "left",
          routing: "orthogonal",
        },
      ],
    });
    const before = harness
      .elements()
      .find(
        (element): element is Extract<ExcalidrawElement, { type: "arrow" }> =>
          element.id === "shape:route" && element.type === "arrow",
      )!;
    expect(before.points).toHaveLength(4);
    expect(Math.min(...before.points.map(([, y]) => before.y + y))).toBeLessThan(80);
    expect(before.x).toBe(100);

    adapter.apply({ operations: [{ type: "move", ids: ["right"], deltaX: 100, deltaY: 80 }] });
    const after = harness
      .elements()
      .find(
        (element): element is Extract<ExcalidrawElement, { type: "arrow" }> =>
          element.id === "shape:route" && element.type === "arrow",
      )!;
    expect(after.points.at(-1)?.[0]).toBeGreaterThan(before.points.at(-1)?.[0] ?? 0);
    expect(after.startBinding?.elementId).toBe("shape:left");
    expect(after.endBinding?.elementId).toBe("shape:right");
  });

  it.each(["below", "right"] as const)(
    "keeps visible arrowhead directions when connecting aligned ports %s",
    (side) => {
      adapter.apply({
        operations: [
          {
            type: "create",
            shape: { id: "from", type: "geo", x: 0, y: 0, width: 220, height: 100 },
          },
          {
            type: "create-relative",
            shape: {
              id: "to",
              type: "geo",
              width: 220,
              height: 100,
              placement: { relativeTo: "from", side, gap: 100 },
            },
          },
          { type: "connect", id: "link", fromId: "from", toId: "to", routing: "orthogonal" },
          { type: "style", ids: ["link"], style: { startArrowhead: "arrow" } },
        ],
      });
      const arrow = harness.elements().find((element) => element.type === "arrow")!;
      if (arrow.type !== "arrow") throw new Error("Expected an arrow");
      expect(arrow.points[0]).toEqual([0, 0]);
      expect(arrow.points.at(-1)).toEqual(side === "below" ? [0, 100] : [100, 0]);
      expect(arrow.points[0]).not.toEqual(arrow.points[1]);
      expect(arrow.points.at(-1)).not.toEqual(arrow.points.at(-2));
      expect([arrow.startArrowhead, arrow.endArrowhead]).toEqual(["arrow", "arrow"]);
    },
  );

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
      ["shape:link", "shape:left", "shape:right"],
    ]);
  });

  it("layers same-batch connectors behind nodes independent of creation order", () => {
    adapter.apply({
      operations: [
        {
          type: "create",
          shape: {
            id: "arrow-first",
            type: "arrow",
            x: 20,
            y: 70,
            endX: 420,
            endY: 70,
            text: "visible edge label",
          },
        },
        {
          type: "create",
          shape: {
            id: "left",
            type: "geo",
            x: 0,
            y: 20,
            width: 140,
            height: 100,
            text: "Left",
            fill: "solid",
          },
        },
        {
          type: "create-relative",
          shape: {
            id: "right",
            type: "geo",
            width: 140,
            height: 100,
            text: "Right",
            fill: "solid",
            placement: { relativeTo: "left", side: "right", gap: 120 },
          },
        },
      ],
    });

    const elements = harness.elements();
    const arrowIndex = elements.findIndex(({ id }) => id === "shape:arrow-first");
    const arrowLabelIndex = elements.findIndex(
      (element) => element.type === "text" && element.containerId === "shape:arrow-first",
    );
    const leftIndex = elements.findIndex(({ id }) => id === "shape:left");
    const rightIndex = elements.findIndex(({ id }) => id === "shape:right");
    expect(arrowIndex).toBe(0);
    expect(arrowLabelIndex).toBe(arrowIndex + 1);
    expect(leftIndex).toBeGreaterThan(arrowLabelIndex);
    expect(rightIndex).toBeGreaterThan(arrowLabelIndex);
  });

  it("places new connections without reordering pre-existing artwork", () => {
    adapter.apply({
      operations: [
        {
          type: "create",
          shape: { id: "old-a", type: "geo", x: 0, y: 0, width: 100, height: 80 },
        },
        {
          type: "create",
          shape: { id: "old-b", type: "geo", x: 400, y: 0, width: 100, height: 80 },
        },
        { type: "bring-to-front", ids: ["old-a"] },
      ],
    });
    const oldOrder = harness
      .elements()
      .filter(({ id }) => id === "shape:old-a" || id === "shape:old-b")
      .map(({ id }) => id);

    adapter.apply({
      operations: [
        { type: "connect", id: "new-edge", fromId: "old-a", toId: "old-b", text: "flow" },
      ],
    });

    const elements = harness.elements();
    expect(
      elements.filter(({ id }) => id === "shape:old-a" || id === "shape:old-b").map(({ id }) => id),
    ).toEqual(oldOrder);
    const edgeIndex = elements.findIndex(({ id }) => id === "shape:new-edge");
    const edgeLabelIndex = elements.findIndex(
      (element) => element.type === "text" && element.containerId === "shape:new-edge",
    );
    expect(edgeIndex).toBeLessThan(elements.findIndex(({ id }) => id === oldOrder[0]));
    expect(edgeLabelIndex).toBe(edgeIndex + 1);
    expect(elements.find(({ id }) => id === "shape:old-a")?.boundElements).toContainEqual({
      id: "shape:new-edge",
      type: "arrow",
    });
  });

  it("creates standalone line and arrow elements", () => {
    adapter.apply({
      operations: [
        {
          type: "create",
          shape: {
            id: "node",
            type: "geo",
            x: 140,
            y: 10,
            width: 120,
            height: 90,
            fill: "solid",
          },
        },
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
    const order = harness.elements().map(({ id }) => id);
    expect(order.indexOf("shape:line")).toBeLessThan(order.indexOf("shape:node"));
    expect(order.indexOf("shape:arrow")).toBeLessThan(order.indexOf("shape:node"));
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
      height: expect.any(Number),
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
      bounds: { x: 80, y: 100, width: 280, height: expect.any(Number) },
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
    expect(summary?.bounds?.height).toBeGreaterThanOrEqual(140);
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

  it("fits explicit zoom targets synchronously before returning", () => {
    adapter.apply({
      operations: [
        {
          type: "create",
          shape: { id: "near", type: "geo", x: 0, y: 0, width: 80, height: 60 },
        },
        {
          type: "create",
          shape: { id: "far", type: "geo", x: 2_000, y: 0, width: 80, height: 60 },
        },
        { type: "zoom-to", ids: ["near", "far"] },
      ],
    });

    expect(harness.api.scrollToContent).toHaveBeenCalledWith(harness.elements(), {
      animate: false,
      fitToViewport: true,
      viewportZoomFactor: 0.85,
      maxZoom: 1,
    });
  });

  it("fits the whole animated batch, including labels, rather than the last styled arrow", async () => {
    await adapter.applyAnimated(
      {
        operations: [
          {
            type: "create",
            shape: { id: "left", type: "geo", x: 0, y: 0, width: 240, height: 120, text: "Cake" },
          },
          {
            type: "create-relative",
            shape: {
              id: "right",
              type: "geo",
              width: 240,
              height: 120,
              text: "Pi",
              placement: { relativeTo: "left", side: "right", gap: 300 },
            },
          },
          { type: "connect", id: "link", fromId: "left", toId: "right", text: "calls" },
          { type: "style", ids: ["link"], style: { startArrowhead: "arrow" } },
        ],
      },
      { stepDelayMs: 0 },
    );
    expect(harness.api.scrollToContent).toHaveBeenLastCalledWith(harness.elements(), {
      animate: false,
      fitToViewport: true,
      viewportZoomFactor: 0.85,
      maxZoom: 1,
    });
  });

  it("includes existing connector endpoints but excludes unrelated artwork from automatic fitting", async () => {
    adapter.apply({
      operations: [
        { type: "create", shape: { id: "left", type: "geo", x: 0, y: 0, width: 120, height: 80 } },
        {
          type: "create",
          shape: { id: "right", type: "geo", x: 800, y: 0, width: 120, height: 80 },
        },
        {
          type: "create",
          shape: { id: "unrelated", type: "geo", x: 10000, y: 0, width: 120, height: 80 },
        },
      ],
    });
    await adapter.applyAnimated({
      operations: [{ type: "connect", id: "link", fromId: "left", toId: "right" }],
    });
    const fitted = vi.mocked(harness.api.scrollToContent).mock.lastCall![0] as ExcalidrawElement[];
    expect(fitted.map(({ id }) => id)).toEqual(["shape:link", "shape:left", "shape:right"]);
  });

  it("does not reframe a style-only batch or override explicit zoom with later styling", async () => {
    adapter.apply({
      operations: [
        { type: "create", shape: { id: "left", type: "geo", x: 0, y: 0, width: 120, height: 80 } },
      ],
    });
    vi.mocked(harness.api.scrollToContent).mockClear();
    await adapter.applyAnimated({
      operations: [{ type: "style", ids: ["left"], style: { strokeColor: "red" } }],
    });
    expect(harness.api.scrollToContent).not.toHaveBeenCalled();
    await adapter.applyAnimated(
      {
        operations: [
          {
            type: "create",
            shape: { id: "right", type: "geo", x: 800, y: 0, width: 120, height: 80 },
          },
          { type: "zoom-to", ids: ["left"] },
          { type: "style", ids: ["right"], style: { strokeColor: "blue" } },
        ],
      },
      { stepDelayMs: 0 },
    );
    expect(harness.api.scrollToContent).toHaveBeenCalledTimes(1);
    expect(harness.api.scrollToContent).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "shape:left" })],
      expect.any(Object),
    );
  });

  it("allows explicit layer operations to override the creation default", () => {
    adapter.apply({
      operations: [
        {
          type: "create",
          shape: { id: "box", type: "geo", x: 40, y: 20, width: 160, height: 100 },
        },
        {
          type: "create",
          shape: { id: "edge", type: "arrow", x: 0, y: 70, endX: 240, endY: 70, text: "edge" },
        },
        { type: "bring-to-front", ids: ["edge"] },
      ],
    });
    let elements = harness.elements();
    expect(elements.findIndex(({ id }) => id === "shape:edge")).toBeGreaterThan(
      elements.findIndex(({ id }) => id === "shape:box"),
    );
    expect(
      elements.findIndex(
        (element) => element.type === "text" && element.containerId === "shape:edge",
      ),
    ).toBe(elements.findIndex(({ id }) => id === "shape:edge") + 1);

    adapter.apply({ operations: [{ type: "send-to-back", ids: ["box"] }] });
    elements = harness.elements();
    expect(elements.findIndex(({ id }) => id === "shape:box")).toBe(0);
  });

  it("preserves normalized order across snapshots, restore, and semantic reads", () => {
    adapter.apply({
      operations: [
        {
          type: "create",
          shape: { id: "box", type: "geo", x: 20, y: 20, width: 180, height: 100, text: "Box" },
        },
        {
          type: "create",
          shape: {
            id: "edge",
            type: "arrow",
            x: 0,
            y: 70,
            endX: 240,
            endY: 70,
            text: "Readable",
          },
        },
      ],
    });
    const before = adapter.read({ scope: "page" });
    const snapshot = adapter.snapshotDocument();
    const second = editorHarness();
    const restoredAdapter = createDrawEditorAdapter(second.api);
    restoredAdapter.loadDocument(snapshot);

    expect(second.elements().map(({ id }) => id)).toEqual(harness.elements().map(({ id }) => id));
    expect(restoredAdapter.read({ scope: "page" })).toEqual(before);
    expect(second.elements().findIndex(({ id }) => id === "shape:edge")).toBeLessThan(
      second.elements().findIndex(({ id }) => id === "shape:box"),
    );
  });

  it("persists and restores the actual canvas viewport", () => {
    harness.setAppState({
      scrollX: -3_200,
      scrollY: 480,
      zoom: { value: 0.65 } as AppState["zoom"],
    });
    const snapshot = adapter.snapshotDocument();
    const second = editorHarness();

    createDrawEditorAdapter(second.api).loadDocument(snapshot);

    expect(second.api.getAppState()).toMatchObject({
      scrollX: -3_200,
      scrollY: 480,
      zoom: { value: 0.65 },
    });
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

  it("automatically downscales page renders to the requested maximum size", async () => {
    adapter.apply({
      operations: [
        {
          type: "create",
          shape: {
            id: "shape:wide",
            type: "geo",
            x: 0,
            y: 0,
            width: 8_000,
            height: 4_000,
          },
        },
      ],
    });

    const render = await adapter.render({
      scope: "page",
      format: "svg",
      scale: 2,
      maxSize: { width: 800, height: 600 },
    });
    expect(render.width).toBeLessThanOrEqual(800);
    expect(render.height).toBeLessThanOrEqual(600);
    expect(render.data).toContain(`width="${render.width}"`);
    expect(render.data).toContain(`height="${render.height}"`);
  });

  it("uses pane-local bounds for an offset, scrolled, zoomed viewport", async () => {
    harness.setAppState({
      offsetLeft: 300,
      offsetTop: 100,
      scrollX: -100,
      scrollY: -50,
      zoom: { value: 0.5 } as AppState["zoom"],
    });
    adapter.apply({
      operations: [
        {
          type: "create",
          shape: { id: "visible", type: "geo", x: 1600, y: 1100, width: 50, height: 50 },
        },
        {
          type: "create",
          shape: { id: "outside", type: "geo", x: -300, y: -100, width: 50, height: 50 },
        },
      ],
    });
    const scene = adapter.read({ scope: "viewport" });
    expect(scene.viewportBounds).toEqual({ x: 100, y: 50, width: 1600, height: 1200 });
    expect(scene.shapes.map(({ id }) => id)).toEqual(["shape:visible"]);
    await adapter.clear();
    await adapter.insertMermaid("flowchart LR\n  A --> B");
    const { getCommonBounds } = await import("@excalidraw/excalidraw");
    const [left, top, right, bottom] = getCommonBounds(
      harness.elements().filter((element) => !element.isDeleted),
    );
    expect((left + right) / 2).toBe(900);
    expect((top + bottom) / 2).toBe(650);
  });

  it("renders a clipped viewport at screen scale instead of fitting intersecting shapes", async () => {
    harness.setAppState({
      offsetLeft: 300,
      offsetTop: 100,
      scrollX: -100,
      zoom: { value: 0.5 } as AppState["zoom"],
    });
    adapter.apply({
      operations: [
        {
          type: "create",
          shape: { id: "wide", type: "geo", x: -500, y: 0, width: 3000, height: 400 },
        },
      ],
    });
    const before = adapter.snapshotDocument();
    const render = await adapter.render({ scope: "viewport", format: "svg" });
    expect(render.width).toBe(800);
    expect(render.height).toBe(600);
    expect(render.data).toContain('viewBox="0 0 1600 1200"');
    expect(adapter.snapshotDocument()).toEqual(before);
    const small = await adapter.render({
      scope: "viewport",
      format: "svg",
      scale: 2,
      maxSize: { width: 400, height: 400 },
    });
    expect([small.width, small.height]).toEqual([400, 300]);
  });

  it("renders an empty viewport without substituting page content", async () => {
    const empty = await adapter.render({ scope: "viewport", format: "svg" });
    expect([empty.width, empty.height]).toEqual([800, 600]);
    adapter.apply({
      operations: [
        {
          type: "create",
          shape: { id: "offscreen", type: "geo", x: 10000, y: 10000, width: 80, height: 80 },
        },
      ],
    });
    const offscreen = await adapter.render({ scope: "viewport", format: "svg" });
    expect([offscreen.width, offscreen.height]).toEqual([800, 600]);
    expect(offscreen.data).not.toContain("translate(10000");
    await expect(adapter.render({ scope: "selection", format: "svg" })).rejects.toThrow(
      "There are no shapes",
    );
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

  it("creates, reads, updates, removes, persists, and exports Cake source links", () => {
    adapter.apply({
      operations: [
        {
          type: "create",
          shape: {
            id: "linked",
            type: "geo",
            x: 10,
            y: 10,
            width: 80,
            height: 60,
            text: "Implementation",
            sourceLink: {
              path: "src/implementation.ts",
              range: { start: { line: 10 }, end: { line: 14 } },
            },
          },
        },
      ],
    });

    expect(adapter.read({ scope: "page" }).shapes[0]?.sourceLink).toEqual({
      path: "src/implementation.ts",
      range: { start: { line: 10 }, end: { line: 14 } },
    });
    expect(harness.elements().find(({ id }) => id === "shape:linked")?.link).toContain(
      "https://cake.invalid/draw/source?",
    );

    const snapshot = adapter.snapshotDocument();
    const exported = JSON.parse(adapter.exportDocument());
    expect(JSON.stringify(snapshot)).toContain("cake.invalid/draw/source");
    expect(JSON.stringify(exported)).toContain("cake.invalid/draw/source");

    const restored = editorHarness();
    const restoredAdapter = createDrawEditorAdapter(restored.api);
    restoredAdapter.loadDocument(snapshot);
    expect(restoredAdapter.read({ scope: "page" }).shapes[0]?.sourceLink?.path).toBe(
      "src/implementation.ts",
    );

    adapter.apply({
      operations: [{ type: "update", id: "linked", sourceLink: { path: "src/replacement.ts" } }],
    });
    expect(adapter.read({ scope: "page" }).shapes[0]?.sourceLink).toEqual({
      path: "src/replacement.ts",
    });

    adapter.apply({ operations: [{ type: "update", id: "linked", sourceLink: null }] });
    expect(adapter.read({ scope: "page" }).shapes[0]?.sourceLink).toBeUndefined();
    expect(harness.elements().find(({ id }) => id === "shape:linked")?.link).toBeNull();
  });

  it("serializes a native editable Excalidraw document rather than Cake persistence", () => {
    adapter.apply({
      operations: [
        {
          type: "create",
          shape: { id: "editable", type: "geo", x: 10, y: 10, width: 80, height: 60 },
        },
      ],
    });
    harness.api.addFiles([
      {
        id: "file:export" as never,
        dataURL: "data:image/png;base64,iVBORw0KGgo=" as never,
        mimeType: "image/png",
        created: 1,
      },
    ]);
    harness.setElements([
      ...harness.elements(),
      {
        id: "image:export",
        type: "image",
        x: 120,
        y: 10,
        width: 40,
        height: 40,
        angle: 0,
        strokeColor: "transparent",
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: 1,
        strokeStyle: "solid",
        roughness: 0,
        opacity: 100,
        groupIds: [],
        frameId: null,
        index: "a1",
        roundness: null,
        seed: 1,
        version: 1,
        versionNonce: 1,
        isDeleted: false,
        boundElements: null,
        updated: 1,
        link: null,
        locked: false,
        fileId: "file:export",
        status: "saved",
        scale: [1, 1],
        crop: null,
      } as unknown as ExcalidrawElement,
    ]);

    const document = JSON.parse(adapter.exportDocument());

    expect(document).toMatchObject({
      type: "excalidraw",
      version: 2,
      elements: [
        expect.objectContaining({ id: "shape:editable" }),
        expect.objectContaining({ id: "image:export", fileId: "file:export" }),
      ],
      appState: expect.objectContaining({ viewBackgroundColor: "#ffffff" }),
      files: { "file:export": expect.objectContaining({ mimeType: "image/png" }) },
    });
    expect(document.type).not.toBe("cake-excalidraw");
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
