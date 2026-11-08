import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import {
  appendAgentContextFork,
  agentContextForkEntryType,
} from "../../../src/services/pi/runtime/agent-context-fork";
import { projectConversationDisplay } from "../../../src/services/pi/runtime/conversation-display-projection";
import { projectSessionEntries } from "../../../src/services/pi/runtime/session-projection";
import { internalInputEntryType } from "../../../src/services/pi/runtime/internal-input-projection";
import { createLiveMessageProjector } from "../../../src/services/pi/runtime/message-projection";

const inheritedText =
  "<chat>\nCompressed inherited decisions\n</chat>\n\n<current-time>Backend clock (UTC): now</current-time>";
const task = "Investigate the new task. Keep literal <chat>quoted user content</chat>.";

it("groups exactly the inherited Pi entries as context, leaving only the added task as dialogue and retaining full model input", () => {
  const session = SessionManager.inMemory("/project");
  appendAgentContextFork(session, {
    entryId: "source-boundary",
    messages: [{ role: "user", content: inheritedText, timestamp: 1 }],
  });
  const input = {
    role: "user" as const,
    content: `Assignment guidance: investigate read-only.\n\nTask:\n${task}`,
    timestamp: 2,
  };
  const origin = {
    _tag: "UserWithReminders" as const,
    text: input.content,
    userText: task,
    notices: [],
  };
  session.appendCustomEntry(internalInputEntryType, { timestamp: 2, origin });
  const taskId = session.appendMessage(input);
  const live = createLiveMessageProjector({ internalInput: () => origin })({
    type: "message_start",
    message: input,
  });
  expect(live).toContainEqual(expect.objectContaining({ kind: "text", text: task }));
  for (const parts of [
    projectConversationDisplay(session),
    projectSessionEntries(session.getBranch()),
  ]) {
    expect(parts.filter((part) => part.kind === "text")).toEqual([
      expect.objectContaining({ entryId: taskId, text: task, role: "user" }),
    ]);
    expect(parts).toContainEqual(
      expect.objectContaining({
        kind: "context",
        title: "Inherited context",
        text: inheritedText,
      }),
    );
  }
  expect(session.buildSessionContext().messages).toEqual([
    { role: "user", content: inheritedText, timestamp: 1 },
    input,
  ]);
  // The same literal text submitted later is not inherited merely because its words match.
  const ordinaryId = session.appendMessage({ role: "user", content: inheritedText, timestamp: 3 });
  expect(projectConversationDisplay(session)).toContainEqual(
    expect.objectContaining({
      entryId: ordinaryId,
      kind: "text",
      text: inheritedText,
    }),
  );
});

it("leaves ordinary and human Side Chat messages with context-like text intact without exact provenance", () => {
  for (const metadata of [
    undefined,
    { entryId: "legacy-source" },
    { inheritedEntryIds: "invalid" },
  ]) {
    const session = SessionManager.inMemory("/project");
    if (metadata) session.appendCustomEntry(agentContextForkEntryType, metadata);
    session.appendMessage({ role: "user", content: inheritedText, timestamp: 1 });
    session.appendMessage({ role: "user", content: task, timestamp: 2 });
    expect(
      projectConversationDisplay(session)
        .filter((part) => part.kind === "text")
        .map((part) => part.text),
    ).toEqual([inheritedText, task]);
  }
});
