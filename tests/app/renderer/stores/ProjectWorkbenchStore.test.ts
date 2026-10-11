import { describe, expect, it, vi } from "vitest";
import { workingDirectoryEditorLocation } from "../../../../src/ipc/editor-location";
import { TurnId } from "../../../../src/ipc/conversation-data";
import type { Client } from "../../../../src/renderer/client/Client";
import type { DrawBoardMetadata } from "../../../../src/contracts/draw/draw-board-data";
import type { DrawDocumentSnapshot } from "../../../../src/contracts/draw/draw-editor";
import type { DrawEditorAdapter } from "../../../../src/renderer/draw/DrawEditorAdapter";
import { applyConversationUpdate } from "../../../../src/renderer/reducers/ConversationReducer";
import { fakeSavedDrafts } from "../fakes/saved-drafts";
import { projectRecord, sessionSummary } from "../fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "../renderer-store-fixture";
import type { TestClientOverrides } from "../test-client";

function loadedWorkbench(client: TestClientOverrides = {}) {
  const fixture = createRendererStoreFixture({
    client,
    projects: [projectRecord({ path: "/project" })],
    sessions: [sessionSummary({ sessionId: "session-1", projectPath: "/project" })],
  });
  const session = fixture.root.sessionRegistry.load("session-1", "/project");
  fixture.root.appShellStore.selectProjectSession("session-1");
  fixture.root.projectWorkbenchStore.showLoadedSession("session-1");
  return { ...fixture, session };
}

// GUI navigation, staged-composer restoration and resolved-session editing policy
// are covered by project-navigation, root-app, session-identity and workbench workflows.
// The cached-session failure/error journey now lives in workbench-lifecycle-workflow.
// These remaining entries are bootstrap or externally initiated controls, not GUI actions.
describe("Project workbench bootstrap and external-control integration", () => {
  it("re-authorizes the shell's restored selection before accepting its workspace", async () => {
    const inspect = vi.fn<Client["workspaces"]["inspect"]>(async (input) => ({
      ...input,
      trustRequired: true,
    }));
    const open = vi.fn<Client["projectSessions"]["open"]>();
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: "/project" })],
      sessions: [sessionSummary({ sessionId: "session-1", projectPath: "/project" })],
      client: { workspaces: { inspect }, projectSessions: { open } },
    });
    fixture.root.appShellStore.selectProjectSession("session-1");

    // Root.initialize is the renderer bootstrap boundary; there is no user control for it.
    await fixture.root.initialize();

    expect(inspect).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/project" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fixture.root.projectWorkbenchStore.projectOpenStore.pendingTrustPath).toBe("/project");
    expect(fixture.root.sessionRegistry.findSession("session-1")?.workspacePath).toBe("/project");
    expect(fixture.root.appShellStore.selection).toEqual({
      kind: "project-session",
      sessionId: "session-1",
    });
    expect(open).not.toHaveBeenCalled();
  });

  it.each(["draft", "prompted"] as const)(
    "creates an agent-originated %s session without replacing the visible conversation",
    async (kind) => {
      const drafts = fakeSavedDrafts();
      const start = vi.fn<Client["projectSessions"]["start"]>(async () =>
        TurnId.make("10000000-0000-4000-8000-000000000001"),
      );
      using fixture = loadedWorkbench({
        savedDrafts: drafts.client,
        projectSessions: { start },
      });
      // Let the mount-time Saved Draft refresh settle before creating a new authority record.
      await fixture.root.sessionRegistry.pendingSessions.refreshSavedDrafts();
      const creation = fixture.root.projectWorkbenchStore.sessionCreationStore;

      const created =
        kind === "draft"
          ? await creation.createDraft("/other-project", "Background", "Run the tests")
          : await creation.createPrompted("/other-project", "Background", "Run the tests");

      expect(fixture.root.sessionRegistry.findSession(created)?.workspacePath).toBe(
        "/other-project",
      );
      expect(fixture.root.projectWorkbenchStore.projectOpenStore.projectPath).toBe("/project");
      expect(fixture.root.appShellStore.selection).toEqual({
        kind: "project-session",
        sessionId: "session-1",
      });
      if (kind === "draft") {
        expect(drafts.records.get(created)).toMatchObject({
          projectPath: "/other-project",
          title: "Background",
          text: "Run the tests",
          status: "saved",
        });
        expect(start).not.toHaveBeenCalled();
      } else {
        expect(start).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId: created,
            workingDirectory: "/other-project",
            name: "Background",
            text: "Run the tests",
          }),
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
        expect(fixture.root.sessionRegistry.pendingSessions.isTemporary(created)).toBe(false);
      }
    },
  );

  it("routes native editor selection requests only to their working directory, replacing a code-chat draft with an annotation", () => {
    using fixture = loadedWorkbench();
    const store = fixture.root.projectWorkbenchStore;
    const session = fixture.session;
    const reviews = fixture.root.reviewsStore;
    const draft = session.conversationSessionStore.composerStore.draftStore;
    // Native editor emits these transport events; jsdom cannot honestly initiate that selection.
    session.showPresentation("vscode");
    session.workspaceChatSidebarVisible = false;
    store.presentationStore.embeddedEditorStore.visible = true;
    const selection = {
      path: "src/main.ts",
      startLine: 4,
      startColumn: 2,
      endLine: 5,
      endColumn: 8,
      selectedText: "const answer =\n  calculate();",
      contextBefore: "function run() {",
      contextAfter: "}",
    };

    store.receive({
      type: "embedded-editor-side-chat-requested",
      workspacePath: "/elsewhere",
      ...selection,
    });
    expect(reviews.draftAnchor).toBeUndefined();
    expect(session.workspaceChatSidebarVisible).toBe(false);

    store.receive({
      type: "embedded-editor-side-chat-requested",
      workspacePath: "/project",
      ...selection,
    });
    expect(reviews.draftAnchor).toEqual({
      path: "src/main.ts",
      view: "file",
      start: { diffLine: 4, oldLine: 5, newLine: 5, column: 2 },
      end: { diffLine: 5, oldLine: 6, newLine: 6, column: 8 },
      selectedText: "const answer =\n  calculate();",
      contextBefore: "function run() {",
      contextAfter: "}",
      diff: "",
    });
    expect(session.workspaceChatSidebarVisible).toBe(true);
    expect(draft.attachments).toHaveLength(0);

    store.receive({
      type: "embedded-editor-annotation-requested",
      workspacePath: "/elsewhere",
      ...selection,
      comment: "Ignore this other workspace",
    });
    expect(reviews.draftAnchor).toBeDefined();
    expect(draft.attachments).toHaveLength(0);

    store.receive({
      type: "embedded-editor-annotation-requested",
      workspacePath: "/project",
      ...selection,
      comment: "Why is this here?",
    });
    expect(reviews.draftAnchor).toBeUndefined();
    expect(draft.attachments).toEqual([
      {
        kind: "source",
        name: "src/main.ts",
        location: { path: "src/main.ts", range: { start: { line: 4 }, end: { line: 5 } } },
        selectedText: "const answer =\n  calculate();",
        comment: "Why is this here?",
      },
    ]);
    expect(session.workspaceChatSidebarVisible).toBe(true);
  });
});

