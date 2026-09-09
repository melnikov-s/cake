import { createStore, mount, toSnapshot } from "r-state-tree";
import { describe, expect, it } from "vitest";
import { CakeChatPendingSessionsStore } from "../../../../src/renderer/stores/CakeChatPendingSessionsStore";
import { PendingConversationStore } from "../../../../src/renderer/stores/PendingConversationStore";

const configuration = {
  provider: "provider",
  modelId: "model",
  thinkingLevel: "medium" as const,
  fastMode: false,
};

describe("CakeChatPendingSessionsStore", () => {
  it("persists pending configuration, name, and saved-draft state", () => {
    const store = mount(
      createStore(CakeChatPendingSessionsStore, {
        defaultConfiguration: () => configuration,
      }),
    );
    store.create("pending-1");
    const conversation = store.conversation("pending-1")!;
    conversation.setConfiguration(configuration);
    store.rename("pending-1", "Saved plan");
    conversation.createDraft("Do this later", []);

    expect(conversation).toBeInstanceOf(PendingConversationStore);
    expect(store.conversation("pending-1")).toBe(conversation);
    expect(store.newSessionRequest("pending-1", [])).toEqual({
      tools: [],
      configuration,
      name: "Saved plan",
    });
    expect(toSnapshot(store)).toMatchObject({
      state: { conversationIds: ["pending-1"], pendingSessionIds: ["pending-1"] },
      children: {
        conversations: [
          {
            key: "pending-1",
            state: {
              configuration,
              name: "Saved plan",
              draftPrompt: { text: "Do this later", attachments: [], resolved: false },
            },
          },
        ],
      },
    });
    const snapshot = toSnapshot(store);
    store[Symbol.dispose]();

    const restored = mount(createStore(CakeChatPendingSessionsStore, {}), { snapshot });
    expect(restored.conversation("pending-1")).toMatchObject({
      name: "Saved plan",
      configuration,
      draftPrompt: { text: "Do this later", attachments: [], resolved: false },
    });
    restored[Symbol.dispose]();
  });

  it("retains optimistic metadata through materialization and drops it on catalog reconciliation", () => {
    const store = mount(createStore(CakeChatPendingSessionsStore, {}));
    store.create("pending-1");
    const conversation = store.conversation("pending-1")!;
    conversation.createDraft("Start now", []);

    expect(conversation.activateDraft()).toEqual({
      text: "Start now",
      attachments: [],
      resolved: false,
    });
    store.markMaterialized("pending-1");
    expect(store.isPending("pending-1")).toBe(false);
    expect(store.summaries[0]).toMatchObject({ sessionId: "pending-1", messageCount: 1 });

    store.reconcileMaterialized(new Set(["pending-1"]));
    expect(store.summaries).toEqual([]);
    store[Symbol.dispose]();
  });
});
