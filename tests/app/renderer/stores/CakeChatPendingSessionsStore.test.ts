import { createStore, mount, toSnapshot } from "r-state-tree";
import { describe, expect, it } from "vitest";
import { CakeChatPendingSessionsStore } from "../../../../src/renderer/stores/CakeChatPendingSessionsStore";

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
    store.setConfiguration("pending-1", configuration);
    store.rename("pending-1", "Saved plan");
    store.createDraft("pending-1", "Do this later", []);

    expect(store.newSessionRequest("pending-1", [])).toEqual({
      tools: [],
      configuration,
      name: "Saved plan",
    });
    expect(toSnapshot(store)).toMatchObject({
      state: {
        sessions: [
          {
            sessionId: "pending-1",
            started: false,
            configuration,
            name: "Saved plan",
            draftPrompt: { text: "Do this later", attachments: [], resolved: false },
          },
        ],
      },
    });
    store[Symbol.dispose]();
  });

  it("retains optimistic metadata through materialization and drops it on catalog reconciliation", () => {
    const store = mount(createStore(CakeChatPendingSessionsStore, {}));
    store.create("pending-1");
    store.createDraft("pending-1", "Start now", []);

    expect(store.activateDraft("pending-1")).toEqual({
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
