import { describe, expect, it, vi } from "vitest";
import { createCakeVscodeOperations } from "../../../src/services/pi/runtime/cake-vscode-operations";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
import type { EditorLocation } from "../../../src/ipc/editor-location";
import type {
  EditorSelectionId,
  EditorSelectionLocation,
  EditorSelectionState,
  EditorSelectionUpdate,
  EditorSelectionOpenResult,
} from "../../../src/ipc/editor-selection";
import type { JsonValue } from "../../../src/ipc/json-contract";
import type { VscodeActionResult } from "../../../src/services/vscode/VsCodeServer";

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

function registry() {
  const enter = vi.fn(async () => undefined);
  const open = vi.fn(
    async (location: EditorLocation): Promise<VscodeActionResult<EditorSelectionOpenResult>> => ({
      status: "completed",
      value: {
        reveal: {
          outcome:
            location.kind === "working-directory" && location.view === "changes"
              ? { view: "changes" }
              : { view: "file" },
          locations: location.range ? [resolvedLocation(location)] : [],
        },
        selectionIds: location.range ? ["selection-1" as EditorSelectionId] : [],
      },
    }),
  );
  const listSelections = vi.fn(async (): Promise<EditorSelectionState> => state());
  const removeSelection = vi.fn(async (): Promise<EditorSelectionUpdate> => ({ state: state() }));
  const clearSelections = vi.fn(async (): Promise<EditorSelectionUpdate> => ({ state: state() }));
  const runScript = vi.fn(
    async (_source: string, input: JsonValue): Promise<VscodeActionResult<JsonValue>> => ({
      status: "completed",
      value: input,
    }),
  );
  return {
    enter,
    open,
    runScript,
    listSelections,
    removeSelection,
    clearSelections,
    operations: new CakeOperationRegistry(
      createCakeVscodeOperations({
        enter,
        open,
        runScript,
        listSelections,
        removeSelection,
        clearSelections,
      }),
    ),
  };
}

describe("Cake VS Code session selection operations", () => {
  it("returns stable selection IDs from ranged vscode.open and no IDs for a file-only open", async () => {
    const { open, operations } = registry();
    const ranged = await operations.invoke(
      { command: "vscode.open", input: { path: "src/main.ts", line: 4 } },
      context(),
    );
    expect(ranged.details).toMatchObject({
      result: {
        opened: true,
        selectionIds: ["selection-1"],
        location: { path: "src/main.ts", line: 4, endLine: 4 },
      },
    });
    const repeated = await operations.invoke(
      { command: "vscode.open", input: { path: "src/main.ts", line: 4 } },
      context(),
    );
    expect(repeated.details).toMatchObject({ result: { selectionIds: ["selection-1"] } });
    const plain = await operations.invoke(
      { command: "vscode.open", input: { path: "src/main.ts" } },
      context(),
    );
    expect(plain.details).toMatchObject({
      result: { location: { path: "src/main.ts" }, selectionIds: [] },
    });
    expect(open).toHaveBeenCalledTimes(3);
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
    const help = operations.topicHelp("vscode");
    expect(help).toMatch(/session-local/i);
    expect(help).toMatch(/not persisted/i);
    expect(help).toMatch(/clear the previous tour step/i);
    expect(help).toContain("vscode.selections.list");
    expect(help).toContain("vscode.selections.remove");
    expect(help).toContain("vscode.selections.clear");
    expect(help).toMatch(/until removed\/cleared/i);
  });

  it("preserves diff fallback and companion projection warnings in tool results", async () => {
    const { open, removeSelection, operations } = registry();
    open.mockResolvedValueOnce({
      status: "completed",
      value: {
        reveal: { outcome: { view: "file", fallback: "no-changes" }, locations: [source(3)] },
        selectionIds: ["selection-1" as EditorSelectionId],
        warning: "The companion could not refresh highlights.",
      },
    });
    const result = await operations.invoke(
      {
        command: "vscode.open",
        input: {
          path: "src/main.ts",
          view: "changes",
          line: 100,
        },
      },
      context(),
    );
    expect(result.details).toMatchObject({
      result: {
        view: "file",
        selectionIds: ["selection-1"],
        location: { path: "src/main.ts", line: 4, column: 3, endLine: 4, endColumn: 9 },
        warning: expect.stringMatching(
          /no uncommitted changes.*companion could not refresh highlights/i,
        ),
      },
    });
    removeSelection.mockResolvedValueOnce({
      state: state([]),
      warning: "Highlight rendering failed.",
    });
    const removed = await operations.invoke(
      { command: "vscode.selections.remove", input: { id: "selection-1" } },
      context(),
    );
    expect(removed.details).toMatchObject({
      result: { selections: [], warning: "Highlight rendering failed." },
    });
  });
});

