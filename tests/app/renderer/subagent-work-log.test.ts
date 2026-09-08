import { describe, expect, it } from "vitest";
import type { UiPart } from "../../../src/ipc/session-contract";
import { combineSubagentWorkLogParts } from "../../../src/renderer/lib/subagent-work-log";

function tool(
  id: string,
  command: "subagents.start" | "subagents.wait" | "subagents.completion",
  input: object,
  output: object,
): Extract<UiPart, { kind: "tool" }> {
  return {
    id,
    kind: "tool",
    name: "cake",
    command,
    input: JSON.stringify(input),
    output: JSON.stringify(output),
    state: "success",
  };
}

describe("combineSubagentWorkLogParts", () => {
  it("deduplicates a background start and repeated waits by stable handle", () => {
    const handleId = crypto.randomUUID();
    const start = tool(
      "spawn",
      "subagents.start",
      { task: "Inspect the renderer" },
      { handleId, status: "running" },
    );
    const firstPoll = tool(
      "poll-1",
      "subagents.wait",
      { handleId },
      { handleId, status: "running" },
    );
    const completedPoll = tool(
      "poll-2",
      "subagents.wait",
      { handleId },
      { handleId, status: "complete" },
    );

    const items = combineSubagentWorkLogParts([start, firstPoll, completedPoll]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "subagent-work-log",
      id: `subagent-${handleId}`,
      handleId,
      start,
      latest: completedPoll,
      parts: [start, firstPoll, completedPoll],
    });
  });

  it("merges automatic completion into its background start", () => {
    const handleId = crypto.randomUUID();
    const start = tool(
      "start",
      "subagents.start",
      { task: "Inspect the renderer" },
      { handleId, status: "running" },
    );
    const completion = tool(
      "completion",
      "subagents.completion",
      {},
      { handleId, status: "complete" },
    );

    expect(combineSubagentWorkLogParts([start, completion])).toEqual([
      expect.objectContaining({
        id: `subagent-${handleId}`,
        start,
        latest: completion,
        parts: [start, completion],
      }),
    ]);
  });

  it("keeps a standalone wait distinct from an unrelated background start", () => {
    const spawnedHandle = crypto.randomUUID();
    const polledHandle = crypto.randomUUID();
    const items = combineSubagentWorkLogParts([
      tool("spawn", "subagents.start", {}, { handleId: spawnedHandle }),
      tool("poll", "subagents.wait", { handleId: polledHandle }, { handleId: polledHandle }),
    ]);

    expect(items).toHaveLength(2);
    expect(items.map((item) => item.id)).toEqual([
      `subagent-${spawnedHandle}`,
      `subagent-${polledHandle}`,
    ]);
  });
});
