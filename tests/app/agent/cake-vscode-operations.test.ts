import { describe, expect, it, vi } from "vitest";
import { createCakeVscodeOperations } from "../../../src/services/pi/runtime/cake-vscode-operations";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
import type { JsonValue } from "../../../src/ipc/json-contract";
import type { SourceLocation } from "../../../src/ipc/source-location";
import type { VscodeActionResult } from "../../../src/services/vscode/VsCodeServer";

function registry() {
  const enter = vi.fn(async () => undefined);
  const open = vi.fn(
    async (location: SourceLocation): Promise<VscodeActionResult<SourceLocation>> => ({
      status: "completed",
      value: location,
    }),
  );
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
    operations: new CakeOperationRegistry(createCakeVscodeOperations({ enter, open, runScript })),
  };
}

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
        path: "src/main/main.ts",
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
        location: {
          path: "src/main/main.ts",
          line: 804,
          column: 5,
          endLine: 812,
          endColumn: 6,
        },
      },
    });
  });

  it("opens a whole file and advertises the progressively disclosed topic", async () => {
    const { open, operations } = registry();

    expect(operations.help()).toContain("vscode —");
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

    expect(open).toHaveBeenCalledWith({ path: "src/main.ts" }, expect.any(AbortSignal));
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
