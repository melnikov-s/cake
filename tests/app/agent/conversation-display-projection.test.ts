import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { SessionManager, type FileEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { projectConversationDisplay } from "../../../src/services/pi/runtime/conversation-display-projection";
import { forkDisplayProvenanceEntryType } from "../../../src/services/pi/runtime/fork-display-provenance";
import { appendToolCompactedBranch } from "../../../src/services/pi/runtime/session-tool-compaction";
import {
  toolCompactEntryType,
  toolCompactProvenanceEntryType,
} from "../../../src/services/pi/runtime/tool-compaction-provenance";

const usage: Usage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "fixture",
    usage,
    stopReason: "stop",
    timestamp: 2,
  };
}

function sessionWithWork() {
  const session = SessionManager.inMemory("/project");
  session.appendMessage({ role: "user", content: "same text", timestamp: 1 });
  session.appendMessage(
    assistant([
      { type: "text", text: "I checked https://example.com/a." },
      { type: "thinking", thinking: "inspect before reading" },
      { type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/a.ts" } },
    ]),
  );
  session.appendMessage({
    role: "toolResult",
    toolCallId: "read-1",
    toolName: "read",
    content: [{ type: "text", text: "source output" }],
    details: { diff: "@@ -1 +1 @@\n-old\n+new" },
    isError: false,
    timestamp: 3,
  });
  session.appendMessage({ role: "user", content: "same text", timestamp: 4 });
  const leafId = session.appendMessage(assistant([{ type: "text", text: "Finished." }]));
  return { session, leafId };
}

function summarized(parts: ReturnType<typeof projectConversationDisplay>) {
  return parts.map((part) => ({
    id: part.id,
    kind: part.kind,
    origin: "origin" in part ? part.origin : undefined,
    text: part.kind === "text" || part.kind === "reasoning" ? part.text : undefined,
    state: part.kind === "tool" ? part.state : undefined,
  }));
}

describe("Conversation display projection after tool compaction", () => {
  it("restores work at its original positions and substitutes explicitly mapped active dialogue", () => {
    const { session, leafId } = sessionWithWork();
    appendToolCompactedBranch(session, leafId);
    session.appendMessage({ role: "user", content: "new turn", timestamp: 5 });
    session.appendMessage(
      assistant([
        { type: "thinking", thinking: "current reasoning" },
        { type: "toolCall", id: "current-read", name: "read", arguments: { path: "src/b.ts" } },
      ]),
    );
    session.appendMessage({
      role: "toolResult",
      toolCallId: "current-read",
      toolName: "read",
      content: [{ type: "text", text: "current output" }],
      isError: false,
      timestamp: 6,
    });
    session.appendMessage(assistant([{ type: "text", text: "New answer." }]));

    const activeMessageIds = new Set(
      session.getBranch().flatMap((entry) => (entry.type === "message" ? [entry.id] : [])),
    );
    const parts = projectConversationDisplay(session);
    expect(summarized(parts)).toMatchObject([
      { kind: "notice" },
      { kind: "text", text: "same text" },
      { kind: "text", text: "I checked https://example.com/a." },
      { kind: "source" },
      { kind: "reasoning", text: "inspect before reading", origin: "compacted" },
      { kind: "tool", origin: "compacted", state: "success" },
      { kind: "text", text: "same text" },
      { kind: "text", text: "Finished." },
      { kind: "text", text: "new turn" },
      { kind: "reasoning", text: "current reasoning", origin: undefined },
      { kind: "tool", origin: undefined, state: "success" },
      { kind: "text", text: "New answer." },
    ]);
    const dialogue = parts.filter(
      (part): part is Extract<(typeof parts)[number], { kind: "text" }> => part.kind === "text",
    );
    expect(dialogue.every((part) => part.entryId && activeMessageIds.has(part.entryId))).toBe(true);
    expect(parts.find((part) => part.kind === "tool" && part.id === "tool-read-1")).toMatchObject({
      diff: "@@ -1 +1 @@\n-old\n+new",
      origin: "compacted",
    });
  });

  it("follows repeated compaction provenance without matching duplicate text", () => {
    const { session, leafId } = sessionWithWork();
    appendToolCompactedBranch(session, leafId);
    session.appendMessage({ role: "user", content: "same text", timestamp: 7 });
    session.appendMessage(
      assistant([
        { type: "thinking", thinking: "second compacted thought" },
        { type: "toolCall", id: "second-tool", name: "bash", arguments: { command: "pwd" } },
        { type: "text", text: "Second answer." },
      ]),
    );
    session.appendMessage({
      role: "toolResult",
      toolCallId: "second-tool",
      toolName: "bash",
      content: [{ type: "text", text: "/project" }],
      isError: false,
      timestamp: 8,
    });
    const secondLeaf = session.appendMessage(assistant([{ type: "text", text: "Settled." }]));
    appendToolCompactedBranch(session, secondLeaf);

    const parts = projectConversationDisplay(session);
    expect(
      parts.filter((part) => part.kind === "notice" && part.title === "Tool compact"),
    ).toHaveLength(2);
    expect(parts.filter((part) => part.kind === "text" && part.text === "same text")).toHaveLength(
      3,
    );
    expect(
      parts.find((part) => part.kind === "reasoning" && part.text === "inspect before reading"),
    ).toMatchObject({ origin: "compacted" });
    expect(
      parts.find((part) => part.kind === "reasoning" && part.text === "second compacted thought"),
    ).toMatchObject({ origin: "compacted" });
    expect(
      parts.find((part) => part.kind === "tool" && part.id === "tool-second-tool"),
    ).toMatchObject({ origin: "compacted", state: "success" });
  });

  it("keeps legacy markers and malformed provenance on the active-branch behavior", () => {
    const legacy = SessionManager.inMemory("/project");
    legacy.appendCustomMessageEntry(toolCompactEntryType, "Legacy compact", true);
    legacy.appendMessage({ role: "user", content: "visible", timestamp: 1 });
    expect(projectConversationDisplay(legacy).map((part) => part.kind)).toEqual(["notice", "text"]);

    const malformed = SessionManager.inMemory("/project");
    malformed.appendCustomMessageEntry(toolCompactEntryType, "Malformed compact", true);
    malformed.appendMessage({ role: "user", content: "active only", timestamp: 1 });
    malformed.appendCustomEntry(toolCompactProvenanceEntryType, { version: 1, sourceLeafId: 42 });
    expect(projectConversationDisplay(malformed).map((part) => part.kind)).toEqual([
      "notice",
      "text",
    ]);
  });

  it.each([
    { label: "malformed", data: { version: 1, groups: "invalid" } },
    {
      label: "oversized",
      data: {
        version: 1,
        groups: [
          {
            precedingPartId: null,
            parts: [
              {
                id: "x".repeat(513),
                kind: "tool",
                name: "read",
                input: "a",
                output: "untrusted hidden output",
                state: "success",
                origin: "compacted",
              },
            ],
          },
        ],
      },
    },
  ])("falls back to the active branch for $label fork-display provenance", ({ data }) => {
    const session = SessionManager.inMemory("/project");
    session.appendMessage({ role: "user", content: "active only", timestamp: 1 });
    session.appendCustomEntry(forkDisplayProvenanceEntryType, data);

    const parts = projectConversationDisplay(session);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ kind: "text", text: "active only" });
    expect(JSON.stringify(parts)).not.toContain("untrusted hidden output");
  });

  it("falls back safely when provenance cycles or exceeds the depth bound", () => {
    const header = {
      type: "session" as const,
      version: 3,
      id: "cycle-session",
      timestamp: new Date(0).toISOString(),
      cwd: "/project",
    };
    const marker = {
      type: "custom_message" as const,
      id: "marker",
      parentId: null,
      timestamp: header.timestamp,
      customType: toolCompactEntryType,
      content: "compact",
      display: true,
    };
    const replay = {
      type: "message" as const,
      id: "replay",
      parentId: "marker",
      timestamp: header.timestamp,
      message: { role: "user" as const, content: "active", timestamp: 1 },
    };
    const provenance = {
      type: "custom" as const,
      id: "provenance",
      parentId: "replay",
      timestamp: header.timestamp,
      customType: toolCompactProvenanceEntryType,
      data: {
        version: 1,
        sourceLeafId: "provenance",
        markerEntryId: "marker",
        replayStartEntryId: "replay",
        replayEndEntryId: "replay",
        mappings: [{ sourceEntryId: "replay", replayedEntryId: "replay" }],
      },
    };
    const cyclic = SessionManager.inMemory("/project", undefined, [
      header,
      marker,
      replay,
      provenance,
    ] satisfies FileEntry[]);
    expect(projectConversationDisplay(cyclic).map((part) => part.kind)).toEqual(["notice", "text"]);

    const deepEntries: FileEntry[] = [header];
    let sourceLeafId = "base";
    let sourceMessageId = "base";
    deepEntries.push({
      type: "message",
      id: sourceMessageId,
      parentId: null,
      timestamp: header.timestamp,
      message: { role: "user", content: "base", timestamp: 1 },
    });
    for (let index = 0; index < 18; index += 1) {
      const nextMarkerId = `marker-${index}`;
      const nextReplayId = `replay-${index}`;
      const nextProvenanceId = `provenance-${index}`;
      deepEntries.push(
        { ...marker, id: nextMarkerId, parentId: null },
        { ...replay, id: nextReplayId, parentId: nextMarkerId },
        {
          ...provenance,
          id: nextProvenanceId,
          parentId: nextReplayId,
          data: {
            version: 1,
            sourceLeafId,
            markerEntryId: nextMarkerId,
            replayStartEntryId: nextReplayId,
            replayEndEntryId: nextReplayId,
            mappings: [{ sourceEntryId: sourceMessageId, replayedEntryId: nextReplayId }],
          },
        },
      );
      sourceLeafId = nextProvenanceId;
      sourceMessageId = nextReplayId;
    }
    const tooDeep = SessionManager.inMemory("/project", undefined, deepEntries);
    expect(projectConversationDisplay(tooDeep).map((part) => part.kind)).toEqual([
      "notice",
      "text",
    ]);
  });
});
