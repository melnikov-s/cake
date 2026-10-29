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
  it("keeps incremental historical groups at their append positions rather than sorting by original time", () => {
    const source = {
      groupId: "first-merge",
      threadId: "thread",
      title: "Side chat",
      sourceSessionId: "side",
      sourceEntryId: "old-message",
      sourceTimestamp: 1,
      importedAt: 100,
    };
    const imported: UiPart = {
      id: "imported",
      kind: "text",
      role: "user",
      text: "Old question",
      status: "complete",
      sideChatImport: source,
    };
    const attachment: UiPart = {
      id: "file",
      kind: "attachment",
      attachmentKind: "file",
      name: "notes.txt",
      mediaType: "text/plain",
      sideChatImport: source,
    };
    const between: UiPart = {
      id: "between",
      kind: "text",
      role: "assistant",
      text: "A newer main answer",
      status: "complete",
    };
    const incremental: UiPart = {
      ...imported,
      id: "incremental",
      sideChatImport: {
        ...source,
        groupId: "second-merge",
        sourceEntryId: "next-message",
        sourceTimestamp: 2,
        importedAt: 200,
      },
    };
    expect(
      groupTranscriptParts([tool("before"), imported, attachment, between, incremental]),
    ).toMatchObject([
      { kind: "activity-group", parts: [{ id: "before" }] },
      { kind: "side-chat-import", parts: [imported, attachment] },
      between,
      { kind: "side-chat-import", parts: [incremental] },
    ]);
  });
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
