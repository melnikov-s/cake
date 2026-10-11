import { createStore, mount } from "r-state-tree";
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
    expect(store.messageNavigationRequest).toEqual({ messageId: "assistant-1", revision: 2 });
  });

  // Changed-files churn and basic formatting toggles are already covered through
  // real Root/Models/Stores in chat-surface-workflow.test.tsx. Projection handoff
  // and failed formatting/retry live in transcript-interaction-workflow.test.tsx.
});
