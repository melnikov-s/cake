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
describe("navigation snapshot migrations", () => {
  it("collapses a persisted split tree into focused history while retaining visits from the other panes", () => {
    const saved = store(
      {},
      {
        appShellStore: store({ navigationVersion: 3, workspace: "project-sessions" }),
        sessionLayoutStore: store({
          focusedPaneId: "focused",
          layout: {
            kind: "split",
            splitId: "old",
            axis: "x",
            ratio: 0.6,
            first: {
              kind: "pane",
              paneId: "other",
              history: ["other-first", "other-last"],
              historyCursor: 1,
            },
            second: {
              kind: "pane",
              paneId: "focused",
              history: ["parent", "child", "forward"],
              historyCursor: 1,
            },
          },
        }),
      },
    );
    const before = structuredClone(saved);
    using fixture = createRendererStoreFixture({ snapshot: saved });
    const focused = fixture.root.sessionLayoutStore;
    expect(focused.focusedSessionId).toBe("child");
    expect(focused.focusedSessionHistory).toEqual([
      "other-first",
      "other-last",
      "parent",
      "child",
      "forward",
    ]);
    expect(focused.goBack()).toBe("parent");
    expect(focused.goForward()).toBe("child");
    expect(focused.goForward()).toBe("forward");
    expect(saved).toEqual(before);
  });
  it.each(["project-session", "cake-chat"] as const)(
    "migrates %s pane history but startup ignores its old destination",
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
        conversation("cake-chat", CAKE_CHAT_SESSION_ID),
      );
      expect(fixture.root.appShellStore.selection).toEqual(
        conversation("cake-chat", CAKE_CHAT_SESSION_ID),
      );
      const focusedLayout =
        kind === "project-session"
          ? fixture.root.sessionLayoutStore
          : fixture.root.cakeChatCollectionStore.sessionLayoutStore;
      expect(focusedLayout.focusedSessionHistory).toEqual(
        kind === "project-session"
          ? ["older", "pane-current"]
          : ["older", "pane-current", CAKE_CHAT_SESSION_ID],
      );
      expect(toSnapshot(fixture.root).children.appShellStore).toEqual(
        store({
          navigationVersion: 4,
          sessionHistory: visits,
          sessionHistoryCursor: 1,
        }),
      );
      expect(saved).toEqual(before);
    },
  );

  it.each(["settings", "artifact-library"] as const)(
    "migrates a %s cover but launches global without another visit",
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
      expect(migrated.children.appShellStore).toMatchObject({ state: { coveringSurface: cover } });
      expect(shell.selection).toEqual(active);
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

  it("moves a restored permanent Project Chat into the shared layout without changing its identity", () => {
    const sessionId = `project-chat:${"a".repeat(64)}`;
    const saved = store(
      {},
      {
        appShellStore: store({
          navigationVersion: 2,
          workspace: "cake-chat",
          coveringSurface: "settings",
        }),
        sessionLayoutStore: layout("regular"),
        cakeChatCollectionStore: store({}, { sessionLayoutStore: layout(sessionId) }),
      },
    );
    const migrated = migrateNavigation(saved);
    expect(migrateNavigation(migrated)).toBe(migrated);
    using fixture = createRendererStoreFixture({ snapshot: migrated });
    expect(fixture.root.appShellStore.activeConversation).toEqual(
      conversation("cake-chat", CAKE_CHAT_SESSION_ID),
    );
    expect(fixture.root.appShellStore.selection).toEqual(
      conversation("cake-chat", CAKE_CHAT_SESSION_ID),
    );
    expect(fixture.root.sessionLayoutStore.focusedSessionHistory).toEqual([
      "older",
      "regular",
      sessionId,
    ]);
    expect(fixture.root.cakeChatCollectionStore.sessionLayoutStore.focusedSessionId).toBe(
      CAKE_CHAT_SESSION_ID,
    );
  });

  it("seeds a missing Project Session layout, while home retains its inactive pane history", () => {
    const active = conversation("project-session", "restored");
    using seeded = createRendererStoreFixture({
      snapshot: store(
        {},
        { appShellStore: store({ selection: active, activeConversation: active }) },
      ),
    });
    expect(seeded.root.sessionLayoutStore.focusedSessionId).toBe("restored");
    expect(seeded.root.appShellStore.activeConversation).toEqual(
      conversation("cake-chat", CAKE_CHAT_SESSION_ID),
    );
    seeded.root.navigationStore.showEmptyWorkbench();
    using restored = createRendererStoreFixture({ snapshot: toSnapshot(seeded.root) });
    expect(restored.root.appShellStore.selection).toEqual(
      conversation("cake-chat", CAKE_CHAT_SESSION_ID),
    );
    expect(restored.root.appShellStore.activeConversation).toEqual(
      conversation("cake-chat", CAKE_CHAT_SESSION_ID),
    );
    expect(restored.root.sessionLayoutStore.focusedSessionId).toBe("restored");
  });
});
