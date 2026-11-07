/** @vitest-environment jsdom */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, expect, it } from "vitest";
import { emptyProjectTodos } from "../../../src/contracts/projects/project-todos";
import { CakeChatPaneHeader } from "../../../src/renderer/components/cake-chat-pane-header";
import { CakeChatWorkspaceControls } from "../../../src/renderer/components/cake-chat-workspace-controls";
import { ProjectPaneHeader } from "../../../src/renderer/components/project-pane-header";
import { ProjectWorkspaceControls } from "../../../src/renderer/components/project-workspace-controls";
import { WorkspaceNavigator } from "../../../src/renderer/components/workspace-navigator";
import { projectRecord } from "./fixtures/catalog-fixtures";
import {
  navigatorHomeId,
  navigatorProjectPath,
  navigatorSessions,
  populateConversationNavigationFixture,
} from "./fixtures/conversation-navigation-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

afterEach(cleanup);

it.each(
  (["project", "cake-chat"] as const).flatMap((kind) =>
    (["normal", "browser", "vscode"] as const).map((mode) => ({ kind, mode })),
  ),
)(
  "$kind $mode header omits the to-do shortcut but preserves adjacent controls and the To-dos tab",
  async ({ kind, mode }) => {
    using fixture = createRendererStoreFixture({
      projects: [
        {
          ...projectRecord({ path: navigatorProjectPath }),
          todos: {
            ...emptyProjectTodos(),
            items: [
              {
                id: "00000000-0000-4000-8000-000000000059",
                title: "Keep the To-dos tab",
                description: "",
                status: "",
                state: "open",
                revision: 0,
                associations: [],
              },
            ],
          },
        },
      ],
      sessions: navigatorSessions,
    });
    populateConversationNavigationFixture(fixture.models);
    const { root } = fixture;
    let controls;
    if (kind === "project") {
      const session = root.sessionRegistry.load("layout", navigatorProjectPath);
      root.navigationStore.selectProjectSession(session.sessionId);
      controls =
        mode === "normal" ? (
          <ProjectPaneHeader session={session} browserMode={false} />
        ) : (
          <ProjectWorkspaceControls session={session} mode={mode} browserMode={false} />
        );
    } else {
      const session = root.cakeChatCollectionStore.registry.load(navigatorHomeId);
      root.navigationStore.selectCakeChat(session.sessionId);
      controls =
        mode === "normal" ? (
          <CakeChatPaneHeader session={session} />
        ) : (
          <CakeChatWorkspaceControls session={session} mode={mode} browserMode={false} />
        );
    }
    const view = render(
      <StoreProvider store={root}>
        <header aria-label="Conversation controls">{controls}</header>
        <WorkspaceNavigator />
      </StoreProvider>,
    );
    try {
      const header = within(screen.getByRole("banner", { name: "Conversation controls" }));
      expect(header.queryByRole("button", { name: "To-dos" })).toBeNull();
      expect(header.queryByRole("button", { description: /open to-dos/ })).toBeNull();
      expect(header.getByRole("button", { name: "0 artifacts" })).toBeDefined();
      expect(header.getByRole("button", { name: /^Side chats/ })).toBeDefined();
      expect(header.getByRole("group", { name: "Conversation workspace" })).toBeDefined();
      for (const name of [
        mode === "normal" ? "Main" : "Back to agent",
        "Open VS Code",
        "Open Browser Mode",
      ]) {
        expect(header.getByRole("button", { name })).toBeDefined();
      }

      const user = userEvent.setup();
      const workspace = within(screen.getByRole("complementary", { name: "Workspace" }));
      await user.click(workspace.getByRole("button", { name: /^Sessions / }));
      const todosTab = workspace.getByRole("button", { name: "To-dos 1" });
      await user.click(todosTab);
      expect(todosTab.getAttribute("aria-pressed")).toBe("true");
      expect(workspace.getByRole("button", { name: "Keep the To-dos tab" })).toBeDefined();
    } finally {
      view.unmount();
    }
  },
);
