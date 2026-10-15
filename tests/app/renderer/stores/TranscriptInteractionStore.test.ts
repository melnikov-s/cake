import { createStore, mount, observable } from "r-state-tree";
import type { UiPart } from "../../../../src/contracts/conversations/session-contract";
import { describe, expect, it } from "vitest";
import { TranscriptInteractionStore } from "../../../../src/renderer/stores/TranscriptInteractionStore";

describe("TranscriptInteractionStore", () => {
  // Retained scroll-adapter regression: repeated navigation must invalidate a saved
  // anchor and issue a fresh revision. A compact Chat cannot prove Virtuoso/scroll
  // restoration, and mocking its callbacks would not be an honest UI replacement.
  // This checks the request policy only, not native scrolling or geometry.
  it("invalidates the saved anchor and revises repeated message navigation", () => {
    using store = mount(
      createStore(TranscriptInteractionStore, {
        parts: () => [],
        loading: () => false,
      }),
    );
    store.setTranscriptScrollPosition({ kind: "message", messageId: "user-1", offset: -20 });
    store.navigateToMessage("assistant-1");
    store.navigateToMessage("assistant-1");
    expect(store.transcriptScrollPosition).toBeUndefined();
    expect(store.messageSelection).toMatchObject({
      messageId: "assistant-1",
      origin: "navigation",
      revision: 2,
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
            subagentReport: { task: "Review" } as Extract<
              UiPart,
              { kind: "text" }
            >["subagentReport"],
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
        parts: [
          user("user-1"),
          assistant("stream-1", { renderKey: "turn-1", status: "streaming" }),
        ],
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

  // Changed-files churn and basic formatting toggles are already covered through
  // real Root/Models/Stores in chat-surface-workflow.test.tsx. Projection handoff
  // and failed formatting/retry live in transcript-interaction-workflow.test.tsx.
});
