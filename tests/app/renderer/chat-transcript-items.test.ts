import { describe, expect, it } from "vitest";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import {
  groupTranscriptParts,
  transcriptItemKeys,
} from "../../../src/renderer/components/chat-transcript-items";

function tool(id: string, origin?: "compacted"): UiPart {
  return { id, kind: "tool", name: "read", input: id, state: "success", origin };
}

describe("groupTranscriptParts", () => {
  it("anchors synthetic baselines above paged history and reconstructed parts on every chat surface", () => {
    const earlier: UiPart = {
      id: "entry-earlier-text",
      kind: "text",
      role: "user",
      text: "Earlier",
      status: "complete",
    };
    const baseline: UiPart = {
      id: "runtime-system-prompt-system",
      kind: "context",
      title: "System",
      text: "Current rules",
    };
    const change: UiPart = {
      id: "entry-changed-system-prompt-system",
      kind: "context",
      title: "System",
      text: "Changed rules",
    };
    const liveChange: UiPart = {
      id: "live-context-2-system-prompt-system",
      kind: "context",
      title: "System",
      text: "Live rules",
    };
    const input = [earlier, tool("old-work"), baseline, change, tool("new-work"), liveChange];
    expect(groupTranscriptParts(input)).toMatchObject([
      { kind: "context-group", parts: [baseline] },
      earlier,
      { kind: "activity-group", parts: [{ id: "old-work" }] },
      { kind: "context-group", parts: [change] },
      { kind: "activity-group", parts: [{ id: "new-work" }] },
      { kind: "context-group", parts: [liveChange] },
    ]);
    expect(input).toEqual([
      earlier,
      tool("old-work"),
      baseline,
      change,
      tool("new-work"),
      liveChange,
    ]);
  });

  // Context run boundaries and recovered/current work-log separation are covered
  // by presentation-finish-workflow. Keep shell-command classification here:
  // ActivityGroup does not currently expose a command-only group's disclosure.
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
