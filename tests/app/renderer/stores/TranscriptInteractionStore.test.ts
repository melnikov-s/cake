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

describe("message selection", () => {
  const user = (id: string): UiPart => ({
    id,
    kind: "text",
    role: "user",
    text: id,
    status: "complete",
  });
  const assistant = (id: string, extra: Partial<Extract<UiPart, { kind: "text" }>> = {}) =>
    ({
      id,
      kind: "text",
      role: "assistant",
      text: id,
      status: "complete",
      ...extra,
    }) satisfies UiPart;
  const tool: UiPart = { id: "tool-1", kind: "tool", name: "read", input: "", state: "success" };

  function selectionStore(state: { parts: UiPart[] }) {
    return mount(
      createStore(TranscriptInteractionStore, {
        parts: () => state.parts,
        loading: () => false,
      }),
    );
  }

  it("walks assistant messages only, newest first, and clears past the newest", () => {
    const state = observable<{ parts: UiPart[] }>({
      parts: [
        user("user-1"),
        assistant("assistant-1"),
        user("user-2"),
        tool,
        assistant("assistant-2"),
        user("user-3"),
      ],
    });
    using store = selectionStore(state);
    expect(store.selectNextAssistantMessage()).toBe(false);
    expect(store.selectedMessageId).toBeUndefined();

    expect(store.selectPreviousAssistantMessage()).toBe(true);
    expect(store.selectedMessageId).toBe("assistant-2");
    expect(store.messageSelection?.origin).toBe("keyboard");
    store.selectPreviousAssistantMessage();
    expect(store.selectedMessageId).toBe("assistant-1");

    // The oldest assistant message stays selected and gets a fresh reveal revision.
    const revision = store.messageSelection!.revision;
    expect(store.selectPreviousAssistantMessage()).toBe(true);
    expect(store.selectedMessageId).toBe("assistant-1");
    expect(store.messageSelection!.revision).toBe(revision + 1);

    store.selectNextAssistantMessage();
    expect(store.selectedMessageId).toBe("assistant-2");
    expect(store.selectNextAssistantMessage()).toBe(true);
    expect(store.selectedMessageId).toBeUndefined();
    expect(store.messageSelection).toBeUndefined();
  });

  it("skips subagent reports and empty assistant text", () => {
    const state = observable<{ parts: UiPart[] }>({
      parts: [
        assistant("assistant-1"),
        assistant("empty", { text: "" }),
        assistant("report", {
          // Only presence matters to selection; the full origin is irrelevant here.
          subagentReport: { task: "Review" } as Extract<UiPart, { kind: "text" }>["subagentReport"],
        }),
      ],
    });
    using store = selectionStore(state);
    store.selectPreviousAssistantMessage();
    expect(store.selectedMessageId).toBe("assistant-1");
  });

  it("reports nothing to select in a transcript without assistant messages", () => {
    const state = observable<{ parts: UiPart[] }>({ parts: [user("user-1")] });
    using store = selectionStore(state);
    expect(store.selectPreviousAssistantMessage()).toBe(false);
    expect(store.messageSelection).toBeUndefined();
  });

  it("continues keyboard selection from a linked message of any role", () => {
    const state = observable<{ parts: UiPart[] }>({
      parts: [assistant("assistant-1"), user("user-1"), assistant("assistant-2")],
    });
    using store = selectionStore(state);
    store.navigateToMessage("user-1");
    expect(store.selectedMessageId).toBe("user-1");
    store.selectPreviousAssistantMessage();
    expect(store.selectedMessageId).toBe("assistant-1");
    store.navigateToMessage("user-1");
    store.selectNextAssistantMessage();
    expect(store.selectedMessageId).toBe("assistant-2");
  });

  it("keeps a streamed message selected when it settles under its entry id", () => {
    const state = observable<{ parts: UiPart[] }>({
      parts: [user("user-1"), assistant("stream-1", { renderKey: "turn-1", status: "streaming" })],
    });
    using store = selectionStore(state);
    store.selectPreviousAssistantMessage();
    expect(store.selectedMessageId).toBe("stream-1");
    state.parts = [user("user-1"), assistant("entry-1", { renderKey: "turn-1" })];
    expect(store.selectedMessageId).toBe("entry-1");
    state.parts = [user("user-1")];
    expect(store.selectedMessageId).toBeUndefined();
    // A vanished selection behaves like no selection.
    expect(store.selectNextAssistantMessage()).toBe(false);
  });
});
