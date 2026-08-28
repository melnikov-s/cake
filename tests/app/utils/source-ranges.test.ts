import { describe, expect, it } from "vitest";
import type { UiPart } from "../../../src/ipc/session-contract";
import { changedRanges, toolSourceRange } from "../../../src/utils/source-ranges";

describe("source ranges", () => {
  it("parses numbered Pi edit output and unified hunks into zero-based ranges", () => {
    expect(changedRanges("-10 old\n+10 new\n 11 context\n+12 next")).toEqual([
      { start: { line: 9 }, end: { line: 9 } },
      { start: { line: 11 }, end: { line: 11 } },
    ]);
    expect(changedRanges("@@ -3,2 +3,3 @@\n old\n-new\n+first\n+2024 value")).toEqual([
      { start: { line: 3 }, end: { line: 4 } },
    ]);
  });

  it("finds the complete source range for a tool diff", () => {
    const part: Extract<UiPart, { kind: "tool" }> = {
      id: "edit",
      kind: "tool",
      name: "edit",
      input: "{}",
      filePath: "src/current.ts",
      diff: "@@ -5 +5 @@\n-before\n+after",
      state: "success",
    };

    expect(toolSourceRange(part)).toEqual({
      start: { line: 4 },
      end: { line: 4 },
    });
  });
});
