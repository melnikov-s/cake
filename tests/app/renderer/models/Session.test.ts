import { toSnapshot } from "r-state-tree";
import { expect, it } from "vitest";
import type { ConversationSnapshot } from "../../../../src/domain/conversation-data";
import { Session } from "../../../../src/renderer/models/Session";
import {
  messageSnapshots,
  applyPartUpdate,
} from "../../../../src/renderer/reducers/SessionPartReducer";
import { applyConversationSnapshot } from "../../../../src/renderer/reducers/ConversationReducer";

it("memoizes projected transcript parts until a message changes", () => {
  const model = Session.create({
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

  model.parts[0]!.update({
    id: "assistant-1",
    kind: "text",
    role: "assistant",
    text: "Second",
    status: "streaming",
  });

  expect(model.uiParts).not.toBe(first);
  expect(model.uiParts[0]).not.toBe(first[0]);
});

it("hydrates a complete authoritative conversation snapshot", () => {
  const model = Session.create({ sessionId: "s", workingDirectory: "/p" });
  const snapshot: ConversationSnapshot = {
    workingDirectory: "/p",
    sessionId: "s",
    sessionFile: "/f",
    parts: [],
    models: [],
    thinkingLevel: "off",
    availableThinkingLevels: ["off"],
    streaming: false,
    diagnostics: [],
    commands: [],
    compatibility: { resources: [], diagnostics: [] },
    extensionUi: { statuses: [] },
    tree: [],
    artifacts: [],
  };
  applyConversationSnapshot(model, snapshot);
  expect(model.sessionFile).toBe("/f");
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
  const first = Session.create({ sessionId: "one", parts: messageSnapshots(parts, "one") });
  const fork = Session.create({ sessionId: "two", parts: messageSnapshots(parts, "two") });
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
  const restored = Session.create(toSnapshot(first));
  expect(restored.parts[0]!.piId).toBe(message.piId);
  expect(restored.parts[0]!.partKey).toBe(message.partKey);
  first[Symbol.dispose]();
  fork[Symbol.dispose]();
  restored[Symbol.dispose]();
});

it("keeps Pi tree navigation identifiers distinct from renderer identity", () => {
  const session = Session.create({ sessionId: "session" });
  applyConversationSnapshot(session, {
    sessionId: "session",
    workingDirectory: "/project",
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
