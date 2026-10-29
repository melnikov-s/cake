import { toSnapshot } from "r-state-tree";
import { expect, it } from "vitest";
import { Conversation } from "../../../../src/renderer/models/Conversation";
import {
  messageSnapshots,
  applyPartUpdate,
} from "../../../../src/renderer/reducers/SessionPartReducer";
import {
  applyConversationSnapshot,
  applyConversationUpdate,
} from "../../../../src/renderer/reducers/ConversationReducer";

// Transcript output and actions are covered by transcript-rendering-workflow,
// work-log-presentation-workflow and session-layout-workflow. React cannot prove
// memoization or the transport/renderer identity and snapshot round-trip below.
it("memoizes projected transcript parts while retaining keyed Models through authority updates", () => {
  using model = Conversation.create({
    sessionId: "s",
    parts: [
      {
        id: "s:assistant-1",
        partKey: "assistant-1",
        kind: "text",
        role: "assistant",
        text: "First",
        status: "streaming",
      },
    ],
  });

  const first = model.uiParts;
  expect(model.uiParts).toBe(first);
  expect(model.uiParts[0]).toBe(first[0]);

  const messages = model.parts;
  const message = model.parts[0];
  applyConversationUpdate(model, {
    _tag: "Event",
    revision: 2,
    event: {
      _tag: "PartUpdated",
      sessionId: "s",
      part: {
        id: "assistant-1",
        kind: "text",
        role: "assistant",
        text: "Second",
        status: "streaming",
      },
    },
  });

  expect(model.parts).toBe(messages);
  expect(model.parts[0]).toBe(message);
  expect(model.uiParts).not.toBe(first);
  expect(model.uiParts[0]).not.toBe(first[0]);
});

it("separates Pi entry identity from Cake display-part identity only where needed", () => {
  const parts = [
    {
      id: "entry-a1b2c3d4-text-0",
      entryId: "a1b2c3d4",
      kind: "text" as const,
      role: "assistant" as const,
      text: "First",
      status: "complete" as const,
    },
    {
      id: "entry-a1b2c3d4-text-1",
      entryId: "a1b2c3d4",
      kind: "text" as const,
      role: "assistant" as const,
      text: "Second",
      status: "complete" as const,
    },
    { id: "notice-1", kind: "notice" as const, tone: "info" as const, title: "Notice" },
  ];
  const first = Conversation.create({ sessionId: "one", parts: messageSnapshots(parts, "one") });
  const fork = Conversation.create({ sessionId: "two", parts: messageSnapshots(parts, "two") });
  expect(first.parts[0]!.piId).toBe("a1b2c3d4");
  expect(first.parts[1]!.piId).toBe("a1b2c3d4");
  expect(first.parts[0]!.id).not.toBe(first.parts[1]!.id);
  expect(first.parts[0]!.id).not.toBe(fork.parts[0]!.id);
  expect(first.parts[2]!.piId).toBeUndefined();
  expect(first.uiParts).toEqual(parts);
  const message = first.parts[0]!;
  const textPart = parts[0]!;
  if (textPart.kind !== "text") throw new Error("Expected text fixture");
  applyPartUpdate(first.parts, { ...textPart, text: "Updated" }, "one");
  expect(first.parts[0]).toBe(message);
  expect(message.piId).toBe("a1b2c3d4");
  const restored = Conversation.create(toSnapshot(first));
  expect(restored.parts[0]!.piId).toBe(message.piId);
  expect(restored.parts[0]!.partKey).toBe(message.partKey);
  first[Symbol.dispose]();
  fork[Symbol.dispose]();
  restored[Symbol.dispose]();
});

it("keeps Pi tree navigation identifiers distinct from renderer identity", () => {
  const session = Conversation.create({ sessionId: "session" });
  applyConversationSnapshot(session, {
    sessionId: "session",
    sessionFile: "/session.jsonl",
    parts: [],
    models: [],
    thinkingLevel: "off",
    availableThinkingLevels: ["off"],
    streaming: false,
    diagnostics: [],
    commands: [],
    compatibility: { resources: [], diagnostics: [] },
    extensionUi: { statuses: [] },
    tree: [{ id: "child", parentId: "parent", type: "message", preview: "Message", active: true }],
  });
  expect(session.tree[0]).toMatchObject({
    id: "session:child",
    piId: "child",
    parentPiId: "parent",
  });
  session[Symbol.dispose]();
});
