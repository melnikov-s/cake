import { describe, expect, it } from "vitest";
import type { StoreSnapshot } from "r-state-tree";
import { CAKE_CHAT_SESSION_ID } from "../../../../src/contracts/cake-chats/cake-chat-identity";
import { browserInitialSnapshot } from "../../../../src/renderer/bootstrap/browser-initial-snapshot";
import type { AppSelection } from "../../../../src/renderer/stores/AppShellStore";
import { createRendererStoreFixture } from "../renderer-store-fixture";

function savedPresentation(hidden: boolean, selection: AppSelection): StoreSnapshot {
  const activeConversation =
    selection.kind === "project-session"
      ? selection
      : selection.kind === "settings" || selection.kind === "artifact-library"
        ? { kind: "project-session", sessionId: "previous" }
        : undefined;
  return {
    state: {},
    children: {
      sidebarStore: {
        state: { hidden, width: 330, navigationMode: "activity" },
        children: {},
      },
      appShellStore: {
        state: {
          selection,
          activeConversation,
          sessionHistory: [{ kind: "project-session", sessionId: "previous" }],
          sessionHistoryCursor: 0,
        },
        children: {},
      },
      sessionLayoutStore: {
        state: {
          layout: {
            kind: "pane",
            paneId: "saved-pane",
            history: ["previous"],
            historyCursor: 0,
          },
          focusedPaneId: "saved-pane",
        },
        children: {},
      },
    },
  };
}

const selections: AppSelection[] = [
  { kind: "project-session", sessionId: "previous" },
  { kind: "settings" },
  { kind: "artifact-library" },
  { kind: "workbench" },
  { kind: "cake-chat" },
];
const cakeChat = { kind: "cake-chat", sessionId: CAKE_CHAT_SESSION_ID };

describe("browser initial presentation", () => {
  it("starts a fresh phone in permanent Cake Chat with the sidebar closed", () => {
    using fixture = createRendererStoreFixture({
      snapshot: browserInitialSnapshot(undefined, true),
    });
    expect(fixture.root.appShellStore.selection).toEqual(cakeChat);
    expect(fixture.root.appShellStore.activeConversation).toEqual(cakeChat);
    expect(fixture.root.sidebarStore.visible).toBe(false);
  });

  it.each(selections)("starts phones in Cake Chat instead of restoring $kind", (selection) => {
    for (const hidden of [false, true]) {
      const saved = savedPresentation(hidden, selection);
      const before = structuredClone(saved);
      const initial = browserInitialSnapshot(saved, true);
      using fixture = createRendererStoreFixture({ snapshot: initial });
      expect(fixture.root.appShellStore.selection).toEqual(cakeChat);
      expect(fixture.root.appShellStore.activeConversation).toEqual(cakeChat);
      expect(fixture.root.sidebarStore.visible).toBe(false);
      expect(fixture.root.sidebarStore.width).toBe(330);
      expect(fixture.root.sidebarStore.navigationMode).toBe("activity");
      expect(fixture.root.sessionLayoutStore.focusedSessionId).toBe("previous");
      expect(initial.children.sessionLayoutStore).toBe(saved.children.sessionLayoutStore);
      expect(saved).toEqual(before);
    }
  });

  it.each(selections)("keeps desktop browser restoration of $kind and its layout", (selection) => {
    for (const hidden of [false, true]) {
      const saved = savedPresentation(hidden, selection);
      const initial = browserInitialSnapshot(saved, false);
      expect(initial).toBe(saved);
      using fixture = createRendererStoreFixture({ snapshot: initial });
      expect(fixture.root.appShellStore.selection).toEqual(selection);
      expect(fixture.root.appShellStore.activeConversation).toEqual(
        (saved.children.appShellStore as StoreSnapshot).state.activeConversation,
      );
      expect(fixture.root.sidebarStore.visible).toBe(!hidden);
      expect(fixture.root.sidebarStore.width).toBe(330);
      expect(fixture.root.sessionLayoutStore.focusedSessionId).toBe("previous");
    }
  });

  it("keeps fresh desktop defaults", () => {
    using fixture = createRendererStoreFixture({
      snapshot: browserInitialSnapshot(undefined, false),
    });
    expect(fixture.root.appShellStore.selection).toEqual({ kind: "workbench" });
    expect(fixture.root.sidebarStore.visible).toBe(true);
  });
});
