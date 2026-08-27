import { describe, expect, it } from "vitest";
import { workLogChanges } from "../../../src/utils/turn-diff";

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
});
