import { applySnapshot, toSnapshot } from "r-state-tree";
import { describe, expect, it } from "vitest";
import { cakeHotkeyActionIds } from "../../../src/contracts/application/cake-settings-data";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-data";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

// Dispatch-policy regressions with real owners. Native keyboard/UI wiring is covered by
// hotkeys, active-session-navigation, and session-split Electron workflows.
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

  it("splits and focuses staged project panes, preserves drafts, and retires the closed staged pane", () => {
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: "/work/alpha" })],
      client: { workspaces: { loadStagedSlashCommands: async () => [] } },
    });
    const { root } = fixture;
    const source = root.sessionRegistry.pendingSessions.prepareStaged("/work/alpha", "source");
    root.navigationStore.showLoadedProjectSession(source.sessionId);
    source.conversationSessionStore.composerStore.draftStore.setText("source draft");
    root.commands.execute("split-right");
    expect(root.sessionLayoutStore.panes).toHaveLength(2);
    const splitSessionId = root.sessionLayoutStore.focusedSessionId!;
    expect(splitSessionId).not.toBe(source.sessionId);
    const splitSession = root.sessionRegistry.findSession(splitSessionId)!;
    splitSession.conversationSessionStore.composerStore.draftStore.setText("split draft");
    root.commands.execute("focus-left");
    expect(root.appShellStore.activeConversation?.sessionId).toBe(source.sessionId);
    root.commands.execute("focus-pane-2");
    expect(root.appShellStore.activeConversation?.sessionId).toBe(splitSessionId);
    expect(source.conversationSessionStore.composerStore.draftStore.text).toBe("source draft");
    expect(splitSession.conversationSessionStore.composerStore.draftStore.text).toBe("split draft");
    root.navigationStore.closeSessionPane(root.sessionLayoutStore.focusedPaneId!);
    expect(root.sessionRegistry.findSession(splitSessionId)).toBeUndefined();
    expect(root.sessionLayoutStore.panes).toHaveLength(1);
    expect(root.appShellStore.activeConversation?.sessionId).toBe(source.sessionId);

    // Cake Chat focus must not redirect to the still-loaded Project pane; splitting is Project-only.
    root.appShellStore.selectCakeChat(CAKE_CHAT_SESSION_ID);
    root.commands.execute("focus-pane-1");
    root.commands.execute("split-right");
    expect(root.appShellStore.activeConversation).toEqual({
      kind: "cake-chat",
      sessionId: CAKE_CHAT_SESSION_ID,
    });
    expect(root.sessionLayoutStore.panes).toHaveLength(1);
  });

  it("returns from Settings to the same conversation and leaves snapshot authority with shell and layout", () => {
    using fixture = createRendererStoreFixture();
    const { root } = fixture;
    root.appShellStore.selectCakeChat(CAKE_CHAT_SESSION_ID);
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
      state: { selection: { kind: "cake-chat", sessionId: CAKE_CHAT_SESSION_ID } },
    });
    expect(snapshot.children?.navigationStore).toMatchObject({ state: {} });
  });
});
