import { createStore, mount, toSnapshot, updateStore } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorSelectionsStore } from "../../../../src/renderer/stores/EditorSelectionsStore";
import { workingDirectoryEditorLocation } from "../../../../src/ipc/editor-location";
import type { Client } from "../../../../src/renderer/client/Client";
import type { ExtensionUiStore } from "../../../../src/renderer/stores/ExtensionUiStore";
import type { ProjectCatalogStore } from "../../../../src/renderer/stores/ProjectCatalogStore";
import { ProjectWorkbenchStore } from "../../../../src/renderer/stores/ProjectWorkbenchStore";
import type { ReviewsStore } from "../../../../src/renderer/stores/ReviewsStore";
import type { SessionCatalogStore } from "../../../../src/renderer/stores/SessionCatalogStore";
import type { SessionRegistryStore } from "../../../../src/renderer/stores/SessionRegistryStore";
import { SessionOperationCoordinatorStore } from "../../../../src/renderer/stores/SessionOperationCoordinatorStore";
import { mountWithClient } from "../mount-with-client";

function mountWorkbench(
  registry: SessionRegistryStore,
  catalog: SessionCatalogStore,
  client: Client,
  initialActiveSessionId?: string,
  restoreStagedSession?: (projectPath: string) => string | undefined,
  workflow?: {
    prepareWorkingDirectoryRetirement?(workingDirectories: readonly string[]): Promise<boolean>;
    onWorktreeSessionsResolved?(sessionIds: readonly string[], projectPath: string): Promise<void>;
    openSessionById?(sessionId: string): Promise<void>;
    reviews?: Partial<ReviewsStore>;
  },
) {
  let activeSessionId = initialActiveSessionId;
  const selectSession = vi.fn((sessionId: string) => {
    activeSessionId = sessionId;
  });
  const operations = mount(createStore(SessionOperationCoordinatorStore));
  const mounted = mountWithClient(
    createStore(ProjectWorkbenchStore, {
      retirement: {
        prepare: workflow?.prepareWorkingDirectoryRetirement ?? (async () => true),
      },
      sessionRegistry: registry,
      operations,
      projects: {
        nameFromPath: (path: string) => path.split("/").at(-1) ?? path,
        nameForPath: (path: string) => path.split("/").at(-1) ?? path,
        recordOpened: vi.fn(),
      } as unknown as ProjectCatalogStore,
      globalLabels: () => [],
      reviews: () =>
        ({
          codeThreadsForSession: () => [],
          threadStreaming: () => false,
          ...workflow?.reviews,
        }) as unknown as ReviewsStore,
      extensionUi: () => ({ clear: vi.fn() }) as unknown as ExtensionUiStore,
      catalog,
      startCakeChat: async () => undefined,
      onWorktreeSessionsResolved: workflow?.onWorktreeSessionsResolved ?? (async () => undefined),
      openSessionById: workflow?.openSessionById ?? (async () => undefined),
      activeSessionId: () => activeSessionId,
      restoreStagedSession,
      selectSession,
      toggleProjectSidebar: vi.fn(),
      enterIdeSidebarMode: vi.fn(),
      leaveIdeSidebarMode: vi.fn(),
      projectSidebarWidth: () => 292,
    }),
    client,
  );
  return { ...mounted, operations, selectSession };
}

const selectionStores: EditorSelectionsStore[] = [];
afterEach(() => {
  for (const store of selectionStores.splice(0)) store[Symbol.dispose]();
});
function emptySelections() {
  const store = mount(
    createStore(EditorSelectionsStore, {
      sessionId: "session-1",
      openLocation: async () => {
        throw new Error("Unexpected editor navigation");
      },
      refreshHighlights: async () => undefined,
    }),
  );
  selectionStores.push(store);
  return store;
}

