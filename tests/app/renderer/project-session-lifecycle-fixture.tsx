import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConversationSnapshot } from "../../../src/contracts/conversations/conversation-data";
import type { DiscussionThread } from "../../../src/contracts/discussion-sessions/discussion-session-data";
import type { Client } from "../../../src/renderer/client/Client";
import { applySnapshot } from "r-state-tree";
import type { TestClientOverrides } from "./test-client";
import { Chat } from "../../../src/renderer/components/chat";
import { SideChatLayout } from "../../../src/renderer/components/side-chat-layout";
import { SideChatsMenu } from "../../../src/renderer/components/side-chats-menu";
import {
  applyConversationUpdate,
  applyDiscussionSessionUpdate,
} from "../../../src/renderer/reducers/ConversationReducer";
import { applyDiscussionCatalogUpdate } from "../../../src/renderer/reducers/DiscussionReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

function conversation(sessionId: string): ConversationSnapshot {
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

export const lifecycleSelectionThread: DiscussionThread = {
  id: "selection-thread",
  workingDirectory: "/project",
  parentSessionId: "parent",
  anchor: {
    path: "session:parent/message/assistant-1",
    view: "message",
    messageId: "assistant-1",
    entryId: "entry-1",
    start: { diffLine: 0 },
    end: { diffLine: 0 },
    selectedText: "Original selection",
    contextBefore: "",
    contextAfter: "",
    diff: "",
    startOffset: 0,
    endOffset: 18,
  },
  parts: [],
  status: "open",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

export function renderResolvedProjectLifecycle(client: TestClientOverrides) {
  const summary = sessionSummary({
    sessionId: "resolved",
    projectPath: "/project",
    resolved: true,
  });
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: [summary],
    client,
  });
  const session = fixture.root.sessionRegistry.load("resolved", "/project");
  const snapshot = conversation("resolved");
  applyConversationUpdate(session.model, { _tag: "Snapshot", revision: 1, snapshot });
  fixture.root.appShellStore.previewResolvedProjectSession("resolved");
  fixture.root.sessionLayoutStore.ensureSession("resolved");
  fixture.root.projectWorkbenchStore.showLoadedSession("resolved");
  const view = render(
    <Chat store={session.conversationSessionStore.chatStore} composerFocusEnabled={false} />,
  );
  return {
    user: userEvent.setup(),
    async publishRestoredCatalog() {
      await act(async () =>
        applySnapshot(fixture.models.sessionCatalog, {
          sessions: [{ ...summary, resolved: false }],
          resolvedHasMoreByProject: {},
        }),
      );
    },
    async publishFreshConversation() {
      await act(async () =>
        applyConversationUpdate(session.model, { _tag: "Snapshot", revision: 2, snapshot }),
      );
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

export function renderProjectSelectionLifecycle(start: Client["discussionSessions"]["start"]) {
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: [sessionSummary({ sessionId: "parent", projectPath: "/project" })],
    client: { discussionSessions: { start } },
  });
  const session = fixture.root.sessionRegistry.load("parent", "/project");
  applyConversationUpdate(session.model, {
    _tag: "Snapshot",
    revision: 1,
    snapshot: {
      ...conversation("parent"),
      parts: [
        {
          id: "assistant-1",
          entryId: "entry-1",
          kind: "text",
          role: "assistant",
          text: "Original selection",
          status: "complete",
        },
      ],
    },
  });
  fixture.root.appShellStore.selectProjectSession("parent");
  fixture.root.sessionLayoutStore.ensureSession("parent");
  fixture.root.projectWorkbenchStore.showLoadedSession("parent");
  // Establish an already-open selection draft; native text-selection initiation is separate.
  session.messageCommentsStore.prepareDraft({
    messageId: "assistant-1",
    entryId: "entry-1",
    selectedText: "Original selection",
    startOffset: 0,
    endOffset: 18,
    contextBefore: "",
    contextAfter: "",
  });
  session.conversationSessionStore.sideChatStore.open({
    key: "selection-draft:parent",
    title: "Side chat",
    eyebrow: () => "Selection",
    chatStore: session.messageCommentsStore.draftChatStore,
  });
  const view = render(
    <SideChatLayout
      store={session.conversationSessionStore.sideChatStore}
      renderChat={(chat) => <Chat store={chat} embedded composerFocusEnabled={false} />}
    >
      <SideChatsMenu store={session} />
      <Chat
        store={session.conversationSessionStore.chatStore}
        embedded
        composerFocusEnabled={false}
      />
    </SideChatLayout>,
  );
  let revision = 0;
  return {
    user: userEvent.setup(),
    async publishThread(thread: DiscussionThread) {
      await act(async () => {
        if (thread.sidecarSessionId)
          applyDiscussionSessionUpdate(
            fixture.models.discussionConversation(thread.sidecarSessionId, "/project"),
            thread.sidecarSessionId,
            {
              _tag: "Snapshot",
              revision: revision + 1,
              snapshot: {
                identity: {
                  _tag: "DiscussionSession",
                  sessionId: thread.sidecarSessionId,
                  parentSessionId: "parent",
                },
                conversation: conversation(thread.sidecarSessionId),
              },
            },
          );
        applyDiscussionCatalogUpdate(fixture.models.discussionCatalog("parent"), "parent", {
          _tag: "Snapshot",
          revision: ++revision,
          parentSessionId: "parent",
          threads: [thread],
        });
      });
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
