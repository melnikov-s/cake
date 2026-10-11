import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StoreProvider } from "r-state-tree/react";
import { Chat } from "../../../src/renderer/components/chat";
import { CommandPane } from "../../../src/renderer/components/command-pane";
import { TreeNavigationDialog } from "../../../src/renderer/components/tree-navigation-dialog";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

export function renderCommandPane(client: TestClientOverrides) {
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: [sessionSummary({ sessionId: "source", projectPath: "/project" })],
    client: {
      ...client,
      electron: {
        setFullscreenSurfaceOpen: async () => undefined,
        ...client.electron,
      },
    },
  });
  const session = fixture.root.sessionRegistry.load("source", "/project");
  fixture.root.appShellStore.selectProjectSession("source");
  const workbench = fixture.root.projectWorkbenchStore;
  workbench.showLoadedSession("source");
  applyConversationUpdate(fixture.models.projectConversation("source", "/project"), {
    _tag: "Snapshot",
    revision: 1,
    snapshot: {
      sessionId: "source",
      sessionFile: "/project/source.jsonl",
      parts: [
        {
          id: "user-part",
          entryId: "user-entry",
          kind: "text",
          role: "user",
          text: "Original prompt with the full API requirements",
          status: "complete",
        },
        {
          id: "assistant-part",
          entryId: "assistant-entry",
          kind: "text",
          role: "assistant",
          text: "API decisions recorded",
          status: "complete",
        },
      ],
      models: [],
      thinkingLevel: "off",
      availableThinkingLevels: ["off"],
      streaming: false,
      diagnostics: [],
      commands: [],
      compatibility: { resources: [], diagnostics: [] },
      extensionUi: { statuses: [] },
      tree: [
        {
          id: "user-entry",
          type: "message",
          messageRole: "user",
          preview: "Original prompt…",
          editorText: "Original prompt with the full API requirements",
          active: false,
        },
        {
          id: "assistant-entry",
          parentId: "user-entry",
          type: "message",
          messageRole: "assistant",
          preview: "API decisions recorded",
          active: true,
        },
      ],
    },
  });
  // Opening the pane is setup; navigation and summary choices are driven through its real UI.
  void workbench.commandPaneStore.open("tree");
  const view = render(
    <StoreProvider store={fixture.root}>
      <Chat
        store={session.conversationSessionStore.chatStore}
        embedded
        composerFocusEnabled={false}
      />
      <CommandPane store={workbench} extensionUi={fixture.root.extensionUiStore} />
      <StoreProvider store={fixture.root.fullscreenSurfaceStore}>
        <TreeNavigationDialog store={workbench.commandPaneStore} />
      </StoreProvider>
    </StoreProvider>,
  );
  return {
    user: userEvent.setup(),
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
