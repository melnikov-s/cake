import { describe, expect, it } from "vitest";
import type { ConversationSnapshot } from "../../../../src/domain/conversations/conversation-data";
import { Conversation } from "../../../../src/renderer/models/Conversation";
import {
  applyConversationSnapshot,
  applyConversationUpdate,
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
