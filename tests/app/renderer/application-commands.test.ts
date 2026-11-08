import { applySnapshot, toSnapshot } from "r-state-tree";
import { describe, expect, it } from "vitest";
import { cakeHotkeyActionIds } from "../../../src/contracts/application/cake-settings-data";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

// Dispatch-policy regressions with real owners. Native keyboard/UI wiring is covered by
// hotkeys and active-session-navigation Electron workflows.
describe("Application command registry", () => {
  it("registers every non-DOM command and evaluates project availability against live selection and resolution", () => {
    const summary = sessionSummary({ sessionId: "session", projectPath: "/work/alpha" });
    using fixture = createRendererStoreFixture({ sessions: [summary] });
    const { root, models } = fixture;
    expect(Object.keys(root.commands.commands).sort()).toEqual(
      cakeHotkeyActionIds.filter((action) => action !== "open-hovered-message").sort(),
    );

    root.commands.execute("toggle-session-tree");
    expect(root.projectWorkbenchStore.commandPaneStore.pane).toBeUndefined();
    root.sessionRegistry.load(summary.sessionId, summary.workingDirectory);
    root.navigationStore.showLoadedProjectSession(summary.sessionId);
    root.commands.execute("toggle-session-tree");
    expect(root.projectWorkbenchStore.commandPaneStore.pane).toBe("tree");
    root.commands.execute("toggle-session-tree");
    expect(root.projectWorkbenchStore.commandPaneStore.pane).toBeUndefined();

    applySnapshot(models.sessionCatalog, {
      sessions: [{ ...summary, resolved: true }],
      resolvedHasMoreByProject: {},
    });
    root.commands.execute("toggle-session-tree");
    expect(root.projectWorkbenchStore.commandPaneStore.pane).toBeUndefined();
    applySnapshot(models.sessionCatalog, { sessions: [summary], resolvedHasMoreByProject: {} });
    root.commands.execute("toggle-session-tree");
    expect(root.projectWorkbenchStore.commandPaneStore.pane).toBe("tree");
  });

  it("routes the Workspace hotkey to the same mode-aware pane toggle", () => {
    const summary = sessionSummary({ sessionId: "session", projectPath: "/work/alpha" });
    using fixture = createRendererStoreFixture({ sessions: [summary] });
    const { root } = fixture;
    const session = root.sessionRegistry.load(summary.sessionId, summary.workingDirectory);
    root.navigationStore.showLoadedProjectSession(summary.sessionId);
    const navigator = root.workspaceNavigatorStore;
    for (const mode of ["normal", "browser", "vscode"] as const) {
      session.showPresentation(mode);
      const previous = navigator.paneVisible;
      root.commands.execute("toggle-sidebar");
      expect(navigator.paneVisible).toBe(!previous);
      expect(session.presentationMode).toBe(mode);
      root.commands.execute("toggle-sidebar");
      expect(navigator.paneVisible).toBe(previous);
    }
  });

  it("dismisses hints even for unavailable commands but lets the hint command toggle itself", () => {
    using fixture = createRendererStoreFixture();
    const { root } = fixture;
    root.commands.execute("show-ui-hints");
    expect(root.uiHintModeStore.active).toBe(true);
    root.commands.execute("show-ui-hints");
    expect(root.uiHintModeStore.active).toBe(false);
    root.commands.execute("show-ui-hints");
    root.commands.execute("open-editor");
    expect(root.uiHintModeStore.active).toBe(false);
  });

  it.each(["project-session", "project-chat", "cake-chat"])(
    "retains only the %s Settings origin without making a hidden conversation active",
    (kind) => {
      using fixture = createRendererStoreFixture({
        sessions: [sessionSummary({ sessionId: "session", projectPath: "/project" })],
      });
      const { root } = fixture;
      const sessionId =
        kind === "project-session"
          ? "session"
          : kind === "project-chat"
            ? `project-chat:${"a".repeat(64)}`
            : CAKE_CHAT_SESSION_ID;
      const owner =
        kind === "project-session"
          ? root.sessionRegistry.load(sessionId, "/project")
          : root.cakeChatCollectionStore.registry.load(sessionId);
      if (kind === "project-session") root.navigationStore.showLoadedProjectSession(sessionId);
      else root.navigationStore.selectCakeChat(sessionId);
      root.navigationStore.showSettings();
      expect(root.appShellStore.activeConversation).toBeUndefined();
      expect(root.settingsStore.activeSession).toBe(owner);
      root.navigationStore.showAutomations();
      expect(root.settingsStore.activeSession).toBeUndefined();
    },
  );

  it("returns from Settings to the same conversation and leaves snapshot authority with shell and layout", () => {
    using fixture = createRendererStoreFixture();
    const { root } = fixture;
    root.navigationStore.selectCakeChat(CAKE_CHAT_SESSION_ID);
    root.commands.execute("open-settings");
    expect(root.appShellStore.surface).toBe("settings");
    root.commands.execute("open-settings");
    expect(root.appShellStore.activeConversation).toEqual({
      kind: "cake-chat",
      sessionId: CAKE_CHAT_SESSION_ID,
    });
    expect(root.appShellStore.surface).toBe("cake-chat");
    const snapshot = toSnapshot(root);
    expect(snapshot.children?.appShellStore).toMatchObject({
      state: { navigationVersion: 4 },
    });
    expect(snapshot.children?.appShellStore).not.toHaveProperty("state.workspace");
    expect(snapshot.children?.navigationStore).toMatchObject({ state: {} });
  });
});
