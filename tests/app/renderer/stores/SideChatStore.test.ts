import { createStore, mount } from "r-state-tree";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatStore } from "../../../../src/renderer/stores/ChatStore";
import { SideChatStore } from "../../../../src/renderer/stores/SideChatStore";

describe("SideChatStore", () => {
  let store: SideChatStore;
  const onClose = vi.fn();

  beforeEach(() => {
    onClose.mockClear();
    store = mount(createStore(SideChatStore, { onClose }));
  });

  afterEach(() => {
    store[Symbol.dispose]();
  });

  it("keeps one side-chat target per primary session", () => {
    const selectionChat = { id: "selection" } as ChatStore;
    const subagentChat = { id: "subagent" } as ChatStore;

    store.open({
      key: "selection:one",
      title: "Selection chat",
      eyebrow: () => "Selection",
      chatStore: selectionChat,
    });
    store.open({
      key: "subagent:one",
      title: "Subagent",
      eyebrow: () => "Running",
      chatStore: subagentChat,
    });

    expect(store.target).toMatchObject({
      key: "subagent:one",
      title: "Subagent",
      chatStore: subagentChat,
    });

    store.close();
    expect(store.target).toBeUndefined();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