function loadedSessionStub(model: { sessionFile: string }, workspacePath = "/project") {
  return {
    sessionId: "session-1",
    workspacePath,
    model,
    editorSelectionsStore: emptySelections(),
    presentationMode: "normal" as const,
    workspaceChatSidebarVisible: true,
    workspaceChatSidebarWidth: 420,
    showPresentation: vi.fn(),
    toggleWorkspaceChatSidebar: vi.fn(),
    showWorkspaceChatSidebar: vi.fn(),
    setWorkspaceChatSidebarWidth: vi.fn(),
    conversationSessionStore: {
      composerStore: {
        draftStore: {
          requestFocus: vi.fn(),
          setEditorContextAttachment: vi.fn(),
        },
      },
    },
    markRead: vi.fn(),
  };
}

// Migration backlog: retain the remaining startup, background-session,
// and editing-surface contracts until equivalent real workflow coverage replaces them.
// Navigation moved to project-navigation-workflow; new-session opening to
// project-open-workflow; saved Draft worktree naming to worktree-creation-workflow;
// bulk cleanup and worktree resolution to workbench-workflow; fork selection
// and identity-only runtime opening to session-continuation-workflow.
describe("ProjectWorkbenchStore startup selection", () => {
  it("hydrates its runtime view from the shell selection without persisting another selection", async () => {
    const inspect = vi.fn(async (input: { operationId: string; path: string }) => ({
      ...input,
      trustRequired: true,
    }));
    const load = vi.fn();
    const registry = {
      findSession: () => undefined,
      load,
      pendingSessions: { isTemporary: () => false, isDraft: () => false },
    } as unknown as SessionRegistryStore;
    const {
      root,
      subject: store,
      operations,
      selectSession,
    } = mountWorkbench(
      registry,
      {} as SessionCatalogStore,
      { workspaces: { inspect } } as unknown as Client,
      "session-1",
    );

    await store.initialize({ workspacePath: "/project", sessionId: "session-1" });

    expect(store.projectOpenStore.projectPath).toBe("/project");
    expect(store.activeSessionId).toBe("session-1");
    expect(load).toHaveBeenCalledWith("session-1", "/project");
    expect(inspect).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/project" }),
      expect.any(Object),
    );
    const snapshot = toSnapshot(store);
    expect(snapshot.state).not.toHaveProperty("selectedSessionId");
    expect(snapshot.state).not.toHaveProperty("projectPath");
    expect(snapshot.children.projectOpenStore).toMatchObject({
      state: { projectPath: "/project" },
    });
    expect(selectSession).not.toHaveBeenCalled();

    root[Symbol.dispose]();
    operations[Symbol.dispose]();
  });

  it("restores the focused pane's staged composer when starting a new session", async () => {
    const stagedSession = { sessionId: "staged-1", workspacePath: "/project" };
    const registry = {
      findSession: (sessionId: string) =>
        sessionId === stagedSession.sessionId ? stagedSession : undefined,
      pendingSessions: { isStaged: () => false },
    } as unknown as SessionRegistryStore;
    const restoreStagedSession = vi.fn(() => stagedSession.sessionId);
    const {
      root,
      subject: store,
      operations,
      selectSession,
    } = mountWorkbench(
      registry,
      {} as SessionCatalogStore,
      {} as Client,
      undefined,
      restoreStagedSession,
    );
    const showLoadedSession = vi.spyOn(store, "showLoadedSession").mockReturnValue(true);

    await store.startNewSession("/project");

    expect(restoreStagedSession).toHaveBeenCalledWith("/project");
    expect(selectSession).toHaveBeenCalledWith(stagedSession.sessionId);
    expect(showLoadedSession).toHaveBeenCalledWith(stagedSession.sessionId);

    root[Symbol.dispose]();
    operations[Symbol.dispose]();
  });

  it("creates agent drafts in the background without changing the visible session", async () => {
    const pendingConversation = { setName: vi.fn(), setConfiguration: vi.fn() };
    const pendingSessions = {
      prepare: vi.fn(),
      conversation: vi.fn(() => pendingConversation),
      createDraft: vi.fn(async () => undefined),
    };
    const registry = {
      findSession: () => undefined,
      pendingSessions,
      removeSession: vi.fn(),
    } as unknown as SessionRegistryStore;
    const {
      root,
      subject: store,
      operations,
      selectSession,
    } = mountWorkbench(registry, {} as SessionCatalogStore, {} as Client, "visible-session");
    store.projectOpenStore.projectPath = "/visible-project";

    const created = await store.sessionCreationStore.createDraft(
      "/other-project",
      "Draft",
      "Do this later",
    );

    expect(pendingSessions.prepare).toHaveBeenCalledWith("/other-project", created);
    expect(pendingSessions.createDraft).toHaveBeenCalledWith(created, "Do this later", []);
    expect(store.projectOpenStore.projectPath).toBe("/visible-project");
    expect(store.activeSessionId).toBe("visible-session");
    expect(selectSession).not.toHaveBeenCalled();

    root[Symbol.dispose]();
    operations[Symbol.dispose]();
  });

  it("starts agent-created sessions in the background without changing the visible session", async () => {
    const start = vi.fn(async () => undefined);
    const pendingConversation = { setName: vi.fn(), setConfiguration: vi.fn() };
    const pendingSessions = {
      prepare: vi.fn(),
      conversation: vi.fn(() => pendingConversation),
      projectSubmission: vi.fn(),
      materialize: vi.fn(),
    };
    const registry = {
      findSession: () => undefined,
      pendingSessions,
      removeSession: vi.fn(),
    } as unknown as SessionRegistryStore;
    const {
      root,
      subject: store,
      operations,
      selectSession,
    } = mountWorkbench(
      registry,
      {} as SessionCatalogStore,
      { projectSessions: { start } } as unknown as Client,
      "visible-session",
    );
    store.projectOpenStore.projectPath = "/visible-project";

    const created = await store.sessionCreationStore.createPrompted(
      "/other-project",
      "Background",
      "Run the tests",
    );

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: created,
        workingDirectory: "/other-project",
        name: "Background",
        text: "Run the tests",
      }),
      expect.any(Object),
    );
    expect(pendingSessions.materialize).toHaveBeenCalledWith(created, "/other-project");
    expect(store.projectOpenStore.projectPath).toBe("/visible-project");
    expect(store.activeSessionId).toBe("visible-session");
    expect(selectSession).not.toHaveBeenCalled();

    root[Symbol.dispose]();
    operations[Symbol.dispose]();
  });

  it("keeps a failed open attached to the selected session error state", async () => {
    const error = new Error("Cake could not find Project Session session-1");
    const open = vi.fn(async () => Promise.reject(error));
    const registry = {
      findSession: () => undefined,
    } as unknown as SessionRegistryStore;
    const catalog = {
      find: (sessionId: string) => ({
        sessionId,
        workingDirectory: "/project",
        unread: false,
      }),
    } as SessionCatalogStore;
    const {
      root,
      subject: store,
      operations,
    } = mountWorkbench(registry, catalog, {
      projectSessions: { open },
    } as unknown as Client);

    await store.openSession("session-1");

    expect(store.contextError("session-1")).toEqual({
      message: "Cake could not find Project Session session-1",
      details: expect.stringContaining("Context:\nOpening Project Session"),
    });

    root[Symbol.dispose]();
    operations[Symbol.dispose]();
  });

  it("routes explicit VS Code selection actions to the code-chat draft and the project composer", () => {
    const draftStore = {
      addSourceAttachment: vi.fn(),
      requestFocus: vi.fn(),
      setEditorContextAttachment: vi.fn(),
    };
    const session = {
      workspacePath: "/project",
      model: { sessionId: "session-1", sessionFile: "/sessions/session-1.jsonl" },
      editorSelectionsStore: emptySelections(),
      presentationMode: "vscode" as const,
      workspaceChatSidebarVisible: true,
      workspaceChatSidebarWidth: 420,
      showWorkspaceChatSidebar: vi.fn(),
      conversationSessionStore: { composerStore: { draftStore } },
      markRead: vi.fn(),
    };
    const reviews = {
      prepareDraft: vi.fn(),
      cancelDraft: vi.fn(),
      clearActiveThread: vi.fn(),
    };
    const registry = {
      findSession: (sessionId: string) => (sessionId === "session-1" ? session : undefined),
      pendingSessions: { isTemporary: () => false },
    } as unknown as SessionRegistryStore;
    const {
      root,
      subject: store,
      operations,
    } = mountWorkbench(
      registry,
      {} as SessionCatalogStore,
      {} as unknown as Client,
      "session-1",
      undefined,
      { reviews: reviews as unknown as Partial<ReviewsStore> },
    );
    store.projectOpenStore.projectPath = "/project";
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

    // Selections from another Working Directory never touch this session.
    store.receive({
      type: "embedded-editor-side-chat-requested",
      workspacePath: "/elsewhere",
      ...selection,
    });
    expect(reviews.prepareDraft).not.toHaveBeenCalled();

    store.receive({
      type: "embedded-editor-side-chat-requested",
      workspacePath: "/project",
      ...selection,
    });
    expect(reviews.clearActiveThread).toHaveBeenCalledTimes(1);
    expect(reviews.prepareDraft).toHaveBeenCalledWith({
      path: "src/main.ts",
      view: "file",
      start: { diffLine: 4, oldLine: 5, newLine: 5, column: 2 },
      end: { diffLine: 5, oldLine: 6, newLine: 6, column: 8 },
      selectedText: "const answer =\n  calculate();",
      contextBefore: "function run() {",
      contextAfter: "}",
      diff: "",
    });
    expect(session.showWorkspaceChatSidebar).toHaveBeenCalledTimes(1);
    expect(draftStore.addSourceAttachment).not.toHaveBeenCalled();

    store.receive({
      type: "embedded-editor-annotation-requested",
      workspacePath: "/project",
      ...selection,
      comment: "Why is this here?",
    });
    // The annotation lands in the project composer, so any code-chat draft steps aside.
    expect(reviews.cancelDraft).toHaveBeenCalledTimes(1);
    expect(reviews.clearActiveThread).toHaveBeenCalledTimes(2);
    expect(draftStore.addSourceAttachment).toHaveBeenCalledWith({
      kind: "source",
      name: "src/main.ts",
      location: { path: "src/main.ts", range: { start: { line: 4 }, end: { line: 5 } } },
      selectedText: "const answer =\n  calculate();",
      comment: "Why is this here?",
    });
    expect(session.showWorkspaceChatSidebar).toHaveBeenCalledTimes(2);

    root[Symbol.dispose]();
    operations[Symbol.dispose]();
  });

  it("keeps Draw open when its working document cannot be flushed", async () => {
    const flush = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue(undefined);
    const showPresentation = vi.fn();
    const requestFocus = vi.fn();
    const session = {
      sessionId: "session-1",
      workspacePath: "/project",
      model: { sessionId: "session-1", sessionFile: "/session.jsonl" },
      editorSelectionsStore: emptySelections(),
      presentationMode: "draw" as const,
      drawStore: { flush },
      showPresentation,
      conversationSessionStore: {
        composerStore: {
          draftStore: { setEditorContextAttachment: vi.fn(), requestFocus },
        },
      },
      markRead: vi.fn(),
    };
    const registry = {
      findSession: vi.fn(() => session),
      pendingSessions: { isTemporary: vi.fn(() => false) },
    } as unknown as SessionRegistryStore;
    const {
      root,
      subject: store,
      operations,
    } = mountWorkbench(registry, {} as SessionCatalogStore, {} as Client, "session-1");

    await store.presentationStore.backToAgent();
    expect(showPresentation).not.toHaveBeenCalled();
    expect(requestFocus).not.toHaveBeenCalled();

    await store.presentationStore.backToAgent();
    expect(flush).toHaveBeenCalledTimes(2);
    expect(showPresentation).toHaveBeenCalledWith("normal");
    expect(requestFocus).toHaveBeenCalledOnce();

    root[Symbol.dispose]();
    operations[Symbol.dispose]();
  });

  it("switches from Draw to VS Code and reveals an exact source location", async () => {
    const flush = vi.fn(async () => undefined);
    const session = {
      ...loadedSessionStub({ sessionFile: "/session.jsonl" }),
      presentationMode: "draw" as const,
      drawStore: { flush },
    };
    const registry = {
      findSession: vi.fn(() => session),
      pendingSessions: { isTemporary: vi.fn(() => false) },
    } as unknown as SessionRegistryStore;
    const catalog = {
      find: vi.fn(() => ({ sessionId: "session-1", resolved: false })),
    } as unknown as SessionCatalogStore;
    const open = vi.fn(async () => undefined);
    const reveal = vi.fn(async () => ({ outcome: { view: "file" as const }, locations: [] }));
    const updateSelectionHighlights = vi.fn(async () => undefined);
    const updateAnnotations = vi.fn(async () => undefined);
    const {
      root,
      subject: store,
      operations,
    } = mountWorkbench(
      registry,
      catalog,
      {
        vscode: { open, reveal, updateAnnotations, updateSelectionHighlights },
      } as unknown as Client,
      "session-1",
    );
    store.projectOpenStore.projectPath = "/project";
    updateStore(session.editorSelectionsStore, {
      openLocation: (location, signal) =>
        store.presentationStore.openSelectionLocation("session-1", location, signal),
      refreshHighlights: () =>
        store.presentationStore.embeddedEditorStore.syncSelectionHighlights(),
    });
    const location = workingDirectoryEditorLocation({
      path: "src/app.ts",
      range: { start: { line: 4, column: 2 }, end: { line: 8, column: 7 } },
    });

    await store.presentationStore.openFile(location);

    expect(flush).toHaveBeenCalledOnce();
    expect(session.showPresentation).toHaveBeenCalledWith("vscode");
    expect(open).toHaveBeenCalledWith("/project", expect.anything());
    expect(reveal).toHaveBeenCalledWith("/project", location, expect.anything());

    root[Symbol.dispose]();
    operations[Symbol.dispose]();
  });

  it("does not open editing surfaces for a resolved session", async () => {
    const session = {
      ...loadedSessionStub({ sessionFile: "/session.jsonl" }),
      presentationMode: "vscode" as const,
    };
    const registry = {
      findSession: vi.fn(() => session),
      pendingSessions: { isTemporary: vi.fn(() => false) },
    } as unknown as SessionRegistryStore;
    const catalog = {
      find: vi.fn(() => ({ sessionId: "session-1", resolved: true })),
    } as unknown as SessionCatalogStore;
    const open = vi.fn(async () => undefined);
    const openSourceControl = vi.fn(async () => undefined);
    const {
      root,
      subject: store,
      operations,
    } = mountWorkbench(
      registry,
      catalog,
      { vscode: { open, openSourceControl } } as unknown as Client,
      "session-1",
    );
    store.projectOpenStore.projectPath = "/project";

    store.presentationStore.restore();
    await store.presentationStore.openIde();
    await store.presentationStore.openWorkspaceChanges();
    await store.presentationStore.openFile(workingDirectoryEditorLocation({ path: "src/app.ts" }));

    expect(store.presentationStore.embeddedEditorStore.visible).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(openSourceControl).not.toHaveBeenCalled();

    root[Symbol.dispose]();
    operations[Symbol.dispose]();
  });
});
