import { createStore, mount } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import { GlobalChatStore } from "../../../../src/renderer/stores/GlobalChatStore";

function createTestStore() {
  const port = {
    open: vi.fn(async () => undefined),
    prompt: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined)
  };
  const store = mount(createStore(GlobalChatStore, {
    port,
    tools: () => [{ name: "get_app_state", description: "Read app state" }]
  }));
  return { store, port };
}

describe("GlobalChatStore", () => {
  it("hydrates the persistent transcript and submits a follow-up", async () => {
    const { store, port } = createTestStore();
    await vi.waitFor(() => expect(port.open).toHaveBeenCalledOnce());
    store.receive({
      type: "global-chat-snapshot-received",
      sessionId: "global-1",
      streaming: false,
      parts: [{ id: "old", kind: "text", role: "assistant", text: "The PDF task is task-7.", status: "complete" }]
    });

    store.setDraft("Open it");
    await store.submit();

    expect(store.parts.map((part) => part.kind === "text" ? part.text : "")).toEqual(["The PDF task is task-7.", "Open it"]);
    expect(port.prompt).toHaveBeenCalledWith(expect.objectContaining({ text: "Open it" }));
    store[Symbol.dispose]();
  });

  it("starts a new hidden session when cleared", async () => {
    const { store, port } = createTestStore();
    await vi.waitFor(() => expect(port.open).toHaveBeenCalledOnce());

    await store.clear();

    expect(port.clear).toHaveBeenCalledWith(expect.objectContaining({ tools: [{ name: "get_app_state", description: "Read app state" }] }));
    store[Symbol.dispose]();
  });
});
