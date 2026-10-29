import { describe, expect, it } from "vitest";
import type { UiPart } from "../../../../src/contracts/conversations/session-contract";
import { applyConversationSnapshot } from "../../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "../fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "../renderer-store-fixture";

const user: UiPart = {
  id: "user-1",
  entryId: "user-entry",
  kind: "text",
  role: "user",
  text: "Question",
  status: "complete",
};
const assistant: Extract<UiPart, { kind: "text" }> = {
  id: "assistant-1",
  entryId: "assistant-entry",
  kind: "text",
  role: "assistant",
  text: "Answer",
  status: "complete",
};

function transcriptAdapter(parts: UiPart[]) {
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project" })],
    sessions: [sessionSummary({ sessionId: "session-1", projectPath: "/project" })],
  });
  const session = fixture.root.sessionRegistry.load("session-1", "/project");
  const publish = (nextParts: UiPart[]) => {
    applyConversationSnapshot(session.model, {
      sessionId: "session-1",
      sessionFile: "/project/session-1.jsonl",
      parts: nextParts,
      models: [],
      thinkingLevel: "off",
      availableThinkingLevels: ["off"],
      streaming: nextParts.some((part) => part.kind === "text" && part.status === "streaming"),
      diagnostics: [],
      commands: [],
      compatibility: { resources: [], diagnostics: [] },
      extensionUi: { statuses: [] },
      tree: [],
    });
  };
  publish(parts);
  fixture.root.navigationStore.selectProjectSession("session-1");
  fixture.root.projectWorkbenchStore.showLoadedSession("session-1");
  return {
    root: fixture.root,
    interaction: session.conversationSessionStore.chatStore.transcriptInteraction,
    publish,
    [Symbol.dispose]() {
      fixture[Symbol.dispose]();
    },
  };
}

// Native/control-adapter exceptions, not parallel renderer workflow coverage:
// openSession(messageId) is a control-protocol operation; selection methods are
// the native keyboard adapter. Keep real Root/catalog/navigation/Models and no
// fake parts callbacks or Store casts. Native key routing, focus and real Virtuoso
// reveal are covered by message-keyboard-selection/message-navigation Electron
// suites, not by jsdom with invented geometry. Visible formatting/failure/retry
// lives in transcript-interaction-workflow; disclosure in chat-surface-workflow.
describe("Transcript native/control adapter integration", () => {
  it("resolves entry identities, invalidates saved anchors for repeated targets, and ignores unavailable messages", async () => {
    using fixture = transcriptAdapter([user, assistant]);
    const { interaction } = fixture;
    interaction.setTranscriptScrollPosition({ kind: "message", messageId: "user-1", offset: -20 });

    await expect(
      fixture.root.navigationStore.openSession("session-1", "assistant-entry"),
    ).resolves.toBe(true);
    expect(interaction.transcriptScrollPosition).toBeUndefined();
    expect(interaction.messageSelection).toMatchObject({
      messageId: "assistant-1",
      origin: "navigation",
      revision: 1,
    });
    interaction.setTranscriptScrollPosition({ kind: "bottom" });
    await expect(
      fixture.root.navigationStore.openSession("session-1", "assistant-1"),
    ).resolves.toBe(true);
    expect(interaction.transcriptScrollPosition).toBeUndefined();
    expect(interaction.messageSelection).toMatchObject({
      messageId: "assistant-1",
      origin: "navigation",
      revision: 2,
    });

    interaction.setTranscriptScrollPosition({ kind: "top" });
    await expect(
      fixture.root.navigationStore.openSession("session-1", "missing-entry"),
    ).resolves.toBe(false);
    expect(interaction.transcriptScrollPosition).toEqual({ kind: "top" });
    expect(interaction.messageSelection).toMatchObject({
      messageId: "assistant-1",
      origin: "navigation",
      revision: 2,
    });
  });

  it("skips activity and empty assistant placeholders but includes attachment-only user anchors", () => {
    using fixture = transcriptAdapter([
      { ...user, id: "user", text: "" },
      { ...assistant, id: "empty", text: "" },
      { id: "tool", kind: "tool", name: "read", input: "", state: "success" },
    ]);
    const store = fixture.interaction;
    expect(store.selectPreviousMessage()).toBe(true);
    expect(store.selectedMessageId).toBe("user");
    store.selectNextMessage();
    expect(store.selectedMessageId).toBeUndefined();
    fixture.publish([{ ...assistant, id: "empty", text: "" }]);
    expect(store.selectPreviousMessage()).toBe(false);
  });

  it("continues keyboard selection from a linked activity between conversational entries", () => {
    using fixture = transcriptAdapter([
      { ...user, id: "before" },
      { id: "tool", kind: "tool", name: "read", input: "", state: "success" },
      { ...assistant, id: "after" },
    ]);
    const store = fixture.interaction;
    store.navigateToMessage("tool");
    store.selectPreviousMessage();
    expect(store.selectedMessageId).toBe("before");
    store.navigateToMessage("tool");
    store.selectNextMessage();
    expect(store.selectedMessageId).toBe("after");
  });

  it("does not confuse a skill with its accompanying text when both settle", () => {
    const skill = (id: string): UiPart => ({
      id,
      kind: "skill",
      name: "review",
      content: "Review",
      renderKey: "input",
    });
    const text = (id: string): UiPart => ({ ...user, id, renderKey: "input" });
    using fixture = transcriptAdapter([skill("live-skill"), text("live-text")]);
    const store = fixture.interaction;
    store.selectPreviousMessage();
    fixture.publish([skill("settled-skill"), text("settled-text")]);
    expect(store.selectedMessageId).toBe("settled-text");
    store.selectPreviousMessage();
    fixture.publish([skill("resettled-skill"), text("resettled-text")]);
    expect(store.selectedMessageId).toBe("resettled-skill");
  });

  it.each(["assistant", "user", "skill"] as const)(
    "keeps a streamed %s selected when it settles under its entry id",
    (kind) => {
      const part = (id: string): UiPart =>
        kind === "skill"
          ? { id, kind, name: "review", content: "Review", renderKey: "turn-1" }
          : { ...assistant, id, role: kind, renderKey: "turn-1" };
      using fixture = transcriptAdapter([part("stream-1")]);
      const store = fixture.interaction;
      store.selectPreviousMessage();
      expect(store.selectedMessageId).toBe("stream-1");
      const revision = store.messageSelection!.revision;
      fixture.publish([part("entry-1")]);
      expect(store.selectedMessageId).toBe("entry-1");
      expect(store.messageSelection!.revision).toBe(revision);
      fixture.publish([]);
      expect(store.selectedMessageId).toBeUndefined();
      expect(store.selectNextMessage()).toBe(false);
    },
  );
});
