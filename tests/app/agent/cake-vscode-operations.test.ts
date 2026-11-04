import { describe, expect, it, vi } from "vitest";
import { createCakeVscodeOperations } from "../../../src/domain/editor/cake-vscode-operations";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
import type { EditorLocation } from "../../../src/contracts/editor/editor-location";
import type {
  EditorSelectionId,
  EditorSelectionLocation,
  EditorSelectionState,
  EditorSelectionUpdate,
  EditorSelectionReveal,
  EditorSelectionsWriteResult,
} from "../../../src/contracts/editor/editor-selection";
import type { JsonValue } from "../../../src/contracts/serialization/json-contract";
import type { VscodeActionResult } from "../../../src/contracts/vscode/vscode-action-result";

function state(selections: EditorSelectionState["selections"] = []): EditorSelectionState {
  return { sessionId: "session-a", selections };
}

function resolvedLocation(location: EditorLocation): EditorSelectionLocation {
  if (!location.range) throw new Error("A range is required");
  if (location.kind === "absolute-file")
    return {
      kind: "absolute-file",
      view: "file",
      path: location.path,
      range: location.range,
    };
  if (location.view === "changes")
    return {
      kind: "working-directory",
      view: "changes",
      path: location.path,
      side: location.side ?? "after",
      base: location.base ?? "HEAD",
      range: location.range,
    };
  return { kind: "working-directory", view: "file", path: location.path, range: location.range };
}

const selection = (id: string, location: EditorSelectionLocation) => ({
  id: id as EditorSelectionId,
  location,
});
const source = (line: number): EditorSelectionLocation => ({
  kind: "working-directory",
  view: "file",
  path: "src/main.ts",
  range: { start: { line, column: 2 }, end: { line, column: 8 } },
});
const context = () => ({
  signal: new AbortController().signal,
  toolCallId: "selection-tool",
  runtime: {},
});

import {
  selectionEditorLocation,
  type VscodeOpenInput,
  type VscodeSelectionsInput,
} from "../../../src/contracts/editor/vscode-tool-input";
function registry() {
  const enter = vi.fn(async () => undefined);
  const open = vi.fn<
    (location: VscodeOpenInput) => Promise<VscodeActionResult<EditorSelectionReveal>>
  >(async () => ({
    status: "completed",
    value: { outcome: { view: "file" }, locations: [] },
  }));
  const write = async (
    input: VscodeSelectionsInput,
  ): Promise<VscodeActionResult<EditorSelectionsWriteResult>> => {
    const locations = input.selections.map(selectionEditorLocation).map(resolvedLocation);
    return {
      status: "completed",
      value: {
        state: state(locations.map((location, i) => selection(`selection-${i + 1}`, location))),
        selectionIds: locations.map((_, i) => `selection-${i + 1}` as EditorSelectionId),
        reveals: locations.map((location) => ({
          outcome: { view: location.view },
          locations: [location],
        })),
      },
    };
  };
  const addSelections = vi.fn(write);
  const setSelections = vi.fn(write);
  const listSelections = vi.fn(async (): Promise<EditorSelectionState> => state());
  const removeSelection = vi.fn(async (): Promise<EditorSelectionUpdate> => ({ state: state() }));
  const clearSelections = vi.fn(async (): Promise<EditorSelectionUpdate> => ({ state: state() }));
  const runScript = vi.fn(
    async (_source: string, input: JsonValue): Promise<VscodeActionResult<JsonValue>> => ({
      status: "completed",
      value: input,
    }),
  );
  const control = {
    enter,
    open,
    addSelections,
    setSelections,
    listSelections,
    removeSelection,
    clearSelections,
    runScript,
  };
  return { ...control, operations: new CakeOperationRegistry(createCakeVscodeOperations(control)) };
}

