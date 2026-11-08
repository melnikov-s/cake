import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { App } from "../../../src/renderer/components/app";
import type { ConversationSnapshot } from "../../../src/contracts/conversations/conversation-data";
import { NewSessionDialog } from "../../../src/renderer/components/new-session-dialog";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import {
  projectRecord,
  sessionSummary,
  type SessionSummaryFixture,
} from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

export const rootAppSession = sessionSummary({
  sessionId: "current-session",
  title: "Current conversation",
  projectPath: "/alpha",
  projectName: "Alpha",
});
export const rootAppProjects = [
  projectRecord({ path: "/alpha", name: "Alpha" }),
  projectRecord({ path: "/beta", name: "Beta" }),
];

export function renderRootAppWorkflow(client: TestClientOverrides) {
  const fixture = createRendererStoreFixture({
    projects: rootAppProjects,
    sessions: [rootAppSession],
    client: {
      ...client,
      cakeChats: { open: async () => undefined, ...client.cakeChats },
      workspaces: { loadStagedSlashCommands: async () => [], ...client.workspaces },
    },
  });
  const session = fixture.root.sessionRegistry.load(rootAppSession.sessionId, "/alpha");
  fixture.root.projectWorkbenchStore.projectOpenStore.projectPath = "/alpha";
  fixture.root.navigationStore.selectProjectSession(session.sessionId);
  fixture.root.projectWorkbenchStore.showLoadedSession(session.sessionId);
  fixture.root.sessionLayoutStore.ensureSession(session.sessionId);
  const snapshot: ConversationSnapshot = {
    sessionId: session.sessionId,
    sessionFile: "/alpha/current-session.jsonl",
    parts: [],
    models: [],
    thinkingLevel: "off",
    availableThinkingLevels: ["off"],
    streaming: false,
    diagnostics: [],
    commands: [],
    compatibility: { resources: [], diagnostics: [] },
    extensionUi: { statuses: [] },
    tree: [],
  };
  applyConversationUpdate(session.model, { _tag: "Snapshot", revision: 1, snapshot });
  const chats = rootAppProjects.map((project, index) => ({
    sessionId: `project-chat:${(index ? "b" : "a").repeat(64)}`,
    projectPath: project.path,
    title: `${project.name} / Project Chat`,
  }));
  applySnapshot(fixture.models.cakeChatCatalog, { loaded: true, sessions: chats });
  for (const chat of chats)
    applyConversationUpdate(fixture.models.cakeChatConversation(chat.sessionId), {
      _tag: "Snapshot",
      revision: 1,
      snapshot: {
        ...snapshot,
        sessionId: chat.sessionId,
        sessionFile: `/chats/${chat.sessionId}.sqlite`,
      },
    });
  fixture.root.workspaceNavigatorStore.show("sessions");
  const view = render(
    <StoreProvider store={fixture.root}>
      <App />
      <NewSessionDialog store={fixture.root.newSessionStore} />
    </StoreProvider>,
  );
  return {
    root: fixture.root,
    user: userEvent.setup(),
    publishSessions(sessions: SessionSummaryFixture[]) {
      act(() =>
        applySnapshot(fixture.models.sessionCatalog, { sessions, resolvedHasMoreByProject: {} }),
      );
    },
    publishProjects(projects: ReturnType<typeof projectRecord>[]) {
      act(() => applySnapshot(fixture.models.projects, { projects }));
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
