import { act } from "@testing-library/react";
import { renderTranscriptContent as render } from "./render-transcript-content";
import userEvent from "@testing-library/user-event";
import { observer, StoreProvider } from "r-state-tree/react";
import type { ConversationSnapshot } from "../../../src/contracts/conversations/conversation-data";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import type { DiscussionThread } from "../../../src/contracts/discussion-sessions/discussion-session-data";
import { Chat } from "../../../src/renderer/components/chat";
import { ExtensionRequestDialog } from "../../../src/renderer/components/extension-request-dialog";
import { SessionContinuationDialog } from "../../../src/renderer/components/session-continuation-dialog";
import { SideChatLayout } from "../../../src/renderer/components/side-chat-layout";
import { SideChatsMenu } from "../../../src/renderer/components/side-chats-menu";
import { TreeNavigationDialog } from "../../../src/renderer/components/tree-navigation-dialog";
import { projectTranscriptBehaviorFor } from "../../../src/renderer/lib/project-transcript-behavior";
import {
  applyConversationUpdate,
  applyDiscussionSessionUpdate,
} from "../../../src/renderer/reducers/ConversationReducer";
import { applyDiscussionCatalogUpdate } from "../../../src/renderer/reducers/DiscussionReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

export const transcriptFinishSessionId = "transcript-finish";

function snapshot(sessionId: string, parts: UiPart[], streaming = false): ConversationSnapshot {
  return {
    sessionId,
    sessionFile: `/project/${sessionId}.jsonl`,
    parts,
    models: [],
    thinkingLevel: "off",
    availableThinkingLevels: ["off"],
    streaming,
    diagnostics: [],
    commands: [],
    compatibility: { resources: [], diagnostics: [] },
    extensionUi: { statuses: [] },
    tree: parts.flatMap((part) => {
      if (part.kind !== "text" || !part.entryId) return [];
      const entry = {
        id: part.entryId,
        type: "message",
        messageRole: part.role,
        preview: part.text,
        active: true,
      };
      return part.role === "user" ? [{ ...entry, editorText: part.text }] : [entry];
    }),
  };
}

export function renderTranscriptFinish(
  parts: UiPart[],
  options: {
    client?: TestClientOverrides;
    streaming?: boolean;
    waitingForUser?: boolean;
    thread?: DiscussionThread;
  } = {},
) {
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: [sessionSummary({ sessionId: transcriptFinishSessionId, projectPath: "/project" })],
    client: {
      ...options.client,
      electron: {
        setFullscreenSurfaceOpen: async () => undefined,
        ...options.client?.electron,
      },
    },
  });
  const { root } = fixture;
  const session = root.sessionRegistry.load(transcriptFinishSessionId, "/project");
  root.navigationStore.selectProjectSession(transcriptFinishSessionId);
  root.projectWorkbenchStore.showLoadedSession(transcriptFinishSessionId);
  root.sessionLayoutStore.ensureSession(transcriptFinishSessionId);
  let revision = 1;
  applyConversationUpdate(session.model, {
    _tag: "Snapshot",
    revision,
    snapshot: snapshot(transcriptFinishSessionId, parts, options.streaming),
  });
  const thread = options.thread;
  if (thread) {
    if (!thread.sidecarSessionId)
      throw new Error("Transcript fixture requires a persisted sidecar");
    applyDiscussionSessionUpdate(
      fixture.models.discussionConversation(thread.sidecarSessionId, "/project"),
      thread.sidecarSessionId,
      {
        _tag: "Snapshot",
        revision: 1,
        snapshot: {
          identity: {
            _tag: "DiscussionSession",
            sessionId: thread.sidecarSessionId,
            parentSessionId: transcriptFinishSessionId,
          },
          conversation: { ...snapshot(thread.sidecarSessionId, []), parts: thread.parts },
        },
      },
    );
    applyDiscussionCatalogUpdate(
      fixture.models.discussionCatalog(transcriptFinishSessionId),
      transcriptFinishSessionId,
      {
        _tag: "Snapshot",
        revision: 1,
        parentSessionId: transcriptFinishSessionId,
        threads: [thread],
      },
    );
    session.messageCommentsStore
      .chatStore(thread.id)
      ?.transcriptInteraction.setTranscriptScrollPosition({ kind: "top" });
  }
  if (options.waitingForUser)
    root.extensionUiStore.receive({
      type: "ui-requested",
      sessionId: transcriptFinishSessionId,
      operationId: "transcript-confirm",
      uiRequestId: "transcript-confirm-request",
      kind: "confirm",
      title: "Continue the task?",
      message: "Ready for the next step.",
    });

  // Compact controls density only. Use the supported Virtuoso content context;
  // native layout, selection and scrolling remain Electron contracts.
  session.conversationSessionStore.chatStore.transcriptInteraction.setTranscriptScrollPosition({
    kind: "top",
  });
  // Production behavior supplies all callbacks and collaborating Stores.
  const TranscriptFinishSurface = observer(function TranscriptFinishSurface() {
    return (
      <>
        <SideChatLayout
          store={session.conversationSessionStore.sideChatStore}
          renderChat={(chat) => <Chat store={chat} embedded compact composerFocusEnabled={false} />}
        >
          <SideChatsMenu store={session} />
          <Chat
            store={session.conversationSessionStore.chatStore}
            compact
            composerFocusEnabled={false}
            transcriptBehavior={projectTranscriptBehaviorFor(root, session)}
          />
        </SideChatLayout>
        <SessionContinuationDialog store={root.projectWorkbenchStore.sessionContinuationStore} />
        <TreeNavigationDialog store={root.projectWorkbenchStore.commandPaneStore} />
        <ExtensionRequestDialog />
      </>
    );
  });
  const view = render(
    <StoreProvider store={root}>
      <StoreProvider store={root.fullscreenSurfaceStore}>
        <TranscriptFinishSurface />
      </StoreProvider>
    </StoreProvider>,
  );
  return {
    user: userEvent.setup(),
    container: view.container,
    publish(nextParts: UiPart[], streaming = false) {
      act(() => {
        applyConversationUpdate(session.model, {
          _tag: "Snapshot",
          revision: ++revision,
          snapshot: snapshot(transcriptFinishSessionId, nextParts, streaming),
        });
      });
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
