import { describe, expect, it } from "vitest";
import { workLogChanges, workLogTurns } from "../../../src/utils/turn-diff";

const user = (id: string, text: string) => ({
  id,
  kind: "text" as const,
  role: "user" as const,
  text,
  status: "complete" as const,
});

const edit = (id: string, path: string, diff: string) => ({
  id,
  kind: "tool" as const,
  name: "edit",
  input: JSON.stringify({ path }),
  filePath: path,
  diff,
  state: "success" as const,
});

describe("workLogTurns", () => {
  it("groups tool diffs by user turn and totals repeated file edits", () => {
    const turns = workLogTurns([
      user("user-1", "Update the app"),
      edit("edit-1", "src/app.ts", "-1 old\n+1 fresh"),
      edit("edit-2", "src/app.ts", "-2 stale\n+2 current"),
      user("user-2", "Update the plan"),
      edit("edit-3", "PLAN.md", "+1 plan"),
    ]);

    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({
      id: "turn-user-1",
      label: "Update the app",
      additions: 2,
      deletions: 2,
    });
    expect(turns[0]!.changes).toEqual([
      {
        path: "src/app.ts",
        status: "modified",
        additions: 2,
        deletions: 2,
        diff: "-1 old\n+1 fresh\n-2 stale\n+2 current",
      },
    ]);
    expect(turns[1]!.changes[0]!.path).toBe("PLAN.md");
  });

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

  it("uses the edit input when a tool result has not exposed a diff yet", () => {
    const turns = workLogTurns([
      user("user-1", "Make the edit"),
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
    ]);

    expect(turns[0]!.changes[0]).toMatchObject({
      path: "src/app.ts",
      additions: 1,
      deletions: 1,
      diff: "-old\n+new",
    });
  });
});
