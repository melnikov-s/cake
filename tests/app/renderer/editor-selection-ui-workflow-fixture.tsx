import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StoreProvider } from "r-state-tree/react";
import { vi } from "vitest";
import type { JsonObject } from "../../../src/ipc/json-contract";
import type { Client } from "../../../src/renderer/client/Client";
import { App } from "../../../src/renderer/components/app";
import { applyConversationSnapshot } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

export const selectionWorkspace = "/project";
export const selectionSessionId = "tour-session";

/** The command driver is Cake's public application-control API, not a Store mock. */
export async function createSelectionCommandFixture(client: TestClientOverrides = {}) {
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
    sessions: [sessionSummary({ sessionId: selectionSessionId, projectPath: selectionWorkspace })],
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
  const session = fixture.root.sessionRegistry.load(selectionSessionId, selectionWorkspace);
  applyConversationSnapshot(session.model, {
    sessionId: selectionSessionId,
    sessionFile: "/sessions/tour-session.jsonl",
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
  fixture.root.appShellStore.selectProjectSession(selectionSessionId);
  fixture.root.projectWorkbenchStore.showLoadedSession(selectionSessionId);
  fixture.root.sessionLayoutStore.ensureSession(selectionSessionId);
  fixture.root.projectWorkbenchStore.presentationStore.embeddedEditorStore.applyState({
    status: "ready",
  });
  const invoke = (name: string, args: JsonObject = {}) =>
    fixture.root.applicationControlStore.invoke(
      { name, arguments: args },
      {
        kind: "project-session",
        sessionId: selectionSessionId,
        title: "Tour",
        projectName: "Project",
        projectPath: selectionWorkspace,
        workingDirectory: selectionWorkspace,
      },
    );
  try {
    const entering = await invoke("vscode.enter");
    if (!entering.ok) throw new Error("Could not enter editor presentation");
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
      const result = await invoke("vscode.open", args);
      if (!result.ok || result.command !== "vscode.open")
        throw new Error("Could not open selection");
      return result.selection;
    },
    async list() {
      const result = await invoke("vscode.selections.list");
      if (!result.ok || result.command !== "vscode.selections.list")
        throw new Error("Could not list selections");
      return result.state;
    },
  };
}

export async function renderSelectionUi(client: TestClientOverrides = {}) {
  const fixture = await createSelectionCommandFixture(client);
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
