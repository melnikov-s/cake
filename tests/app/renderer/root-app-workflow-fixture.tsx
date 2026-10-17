import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { App } from "../../../src/renderer/components/app";
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
      workspaces: { loadStagedSlashCommands: async () => [], ...client.workspaces },
    },
  });
  const session = fixture.root.sessionRegistry.load(rootAppSession.sessionId, "/alpha");
  fixture.root.projectWorkbenchStore.projectOpenStore.projectPath = "/alpha";
  fixture.root.navigationStore.selectProjectSession(session.sessionId);
  fixture.root.projectWorkbenchStore.showLoadedSession(session.sessionId);
  fixture.root.sessionLayoutStore.ensureSession(session.sessionId);
  applyConversationUpdate(session.model, {
    _tag: "Snapshot",
    revision: 1,
    snapshot: {
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
    },
  });
  const view = render(
    <StoreProvider store={fixture.root}>
      <App />
    </StoreProvider>,
  );
  return {
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
