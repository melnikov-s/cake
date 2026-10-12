import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StoreProvider } from "r-state-tree/react";
import type { EmbeddedEditorStateSnapshot } from "../../../src/renderer/client/Client";
import { App } from "../../../src/renderer/components/app";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
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
  fixture.root.appShellStore.selectProjectSession(editorSessionId);
  fixture.root.projectWorkbenchStore.showLoadedSession(editorSessionId);
  if (options.savedIde)
    fixture.root.sessionRegistry.findSession(editorSessionId)!.showPresentation("vscode");
  fixture.root.sessionLayoutStore.ensureSession(editorSessionId);
  const editor = fixture.root.projectWorkbenchStore.presentationStore.embeddedEditorStore;
  // Match vscode-state.ts's authoritative state subscription, not a user operation.
  editor.applyState({ status: "ready" });
  const view = render(
    <StoreProvider store={fixture.root}>
      <App />
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
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
