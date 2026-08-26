import { describe, expect, it } from "vitest";
import type { UiPart } from "../../../src/ipc/session-contract";
import { agentChanges, changedRanges, toolSourceRange } from "../../../src/utils/agent-changes";

describe("agent changes", () => {
  it("parses numbered Pi edit output and unified hunks into zero-based ranges", () => {
    expect(changedRanges("-10 old\n+10 new\n 11 context\n+12 next")).toEqual([
      { start: { line: 9 }, end: { line: 9 } },
      { start: { line: 11 }, end: { line: 11 } },
    ]);
    expect(changedRanges("@@ -3,2 +3,3 @@\n old\n-new\n+first\n+2024 value")).toEqual([
      { start: { line: 3 }, end: { line: 4 } },
    ]);
  });

  it("marks only changes after the latest user message as current-turn work", () => {
    const parts: UiPart[] = [
      { id: "user-1", kind: "text", role: "user", text: "first", status: "complete" },
      {
        id: "edit-1",
        kind: "tool",
        name: "edit",
        input: "{}",
        filePath: "src/old.ts",
        diff: "+1 old turn",
        state: "success",
      },
      { id: "user-2", kind: "text", role: "user", text: "second", status: "complete" },
      {
        id: "edit-2",
        kind: "tool",
        name: "edit",
        input: "{}",
        filePath: "src/current.ts",
        diff: "@@ -5 +5 @@\n-before\n+after",
        state: "success",
      },
    ];

    expect(agentChanges(parts)).toEqual([
      {
        id: "edit-1:0",
        path: "src/old.ts",
        range: { start: { line: 0 }, end: { line: 0 } },
        currentTurn: false,
      },
      {
        id: "edit-2:0",
        path: "src/current.ts",
        range: { start: { line: 4 }, end: { line: 4 } },
        currentTurn: true,
      },
    ]);
    expect(toolSourceRange(parts[3] as Extract<UiPart, { kind: "tool" }>)).toEqual({
      start: { line: 4 },
      end: { line: 4 },
    });
  });
});
