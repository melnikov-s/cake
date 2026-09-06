import { describe, expect, it } from "vitest";
import { workLogChangeChunks, workLogChanges } from "../../../src/utils/turn-diff";

describe("workLogChanges", () => {
  it("projects pending edits and writes into a single live file diff", () => {
    const changes = workLogChanges([
      {
        id: "edit-1",
        kind: "tool" as const,
        name: "edit",
        input: JSON.stringify({
          path: "src/app.ts",
          edits: [{ oldText: "old", newText: "new" }],
        }),
        filePath: "src/app.ts",
        state: "running" as const,
      },
      {
        id: "write-1",
        kind: "tool" as const,
        name: "write",
        input: JSON.stringify({ path: "src/new.ts", content: "export const value = 1;" }),
        filePath: "src/new.ts",
        state: "running" as const,
      },
    ]);

    expect(changes).toEqual([
      expect.objectContaining({ path: "src/app.ts", diff: "-old\n+new" }),
      expect.objectContaining({ path: "src/new.ts", diff: "+export const value = 1;" }),
    ]);
  });

  it("keeps repeated edits to a file as chronological work-log chunks", () => {
    const parts = [
      {
        id: "edit-app-1",
        kind: "tool" as const,
        name: "edit",
        input: JSON.stringify({ path: "src/app.ts", edits: [{ oldText: "one", newText: "two" }] }),
        state: "success" as const,
      },
      {
        id: "edit-other",
        kind: "tool" as const,
        name: "edit",
        input: JSON.stringify({ path: "src/other.ts", edits: [{ oldText: "a", newText: "b" }] }),
        state: "success" as const,
      },
      {
        id: "edit-app-2",
        kind: "tool" as const,
        name: "edit",
        input: JSON.stringify({
          path: "src/app.ts",
          edits: [{ oldText: "two", newText: "three" }],
        }),
        state: "success" as const,
      },
    ];

    expect(workLogChangeChunks(parts)).toEqual([
      expect.objectContaining({ id: "edit-app-1", path: "src/app.ts", diff: "-one\n+two" }),
      expect.objectContaining({ id: "edit-other", path: "src/other.ts", diff: "-a\n+b" }),
      expect.objectContaining({ id: "edit-app-2", path: "src/app.ts", diff: "-two\n+three" }),
    ]);
    expect(workLogChanges(parts)).toHaveLength(2);
  });
});
