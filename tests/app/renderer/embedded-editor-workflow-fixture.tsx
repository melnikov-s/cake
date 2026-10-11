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

export function renderEmbeddedEditor(client: TestClientOverrides) {
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: editorWorkingDirectory, name: "Project" })],
    sessions: [
      sessionSummary({
        sessionId: editorSessionId,
        title: "Editor conversation",
        projectPath: editorWorkingDirectory,
        workingDirectory: editorWorkingDirectory,
      }),
    ],
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
  fixture.root.sessionRegistry.load(editorSessionId, editorWorkingDirectory);
  applyConversationUpdate(
    fixture.models.projectConversation(editorSessionId, editorWorkingDirectory),
    {
      _tag: "Snapshot",
      revision: 1,
      snapshot: {
        sessionId: editorSessionId,
        sessionFile: `/sessions/${editorSessionId}.jsonl`,
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
  fixture.root.appShellStore.selectProjectSession(editorSessionId);
  fixture.root.projectWorkbenchStore.showLoadedSession(editorSessionId);
  fixture.root.sessionLayoutStore.ensureSession(editorSessionId);
  const editor = fixture.root.projectWorkbenchStore.presentationStore.embeddedEditorStore;
  // Match vscode-state.ts's authoritative state subscription, not a user operation.
  editor.applyState({ status: "ready" });
  const view = render(
    <StoreProvider store={fixture.root}>
      <App />
    </StoreProvider>,
  );
  return {
    user: userEvent.setup(),
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
