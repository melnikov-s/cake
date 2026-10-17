import { toSnapshot, type StoreSnapshot } from "r-state-tree";
import { describe, expect, it } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../../src/contracts/cake-chats/cake-chat-identity";
import { migrateNavigation } from "../../../../src/renderer/persistence/migrate-navigation";
import { createRendererStoreFixture } from "../renderer-store-fixture";

const store = (
  state: StoreSnapshot["state"] = {},
  children: StoreSnapshot["children"] = {},
): StoreSnapshot => ({ state, children });
const conversation = (kind: "project-session" | "cake-chat", sessionId: string) => ({
  kind,
  sessionId,
});
const layout = (sessionId: string) =>
  store({
    layout: {
      kind: "pane",
      paneId: "retained-pane",
      history: ["older", sessionId],
      historyCursor: 1,
    },
    focusedPaneId: "retained-pane",
  });

// Persistence/bootstrap has no GUI trigger. Exercise migration through the real mounted Root;
// visible restored-surface journeys are in app-shell-navigation-workflow.test.tsx.
describe("navigation snapshot v1 -> v2", () => {
  it.each(["project-session", "cake-chat"] as const)(
    "persisted-window restore derives %s from the pane when old shell identities disagree",
    (kind) => {
      const selected = conversation(kind, "shell-selection");
      const active = conversation(kind, "shell-retained");
      const retainedLayout = layout("pane-current");
      const visits = [conversation("project-session", "visited"), selected];
      const saved = store(
        {},
        {
          appShellStore: store({
            selection: selected,
            activeConversation: active,
            sessionHistory: visits,
            sessionHistoryCursor: 1,
          }),
          ...(kind === "project-session"
            ? { sessionLayoutStore: retainedLayout }
            : { cakeChatCollectionStore: store({}, { sessionLayoutStore: retainedLayout }) }),
        },
      );
      const before = structuredClone(saved);
      using fixture = createRendererStoreFixture({ snapshot: saved });
      expect(fixture.root.appShellStore.activeConversation).toEqual(
        conversation(kind, "pane-current"),
      );
      expect(fixture.root.appShellStore.selection).toEqual(conversation(kind, "pane-current"));
      const focusedLayout =
        kind === "project-session"
          ? fixture.root.sessionLayoutStore
          : fixture.root.cakeChatCollectionStore.sessionLayoutStore;
      expect(focusedLayout.focusedSessionHistory).toEqual(["older", "pane-current"]);
      expect(toSnapshot(fixture.root).children.appShellStore).toEqual(
        store({
          navigationVersion: 2,
          workspace: kind === "project-session" ? "project-sessions" : "cake-chat",
          coveringSurface: undefined,
          sessionHistory: visits,
          sessionHistoryCursor: 1,
        }),
      );
      expect(saved).toEqual(before);
    },
  );

  it.each(["settings", "artifact-library"] as const)(
    "migrates a %s cover, seeds a missing conversation layout, and restores without another visit",
    (cover) => {
      const active = conversation("cake-chat", CAKE_CHAT_SESSION_ID);
      const saved = store(
        {},
        {
          appShellStore: store({
            selection: { kind: cover },
            activeConversation: active,
            sessionHistory: [active],
            sessionHistoryCursor: 0,
          }),
        },
      );
      const migrated = migrateNavigation(saved);
      expect(migrateNavigation(migrated)).toBe(migrated);
      using fixture = createRendererStoreFixture({ snapshot: migrated });
      const shell = fixture.root.appShellStore;
      expect(shell.selection).toEqual({ kind: cover });
      expect(shell.activeConversation).toEqual(active);
      fixture.root.navigationStore.returnToWorkbench();
      expect(shell.selection).toEqual(active);
      expect(shell.canGoBack).toBe(false);
      expect(shell.canGoForward).toBe(false);
      const persisted = toSnapshot(fixture.root);
      using restored = createRendererStoreFixture({ snapshot: persisted });
      expect(restored.root.appShellStore.activeConversation).toEqual(active);
      expect(restored.root.cakeChatCollectionStore.sessionId).toBe(active.sessionId);
    },
  );

  it("seeds a missing Project Session layout, while home retains its inactive pane history", () => {
    const active = conversation("project-session", "restored");
    using seeded = createRendererStoreFixture({
      snapshot: store(
        {},
        { appShellStore: store({ selection: active, activeConversation: active }) },
      ),
    });
    expect(seeded.root.sessionLayoutStore.focusedSessionId).toBe("restored");
    expect(seeded.root.appShellStore.activeConversation).toEqual(active);
    seeded.root.navigationStore.showEmptyWorkbench();
    using restored = createRendererStoreFixture({ snapshot: toSnapshot(seeded.root) });
    expect(restored.root.appShellStore.selection).toEqual({ kind: "workbench" });
    expect(restored.root.appShellStore.activeConversation).toBeUndefined();
    expect(restored.root.sessionLayoutStore.focusedSessionId).toBe("restored");
  });
});
