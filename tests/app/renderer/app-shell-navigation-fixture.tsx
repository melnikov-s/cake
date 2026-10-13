import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot, type StoreSnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-data";
import type { ConversationSnapshot } from "../../../src/contracts/conversations/conversation-data";
import { App } from "../../../src/renderer/components/app";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

const sessions = ["alpha", "beta", "gamma"].map((name) =>
  sessionSummary({ sessionId: name, title: `${name} conversation`, projectPath: `/${name}` }),
);

function snapshot(sessionId: string): ConversationSnapshot {
  return {
    sessionId,
    sessionFile: `/sessions/${sessionId}.jsonl`,
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
}

export function renderAppShellNavigation(
  client: TestClientOverrides = {},
  savedSnapshot?: StoreSnapshot,
) {
  const fixture = createRendererStoreFixture({
    snapshot: savedSnapshot,
    projects: sessions.map((session) => projectRecord({ path: session.projectPath })),
    sessions,
    client: {
      ...client,
      projectSessions: { open: async () => undefined, ...client.projectSessions },
      cakeChats: { open: async () => undefined, ...client.cakeChats },
      artifacts: {
        catalog: async (request) => ({
          offset: request.offset ?? 0,
          limit: request.limit ?? 50,
          items: [],
          total: 0,
          hasMore: false,
        }),
        ...client.artifacts,
      },
      workspaces: {
        inspect: async (request) => ({ ...request, trustRequired: false }),
        registerProject: async () => defaultApplicationState(),
        loadStagedSlashCommands: async () => [],
        ...client.workspaces,
      },
    },
  });
  // Loaded authority snapshots make history navigation independent of hydration timing.
  for (const summary of sessions) {
    fixture.root.sessionRegistry.load(summary.sessionId, summary.workingDirectory);
    applyConversationUpdate(
      fixture.models.projectConversation(summary.sessionId, summary.workingDirectory),
      { _tag: "Snapshot", revision: 1, snapshot: snapshot(summary.sessionId) },
    );
  }
  applySnapshot(fixture.models.cakeChatCatalog, {
    loaded: true,
    sessions: [
      {
        sessionId: CAKE_CHAT_SESSION_ID,
        title: "Cake Chat",
        createdAt: sessions[0]!.createdAt,
        modifiedAt: sessions[0]!.modifiedAt,
        messageCount: 0,
        resolved: false,
        unread: false,
      },
    ],
  });
  fixture.root.cakeChatCollectionStore.registry.load(CAKE_CHAT_SESSION_ID);
  applyConversationUpdate(fixture.models.cakeChatConversation(CAKE_CHAT_SESSION_ID), {
    _tag: "Snapshot",
    revision: 1,
    snapshot: snapshot(CAKE_CHAT_SESSION_ID),
  });
  const view = render(
    <StoreProvider store={fixture.root}>
      <App />
    </StoreProvider>,
  );
  return {
    root: fixture.root,
    client: fixture.client,
    user: userEvent.setup(),
    async publishResolved(sessionId: string) {
      await act(async () =>
        applySnapshot(fixture.models.sessionCatalog, {
          sessions: sessions.map((session) => ({
            ...session,
            resolved: session.sessionId === sessionId,
          })),
          resolvedHasMoreByProject: {},
        }),
      );
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
