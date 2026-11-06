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
      state: { navigationVersion: 4, workspace: "cake-chat" },
    });
    expect(snapshot.children?.navigationStore).toMatchObject({ state: {} });
  });
});
