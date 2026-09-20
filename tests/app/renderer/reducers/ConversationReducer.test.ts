import { toSnapshot } from "r-state-tree";
import { describe, expect, it } from "vitest";
import type { ConversationSnapshot } from "../../../../src/domain/conversations/conversation-data";
import { Conversation } from "../../../../src/renderer/models/Conversation";
import {
  applyConversationSnapshot,
  applyConversationUpdate,
  applyDiscussionSessionUpdate,
} from "../../../../src/renderer/reducers/ConversationReducer";

const snapshot = (parts: ConversationSnapshot["parts"] = []): ConversationSnapshot => ({
  sessionId: "session",
  sessionFile: "/sessions/session.jsonl",
  parts,
  models: [],
  thinkingLevel: "off",
  availableThinkingLevels: [],
  streaming: false,
  diagnostics: [],
  commands: [],
  compatibility: { resources: [], diagnostics: [] },
  extensionUi: { statuses: [] },
  tree: [],
});

describe("ConversationReducer", () => {
  it("hydrates an independently observed Conversation and applies ordered events", () => {
    const model = Conversation.create({ sessionId: "session" });
    applyConversationUpdate(model, { _tag: "Snapshot", revision: 1, snapshot: snapshot() });
    const transcriptIdentity = model.parts;

    applyConversationUpdate(model, {
      _tag: "Event",
      revision: 2,
      event: {
        _tag: "PartUpdated",
        sessionId: "session",
        part: {
          id: "assistant",
          kind: "text",
          role: "assistant",
          text: "Done",
          status: "complete",
        },
      },
    });

    expect(model.observedSnapshotRevision).toBe(1);
    expect(model.parts).toBe(transcriptIdentity);
    expect(model.uiParts[0]).toEqual(expect.objectContaining({ text: "Done" }));
    model[Symbol.dispose]();
  });

  it.each(["Snapshot", "SnapshotUpdated"] as const)(
    "rejects a mismatched %s without mutating the Conversation",
    (kind) => {
      const model = Conversation.create({ sessionId: "session" });
      applyConversationUpdate(model, { _tag: "Snapshot", revision: 1, snapshot: snapshot() });
      const before = toSnapshot(model);
      const mismatched = { ...snapshot(), sessionId: "other", sessionFile: "/other.jsonl" };

      expect(() =>
        applyConversationUpdate(
          model,
          kind === "Snapshot"
            ? { _tag: "Snapshot", revision: 2, snapshot: mismatched }
            : {
                _tag: "Event",
                revision: 2,
                event: { _tag: "SnapshotUpdated", snapshot: mismatched },
              },
        ),
      ).toThrow("Conversation snapshot identity collision: session");
      expect(toSnapshot(model)).toEqual(before);
      model[Symbol.dispose]();
    },
  );

  it("rejects an initial Discussion snapshot whose inner Conversation identity disagrees", () => {
    const model = Conversation.create({ sessionId: "session" });
    applyConversationUpdate(model, { _tag: "Snapshot", revision: 1, snapshot: snapshot() });
    const before = toSnapshot(model);

    expect(() =>
      applyDiscussionSessionUpdate(model, "session", {
        _tag: "Snapshot",
        revision: 2,
        snapshot: {
          identity: {
            _tag: "DiscussionSession",
            sessionId: "session",
            parentSessionId: "parent",
          },
          conversation: { ...snapshot(), sessionId: "other", sessionFile: "/other.jsonl" },
        },
      }),
    ).toThrow("Conversation snapshot identity collision: session");
    expect(toSnapshot(model)).toEqual(before);
    model[Symbol.dispose]();
  });

  it("preserves compacted historical work-log parts in durable snapshots", () => {
    const model = Conversation.create({ sessionId: "session" });
    applyConversationSnapshot(
      model,
      snapshot([
        {
          id: "compacted-tool",
          kind: "tool",
          name: "bash",
          input: "pnpm test",
          output: "passed",
          state: "success",
        },
      ]),
    );

    expect(model.uiParts).toEqual([
      expect.objectContaining({ kind: "tool", name: "bash", output: "passed" }),
    ]);
    model[Symbol.dispose]();
  });
});