describe("Cake VS Code navigation and selection operations", () => {
  it("opens a file at a navigation line without invoking selection management", async () => {
    const { open, addSelections, setSelections, operations } = registry();
    for (const path of ["src/main.ts", "/tmp/cake.log"]) {
      const result = await operations.invoke(
        { command: "vscode.open", input: { path, line: 4 } },
        context(),
      );
      expect(result.details).toMatchObject({
        result: { opened: true, location: { path, line: 4 }, view: "file" },
      });
      expect(open).toHaveBeenLastCalledWith({ path, line: 4 }, expect.any(AbortSignal));
    }
    expect(addSelections).not.toHaveBeenCalled();
    expect(setSelections).not.toHaveBeenCalled();
  });

  it.each(["column", "endLine", "endColumn", "range", "ranges", "view", "side", "base", "symbol"])(
    "rejects selection field %s on open",
    async (field) => {
      const { open, operations } = registry();
      await expect(
        operations.invoke(
          { command: "vscode.open", input: { path: "src/main.ts", line: 4, [field]: 5 } },
          context(),
        ),
      ).rejects.toThrow();
      expect(open).not.toHaveBeenCalled();
    },
  );

  it.each(["add", "set"] as const)(
    "provides typed source ranges and diff context for %s",
    async (operation) => {
      const { operations, addSelections, setSelections } = registry();
      const input = {
        selections: [
          {
            path: "src/main.ts",
            line: 804,
            column: 5,
            endLine: 812,
            endColumn: 6,
            view: "changes",
            side: "before",
            base: "main",
          },
        ],
      };
      const result = await operations.invoke(
        { command: `vscode.selections.${operation}`, input },
        context(),
      );
      expect(operation === "add" ? addSelections : setSelections).toHaveBeenCalledWith(
        input,
        expect.any(AbortSignal),
      );
      expect(result.details).toMatchObject({
        result: {
          selectionIds: ["selection-1"],
          selections: [{ id: "selection-1", location: input.selections[0] }],
        },
      });
    },
  );

  it("rejects invalid batches before either selection handler runs", async () => {
    const { operations, addSelections, setSelections } = registry();
    for (const operation of ["add", "set"]) {
      for (const bad of [
        { path: "src/a.ts" },
        { path: "src/a.ts", line: 0 },
        { path: "src/a.ts", line: 5, endLine: 4 },
        { path: "src/a.ts", line: 5, column: 9, endColumn: 3 },
        { path: "src/a.ts", line: 5, side: "before" },
        { path: "src/a.ts", line: 5, base: "main" },
        { path: "src/a.ts", line: 5, view: "changes", base: "--invalid" },
        { path: "src/a.ts", line: 5, unexpected: true },
      ]) {
        await expect(
          operations.invoke(
            {
              command: `vscode.selections.${operation}`,
              input: { selections: [{ path: "src/good.ts", line: 1 }, bad] },
            },
            context(),
          ),
        ).rejects.toThrow();
      }
    }
    expect(addSelections).not.toHaveBeenCalled();
    expect(setSelections).not.toHaveBeenCalled();
  });

  it("preserves diff fallback and projection warnings in mutation results", async () => {
    const { operations, addSelections } = registry();
    addSelections.mockResolvedValueOnce({
      status: "completed",
      value: {
        state: state([selection("one", source(3))]),
        selectionIds: ["one" as EditorSelectionId],
        reveals: [{ outcome: { view: "file", fallback: "no-changes" }, locations: [source(3)] }],
        warning: "Could not refresh highlights",
      },
    });
    const result = await operations.invoke(
      {
        command: "vscode.selections.add",
        input: { selections: [{ path: "src/main.ts", line: 100, view: "changes" }] },
      },
      context(),
    );
    expect(result.details).toMatchObject({
      result: {
        warning: "Could not refresh highlights",
        reveals: [{ outcome: { view: "file", fallback: "no-changes" } }],
        selections: [{ location: { line: 4 } }],
      },
    });
  });

  it.each(["add", "set"] as const)("returns typed mode recovery for %s", async (operation) => {
    const { operations, addSelections, setSelections } = registry();
    (operation === "add" ? addSelections : setSelections).mockResolvedValueOnce({
      status: "mode-required",
    });
    const result = await operations.invoke(
      { command: `vscode.selections.${operation}`, input: { selections: [] } },
      context(),
    );
    expect(result.structuredContent).toMatchObject({
      command: `vscode.selections.${operation}`,
      result: { ok: false, error: { code: "VSCODE_MODE_REQUIRED" } },
    });
    expect(operations.operationHelp(`vscode.selections.${operation}`)).toContain("output-schema");
  });

  it("advertises separate navigation and selection contracts", () => {
    const { operations } = registry();
    expect(operations.operationHelp("vscode.open")).toContain("no selections");
    expect(operations.operationHelp("vscode.selections.set")).toContain(
      "before changing the collection",
    );
    for (const command of [
      "vscode.open",
      "vscode.selections.add",
      "vscode.selections.set",
      "vscode.script.run",
      "vscode.debug.start",
    ])
      expect(operations.topicHelp("vscode")).toContain(command);
  });

  it("lists current selection IDs and one-based locations in insertion order", async () => {
    const { listSelections, operations } = registry();
    listSelections.mockResolvedValueOnce(
      state([
        selection("first", source(2)),
        selection("diff", {
          kind: "working-directory",
          view: "changes",
          side: "before",
          base: "main",
          path: "src/main.ts",
          range: { start: { line: 6 }, end: { line: 8 } },
        }),
        selection("absolute", {
          kind: "absolute-file",
          view: "file",
          path: "/tmp/log",
          range: { start: { line: 0 }, end: { line: 0 } },
        }),
      ]),
    );
    const result = await operations.invoke(
      { command: "vscode.selections.list", input: {} },
      context(),
    );
    expect(listSelections).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(result.details).toMatchObject({
      result: {
        sessionId: "session-a",
        selections: [
          {
            id: "first",
            location: { path: "src/main.ts", line: 3, column: 3, endLine: 3, endColumn: 9 },
          },
          {
            id: "diff",
            location: {
              path: "src/main.ts",
              view: "changes",
              side: "before",
              base: "main",
              line: 7,
              endLine: 9,
            },
          },
          { id: "absolute", location: { path: "/tmp/log", line: 1, endLine: 1 } },
        ],
      },
    });
  });

  it("bounds selection discovery and mutation receipts, filtering before paging", async () => {
    const { operations, listSelections, removeSelection } = registry();
    const entries = Array.from({ length: 65 }, (_, index) =>
      selection(`selection-${index}`, {
        ...source(index),
        path: index % 2 === 0 ? "src/even.ts" : "src/odd.ts",
      }),
    );
    listSelections.mockResolvedValue(state(entries));
    const first = await operations.invoke({ command: "vscode.selections.list" }, context());
    expect(first.details).toMatchObject({
      result: {
        total: 65,
        offset: 0,
        nextOffset: 20,
        selections: entries.slice(0, 20).map(({ id }) => ({ id })),
      },
    });
    const filtered = await operations.invoke(
      { command: "vscode.selections.list", input: { query: "even", offset: 30, limit: 2 } },
      context(),
    );
    expect(filtered.details).toMatchObject({
      result: {
        total: 33,
        offset: 30,
        nextOffset: 32,
        selections: [{ id: "selection-60" }, { id: "selection-62" }],
      },
    });
    const end = await operations.invoke(
      { command: "vscode.selections.list", input: { query: "even", offset: 32, limit: 50 } },
      context(),
    );
    expect(end.details).toMatchObject({
      result: { nextOffset: null, selections: [{ id: "selection-64" }] },
    });
    removeSelection.mockResolvedValue({ state: state(entries) });
    const removed = await operations.invoke(
      { command: "vscode.selections.remove", input: { id: "absent" } },
      context(),
    );
    expect(removed.details).toMatchObject({ result: { nextOffset: 20 } });
    listSelections.mockClear();
    await expect(
      operations.invoke({ command: "vscode.selections.list", input: { limit: 51 } }, context()),
    ).rejects.toThrow();
    expect(listSelections).not.toHaveBeenCalled();
  });

  it("removes an explicit ID without treating an unknown ID as clear-all", async () => {
    const { removeSelection, clearSelections, operations } = registry();
    const remaining = state([selection("other", source(4))]);
    removeSelection.mockResolvedValue({ state: remaining });
    const result = await operations.invoke(
      { command: "vscode.selections.remove", input: { id: "first" } },
      context(),
    );
    expect(removeSelection).toHaveBeenCalledWith("first", expect.any(AbortSignal));
    expect(result.details).toMatchObject({
      result: {
        selections: [{ id: "other", location: { path: "src/main.ts", line: 5 } }],
      },
    });
    const unknown = await operations.invoke(
      { command: "vscode.selections.remove", input: { id: "absent" } },
      context(),
    );
    expect(unknown.details).toMatchObject({
      result: {
        selections: [{ id: "other", location: { path: "src/main.ts", line: 5 } }],
      },
    });
    expect(clearSelections).not.toHaveBeenCalled();
  });

  it("clears the collection even when VS Code mode is inactive", async () => {
    const { clearSelections, enter, open, operations } = registry();
    open.mockResolvedValueOnce({ status: "mode-required" });
    const inactive = await operations.invoke(
      { command: "vscode.open", input: { path: "src/main.ts" } },
      context(),
    );
    expect(inactive.details).toMatchObject({ result: { error: { code: "VSCODE_MODE_REQUIRED" } } });
    const result = await operations.invoke(
      { command: "vscode.selections.clear", input: {} },
      context(),
    );
    expect(clearSelections).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(result.details).toMatchObject({ result: { sessionId: "session-a", selections: [] } });
    expect(enter).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledOnce();
  });

  it("rejects missing or malformed removal IDs before invoking the control", async () => {
    const { removeSelection, clearSelections, operations } = registry();
    for (const input of [{}, { id: "" }, { id: 12 }, { id: "x".repeat(129) }]) {
      await expect(
        operations.invoke({ command: "vscode.selections.remove", input }, context()),
      ).rejects.toThrow();
    }
    expect(removeSelection).not.toHaveBeenCalled();
    expect(clearSelections).not.toHaveBeenCalled();
  });

  it("discloses session-local retention, non-persistence, and next-tour-step cleanup guidance", () => {
    const { operations } = registry();
    const help = operations.operationHelp("vscode.selections.list");
    expect(help).toContain("calling session");
    expect(help).toMatch(/not persisted/i);
    expect(help).toMatch(/use set for the next tour step/i);
    expect(help).toContain("vscode.selections.list");
    expect(operations.topicHelp("vscode")).toContain("vscode.selections.remove");
    expect(operations.topicHelp("vscode")).toContain("vscode.selections.clear");
    expect(help).toMatch(/until removed\/cleared/i);
  });

  it("enters VS Code mode explicitly", async () => {
    const { enter, operations } = registry();

    const result = await operations.invoke(
      { command: "vscode.enter" },
      {
        signal: new AbortController().signal,
        toolCallId: "tool-enter",
        runtime: {},
      },
    );

    expect(enter).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(result.details).toMatchObject({ result: { entered: true } });
  });

  it("returns a structured recovery result when VS Code mode is inactive", async () => {
    const { open, operations } = registry();
    open.mockResolvedValueOnce({ status: "mode-required" });

    const result = await operations.invoke(
      { command: "vscode.open", input: { path: "src/main.ts" } },
      {
        signal: new AbortController().signal,
        toolCallId: "tool-mode-required",
        runtime: {},
      },
    );

    expect(result.details).toMatchObject({
      result: {
        ok: false,
        error: { code: "VSCODE_MODE_REQUIRED", retryable: true },
      },
    });
  });

  it("runs arbitrary extension-host JavaScript with JSON input", async () => {
    const { runScript, operations } = registry();

    const result = await operations.invoke(
      {
        command: "vscode.script.run",
        input: { source: "return input;", input: { layout: "split" } },
      },
      {
        signal: new AbortController().signal,
        toolCallId: "tool-script",
        runtime: {},
      },
    );

    expect(runScript).toHaveBeenCalledWith(
      "return input;",
      { layout: "split" },
      expect.any(AbortSignal),
    );
    expect(result.details).toMatchObject({
      result: { ok: true, result: { layout: "split" } },
    });
  });

  it.each([
    ["vscode.debug.start", { configuration: "Debug Current Test" }, "startDebugging"],
    ["vscode.debug.status", {}, "vscode.debug.breakpoints"],
    ["vscode.debug.setBreakpoint", { path: "src/main.ts", line: 42 }, "addBreakpoints"],
    ["vscode.debug.clearBreakpoints", {}, "removeBreakpoints"],
    ["vscode.debug.stack", { threadId: 1, levels: 20 }, 'customRequest("stackTrace"'],
    ["vscode.debug.scopes", { frameId: 7 }, 'customRequest("scopes"'],
    ["vscode.debug.variables", { variablesReference: 12 }, 'customRequest("variables"'],
    [
      "vscode.debug.evaluate",
      { expression: "user.id", frameId: 7, context: "watch" },
      'customRequest("evaluate"',
    ],
    ["vscode.debug.control", { action: "next", threadId: 1 }, "input.action"],
    ["vscode.debug.stop", {}, "stopDebugging"],
  ])(
    "runs the first-class debugger operation %s through a fixed script",
    async (command, input, marker) => {
      const { runScript, operations } = registry();

      const result = await operations.invoke(
        { command, input },
        {
          signal: new AbortController().signal,
          toolCallId: `tool-${command}`,
          runtime: {},
        },
      );

      expect(runScript).toHaveBeenCalledWith(
        expect.stringContaining(marker),
        input,
        expect.any(AbortSignal),
      );
      expect(result.details).toMatchObject({ result: input });
    },
  );

  it("returns the VS Code mode recovery for debugger operations", async () => {
    const { runScript, operations } = registry();
    runScript.mockResolvedValueOnce({ status: "mode-required" });

    const result = await operations.invoke(
      { command: "vscode.debug.status" },
      {
        signal: new AbortController().signal,
        toolCallId: "tool-debug-mode-required",
        runtime: {},
      },
    );

    expect(result.details).toMatchObject({
      result: { ok: false, error: { code: "VSCODE_MODE_REQUIRED", retryable: true } },
    });
  });

  it("bounds debugger reads and validates breakpoint selectors", async () => {
    const { runScript, operations } = registry();
    const context = {
      signal: new AbortController().signal,
      toolCallId: "tool-debug-validation",
      runtime: {},
    };

    await expect(
      operations.invoke(
        { command: "vscode.debug.variables", input: { variablesReference: 1, count: 501 } },
        context,
      ),
    ).rejects.toThrow();
    await expect(
      operations.invoke({ command: "vscode.debug.clearBreakpoints", input: { line: 10 } }, context),
    ).rejects.toThrow("line requires path");
    expect(runScript).not.toHaveBeenCalled();
  });
});