const drawBoard: DrawBoardMetadata = {
  id: "11111111-1111-4111-8111-111111111111",
  sessionId: "session-1",
  title: "Board 1",
  revision: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const emptyDocument: DrawDocumentSnapshot = {
  type: "cake-excalidraw",
  version: 1,
  source: "cake",
  elements: [],
  appState: { viewBackgroundColor: "#ffffff" },
  files: {},
};
const editedDocument: DrawDocumentSnapshot = {
  ...emptyDocument,
  appState: { viewBackgroundColor: "#f8f9fa" },
};

// A document-only native boundary: no simulated canvas, geometry, playback,
// export implementation or Store callbacks. Every unused editor operation fails.
function documentEditorBoundary() {
  let document = emptyDocument;
  const unexpected = () => {
    throw new Error("Unexpected native editor operation");
  };
  const adapter: DrawEditorAdapter = {
    snapshotDocument: () => document,
    loadDocument: (snapshot) => {
      document = snapshot;
    },
    exportDocument: unexpected,
    read: unexpected,
    render: async () => unexpected(),
    apply: unexpected,
    applyAnimated: async () => unexpected(),
    insertMermaid: async () => unexpected(),
    clear: unexpected,
  };
  return {
    adapter,
    replaceDocument(snapshot: DrawDocumentSnapshot) {
      document = snapshot;
    },
  };
}
function saveGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
async function drawingWorkbench(client: TestClientOverrides = {}) {
  let authorityBoard = drawBoard;
  let persistedDocument = emptyDocument;
  const persistSave: Client["draw"]["save"] = async (input) => {
    if (input.boardId !== authorityBoard.id || input.expectedRevision !== authorityBoard.revision)
      throw new Error("Unexpected board revision");
    persistedDocument = input.snapshot;
    authorityBoard = { ...authorityBoard, revision: authorityBoard.revision + 1 };
    return authorityBoard;
  };
  const save = vi.fn<Client["draw"]["save"]>(persistSave);
  const fixture = loadedWorkbench({
    ...client,
    draw: {
      list: async () => [authorityBoard],
      read: async () => ({ board: authorityBoard, snapshot: persistedDocument }),
      save,
    },
  });
  const session = fixture.session;
  applyConversationUpdate(session.model, {
    _tag: "Snapshot",
    revision: 1,
    snapshot: {
      sessionId: session.sessionId,
      sessionFile: "/sessions/session-1.jsonl",
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
  await session.drawStore.initialize();
  const editor = documentEditorBoundary();
  session.drawStore.attachEditor(editor.adapter);
  session.showPresentation("draw");
  editor.replaceDocument(editedDocument);
  session.drawStore.editorChanged();
  return {
    ...fixture,
    save,
    persistSave,
    persisted: () => ({ board: authorityBoard, document: persistedDocument }),
  };
}

// These native-document coordination regressions use the real Root/Registry/
// Session/Draw/Presentation/Selections composition. Draw App loading/retry is
// covered elsewhere; these assertions do not claim native focus or source geometry.
describe("Draw document navigation integration", () => {
  it("keeps Draw open after a failed flush and returns to Agent only once the retry commits", async () => {
    using fixture = await drawingWorkbench();
    const session = fixture.session;
    const presentation = fixture.root.projectWorkbenchStore.presentationStore;
    const draft = session.conversationSessionStore.composerStore.draftStore;
    const originalFocusRevision = draft.focusRequestRevision;
    fixture.save.mockRejectedValueOnce(new Error("disk full"));

    await presentation.backToAgent();

    expect(session.presentationMode).toBe("draw");
    expect(draft.focusRequestRevision).toBe(originalFocusRevision);
    expect(session.drawStore.error).toContain("disk full");
    expect(fixture.persisted()).toEqual({ board: drawBoard, document: emptyDocument });

    const started = saveGate();
    const finish = saveGate();
    fixture.save.mockImplementationOnce(async (input, options) => {
      started.resolve();
      await finish.promise;
      return fixture.persistSave(input, options);
    });
    const returning = presentation.backToAgent();
    await started.promise;
    expect(session.presentationMode).toBe("draw");
    expect(draft.focusRequestRevision).toBe(originalFocusRevision);
    finish.resolve();
    await returning;

    expect(session.presentationMode).toBe("normal");
    expect(draft.focusRequestRevision).toBe(originalFocusRevision + 1);
    expect(session.drawStore.error).toBeUndefined();
    expect(fixture.persisted()).toEqual({
      board: { ...drawBoard, revision: 1 },
      document: editedDocument,
    });
    expect(fixture.save).toHaveBeenCalledTimes(2);
    for (const [input] of fixture.save.mock.calls)
      expect(input).toEqual({
        sessionId: "session-1",
        boardId: drawBoard.id,
        expectedRevision: 0,
        snapshot: editedDocument,
      });
  });

  it("commits Draw's dirty document before switching to VS Code and revealing the exact source location", async () => {
    const order: string[] = [];
    const open = vi.fn<Client["vscode"]["open"]>(async () => {
      order.push("editor-open");
    });
    const reveal = vi.fn<Client["vscode"]["reveal"]>(async () => {
      order.push("editor-reveal");
      return { outcome: { view: "file" }, locations: [] };
    });
    using fixture = await drawingWorkbench({
      vscode: {
        open,
        reveal,
        updateSelectionHighlights: async () => undefined,
        updateAnnotations: async () => undefined,
      },
    });
    const started = saveGate();
    const finish = saveGate();
    fixture.save.mockImplementationOnce(async (input, options) => {
      order.push("save-start");
      started.resolve();
      await finish.promise;
      const committed = await fixture.persistSave(input, options);
      order.push("save-commit");
      return committed;
    });
    const location = workingDirectoryEditorLocation({
      path: "src/app.ts",
      range: { start: { line: 4, column: 2 }, end: { line: 8, column: 7 } },
    });
    const opening = fixture.root.projectWorkbenchStore.presentationStore.openFile(location);
    await started.promise;

    expect(fixture.session.presentationMode).toBe("draw");
    expect(fixture.persisted()).toEqual({ board: drawBoard, document: emptyDocument });
    expect(open).not.toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();
    finish.resolve();
    await opening;

    expect(order).toEqual(["save-start", "save-commit", "editor-open", "editor-reveal"]);
    expect(fixture.session.presentationMode).toBe("vscode");
    expect(fixture.session.drawStore.activeBoard?.revision).toBe(1);
    expect(fixture.persisted()).toEqual({
      board: { ...drawBoard, revision: 1 },
      document: editedDocument,
    });
    expect(fixture.save).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledExactlyOnceWith(
      "/project",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(reveal).toHaveBeenCalledExactlyOnceWith(
      "/project",
      location,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
