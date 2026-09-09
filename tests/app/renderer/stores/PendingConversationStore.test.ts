import { createStore, mount } from "r-state-tree";
import { describe, expect, it } from "vitest";
import { PendingConversationStore } from "../../../../src/renderer/stores/PendingConversationStore";

const configuration = {
  provider: "provider",
  modelId: "model",
  thinkingLevel: "medium" as const,
  fastMode: false,
};

describe("PendingConversationStore", () => {
  it("owns shared name, configuration, saved-prompt, resolution, and materialization behavior", () => {
    const store = mount(createStore(PendingConversationStore, { sessionId: "pending-1" }));
    store.setName(" Saved plan ");
    store.setConfiguration(configuration);
    store.createDraft("Do this later", []);
    store.setDraftResolved(true);

    expect(store).toMatchObject({
      sessionId: "pending-1",
      name: "Saved plan",
      configuration,
      resolved: true,
      messageCount: 0,
    });
    expect(store.activateDraft()).toMatchObject({ text: "Do this later", resolved: true });

    store.createDraft("Start now", []);
    store.markMaterialized();
    expect(store.draftPrompt).toBeUndefined();
    expect(store.configuration).toBeUndefined();
    expect(store.messageCount).toBe(1);
    store[Symbol.dispose]();
  });
});
