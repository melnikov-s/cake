import { createStore, mount } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import { ExtensionUiStore } from "../../../../src/renderer/stores/ExtensionUiStore";

describe("ExtensionUiStore", () => {
  it("applies each focused editor intent exactly once and ignores other sessions", () => {
    let draft = "existing";
    const requestComposerFocus = vi.fn();
    const store = mount(
      createStore(ExtensionUiStore, {
        activeSessionModel: () => undefined,
        sessionContext: () => ({ sessionId: "active" }),
        setDraft: (value) => {
          draft = typeof value === "function" ? value(draft) : value;
        },
        requestComposerFocus,
      }),
    );

    store.receive({
      type: "extension-ui-intent",
      sessionId: "active",
      intent: { kind: "editor-text", text: " appended", mode: "insert" },
    });
    store.receive({
      type: "extension-ui-intent",
      sessionId: "other",
      intent: { kind: "editor-text", text: "wrong", mode: "replace" },
    });

    expect(draft).toBe("existing appended");
    expect(requestComposerFocus).toHaveBeenCalledOnce();
    store[Symbol.dispose]();
  });

  it("owns transient notifications without putting them in a Session Model", () => {
    const store = mount(
      createStore(ExtensionUiStore, {
        activeSessionModel: () => undefined,
        sessionContext: () => ({ sessionId: "active" }),
        setDraft: () => undefined,
        requestComposerFocus: () => undefined,
      }),
    );

    store.receive({
      type: "extension-ui-intent",
      sessionId: "active",
      intent: { kind: "notify", id: "notice", message: "Connected", tone: "info" },
    });
    expect(store.notifications.map((notification) => notification.message)).toEqual(["Connected"]);

    store.dismissNotification("notice");
    expect(store.notifications).toEqual([]);
    store[Symbol.dispose]();
  });
});
