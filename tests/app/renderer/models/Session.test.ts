import { applySnapshot } from "r-state-tree";
import { expect, it } from "vitest";
import type { ConversationSnapshot } from "../../../../src/domain/conversation-data";
import { Session } from "../../../../src/renderer/models/Session";
import { toSessionSnapshot } from "../../../../src/utils/session-snapshot";

it("memoizes projected transcript parts until a message changes", () => {
  const model = Session.create({
    sessionId: "s",
    parts: [
      {
        id: "assistant-1",
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
  const converted = toSessionSnapshot(snapshot);
  expect(converted).toBeDefined();
  applySnapshot(model, converted);
  expect(model.sessionFile).toBe("/f");
});
