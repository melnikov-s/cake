import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { VirtuosoMockContext } from "react-virtuoso";
import type { EmbeddedEditorStateSnapshot } from "../../../src/renderer/client/Client";
import type { DiscussionThread } from "../../../src/contracts/discussion-sessions/discussion-session-data";
import type { StoreEvent } from "../../../src/renderer/events/StoreEvent";
import { applyDiscussionCatalogUpdate } from "../../../src/renderer/reducers/DiscussionReducer";
import { App } from "../../../src/renderer/components/app";
import {
  applyConversationUpdate,
  applyDiscussionSessionUpdate,
} from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

export const editorWorkingDirectory = "/project";
export const editorSessionId = "editor-session";

export function editorLease(character: string) {
  const id = character.repeat(64);
  return { id, endpoint: `http://localhost:4317/editor/1/${id}/` };
}

export function deferredEditorOpen() {
  let resolve!: (lease: ReturnType<typeof editorLease>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ReturnType<typeof editorLease>>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export function renderEmbeddedEditor(
  client: TestClientOverrides,
  options: {
    threads?: readonly DiscussionThread[];
    bootstrap?: boolean;
    savedIde?: boolean;
    additionalSessions?: ReturnType<typeof sessionSummary>[];
  } = {},
) {
  const sessions = [
    sessionSummary({
      sessionId: editorSessionId,
      title: "Editor conversation",
      projectPath: editorWorkingDirectory,
      workingDirectory: editorWorkingDirectory,
    }),
    ...(options.additionalSessions ?? []),
  ];
  const fixture = createRendererStoreFixture({
    projects: [...new Set(sessions.map((session) => session.projectPath))].map((path) =>
      projectRecord({ path, name: path === editorWorkingDirectory ? "Project" : "Other" }),
    ),
    sessions,
    client: {
      ...client,
      projectSessions: { open: async () => undefined, ...client.projectSessions },
      workspaces: { loadStagedSlashCommands: async () => [], ...client.workspaces },
      vscode: {
        updateBounds: async () => undefined,
        updateAnnotations: async () => undefined,
        updateSelectionHighlights: async () => undefined,
        setTheme: async () => undefined,
        release: async () => undefined,
        ...client.vscode,
      },
    },
  });
  const hydrate = (sessionId: string) => {
    const summary = sessions.find((session) => session.sessionId === sessionId)!;
    applyConversationUpdate(
      fixture.models.projectConversation(sessionId, summary.workingDirectory),
      {
        _tag: "Snapshot",
        revision: 1,
        snapshot: {
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
        },
      },
    );
  };
  for (const summary of sessions) {
    fixture.root.sessionRegistry.load(summary.sessionId, summary.workingDirectory);
    if (!options.bootstrap || summary.sessionId !== editorSessionId) hydrate(summary.sessionId);
  }
  const threads = options.threads ?? [];
  applySnapshot(fixture.models.cakeChatCatalog, { loaded: true, sessions: [] });
  applyDiscussionCatalogUpdate(fixture.models.discussionCatalog(editorSessionId), editorSessionId, {
    _tag: "Snapshot",
    revision: 1,
    parentSessionId: editorSessionId,
    threads: [...threads],
  });
  for (const thread of threads) {
    if (!thread.sidecarSessionId) continue;
    applyDiscussionSessionUpdate(
      fixture.models.discussionConversation(thread.sidecarSessionId, editorWorkingDirectory),
      thread.sidecarSessionId,
      {
        _tag: "Snapshot",
        revision: 1,
        snapshot: {
          identity: {
            _tag: "DiscussionSession",
            sessionId: thread.sidecarSessionId,
            parentSessionId: editorSessionId,
          },
          conversation: {
            sessionId: thread.sidecarSessionId,
            sessionFile: `/sessions/${thread.sidecarSessionId}.jsonl`,
            parts: thread.parts,
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
        },
      },
    );
  }
  fixture.root.navigationStore.selectProjectSession(editorSessionId);
  fixture.root.projectWorkbenchStore.showLoadedSession(editorSessionId);
  if (options.savedIde)
    fixture.root.sessionRegistry.findSession(editorSessionId)!.showPresentation("vscode");
  fixture.root.sessionLayoutStore.ensureSession(editorSessionId);
  // jsdom cannot settle Virtuoso's initial bottom alignment. Restore a top
  // scroll preference so the real transcript mounts without fake geometry.
  const session = fixture.root.sessionRegistry.findSession(editorSessionId)!;
  session.conversationSessionStore.chatStore.transcriptInteraction.setTranscriptScrollPosition({
    kind: "top",
  });
  for (const discussion of fixture.root.reviewsStore.discussionSessions)
    discussion.chatStore.transcriptInteraction.setTranscriptScrollPosition({ kind: "top" });
  const editor = fixture.root.projectWorkbenchStore.presentationStore.embeddedEditorStore;
  // Match vscode-state.ts's authoritative state subscription, not a user operation.
  editor.applyState({ status: "ready" });
  const view = render(
    <StoreProvider store={fixture.root}>
      <VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 100 }}>
        <App />
      </VirtuosoMockContext.Provider>
    </StoreProvider>,
  );
  // Bootstrap reauthorizes the retained target; tests control only its external boundaries.
  const initialization = options.bootstrap
    ? fixture.root.projectWorkbenchStore.initialize({
        workspacePath: editorWorkingDirectory,
        sessionId: editorSessionId,
      })
    : Promise.resolve();
  return {
    user: userEvent.setup(),
    initialization,
    hydrate() {
      act(() => hydrate(editorSessionId));
    },
    disconnected() {
      // The transport connection callback in main.ts/browser-main.ts owns this routing.
      act(() => editor.disconnected());
    },
    state(snapshot: EmbeddedEditorStateSnapshot) {
      act(() => editor.applyState(snapshot));
    },
    nativeEvent(
      event: Extract<
        StoreEvent,
        {
          type:
            | "embedded-editor-selection"
            | "embedded-editor-selection-cleared"
            | "embedded-editor-toggle-chat"
            | "embedded-editor-annotation-opened";
        }
      >,
    ) {
      // Same authority ingress as application-events.ts; not native selection proof.
      act(() => fixture.root.projectWorkbenchStore.receive(event));
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
