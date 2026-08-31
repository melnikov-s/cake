import { applySnapshot } from "r-state-tree";
import { expect, it } from "vitest";
import type { ConversationSnapshot } from "../../../../src/domain/conversation-data";
import { Session } from "../../../../src/renderer/models/Session";
import { toSessionSnapshot } from "../../../../src/utils/session-snapshot";

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
    sessions: [],
    tree: [],
    artifacts: [],
  };
  const converted = toSessionSnapshot(snapshot);
  expect(converted).toBeDefined();
  applySnapshot(model, converted);
  expect(model.sessionFile).toBe("/f");
});
