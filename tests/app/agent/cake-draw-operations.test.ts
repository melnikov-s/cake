import { describe, expect, it, vi } from "vitest";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
import { createCakeToolDefinition } from "../../../src/services/pi/runtime/cake-runtime-capabilities";
import {
  createCakeDrawOperations,
  type CakeDrawControl,
} from "../../../src/services/pi/runtime/cake-draw-operations";

const tinyPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const scene = {
  pageId: "page:default",
  viewportBounds: { x: 0, y: 0, width: 800, height: 600 },
  selectedShapeIds: [],
  shapes: [],
  truncated: false,
};

const board = {
  id: "00000000-0000-4000-8000-000000000001",
  sessionId: "caller-session",
  title: "Board 1",
  revision: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function context() {
  return {
    signal: new AbortController().signal,
    toolCallId: "draw-call",
    runtime: {},
  };
}

function control(overrides: Partial<CakeDrawControl> = {}): CakeDrawControl {
  return {
    list: vi.fn(async () => [board]),
    create: vi.fn(async (title) => ({ ...board, title })),
    open: vi.fn<CakeDrawControl["open"]>(async () => ({
      ok: true,
      kind: "opened",
      board,
      scene,
    })),
    request: vi.fn<CakeDrawControl["request"]>(async (invocation) => {
      if (invocation._tag === "Enter") return { ok: true, kind: "entered", board, scene };
      if (invocation._tag === "Render")
        return {
          ok: true,
          kind: "rendered",
          boardId: board.id,
          render: {
            format: "png",
            mediaType: "image/png",
            width: 32,
            height: 16,
            data: `data:image/png;base64,${tinyPng}`,
          },
        };
      if (invocation._tag === "Apply")
        return {
          ok: true,
          kind: "applied",
          boardId: board.id,
          receipt: { createdIds: ["shape:one"], updatedIds: [], deletedIds: [] },
          scene,
        };
      if (invocation._tag === "Mermaid")
        return {
          ok: true,
          kind: "mermaid",
          boardId: board.id,
          elementCount: 5,
          scene,
        };
      return {
        ok: false,
        code: "DRAW_MODE_REQUIRED",
        message: "Enter Cake Draw for this Project Session, then retry.",
      };
    }),
    exportFile: vi.fn(async (path, content) => ({ path, bytes: content.byteLength })),
    canMutate: () => true,
    ...overrides,
  };
}

describe("Cake Draw operations", () => {
  it("progressively discloses explicit draw operations", async () => {
    const registry = new CakeOperationRegistry(createCakeDrawOperations(control()));
    expect(registry.help()).toContain("draw —");
    expect(registry.help()).not.toContain("draw.apply");
    const help = await registry.invoke({ command: "draw" }, context());
    expect(help.text).toContain("draw.enter");
    expect(help.text).toContain("draw.list");
    expect(help.text).toContain("draw.apply");
    expect(help.text).toContain("draw.export");
    expect(help.text).toContain("draw.mermaid");
    expect(help.text).toContain("Prefer draw.mermaid for architecture");
    expect(help.text).toContain("one visible stage of at most 8 operations");
    expect(help.text).toContain("draw.read or draw.render between major stages");
    expect(help.text).toContain("update changes position, size, endpoints");
    expect(help.text).toContain("style applies colors, fill, stroke");
    expect(help.text).toContain("set-locked");
    expect(help.text).toContain('"backgroundColor"');
    expect(help.text).toContain('"fontFamily"');
    expect(help.text).toContain('"format"');
    expect(help.text).toContain('"path"');
    expect(help.text).toContain("An existing target file is replaced");
    expect(help.text).toContain("does not publish an artifact");
  });

  it("keeps caller identity out of the board metadata input", async () => {
    const fake = control();
    const registry = new CakeOperationRegistry(createCakeDrawOperations(fake));
    await registry.invoke({ command: "draw.list", input: {} }, context());
    expect(fake.list).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(registry.topicHelp("draw")).not.toContain('"sessionId"');
  });

  it("routes open, read, and apply to the explicit board without silently switching", async () => {
    const fake = control();
    const registry = new CakeOperationRegistry(createCakeDrawOperations(fake));
    await registry.invoke({ command: "draw.open", input: { boardId: board.id } }, context());
    await registry
      .invoke({ command: "draw.read", input: { boardId: board.id, scope: "page" } }, context())
      .catch(() => undefined);
    const applyResult = await registry.invoke(
      {
        command: "draw.apply",
        input: {
          boardId: board.id,
          operations: [{ type: "connect", fromId: "shape:one", toId: "shape:two", text: "flow" }],
        },
      },
      context(),
    );
    expect(fake.open).toHaveBeenCalledWith(board.id, expect.any(AbortSignal));
    expect(fake.request).toHaveBeenCalledWith(
      { _tag: "Read", boardId: board.id, scope: "page" },
      expect.any(AbortSignal),
    );
    expect(fake.request).toHaveBeenCalledWith(
      {
        _tag: "Apply",
        boardId: board.id,
        operations: [{ type: "connect", fromId: "shape:one", toId: "shape:two", text: "flow" }],
      },
      expect.any(AbortSignal),
    );
    expect(applyResult.details).toMatchObject({
      result: {
        boardId: board.id,
        receipt: { createdIds: ["shape:one"], updatedIds: [], deletedIds: [] },
      },
    });
    expect(JSON.stringify(applyResult.details)).not.toContain('"scene"');
  });

  it("converts Mermaid through one explicit renderer request", async () => {
    const fake = control();
    const registry = new CakeOperationRegistry(createCakeDrawOperations(fake));
    const diagram = "flowchart LR\n  A --> B";

    const result = await registry.invoke(
      { command: "draw.mermaid", input: { boardId: board.id, diagram } },
      context(),
    );

    expect(fake.request).toHaveBeenCalledWith(
      { _tag: "Mermaid", boardId: board.id, diagram },
      expect.any(AbortSignal),
    );
    expect(result.details).toMatchObject({
      result: { boardId: board.id, elementCount: 5 },
    });
    expect(JSON.stringify(result.details)).not.toContain(diagram);
  });

  it("accepts bounded in-place geometry, style, selection, and locking edits", async () => {
    const fake = control();
    const registry = new CakeOperationRegistry(createCakeDrawOperations(fake));
    const operations = [
      {
        type: "update" as const,
        id: "shape:card",
        width: 320,
        height: 180,
        geo: "diamond" as const,
      },
      {
        type: "style" as const,
        ids: ["shape:card"],
        style: {
          strokeColor: "blue",
          backgroundColor: "#dbeafe",
          fill: "solid" as const,
          fontSize: 28,
          fontFamily: "sans-serif" as const,
          textAlign: "center" as const,
        },
      },
      { type: "move" as const, ids: ["shape:card"], deltaX: 40, deltaY: -20 },
      { type: "select" as const, ids: ["shape:card"] },
      { type: "set-locked" as const, ids: ["shape:card"], locked: true },
    ];

    await registry.invoke({ command: "draw.apply", input: { operations } }, context());

    expect(fake.request).toHaveBeenCalledWith(
      { _tag: "Apply", operations },
      expect.any(AbortSignal),
    );
  });

  it("rejects invalid resize and empty style inputs at the tool boundary", async () => {
    const fake = control();
    const registry = new CakeOperationRegistry(createCakeDrawOperations(fake));

    await expect(
      registry.invoke(
        {
          command: "draw.apply",
          input: { operations: [{ type: "update", id: "shape:card", width: 0 }] },
        },
        context(),
      ),
    ).rejects.toThrow();
    await expect(
      registry.invoke(
        {
          command: "draw.apply",
          input: { operations: [{ type: "update", id: "shape:card" }] },
        },
        context(),
      ),
    ).rejects.toThrow();
    await expect(
      registry.invoke(
        {
          command: "draw.apply",
          input: { operations: [{ type: "style", ids: ["shape:card"], style: {} }] },
        },
        context(),
      ),
    ).rejects.toThrow();
    await expect(
      registry.invoke(
        {
          command: "draw.apply",
          input: {
            operations: [{ type: "style", ids: ["shape:card"], style: { fill: "gradient" } }],
          },
        },
        context(),
      ),
    ).rejects.toThrow();
    expect(fake.request).not.toHaveBeenCalled();
  });

  it("limits each visible drawing stage to eight operations", async () => {
    const fake = control();
    const registry = new CakeOperationRegistry(createCakeDrawOperations(fake));
    const operations = Array.from({ length: 9 }, (_, index) => ({
      type: "select",
      ids: [`shape:${index}`],
    }));

    await expect(
      registry.invoke({ command: "draw.apply", input: { operations } }, context()),
    ).rejects.toThrow();
    expect(fake.request).not.toHaveBeenCalled();
  });

  it("returns PNG bytes as image content without duplicating base64 in details", async () => {
    const fake = control();
    const registry = new CakeOperationRegistry(createCakeDrawOperations(fake));
    const result = await registry.invoke(
      { command: "draw.render", input: { scope: "viewport" } },
      context(),
    );
    expect(fake.request).toHaveBeenCalledWith(
      { _tag: "Render", scope: "viewport", format: "png" },
      expect.anything(),
    );
    expect(result.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining('"boardId"'),
      },
      { type: "image", mimeType: "image/png", data: tinyPng },
    ]);
    expect(JSON.stringify(result.details)).not.toContain(tinyPng);
    expect(JSON.stringify(result.details)).not.toContain("data:image/png");

    const tool = createCakeToolDefinition(createCakeDrawOperations(control()));
    const nativeResult = await tool.execute(
      "draw-render-call",
      { command: "draw.render", input: { scope: "viewport" } },
      new AbortController().signal,
      undefined,
      {} as never,
    );
    expect(nativeResult.content).toContainEqual({
      type: "image",
      mimeType: "image/png",
      data: tinyPng,
    });
    expect(JSON.stringify(nativeResult.details)).not.toContain(tinyPng);
  });

  it("rejects malformed PNG bytes before forwarding image content", async () => {
    const fake = control({
      request: vi.fn<CakeDrawControl["request"]>(async () => ({
        ok: true,
        kind: "rendered",
        boardId: board.id,
        render: {
          format: "png",
          mediaType: "image/png",
          width: 1,
          height: 1,
          data: "data:image/png;base64,aW1hZ2U=",
        },
      })),
    });
    const registry = new CakeOperationRegistry(createCakeDrawOperations(fake));
    await expect(
      registry.invoke({ command: "draw.render", input: { scope: "page" } }, context()),
    ).rejects.toThrow("malformed PNG bytes");
  });

  it("exports bounded PNG and SVG bytes through the main writer without transcript content", async () => {
    const pngControl = control();
    const pngRegistry = new CakeOperationRegistry(createCakeDrawOperations(pngControl));
    const pngResult = await pngRegistry.invoke(
      {
        command: "draw.export",
        input: { boardId: board.id, scope: "page", format: "png", path: "docs/board.png" },
      },
      context(),
    );
    expect(pngControl.request).toHaveBeenCalledWith(
      { _tag: "Render", boardId: board.id, scope: "page", format: "png" },
      expect.any(AbortSignal),
    );
    expect(pngControl.exportFile).toHaveBeenCalledWith(
      "docs/board.png",
      expect.any(Uint8Array),
      expect.any(AbortSignal),
    );
    expect(JSON.stringify(pngResult.details)).not.toContain(tinyPng);
    expect(pngResult.details).toMatchObject({
      result: {
        boardId: board.id,
        path: "docs/board.png",
        format: "png",
        overwritePolicy: "replace-existing",
      },
    });

    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>';
    const svgControl = control({
      request: vi.fn<CakeDrawControl["request"]>(async () => ({
        ok: true,
        kind: "rendered",
        boardId: board.id,
        render: {
          format: "svg",
          mediaType: "image/svg+xml",
          width: 1,
          height: 1,
          data: svg,
        },
      })),
    });
    const svgRegistry = new CakeOperationRegistry(createCakeDrawOperations(svgControl));
    const svgResult = await svgRegistry.invoke(
      { command: "draw.export", input: { format: "svg", path: "docs/board.svg" } },
      context(),
    );
    const writtenSvg = vi.mocked(svgControl.exportFile).mock.calls[0]?.[1];
    expect(writtenSvg && new TextDecoder().decode(writtenSvg)).toBe(svg);
    expect(JSON.stringify(svgResult.details)).not.toContain("<svg");
  });

  it("rejects malformed SVG before writing", async () => {
    const fake = control({
      request: vi.fn<CakeDrawControl["request"]>(async () => ({
        ok: true,
        kind: "rendered",
        boardId: board.id,
        render: {
          format: "svg",
          mediaType: "image/svg+xml",
          width: 1,
          height: 1,
          data: "<html>not svg</html>",
        },
      })),
    });
    const registry = new CakeOperationRegistry(createCakeDrawOperations(fake));
    await expect(
      registry.invoke(
        { command: "draw.export", input: { format: "svg", path: "docs/board.svg" } },
        context(),
      ),
    ).rejects.toThrow("malformed SVG source");
    expect(fake.exportFile).not.toHaveBeenCalled();
  });

  it("rejects export extension mismatches before rendering or writing", async () => {
    const fake = control();
    const registry = new CakeOperationRegistry(createCakeDrawOperations(fake));
    await expect(
      registry.invoke(
        { command: "draw.export", input: { format: "png", path: "docs/board.svg" } },
        context(),
      ),
    ).rejects.toThrow("requires a .png path");
    expect(fake.request).not.toHaveBeenCalled();
    expect(fake.exportFile).not.toHaveBeenCalled();
  });

  it("rejects resolved mutations before contacting the renderer", async () => {
    const fake = control({ canMutate: () => false });
    const registry = new CakeOperationRegistry(createCakeDrawOperations(fake));
    await expect(
      registry.invoke(
        {
          command: "draw.apply",
          input: {
            operations: [
              {
                type: "create",
                shape: { type: "note", x: 10, y: 20, text: "Blocked" },
              },
            ],
          },
        },
        context(),
      ),
    ).rejects.toThrow("SESSION_RESOLVED");
    await expect(
      registry.invoke(
        { command: "draw.mermaid", input: { diagram: "flowchart LR\nA --> B" } },
        context(),
      ),
    ).rejects.toThrow("SESSION_RESOLVED");
    expect(fake.request).not.toHaveBeenCalled();
  });
});
