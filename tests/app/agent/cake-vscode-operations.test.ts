import { describe, expect, it, vi } from "vitest";
import { createCakeVscodeOperations } from "../../../src/agent/cake-vscode-operations";
import { CakeOperationRegistry } from "../../../src/agent/cake-operation-registry";
import type { SourceLocation } from "../../../src/ipc/source-location";

function registry(open = vi.fn(async (location: SourceLocation) => location)) {
  return {
    open,
    operations: new CakeOperationRegistry(createCakeVscodeOperations({ open })),
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
    expect(operations.topicHelp("vscode")).toContain("vscode.open");
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
