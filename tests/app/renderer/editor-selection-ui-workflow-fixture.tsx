import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Schema } from "effect";
import { StoreProvider } from "r-state-tree/react";
import { vi } from "vitest";
import type { JsonObject } from "../../../src/contracts/serialization/json-contract";
import {
  EditorSelectionOpenResult,
  EditorSelectionState,
} from "../../../src/contracts/editor/editor-selection";
import type { Client } from "../../../src/renderer/client/Client";
import { App } from "../../../src/renderer/components/app";
import { applyConversationSnapshot } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

export const selectionWorkspace = "/project";
export const selectionSessionId = "tour-session";

/** The command driver is Cake's public application-control API, not a Store mock. */
export async function createSelectionCommandFixture(
  client: TestClientOverrides = {},
  options: { secondary?: boolean } = {},
) {
  const reveal = vi.fn<Client["vscode"]["reveal"]>(async (_workspace, location) => ({
    outcome: { view: "file" },
    locations: (location.ranges ?? (location.range ? [location.range] : [])).map((range) => ({
      kind: location.kind,
      path: location.path,
      view: "file",
      range,
    })),
  }));
  const highlights = vi.fn<Client["vscode"]["updateSelectionHighlights"]>(async () => undefined);
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: selectionWorkspace, name: "Project" })],
    sessions: [selectionSessionId, ...(options.secondary ? ["other-tour"] : [])].map((sessionId) =>
      sessionSummary({ sessionId, projectPath: selectionWorkspace, title: sessionId }),
    ),
    client: {
      ...client,
      workspaces: { loadStagedSlashCommands: async () => [], ...client.workspaces },
      vscode: {
        open: async () => undefined,
        updateBounds: async () => undefined,
        updateAnnotations: async () => undefined,
        reveal,
        updateSelectionHighlights: highlights,
        ...client.vscode,
      },
    },
  });
  for (const sessionId of [selectionSessionId, ...(options.secondary ? ["other-tour"] : [])]) {
    const session = fixture.root.sessionRegistry.load(sessionId, selectionWorkspace);
    applyConversationSnapshot(session.model, {
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
    });
  }
  fixture.root.appShellStore.selectProjectSession(selectionSessionId);
  fixture.root.projectWorkbenchStore.showLoadedSession(selectionSessionId);
  fixture.root.sessionLayoutStore.ensureSession(selectionSessionId);
  fixture.root.projectWorkbenchStore.presentationStore.embeddedEditorStore.applyState({
    status: "ready",
  });
  const invoke = (name: string, args: JsonObject = {}, sessionId = selectionSessionId) =>
    fixture.root.applicationControlStore.invoke(
      { name, arguments: args },
      {
        kind: "project-session",
        sessionId,
        title: sessionId,
        projectName: "Project",
        projectPath: selectionWorkspace,
        workingDirectory: selectionWorkspace,
      },
    );
  try {
    Schema.decodeUnknownSync(
      Schema.Struct({
        ok: Schema.Literal(true),
        command: Schema.Literal("vscode.enter"),
        entered: Schema.Literal(true),
      }),
    )(await invoke("vscode.enter"));
  } catch (error) {
    fixture[Symbol.dispose]();
    throw error;
  }
  return {
    ...fixture,
    reveal,
    highlights,
    invoke,
    async open(args: JsonObject = { path: "src/tour.ts", line: 2, endLine: 3 }) {
      const result = Schema.decodeUnknownSync(
        Schema.Struct({
          ok: Schema.Literal(true),
          command: Schema.Literal("vscode.open"),
          selection: EditorSelectionOpenResult,
        }),
      )(await invoke("vscode.open", args));
      return result.selection;
    },
    async list() {
      const result = Schema.decodeUnknownSync(
        Schema.Struct({
          ok: Schema.Literal(true),
          command: Schema.Literal("vscode.selections.list"),
          state: EditorSelectionState,
        }),
      )(await invoke("vscode.selections.list"));
      return result.state;
    },
  };
}

export async function renderSelectionUi(
  client: TestClientOverrides = {},
  options: { secondary?: boolean } = {},
) {
  const fixture = await createSelectionCommandFixture(client, options);
  try {
    // Establish a completed agent tour through the authoritative command boundary.
    // No native editor, iframe contents, geometry or manual selection is simulated.
    await fixture.open();
    await fixture.open({ path: "src/next.ts", line: 8 });
    const view = render(
      <StoreProvider store={fixture.root}>
        <App />
      </StoreProvider>,
    );
    return {
      user: userEvent.setup(),
      reveal: fixture.reveal,
      highlights: fixture.highlights,
      // Agent commands have no UI control: this is the public application boundary.
      invoke: fixture.invoke,
      [Symbol.dispose]() {
        view.unmount();
        fixture[Symbol.dispose]();
      },
    };
  } catch (error) {
    fixture[Symbol.dispose]();
    throw error;
  }
}
