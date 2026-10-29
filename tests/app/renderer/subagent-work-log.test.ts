import { describe, expect, it } from "vitest";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import { combineSubagentWorkLogParts } from "../../../src/renderer/lib/subagent-work-log";

interface WorkLogRequest {
  readonly handleId?: string;
  readonly task?: string;
}
interface WorkLogReceipt {
  readonly handleId: string;
  readonly status?: "running" | "complete";
}

function tool(
  id: string,
  command: "subagents.start" | "subagents.wait" | "subagents.completion",
  input: WorkLogRequest,
  output: WorkLogReceipt,
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
  // Start/repeated-wait count and settlement are covered through the real Chat
  // in transcript-rendering-workflow. Retain receipt merging and distinct-handle
  // addressing: virtualized inner rows are not honestly inspectable in jsdom.
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
