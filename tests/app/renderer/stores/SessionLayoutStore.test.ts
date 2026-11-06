import { toSnapshot } from "r-state-tree";
import { describe, expect, it } from "vitest";
import { createRendererStoreFixture } from "../renderer-store-fixture";

describe("Focused conversation navigation", () => {
  it("retains backward and forward history without duplicate visits on reopening the selection", () => {
    using fixture = createRendererStoreFixture();
    const store = fixture.root.sessionLayoutStore;
    store.showSession("home");
    store.showSession("parent");
    store.showSession("child");
    store.showSession("child");
    expect(store.goBack()).toBe("parent");
    expect(store.goBack()).toBe("home");
    expect(store.goForward()).toBe("parent");
    using restored = createRendererStoreFixture({ snapshot: toSnapshot(fixture.root) });
    expect(restored.root.sessionLayoutStore.focusedSessionId).toBe("parent");
    expect(restored.root.sessionLayoutStore.goForward()).toBe("child");
  });

  it("retains conversation-owned drafts and reading selection while navigating ancestors and history", () => {
    using fixture = createRendererStoreFixture();
    const { root } = fixture;
    const parent = root.sessionRegistry.pendingSessions.prepareStaged("/project", "parent");
    const child = root.sessionRegistry.pendingSessions.prepareStaged("/project", "child");
    const parentChat = parent.conversationSessionStore.chatStore;
    const childChat = child.conversationSessionStore.chatStore;
    parent.conversationSessionStore.composerStore.draftStore.setText("parent draft");
    child.conversationSessionStore.composerStore.draftStore.setText("child draft");
    parentChat.transcriptInteraction.setTranscriptScrollPosition({ kind: "top" });
    childChat.transcriptInteraction.setTranscriptScrollPosition({ kind: "top" });
    root.navigationStore.showLoadedProjectSession("parent");
    root.navigationStore.showLoadedProjectSession("child");
    root.navigationStore.navigateBack();
    expect(root.sessionLayoutStore.focusedSessionId).toBe("parent");
    expect(parent.conversationSessionStore.composerStore.draftStore.text).toBe("parent draft");
    root.navigationStore.navigateForward();
    expect(root.sessionLayoutStore.focusedSessionId).toBe("child");
    expect(child.conversationSessionStore.composerStore.draftStore.text).toBe("child draft");
    expect(parentChat.transcriptInteraction.transcriptScrollPosition).toEqual({ kind: "top" });
    expect(childChat.transcriptInteraction.transcriptScrollPosition).toEqual({ kind: "top" });
    expect(parent.conversationSessionStore.chatStore).toBe(parentChat);
    expect(child.conversationSessionStore.chatStore).toBe(childChat);
  });

  it("retains a staged forward visit and removes retired identities without losing the focused survivor", () => {
    using fixture = createRendererStoreFixture();
    const store = fixture.root.sessionLayoutStore;
    store.showSession("first");
    store.showSession("staged");
    store.showSession("last");
    expect(store.goBack()).toBe("staged");
    store.replaceSession("staged", "saved");
    expect(store.focusedSessionId).toBe("saved");
    store.removeSessions(["first"]);
    expect(store.focusedSessionId).toBe("saved");
    expect(store.goForward()).toBe("last");
    store.removeSessions(["saved", "last"]);
    expect(store.focusedSessionId).toBeUndefined();
  });
});
