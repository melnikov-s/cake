import { createStore, mount, observable } from "r-state-tree";
import type { UiPart } from "../../../../src/contracts/conversations/session-contract";
import { TranscriptInteractionStore } from "../../../../src/renderer/stores/TranscriptInteractionStore";
import { describe, expect, it } from "vitest";
import { applyConversationSnapshot } from "../../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "../fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "../renderer-store-fixture";

// Native scroll-adapter exception: NavigationStore.openSession(messageId) is a
// control-protocol operation, not an accessible Chat action. Keep real navigation,
// session/catalog composition and projection here; jsdom cannot prove Virtuoso
// scrolling/restoration. Do not fake its callbacks or geometry. Visible formatting,
// projection/failure/retry lives in transcript-interaction-workflow; changed-files
// churn lives in chat-surface-workflow. This also replaces ChatStore's duplicate.
describe("Transcript control-protocol navigation boundary", () => {
  it("resolves entry identities, invalidates saved anchors for repeated targets, and ignores unavailable messages", async () => {
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: "/project" })],
      sessions: [sessionSummary({ sessionId: "session-1", projectPath: "/project" })],
    });
    const session = fixture.root.sessionRegistry.load("session-1", "/project");
    applyConversationSnapshot(session.model, {
      sessionId: "session-1",
      sessionFile: "/project/session-1.jsonl",
      parts: [
        {
          id: "user-1",
          entryId: "user-entry",
          kind: "text",
          role: "user",
          text: "Question",
          status: "complete",
        },
        {
          id: "assistant-1",
          entryId: "assistant-entry",
          kind: "text",
          role: "assistant",
          text: "Answer",
          status: "complete",
        },
      ],
      models: [],
      thinkingLevel: "off",
      availableThinkingLevels: ["off"],
      streaming: false,
      diagnostics: [],
      commands: [],
      compatibility: { resources: [], diagnostics: [] },
      extensionUi: { statuses: [] },
      tree: [],
    });
    fixture.root.navigationStore.selectProjectSession("session-1");
    fixture.root.projectWorkbenchStore.showLoadedSession("session-1");
    const interaction = session.conversationSessionStore.chatStore.transcriptInteraction;
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
});

describe("message selection identity", () => {
  const text = (id: string, extra: Partial<Extract<UiPart, { kind: "text" }>> = {}): UiPart => ({
    id,
    kind: "text",
    role: "assistant",
    text: id,
    status: "complete",
    ...extra,
  });

  function selectionStore(state: { parts: UiPart[] }) {
    return mount(
      createStore(TranscriptInteractionStore, {
        parts: () => state.parts,
        loading: () => false,
      }),
    );
  }

  it("skips activity and empty assistant placeholders but includes attachment-only user anchors", () => {
    const state = observable<{ parts: UiPart[] }>({
      parts: [
        text("user", { role: "user", text: "" }),
        text("empty", { text: "" }),
        { id: "tool", kind: "tool", name: "read", input: "", state: "success" },
      ],
    });
    using store = selectionStore(state);
    expect(store.selectPreviousMessage()).toBe(true);
    expect(store.selectedMessageId).toBe("user");
    store.selectNextMessage();
    expect(store.selectedMessageId).toBeUndefined();
    state.parts = [text("empty", { text: "" })];
    expect(store.selectPreviousMessage()).toBe(false);
  });

  it("continues keyboard selection from a linked activity between conversational entries", () => {
    const state = observable<{ parts: UiPart[] }>({
      parts: [
        text("before", { role: "user" }),
        { id: "tool", kind: "tool", name: "read", input: "", state: "success" },
        text("after"),
      ],
    });
    using store = selectionStore(state);
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
    const user = (id: string) => text(id, { role: "user", renderKey: "input" });
    const state = observable<{ parts: UiPart[] }>({
      parts: [skill("live-skill"), user("live-text")],
    });
    using store = selectionStore(state);
    store.selectPreviousMessage();
    state.parts = [skill("settled-skill"), user("settled-text")];
    expect(store.selectedMessageId).toBe("settled-text");
    store.selectPreviousMessage();
    state.parts = [skill("resettled-skill"), user("resettled-text")];
    expect(store.selectedMessageId).toBe("resettled-skill");
  });

  it.each(["assistant", "user", "skill"] as const)(
    "keeps a streamed %s selected when it settles under its entry id",
    (kind) => {
      const part = (id: string): UiPart =>
        kind === "skill"
          ? { id, kind, name: "review", content: "Review", renderKey: "turn-1" }
          : text(id, { role: kind, renderKey: "turn-1" });
      const state = observable<{ parts: UiPart[] }>({ parts: [part("stream-1")] });
      using store = selectionStore(state);
      store.selectPreviousMessage();
      expect(store.selectedMessageId).toBe("stream-1");
      const revision = store.messageSelection!.revision;
      state.parts = [part("entry-1")];
      expect(store.selectedMessageId).toBe("entry-1");
      expect(store.messageSelection!.revision).toBe(revision);
      state.parts = [];
      expect(store.selectedMessageId).toBeUndefined();
      expect(store.selectNextMessage()).toBe(false);
    },
  );
});
