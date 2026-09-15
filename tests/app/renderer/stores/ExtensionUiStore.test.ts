import { createStore, mount } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { Client } from "../../../../src/renderer/client/Client";
import { ExtensionUiStore } from "../../../../src/renderer/stores/ExtensionUiStore";
import { mountWithClient } from "../mount-with-client";

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

  it("responds to session-less provider authentication requests", async () => {
    const respondToUi = vi.fn(async () => undefined);
    const { root, subject: store } = mountWithClient(
      createStore(ExtensionUiStore, {
        activeSessionModel: () => undefined,
        sessionContext: () => undefined,
        setDraft: () => undefined,
        requestComposerFocus: () => undefined,
      }),
      { artifacts: { respondToUi } } as unknown as Client,
    );
    store.receive({
      type: "ui-requested",
      operationId: "00000000-0000-4000-8000-000000000001",
      uiRequestId: "00000000-0000-4000-8000-000000000002",
      sessionId: "provider-settings:1",
      kind: "secret",
      title: "Provider authentication",
      message: "Enter your API key",
    });

    await store.respond("secret-key");

    expect(respondToUi).toHaveBeenCalledWith({
      operationId: "00000000-0000-4000-8000-000000000001",
      uiRequestId: "00000000-0000-4000-8000-000000000002",
      sessionId: "provider-settings:1",
      value: "secret-key",
      cancelled: false,
    });
    root[Symbol.dispose]();
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