describe("Cake VS Code operations", () => {
  it("opens a one-based agent range through the zero-based editor contract", async () => {
    const { open, operations } = registry();

    const result = await operations.invoke(
      {
        command: "vscode.open",
        input: {
          path: "src/main/main.ts",
          line: 804,
          column: 5,
          endLine: 812,
          endColumn: 6,
          view: "changes",
          side: "before",
        },
      },
      {
        signal: new AbortController().signal,
        toolCallId: "tool-1",
        runtime: {},
      },
    );

    expect(open).toHaveBeenCalledWith(
      {
        kind: "working-directory",
        path: "src/main/main.ts",
        view: "changes",
        side: "before",
        range: {
          start: { line: 803, column: 4 },
          end: { line: 811, column: 5 },
        },
      },
      expect.any(AbortSignal),
    );
    expect(result.details).toMatchObject({
      command: "vscode.open",
      result: {
        opened: true,
        view: "changes",
        location: {
          path: "src/main/main.ts",
          line: 804,
          column: 5,
          endLine: 812,
          endColumn: 6,
          view: "changes",
          side: "before",
        },
      },
    });
    expect(result.details).not.toHaveProperty("result.warning");
    expect(result.details).toMatchObject({ result: { selectionIds: ["selection-1"] } });
  });

  it.each([
    ["no-changes", undefined, /no uncommitted changes.*pass base/],
    ["no-changes", "main", /does not differ from main/],
    ["unknown-base", "nope", /could not compare it with nope/],
    ["git-unavailable", undefined, /Git extension did not report/],
  ] as const)(
    "reports the actual view and a warning when a changes request falls back (%s, base %s)",
    async (fallback, base, warning) => {
      const { open, operations } = registry();
      const requested = {
        path: "src/main.ts",
        view: "changes" as const,
        ...(base ? { base } : null),
      };
      open.mockResolvedValueOnce({
        status: "completed",
        value: {
          reveal: {
            locations: [source(3)],
            outcome: { view: "file", fallback },
          },
          selectionIds: ["selection-1" as EditorSelectionId],
        },
      });

      const result = await operations.invoke(
        { command: "vscode.open", input: { line: 4, ...requested } },
        { signal: new AbortController().signal, toolCallId: "tool-fallback", runtime: {} },
      );

      expect(open).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "working-directory", ...requested }),
        expect.any(AbortSignal),
      );
      expect(result.details).toMatchObject({
        result: {
          opened: true,
          view: "file",
          location: { path: requested.path, line: 4, column: 3, endLine: 4, endColumn: 9 },
          selectionIds: ["selection-1"],
          warning: expect.stringMatching(warning),
        },
      });
    },
  );

  it("passes a base revision through and echoes it, but only with the changes view", async () => {
    const { open, operations } = registry();
    const context = { signal: new AbortController().signal, toolCallId: "tool-base", runtime: {} };

    const result = await operations.invoke(
      { command: "vscode.open", input: { path: "src/main.ts", view: "changes", base: "HEAD~1" } },
      context,
    );

    expect(open).toHaveBeenCalledWith(
      { kind: "working-directory", path: "src/main.ts", view: "changes", base: "HEAD~1" },
      expect.any(AbortSignal),
    );
    expect(result.details).toMatchObject({
      result: {
        view: "changes",
        selectionIds: [],
        location: { path: "src/main.ts", view: "changes", base: "HEAD~1" },
      },
    });

    await expect(
      operations.invoke(
        { command: "vscode.open", input: { path: "src/main.ts", base: "main" } },
        context,
      ),
    ).rejects.toThrow("base requires changes view");
    for (const base of ["--output=/tmp/x", "main..HEAD", "HEAD:src/main.ts", "a b"]) {
      await expect(
        operations.invoke(
          { command: "vscode.open", input: { path: "src/main.ts", view: "changes", base } },
          context,
        ),
      ).rejects.toThrow();
    }
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("opens a whole file and advertises the progressively disclosed topic", async () => {
    const { open, operations } = registry();

    expect(operations.help()).toContain("vscode —");
    expect(operations.topicHelp("vscode")).toContain("code tours and walkthroughs");
    expect(operations.topicHelp("vscode")).toContain(
      "users do not need to ask for VS Code explicitly",
    );
    expect(operations.topicHelp("vscode")).toContain(
      "Use vscode.open whenever showing code or directing the user's attention",
    );
    expect(operations.topicHelp("vscode")).toContain(
      "Do not recreate source opening or selection with vscode.script.run",
    );
    expect(operations.topicHelp("vscode")).toContain("vscode.enter");
    expect(operations.topicHelp("vscode")).toContain("vscode.open");
    expect(operations.topicHelp("vscode")).toContain("vscode.script.run");
    expect(operations.topicHelp("vscode")).toContain("vscode.debug.start");
    expect(operations.topicHelp("vscode")).toContain("vscode.debug.stack");
    expect(operations.topicHelp("vscode")).toContain("vscode.debug.evaluate");
    await operations.invoke(
      { command: "vscode.open", input: { path: "src/main.ts" } },
      {
        signal: new AbortController().signal,
        toolCallId: "tool-2",
        runtime: {},
      },
    );

    expect(open).toHaveBeenCalledWith(
      { kind: "working-directory", path: "src/main.ts" },
      expect.any(AbortSignal),
    );
  });

  it("opens an absolute local file without changing the Working Directory", async () => {
    const { open, operations } = registry();

    const result = await operations.invoke(
      { command: "vscode.open", input: { path: "/tmp/cake.log", line: 3 } },
      {
        signal: new AbortController().signal,
        toolCallId: "tool-absolute-file",
        runtime: {},
      },
    );

    expect(open).toHaveBeenCalledWith(
      {
        kind: "absolute-file",
        path: "/tmp/cake.log",
        range: { start: { line: 2 }, end: { line: 2 } },
      },
      expect.any(AbortSignal),
    );
    expect(result.details).toMatchObject({
      result: {
        opened: true,
        view: "file",
        selectionIds: ["selection-1"],
        location: { path: "/tmp/cake.log", line: 3 },
      },
    });
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

  it("rejects incomplete and reversed ranges before opening VS Code", async () => {
    const { open, operations } = registry();
    const context = {
      signal: new AbortController().signal,
      toolCallId: "tool-3",
      runtime: {},
    };

    await expect(
      operations.invoke(
        { command: "vscode.open", input: { path: "src/main.ts", column: 2 } },
        context,
      ),
    ).rejects.toThrow("column requires line");
    await expect(
      operations.invoke(
        {
          command: "vscode.open",
          input: { path: "src/main.ts", line: 20, endLine: 10 },
        },
        context,
      ),
    ).rejects.toThrow("endLine cannot precede line");
    expect(open).not.toHaveBeenCalled();
  });
});
