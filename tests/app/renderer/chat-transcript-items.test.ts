import { describe, expect, it } from "vitest";
import type { UiPart } from "../../../src/ipc/session-contract";
import {
  groupTranscriptParts,
  transcriptItemKeys,
} from "../../../src/renderer/components/chat-transcript-items";

function tool(id: string, origin?: "compacted"): UiPart {
  return { id, kind: "tool", name: "read", input: id, state: "success", origin };
}

describe("groupTranscriptParts", () => {
  it("never groups recovered and current work-log activity together", () => {
    const items = groupTranscriptParts([
      tool("old-1", "compacted"),
      tool("old-2", "compacted"),
      tool("current-1"),
      {
        id: "current-reasoning",
        kind: "reasoning",
        text: "similar current work",
        status: "complete",
      },
    ]);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: "activity-group",
      parts: [{ origin: "compacted" }, { origin: "compacted" }],
    });
    expect(items[1]).toMatchObject({ kind: "activity-group" });
    if (items[1]?.kind !== "activity-group") throw new Error("Expected current activity group");
    expect(items[1].parts.map((part) => ("origin" in part ? part.origin : undefined))).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("groups restored shell commands as compacted activity", () => {
    const command: UiPart = {
      id: "old-command",
      kind: "command",
      origin: "compacted",
      command: "pwd",
      output: "/project",
      excludeFromContext: false,
      state: "success",
    };
    expect(groupTranscriptParts([command])).toMatchObject([
      { kind: "activity-group", parts: [{ id: "old-command", origin: "compacted" }] },
    ]);
  });
});

describe("transcriptItemKeys", () => {
  const text = (id: string, renderKey?: string): UiPart => ({
    id,
    kind: "text",
    role: "assistant",
    renderKey,
    text: id,
    status: "complete",
  });

  it("keys assistant text by render key and falls back to ids for duplicates", () => {
    expect(
      transcriptItemKeys([
        text("entry-a-text-0", "assistant-1-text-0"),
        text("entry-b-text-0", "assistant-1-text-0"),
        text("entry-c-text-0"),
        tool("tool-1"),
      ]),
    ).toEqual(["assistant-1-text-0", "entry-b-text-0", "entry-c-text-0", "tool-1"]);
  });
});
