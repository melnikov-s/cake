import { describe, expect, it, vi } from "vitest";
import { StoreProvider } from "r-state-tree/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { jsonValueSchema } from "../../../../src/ipc/json-contract";
import type { SessionPreview, SessionSnapshot } from "../../../../src/ipc/session-contract";
import { type CakePluginSession, usePluginSession } from "../../../../src/renderer/cake";
import type { DesktopClient, DesktopClientEvent } from "../../../../src/renderer/desktop-client";
import { mountRootStore } from "../../../../src/renderer/mount-root-store";
import type { ProjectWorkbenchStore } from "../../../../src/renderer/stores/ProjectWorkbenchStore";

const snapshot: SessionSnapshot = {
  workspacePath: "/project",
  sessionId: "session-1",
  sessionFile: "/sessions/one.jsonl",
  parts: [],
  models: [],
  thinkingLevel: "off",
  availableThinkingLevels: ["off"],
  streaming: false,
  diagnostics: [],
  commands: [],
  compatibility: { resources: [], diagnostics: [] },
  extensionUi: { statuses: [] },
  sessions: [],
  tree: [],
};

function createDesktopClient(restoredPath?: string) {
  let listener: ((event: DesktopClientEvent) => void) | undefined;
  const client: DesktopClient = {
    chooseProject: vi.fn(async () => "/project"),
    openExternalUrl: vi.fn(async () => undefined),
    showTranscriptSelectionContextMenu: vi.fn(async () => undefined),
    showComposerContextMenu: vi.fn(async () => undefined),
    rewordComposerSelection: vi.fn(async ({ selection }) => selection),
    showSessionContextMenu: vi.fn(async () => undefined),
    listModels: vi.fn(async () => [
      {
        provider: "fixture-provider",
        providerName: "Fixture provider",
        id: "fixture-model",
        name: "Fixture model",
        reasoning: false,
        availableThinkingLevels: ["off" as const],
        fastMode: false,
        input: ["text" as const],
        authenticated: true,
        authTypes: [],
      },
    ]),
    getHomeDirectory: vi.fn(async () => "/home/user"),
    getCustomizationState: vi.fn(async () => ({
      schemaVersion: 1 as const,
      recoveryRequired: false,
      diagnostics: [],
      updatedAt: new Date(0).toISOString(),
    })),
    getPluginAuthoringReference: vi.fn(async () => "reference"),
    listPluginFiles: vi.fn(async () => ({
      workingRevision: "a".repeat(64),
      buildRevision: "a".repeat(64),
      files: [],
    })),
    createPlugin: vi.fn(async () => ({
      workingRevision: "a".repeat(64),
      buildRevision: "a".repeat(64),
      files: [],
    })),
    readPluginFile: vi.fn(async () => ""),
    writePluginFile: vi.fn(async () => ({
      workingRevision: "a".repeat(64),
      buildRevision: "a".repeat(64),
      files: [],
    })),
    validateCustomization: vi.fn(async () => ({
      revision: "a".repeat(64),
      sourceRevision: "a".repeat(64),
      diagnostics: [],
      valid: true,
    })),
    activateCustomization: vi.fn(async () => ({
      revision: "a".repeat(64),
      activating: true as const,
    })),
    rollbackCustomization: vi.fn(async () => ({
      schemaVersion: 1 as const,
      recoveryRequired: false,
      diagnostics: [],
      updatedAt: new Date(0).toISOString(),
    })),
    useFactoryCustomization: vi.fn(async () => ({
      schemaVersion: 1 as const,
      recoveryRequired: false,
      diagnostics: [],
      updatedAt: new Date(0).toISOString(),
    })),
    listPlugins: vi.fn(async () => []),
    setPluginEnabled: vi.fn(async () => []),
    setActiveScene: vi.fn(async () => []),
    deletePlugin: vi.fn(async () => []),
    openPluginAgent: vi.fn(async () => {
      throw new Error("not mocked");
    }),
    promptPluginAgent: vi.fn(async () => {
      throw new Error("not mocked");
    }),
    abortPluginAgent: vi.fn(async () => {
      throw new Error("not mocked");
    }),
    detachPluginAgent: vi.fn(async () => undefined),
    runPluginCompletion: vi.fn(async () => {
      throw new Error("not mocked");
    }),
    cancelPluginCompletion: vi.fn(async () => undefined),
    chooseAttachments: vi.fn(async () => []),
    suggestFiles: vi.fn(async () => []),
    readWorkspaceFile: vi.fn(async () => ""),
    compileInlineWidget: vi.fn(async () => ({
      url: "cake-widget://document/00000000-0000-4000-8000-000000000001",
      token: "00000000-0000-4000-8000-000000000001",
    })),
    repairInlineWidget: vi.fn(async (input) => ({
      source: input.source,
      repairSessionId: "repair-session",
    })),
    loadWindowState: vi.fn(async () => ({
      projectPath: restoredPath,
      recentProjectPaths: restoredPath ? [restoredPath] : [],
      draft: "saved",
      theme: "system" as const,
      workLogViewMode: "auto" as const,
      workLogsExpansion: "collapsed" as const,
      draftsBySession: {},
      pendingProjectSessions: [],
    })),
    saveWindowState: vi.fn(async () => undefined),
    loadApplicationState: vi.fn(async () => ({
      schemaVersion: 1 as const,
      projects: [],
      resolvedSessionIds: [],
      resolvedCakeChatSessionIds: [],
      trustedProjectPaths: [],
    })),
    setUtilityModel: vi.fn(async (model) => ({
      schemaVersion: 1 as const,
      projects: [],
      resolvedSessionIds: [],
      resolvedCakeChatSessionIds: [],
      trustedProjectPaths: [],
      utilityModel: model,
    })),
    setModelPresets: vi.fn(async (modelPresets, defaultModelPresetId) => ({
      schemaVersion: 1 as const,
      projects: [],
      resolvedSessionIds: [],
      resolvedCakeChatSessionIds: [],
      trustedProjectPaths: [],
      modelPresets: [...modelPresets],
      defaultModelPresetId,
    })),
    listSessions: vi.fn(async () => ({ sessions: [], reviewThreads: [] })),
    listCakeChatSessions: vi.fn(async () => []),
    loadCakeChatSession: vi.fn(async () => undefined),
    loadSession: vi.fn(async () => undefined),
    openGlobalChat: vi.fn(async () => undefined),
    promptGlobalChat: vi.fn(async () => undefined),
    abortGlobalChat: vi.fn(async () => undefined),
    compactGlobalChat: vi.fn(async () => undefined),
    setGlobalChatModel: vi.fn(async () => undefined),
    setGlobalChatThinkingLevel: vi.fn(async () => undefined),
    setGlobalChatConfiguration: vi.fn(async () => undefined),
    setGlobalChatFastMode: vi.fn(async () => undefined),
    respondToGlobalChatControl: vi.fn(async () => undefined),
    listReviewThreads: vi.fn(async () => []),
    createReviewThread: vi.fn(async () => {
      throw new Error("not mocked");
    }),
    replyReviewThread: vi.fn(async () => {
      throw new Error("not mocked");
    }),
    resolveReviewThread: vi.fn(async () => {
      throw new Error("not mocked");
    }),
    submitReviewThread: vi.fn(async () => undefined),
    registerProject: vi.fn(async () => ({
      schemaVersion: 1 as const,
      projects: [],
      resolvedSessionIds: [],
      resolvedCakeChatSessionIds: [],
      trustedProjectPaths: [],
    })),
    renameProject: vi.fn(async () => ({
      schemaVersion: 1 as const,
      projects: [],
      resolvedSessionIds: [],
      resolvedCakeChatSessionIds: [],
      trustedProjectPaths: [],
    })),
    removeProject: vi.fn(async () => ({
      schemaVersion: 1 as const,
      projects: [],
      resolvedSessionIds: [],
      resolvedCakeChatSessionIds: [],
      trustedProjectPaths: [],
    })),
    resolveSession: vi.fn(async () => ({
      schemaVersion: 1 as const,
      projects: [],
      resolvedSessionIds: [],
      resolvedCakeChatSessionIds: [],
      trustedProjectPaths: [],
    })),
    resolveSessions: vi.fn(async () => ({
      schemaVersion: 1 as const,
      projects: [],
      resolvedSessionIds: [],
      resolvedCakeChatSessionIds: [],
      trustedProjectPaths: [],
    })),
    resolveCakeChatSession: vi.fn(async () => ({
      schemaVersion: 1 as const,
      projects: [],
      resolvedSessionIds: [],
      resolvedCakeChatSessionIds: [],
      trustedProjectPaths: [],
    })),
    restartPi: vi.fn(async () => undefined),
    inspectWorkspace: vi.fn(async () => undefined),
    respondToWorkspaceTrust: vi.fn(async () => undefined),
    openWorkspace: vi.fn(async () => undefined),
    createWorktree: vi.fn(async () => ({
      projectPath: "/tmp/project",
      worktreePath: "/tmp/.project-worktrees/project-test",
      branch: "agent/project-test",
      baseBranch: "main",
      createdAt: new Date().toISOString(),
    })),
    getWorktreeStatus: vi.fn(async () => undefined),
    landWorktree: vi.fn(async () => ({ outcome: "landed" as const })),
    discardWorktree: vi.fn(async () => undefined),
    forkSessionToWorktree: vi.fn(async () => ({
      sessionId: "forked",
      workspacePath: "/tmp/forked",
    })),
    getEmbeddedEditorState: vi.fn(async () => ({ status: "missing" as const })),
    installEmbeddedEditor: vi.fn(async () => undefined),
    setVscodeServerPath: vi.fn(async () => ({
      schemaVersion: 1 as const,
      projects: [],
      resolvedSessionIds: [],
      resolvedCakeChatSessionIds: [],
      trustedProjectPaths: [],
    })),
    openEmbeddedEditor: vi.fn(async () => undefined),
    updateEmbeddedEditorBounds: vi.fn(async () => undefined),
    revealInEmbeddedEditor: vi.fn(async () => undefined),
    openEmbeddedEditorSourceControl: vi.fn(async () => undefined),
    updateEmbeddedEditorAnnotations: vi.fn(async () => undefined),
    steerSubagent: vi.fn(async () => undefined),
    abortSubagent: vi.fn(async () => undefined),
    submit: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    compactSession: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    setThinkingLevel: vi.fn(async () => undefined),
    setChatConfiguration: vi.fn(async () => undefined),
    setFastMode: vi.fn(async () => undefined),
    setPiSetting: vi.fn(async () => undefined),
    reloadPi: vi.fn(async () => undefined),
    refreshModels: vi.fn(async () => undefined),
    login: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    renameGlobalChat: vi.fn(async () => undefined),
    handoffGlobalChat: vi.fn(async () => undefined),
    renameSession: vi.fn(async () => undefined),
    forkSession: vi.fn(async () => undefined),
    handoffSession: vi.fn(async () => undefined),
    navigateSession: vi.fn(async () => undefined),
    getChangelog: vi.fn(async () => undefined),
    respondToUi: vi.fn(async () => undefined),
    respondToArtifact: vi.fn(async () => undefined),
    exportArtifacts: vi.fn(async () => ""),
    subscribe(next) {
      listener = next;
      return vi.fn();
    },
  };
  return { client, emit: (event: DesktopClientEvent) => listener?.(event) };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function mountTestStore(client: DesktopClient) {
  const root = mountRootStore(client);
  return { root, store: root.projectWorkbenchStore };
}

async function openSnapshot(
  store: ProjectWorkbenchStore,
  desktop: ReturnType<typeof createDesktopClient>,
  nextSnapshot = snapshot,
) {
  await store.chooseProject();
  const inspectId = store.activeOperations.at(-1)!;
  desktop.emit({
    type: "workspace-inspected",
    operationId: inspectId,
    path: nextSnapshot.workspacePath,
    trustRequired: false,
  });
  const openId = store.activeOperations.at(-1)!;
  desktop.emit({ type: "session-snapshot-received", operationId: openId, snapshot: nextSnapshot });
}

describe("ProjectWorkbenchStore", () => {
  it("opens a resolved session from its read-only preview without restoring a Pi runtime", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    root.sessionCatalogStore.replace([
      {
        id: "resolved-session",
        title: "Resolved work",
        created: new Date(0).toISOString(),
        modified: new Date(0).toISOString(),
        messageCount: 1,
        resolved: true,
        workspacePath: "/project",
        workspaceName: "Project",
      },
    ]);
    vi.mocked(desktop.client.loadSession).mockResolvedValue({
      workspacePath: "/project",
      sessionId: "resolved-session",
      sessionFile: "/resolved/resolved-session.jsonl",
      parts: [
        {
          kind: "text",
          id: "message-1",
          role: "user",
          text: "Archived prompt",
          status: "complete",
        },
      ],
    });

    await root.openSession("resolved-session");

    expect(desktop.client.loadSession).toHaveBeenCalledWith("resolved-session");
    expect(desktop.client.inspectWorkspace).not.toHaveBeenCalled();
    expect(desktop.client.openWorkspace).not.toHaveBeenCalled();
    expect(store.activeSession?.sessionId).toBe("resolved-session");
    expect(store.activeSession?.chatStore.parts).toEqual([
      expect.objectContaining({ kind: "text", text: "Archived prompt" }),
    ]);
    expect(root.appShellStore.canGoBack).toBe(false);
    root[Symbol.dispose]();
  });

  it("creates a configured named session and submits its initial prompt", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();

    const sessionId = await store.createSession(
      "/project",
      "Named session",
      "Implement the requested feature",
      {
        provider: "anthropic",
        modelId: "claude-opus-4-6",
        thinkingLevel: "high",
        fastMode: false,
      },
    );

    expect(sessionId).toEqual(expect.any(String));
    expect(desktop.client.submit).toHaveBeenCalledWith({
      operationId: expect.any(String),
      sessionId,
      text: "Implement the requested feature",
      delivery: "prompt",
      attachments: [],
      newSession: {
        path: "/project",
        configuration: {
          provider: "anthropic",
          modelId: "claude-opus-4-6",
          thinkingLevel: "high",
          fastMode: false,
        },
        name: "Named session",
      },
    });
    root[Symbol.dispose]();
  });

  it("creates the Cake Chat session in a newly named worktree", async () => {
    const desktop = createDesktopClient();
    const { root } = mountTestStore(desktop.client);
    await flush();
    root.projectCatalogStore.applyApplicationState({
      schemaVersion: 1,
      projects: [
        {
          path: "/project",
          name: "Project",
          addedAt: "2026-08-01T00:00:00.000Z",
          lastOpenedAt: "2026-08-01T00:00:00.000Z",
        },
      ],
      resolvedSessionIds: [],
      resolvedCakeChatSessionIds: [],
      trustedProjectPaths: ["/project"],
    });
    vi.mocked(desktop.client.createWorktree).mockResolvedValueOnce({
      projectPath: "/project",
      worktreePath: "/project-worktrees/isolated-task",
      branch: "agent/isolated-task",
      baseBranch: "main",
      createdAt: "2026-08-01T00:00:00.000Z",
    });

    await expect(
      root.appControl.invoke({
        name: "sessions.create",
        arguments: {
          workspacePath: "/project",
          name: "Isolated task",
          initialPrompt: "Implement it in isolation",
          worktreeName: "isolated-task",
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      sessionId: expect.any(String),
      workspacePath: "/project-worktrees/isolated-task",
      status: "started",
      managedWorktree: { branch: "agent/isolated-task" },
    });
    expect(desktop.client.createWorktree).toHaveBeenCalledWith({
      operationId: expect.any(String),
      path: "/project",
      baseWorktreePath: undefined,
      worktreeName: "isolated-task",
    });
    expect(desktop.client.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Implement it in isolation",
        newSession: expect.objectContaining({
          path: "/project-worktrees/isolated-task",
          name: "Isolated task",
        }),
      }),
    );
    root[Symbol.dispose]();
  });

  it("dismisses the top secondary surface", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();

    void store.commandPaneStore.open("tree");
    root.dismissTopSecondarySurface();
    expect(store.commandPaneStore.pane).toBeUndefined();

    store.embeddedEditorStore.visible = true;
    root.dismissTopSecondarySurface();
    expect(store.embeddedEditorStore.visible).toBe(false);
    root[Symbol.dispose]();
  });

  it("prompts every fork and lets Escape cancel it", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop);

    store.sessionContinuationStore.forkAt("assistant-entry");

    expect(store.sessionContinuationStore.prompt).toMatchObject({
      destination: "existing",
      resolveParent: false,
      worktreeName: expect.stringMatching(/^new-chat-[a-f0-9]{6}$/),
    });
    expect(desktop.client.getWorktreeStatus).not.toHaveBeenCalled();
    root.dismissTopSecondarySurface();
    expect(store.sessionContinuationStore.prompt).toBeUndefined();
    root[Symbol.dispose]();
  });

  it("forks into a named worktree and optionally resolves the parent", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop);

    store.sessionContinuationStore.forkAt("assistant-entry");
    store.sessionContinuationStore.selectDestination("new-worktree");
    store.sessionContinuationStore.setWorktreeName("focused-fix");
    store.sessionContinuationStore.setResolveParent(true);
    await store.sessionContinuationStore.confirmPrompt();

    expect(desktop.client.forkSessionToWorktree).toHaveBeenCalledWith({
      operationId: expect.any(String),
      sessionId: "session-1",
      entryId: "assistant-entry",
      workspacePath: "/project",
      worktreeName: "focused-fix",
      resolveSource: true,
    });
    root[Symbol.dispose]();
  });

  it("keeps a non-serializable control result scoped to the failed tool", async () => {
    const desktop = createDesktopClient();
    const { root } = mountTestStore(desktop.client);
    await flush();
    vi.spyOn(root.appControl, "invoke").mockResolvedValue({
      ok: true,
      name: "get_app_state",
      state: undefined,
    } as never);
    const controlRequestId = crypto.randomUUID();

    desktop.emit({
      type: "global-chat-control-requested",
      controlRequestId,
      invocation: { name: "get_app_state", arguments: {} },
    });
    await flush();

    expect(desktop.client.respondToGlobalChatControl).toHaveBeenCalledWith(controlRequestId, {
      ok: false,
      name: "get_app_state",
      error: "Cake produced a control result that could not be serialized.",
    });
    expect(root.globalChatStore.error).toBeUndefined();
    expect(root.globalChatStore.activeSession?.error).toBeUndefined();
    root[Symbol.dispose]();
  });

  it("returns hydrated customization state as strict JSON", async () => {
    const desktop = createDesktopClient();
    desktop.client.getCustomizationState = vi.fn(async () => ({
      schemaVersion: 1 as const,
      sourceRevision: "a".repeat(64),
      activeRevision: "b".repeat(64),
      lastKnownGoodRevision: "b".repeat(64),
      rollbackRevision: undefined,
      pendingRevision: undefined,
      failedRevision: undefined,
      recoveryRequired: false,
      diagnostics: [],
      updatedAt: new Date(0).toISOString(),
    }));
    const { root } = mountTestStore(desktop.client);
    await flush();

    const result = await root.appControl.invoke({ name: "get_customization_state", arguments: {} });

    expect(jsonValueSchema.safeParse(result).success).toBe(true);
    root[Symbol.dispose]();
  });

  it("uses one root intent to reveal and activate a session", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop);
    root.showGlobalChat();

    await root.openSession("session-1");

    expect(root.appShellStore.surface).toBe("workbench");
    expect(root.appShellStore.selection).toEqual({
      kind: "project-session",
      workspacePath: "/project",
      sessionId: "session-1",
    });
    expect(store.activeSession?.sessionId).toBe("session-1");
    root[Symbol.dispose]();
  });

  it("gives project-session plugins the selected workspace and opaque references", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop);
    let pluginSession: CakePluginSession | undefined;
    function Probe() {
      pluginSession = usePluginSession();
      return createElement("span", null, pluginSession.workspacePath);
    }

    const markup = renderToStaticMarkup(
      createElement(StoreProvider, { store: root }, createElement(Probe)),
    );

    expect(markup).toContain("/project");
    expect(pluginSession).toMatchObject({
      workspacePath: "/project",
      sessionId: "session-1",
      workspace: { kind: "cake.workspace-ref" },
      ref: { kind: "cake.session-ref" },
    });
    root[Symbol.dispose]();
  });

  it("starts recovery work in a new Cake Chat session", async () => {
    const desktop = createDesktopClient();
    const { root } = mountTestStore(desktop.client);
    await flush();
    vi.mocked(desktop.client.openGlobalChat).mockClear();

    await root.startCakeChat("Repair the current Cake customization.");

    expect(root.appShellStore.surface).toBe("global-chat");
    expect(root.appShellStore.selection).toEqual({
      kind: "cake-chat",
      sessionId: expect.any(String),
    });
    expect(desktop.client.openGlobalChat).not.toHaveBeenCalled();
    expect(desktop.client.promptGlobalChat).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Repair the current Cake customization.",
        newSession: expect.objectContaining({ tools: expect.any(Array) }),
      }),
    );

    const prompt = vi.mocked(desktop.client.promptGlobalChat).mock.calls.at(-1)![0];
    desktop.emit({
      type: "global-chat-snapshot-received",
      operationId: prompt.operationId,
      snapshot: { ...snapshot, workspacePath: "/home/user", sessionId: prompt.sessionId },
    });

    expect(root.appShellStore.selection).toEqual({
      kind: "cake-chat",
      sessionId: prompt.sessionId,
    });
    expect(root.sessionRegistry.findSession(prompt.sessionId)).toBeUndefined();
    root[Symbol.dispose]();
  });

  it("keeps shell selection aligned when an empty pending Cake Chat is resolved", async () => {
    const desktop = createDesktopClient();
    const { root } = mountTestStore(desktop.client);
    await flush();

    await root.startCakeChat();
    const discardedSessionId = root.globalChatStore.sessionId!;
    await root.sidebarStore.setCakeChatSessionResolved(discardedSessionId, true);

    expect(root.globalChatStore.sessionId).not.toBe(discardedSessionId);
    expect(root.appShellStore.selection).toEqual({
      kind: "cake-chat",
      sessionId: root.globalChatStore.sessionId,
    });
    root[Symbol.dispose]();
  });

  it("turns desktop projection exceptions into copyable error details", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();

    desktop.emit({
      type: "session-snapshot-received",
      snapshot: {
        ...snapshot,
        parts: [
          { id: "duplicate", kind: "text", role: "assistant", text: "First", status: "complete" },
          { id: "duplicate", kind: "text", role: "assistant", text: "Second", status: "complete" },
        ],
      },
    });

    expect(store.error).toContain("duplicate ids detected after snapshot was loaded");
    expect(store.errorDetails).toContain("r-state-tree");
    expect(store.errorDetails).toContain("Context:\nDesktop event: session-snapshot-received");
    root[Symbol.dispose]();
  });

  it("inserts files chosen from the attachment browser as visible path mentions", async () => {
    const desktop = createDesktopClient();
    vi.mocked(desktop.client.chooseAttachments).mockResolvedValue([
      { kind: "file", name: "foo", path: "/tmp/foo" },
      { kind: "file", name: "notes.txt", path: "/tmp/my notes.txt" },
      { kind: "image", name: "preview.png", mimeType: "image/png", data: "aW1hZ2U=" },
    ]);
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop);
    store.activeSession!.chatStore.setDraft("Review");

    await root.projectWorkbenchStore.activeSession!.composerStore.addAttachments();

    expect(store.activeSession!.chatStore.draft).toBe('Review @/tmp/foo @"/tmp/my notes.txt"');
    expect(root.projectWorkbenchStore.activeSession!.composerStore.attachments).toEqual([
      { kind: "image", name: "preview.png", mimeType: "image/png", data: "aW1hZ2U=" },
    ]);
    root[Symbol.dispose]();
  });

  it("turns pasted clipboard images into Pi image attachments", async () => {
    class MockFileReader {
      result: string | ArrayBuffer | null = null;
      error: DOMException | null = null;
      onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
      onerror: ((event: ProgressEvent<FileReader>) => void) | null = null;
      readAsDataURL() {
        this.result = "data:image/png;base64,Y2xpcGJvYXJk";
        this.onload?.({} as ProgressEvent<FileReader>);
      }
    }
    vi.stubGlobal("FileReader", MockFileReader);
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop);

    await root.projectWorkbenchStore.activeSession!.composerStore.addPastedImages([
      { name: "", type: "image/png" } as File,
    ]);

    expect(root.projectWorkbenchStore.activeSession!.composerStore.attachments).toEqual([
      { kind: "image", name: "Pasted image 1", mimeType: "image/png", data: "Y2xpcGJvYXJk" },
    ]);
    root[Symbol.dispose]();
    vi.unstubAllGlobals();
  });

  it("offers only authenticated models while retaining all providers in settings", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop, {
      ...snapshot,
      models: [
        {
          provider: "openai",
          providerName: "OpenAI",
          id: "gpt",
          name: "GPT",
          reasoning: true,
          availableThinkingLevels: ["off", "medium"],
          input: ["text"],
          authenticated: true,
          authTypes: ["api_key"],
        },
        {
          provider: "anthropic",
          providerName: "Anthropic",
          id: "claude",
          name: "Claude",
          reasoning: true,
          availableThinkingLevels: ["off", "medium"],
          input: ["text"],
          authenticated: false,
          authTypes: ["api_key", "oauth"],
        },
      ],
    });

    expect(
      root.projectWorkbenchStore.activeSession!.configurationStore.modelsByProvider.map(
        (group) => group.id,
      ),
    ).toEqual(["openai", "anthropic"]);
    expect(
      root.projectWorkbenchStore.activeSession!.configurationStore.connectedModelsByProvider,
    ).toHaveLength(1);
    expect(
      root.projectWorkbenchStore.activeSession!.configurationStore.connectedModelsByProvider[0],
    ).toMatchObject({ id: "openai", models: [expect.objectContaining({ id: "gpt" })] });
    root[Symbol.dispose]();
  });

  it("persists only the utility model explicitly selected by the user", async () => {
    const desktop = createDesktopClient();
    const { root } = mountTestStore(desktop.client);
    await flush();

    expect(root.settingsStore.utilityModel.model).toBeUndefined();
    await root.settingsStore.utilityModel.select("openai/gpt-5-mini");
    expect(desktop.client.setUtilityModel).toHaveBeenLastCalledWith({
      provider: "openai",
      modelId: "gpt-5-mini",
      thinkingLevel: "off",
    });
    expect(root.settingsStore.utilityModel.model).toEqual({
      provider: "openai",
      modelId: "gpt-5-mini",
      thinkingLevel: "off",
    });

    await root.settingsStore.utilityModel.selectThinkingLevel("low");
    expect(desktop.client.setUtilityModel).toHaveBeenLastCalledWith({
      provider: "openai",
      modelId: "gpt-5-mini",
      thinkingLevel: "low",
    });

    await root.settingsStore.utilityModel.clear();
    expect(desktop.client.setUtilityModel).toHaveBeenLastCalledWith(undefined);
    expect(root.settingsStore.utilityModel.model).toBeUndefined();
    root[Symbol.dispose]();
  });

  it("routes Pi-owned settings through the active session", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop);

    await root.settingsStore.providers.setPiSetting({ key: "autoCompact", value: false });
    const operationId = root.settingsStore.providers.activeOperations.at(-1)!;
    expect(store.isBusy).toBe(false);
    expect(desktop.client.setPiSetting).toHaveBeenCalledWith({
      operationId,
      sessionId: "session-1",
      update: { key: "autoCompact", value: false },
    });
    desktop.emit({ type: "operation-completed", operationId });
    expect(root.settingsStore.providers.activeOperations).not.toContain(operationId);

    await root.settingsStore.providers.reloadPi();
    const reloadOperationId = root.settingsStore.providers.activeOperations.at(-1)!;
    expect(desktop.client.reloadPi).toHaveBeenCalledWith({
      operationId: reloadOperationId,
      sessionId: "session-1",
    });
    desktop.emit({ type: "operation-completed", operationId: reloadOperationId });

    expect(root.settingsStore.providers.refreshingModels).toBe(false);
    const refreshPromise = root.settingsStore.providers.refreshModels();
    expect(root.settingsStore.providers.refreshingModels).toBe(true);
    const refreshOperationId = root.settingsStore.providers.activeOperations.at(-1)!;
    expect(desktop.client.refreshModels).toHaveBeenCalledWith({
      operationId: refreshOperationId,
      sessionId: "session-1",
    });
    desktop.emit({ type: "operation-completed", operationId: refreshOperationId });
    await refreshPromise;
    expect(root.settingsStore.providers.refreshingModels).toBe(false);
    root[Symbol.dispose]();
  });

  it("tracks provider disconnects and exposes failures for a retry", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop);

    await root.settingsStore.providers.logout("openai-codex");
    const operationId = root.settingsStore.providers.activeOperations.at(-1)!;
    expect(root.settingsStore.providers.providerOperation("openai-codex")).toBe("logout");
    expect(desktop.client.logout).toHaveBeenCalledWith(
      expect.objectContaining({ operationId, provider: "openai-codex" }),
    );

    desktop.emit({
      type: "operation-failed",
      operationId,
      message: "Credential store delete failed",
    });
    expect(root.settingsStore.providers.providerOperation("openai-codex")).toBeUndefined();
    expect(root.settingsStore.error).toBe("Credential store delete failed");

    await root.settingsStore.providers.logout("openai-codex");
    expect(desktop.client.logout).toHaveBeenCalledTimes(2);
    root[Symbol.dispose]();
  });

  it("hydrates before persistence and reopens the persisted project", async () => {
    const desktop = createDesktopClient("/project");
    const { root, store } = mountTestStore(desktop.client);
    await flush();

    expect(root.windowPersistence.hydrated).toBe(true);
    expect(store.activeSession).toBeUndefined();
    expect(desktop.client.inspectWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/project" }),
    );
    expect(desktop.client.saveWindowState).not.toHaveBeenCalled();
    const inspectId = store.activeOperations.at(-1)!;
    desktop.emit({
      type: "workspace-inspected",
      operationId: inspectId,
      path: "/project",
      trustRequired: false,
    });
    const openId = store.activeOperations.at(-1)!;
    desktop.emit({ type: "session-snapshot-received", operationId: openId, snapshot });
    expect(store.activeSession!.chatStore.draft).toBe("saved");
    root[Symbol.dispose]();
  });

  it("restores Cake Chat as the active conversation after a window reload", async () => {
    const desktop = createDesktopClient();
    desktop.client.loadWindowState = vi.fn(async () => ({
      projectPath: "/project",
      selectedSessionId: "session-1",
      activeConversation: { kind: "cake-chat" as const, sessionId: "cake-chat-1" },
      recentProjectPaths: ["/project"],
      draft: "",
      theme: "system" as const,
      workLogViewMode: "auto" as const,
      workLogsExpansion: "collapsed" as const,
      draftsBySession: {},
      pendingProjectSessions: [],
    }));
    desktop.client.listSessions = vi.fn(async () => ({
      sessions: [
        {
          id: "session-1",
          title: "Project work",
          created: new Date(0).toISOString(),
          modified: new Date(0).toISOString(),
          messageCount: 1,
          resolved: false,
          workspacePath: "/project",
          workspaceName: "Project",
        },
      ],
      reviewThreads: [],
    }));
    const { root } = mountTestStore(desktop.client);
    await flush();

    expect(root.appShellStore.selection).toEqual({ kind: "cake-chat", sessionId: "cake-chat-1" });
    expect(desktop.client.openGlobalChat).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "cake-chat-1" }),
    );
    expect(desktop.client.inspectWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/project" }),
    );
    root[Symbol.dispose]();
  });

  it("restores a selected pending session without opening a Pi runtime", async () => {
    const desktop = createDesktopClient();
    desktop.client.loadWindowState = vi.fn(async () => ({
      projectPath: "/project",
      selectedSessionId: "unpersisted-session",
      recentProjectPaths: ["/project"],
      draft: "",
      theme: "system" as const,
      workLogViewMode: "auto" as const,
      workLogsExpansion: "collapsed" as const,
      draftsBySession: { "unpersisted-session": "" },
      pendingProjectSessions: [
        {
          sessionId: "unpersisted-session",
          workspacePath: "/project",
          draft: "restored temporary draft",
        },
      ],
    }));
    const { root, store } = mountTestStore(desktop.client);
    await flush();

    expect(desktop.client.inspectWorkspace).not.toHaveBeenCalled();
    expect(desktop.client.openWorkspace).not.toHaveBeenCalled();
    expect(store.activeSession?.workspacePath).toBe("/project");
    expect(store.activeSession?.chatStore.draft).toBe("restored temporary draft");
    expect(store.sessionRegistry.isTemporarySession(store.activeSession!.sessionId)).toBe(true);
    root[Symbol.dispose]();
  });

  it("gates project resources on trust and applies the authoritative snapshot", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await store.chooseProject();
    const inspectId = store.activeOperations[0]!;
    desktop.emit({
      type: "workspace-inspected",
      operationId: inspectId,
      path: "/project",
      trustRequired: true,
    });

    expect(store.pendingTrustPath).toBe("/project");
    await store.resolveProjectTrust(true);
    expect(desktop.client.respondToWorkspaceTrust).toHaveBeenCalledWith({
      operationId: inspectId,
      path: "/project",
      approved: true,
    });
    expect(desktop.client.openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/project" }),
    );
    const openId = store.activeOperations[0]!;
    desktop.emit({ type: "session-snapshot-received", operationId: openId, snapshot });

    expect(store.session?.sessionFile).toBe("/sessions/one.jsonl");
    const openCalls = vi.mocked(desktop.client.openWorkspace).mock.calls.length;
    await store.startNewSession();
    expect(store.pendingTrustPath).toBeUndefined();
    expect(desktop.client.openWorkspace).toHaveBeenCalledTimes(openCalls);
    expect(store.sessionRegistry.isTemporarySession(store.activeSession!.sessionId)).toBe(true);
    root[Symbol.dispose]();
  });

  it("applies the default model preset when creating a conversation", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop);
    const preset = {
      id: "00000000-0000-4000-8000-000000000001",
      name: "Deep review",
      provider: "openai",
      modelId: "gpt-5.6",
      thinkingLevel: "high" as const,
      fastMode: true,
    };
    root.settingsStore.applyApplicationState({
      schemaVersion: 1,
      projects: [],
      resolvedSessionIds: [],
      resolvedCakeChatSessionIds: [],
      trustedProjectPaths: [],
      modelPresets: [preset],
      defaultModelPresetId: preset.id,
    });

    await store.startNewSession();
    store.activeSession!.chatStore.setDraft("Start with this preset");
    await store.activeSession!.composerStore.submit();

    expect(desktop.client.submit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        newSession: {
          path: "/project",
          configuration: {
            provider: preset.provider,
            modelId: preset.modelId,
            thinkingLevel: preset.thinkingLevel,
            fastMode: true,
          },
        },
      }),
    );
    root[Symbol.dispose]();
  });

  it("keeps workspace slash commands available in a deferred new session", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    const skillCommand: SessionSnapshot["commands"][number] = {
      name: "skill:fixture",
      description: "Fixture skill",
      source: "skill",
      sourceInfo: {
        path: "/project/.agents/skills/fixture/SKILL.md",
        source: "project",
        scope: "project",
        origin: "top-level",
      },
    };
    await openSnapshot(store, desktop, { ...snapshot, commands: [skillCommand] });

    await store.startNewSession();

    expect(store.activeSession?.chatStore.commands).toEqual([skillCommand]);
    root[Symbol.dispose]();
  });

  it("keeps model changes for an unsent chat local until the first prompt", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop);

    await store.startNewSession();
    const session = store.activeSession!;
    const configuration = session.configurationStore;
    expect(configuration.deferred).toBe(true);

    const override = {
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      thinkingLevel: "high" as const,
      fastMode: false,
    };
    await configuration.selectPreset({
      id: "00000000-0000-4000-8000-000000000002",
      name: "Opus review",
      ...override,
    });

    // A deferred chat has no runtime, so no runtime command may be sent.
    expect(desktop.client.setModel).not.toHaveBeenCalled();
    expect(desktop.client.setChatConfiguration).not.toHaveBeenCalled();

    // The picker lists the session-less agent-directory catalog.
    configuration.ensureCatalog();
    await flush();
    expect(desktop.client.listModels).toHaveBeenCalled();
    expect(configuration.modelsByProvider).toEqual([
      {
        id: "fixture-provider",
        name: "Fixture provider",
        models: [expect.objectContaining({ id: "fixture-model" })],
      },
    ]);
    expect(store.newSessionRequest(session.sessionId)).toEqual({
      path: "/project",
      configuration: override,
    });

    session.chatStore.setDraft("Hello there");
    await session.composerStore.submit();
    expect(desktop.client.submit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        newSession: { path: "/project", configuration: override },
      }),
    );

    // The first snapshot promotes the chat to a runtime-backed session and
    // drops the pending override.
    desktop.emit({
      type: "session-snapshot-received",
      operationId: store.activeOperations.at(-1)!,
      snapshot: { ...snapshot, sessionId: session.sessionId },
    });
    await flush();
    expect(store.sessionRegistry.isTemporarySession(session.sessionId)).toBe(false);
    expect(store.sessionRegistry.pendingConfiguration(session.sessionId)).toBeUndefined();

    root[Symbol.dispose]();
  });

  it("creates the selected worktree on first send and starts the session inside it", async () => {
    const desktop = createDesktopClient();
    vi.mocked(desktop.client.createWorktree).mockResolvedValueOnce({
      projectPath: "/project",
      worktreePath: "/project-worktree",
      branch: "agent/project-worktree",
      baseBranch: "main",
      baseCommit: "base",
      createdAt: new Date(0).toISOString(),
    });
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop);
    await store.startNewSession();
    const session = store.activeSession!;
    store.worktreeCreationStore.select(session.sessionId, { kind: "new" });
    session.chatStore.setDraft("Build this in isolation");

    await session.chatStore.submit();

    expect(desktop.client.createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/project", baseWorktreePath: undefined }),
    );
    expect(session.workspacePath).toBe("/project-worktree");
    expect(desktop.client.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Build this in isolation",
        newSession: expect.objectContaining({ path: "/project-worktree" }),
      }),
    );
    root[Symbol.dispose]();
  });

  it("creates a new session directly in an inactive project", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop);

    await store.startNewSession("/other");
    const inspectId = store.activeOperations.at(-1)!;
    expect(desktop.client.inspectWorkspace).toHaveBeenLastCalledWith({
      operationId: inspectId,
      path: "/other",
    });

    desktop.emit({
      type: "workspace-inspected",
      operationId: inspectId,
      path: "/other",
      trustRequired: false,
    });
    expect(store.activeSession?.workspacePath).toBe("/other");
    expect(store.sessionRegistry.isTemporarySession(store.activeSession!.sessionId)).toBe(true);
    root[Symbol.dispose]();
  });

  it("registers a blocking artifact request without an active operation or session selection", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop);
    const request = {
      protocol: "cake.request/v1" as const,
      id: "form",
      title: "Answer",
      responseSchema: {
        type: "object" as const,
        properties: { answer: { type: "string" as const } },
      },
      view: {
        type: "form" as const,
        fields: [{ id: "answer", label: "Answer", type: "text" as const }],
      },
      fallback: { markdown: "Answer" },
    };
    const record = {
      artifact: {
        protocol: "cake.artifact/v1" as const,
        id: request.id,
        sessionId: "session-1",
        revision: 1,
        kind: "request" as const,
        payload: { request },
        fallback: request.fallback,
        interaction: { mode: "request" as const, responseSchema: request.responseSchema },
      },
      workspacePath: "/project",
      digest: "a".repeat(64),
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    // No coordinator operation is started and the event arrives while the
    // session is already selected: either way the request must register so the
    // form stays answerable even after the user switches sessions mid-block.
    desktop.emit({
      type: "artifact-requested",
      operationId: crypto.randomUUID(),
      artifactRequestId: crypto.randomUUID(),
      record,
    });
    expect(
      root.projectWorkbenchStore.activeSession!.artifactInteractionStore.request,
    ).toBeDefined();
    await root.projectWorkbenchStore.activeSession!.artifactInteractionStore.respond({
      answer: "yes",
    });
    expect(desktop.client.respondToArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ value: { answer: "yes" }, cancelled: false }),
    );
    root[Symbol.dispose]();
  });

  it("keeps a pending artifact request alive when the user changes sessions", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop);
    const operationId = root.sessionOperationCoordinator.start();
    const request = {
      protocol: "cake.request/v1" as const,
      id: "form",
      title: "Answer",
      responseSchema: {
        type: "object" as const,
        properties: { answer: { type: "string" as const } },
      },
      view: {
        type: "form" as const,
        fields: [{ id: "answer", label: "Answer", type: "text" as const }],
      },
      fallback: { markdown: "Answer" },
    };
    const record = {
      artifact: {
        protocol: "cake.artifact/v1" as const,
        id: request.id,
        sessionId: "session-1",
        revision: 1,
        kind: "request" as const,
        payload: { request },
        fallback: request.fallback,
        interaction: { mode: "request" as const, responseSchema: request.responseSchema },
      },
      workspacePath: "/project",
      digest: "a".repeat(64),
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    desktop.emit({
      type: "artifact-requested",
      operationId,
      artifactRequestId: crypto.randomUUID(),
      record,
    });
    const requestingSession = root.projectWorkbenchStore.activeSession!;
    expect(requestingSession.artifactInteractionStore.request).toBeDefined();
    await store.startNewSession();
    expect(desktop.client.respondToArtifact).not.toHaveBeenCalled();
    expect(requestingSession.artifactInteractionStore.request).toBeDefined();
    root[Symbol.dispose]();
  });

  it("keeps a blocking request open until its response passes validation", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop);
    const operationId = root.sessionOperationCoordinator.start();
    const request = {
      protocol: "cake.request/v1" as const,
      id: "validated",
      title: "Answer",
      responseSchema: {
        type: "object" as const,
        properties: { answer: { type: "string" as const, minLength: 1 } },
      },
      view: {
        type: "form" as const,
        fields: [{ id: "answer", label: "Answer", type: "text" as const }],
      },
      fallback: { markdown: "Answer" },
    };
    const record = {
      artifact: {
        protocol: "cake.artifact/v1" as const,
        id: request.id,
        sessionId: "session-1",
        revision: 1,
        kind: "request" as const,
        payload: { request },
        fallback: request.fallback,
        interaction: { mode: "request" as const, responseSchema: request.responseSchema },
      },
      workspacePath: "/project",
      digest: "a".repeat(64),
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    desktop.emit({
      type: "artifact-requested",
      operationId,
      artifactRequestId: crypto.randomUUID(),
      record,
    });

    await root.projectWorkbenchStore.activeSession!.artifactInteractionStore.respond({
      answer: 42,
    });
    expect(desktop.client.respondToArtifact).not.toHaveBeenCalled();
    expect(
      root.projectWorkbenchStore.activeSession!.artifactInteractionStore.request,
    ).toBeDefined();

    await root.projectWorkbenchStore.activeSession!.artifactInteractionStore.respond({
      answer: "yes",
    });
    expect(desktop.client.respondToArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ value: { answer: "yes" }, cancelled: false }),
    );
    expect(
      root.projectWorkbenchStore.activeSession!.artifactInteractionStore.request,
    ).toBeUndefined();
    root[Symbol.dispose]();
  });

  it("routes transcript deltas and correlated UI responses", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop);
    desktop.emit({
      type: "part-updated",
      sessionId: "stale",
      part: { id: "stale", kind: "text", role: "assistant", text: "ignored", status: "complete" },
    });
    desktop.emit({
      type: "part-updated",
      sessionId: "session-1",
      part: { id: "live", kind: "text", role: "assistant", text: "hello", status: "streaming" },
    });
    const operationId = root.sessionOperationCoordinator.start();
    const uiRequestId = crypto.randomUUID();
    desktop.emit({
      type: "ui-requested",
      operationId,
      uiRequestId,
      kind: "confirm",
      title: "Continue?",
      message: "Confirm",
    });
    const focusRevision =
      root.projectWorkbenchStore.activeSession!.composerStore.focusRequestRevision;
    await root.extensionUiStore.respond("true");

    expect(
      root.projectWorkbenchStore.activeSession!.composerStore.parts.map((part) => part.id),
    ).toEqual(["live"]);
    expect(desktop.client.respondToUi).toHaveBeenCalledWith({
      operationId,
      sessionId: "session-1",
      uiRequestId,
      value: "true",
      cancelled: false,
    });
    expect(root.projectWorkbenchStore.activeSession!.composerStore.focusRequestRevision).toBe(
      focusRevision + 1,
    );
    root[Symbol.dispose]();
  });

  it("coalesces streamed transcript updates to one update per part per frame", async () => {
    const desktop = createDesktopClient();
    let flushFrame: FrameRequestCallback | undefined;
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      flushFrame = callback;
      return 1;
    });
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const { root, store } = mountTestStore(desktop.client);
    try {
      await flush();
      await openSnapshot(store, desktop);
      for (let index = 0; index < 60; index += 1) {
        desktop.emit({
          type: "part-updated",
          sessionId: "session-1",
          part: {
            id: "live",
            kind: "text",
            role: "assistant",
            text: `token-${index}`,
            status: "streaming",
          },
        });
      }

      expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
      expect(root.sessionRegistry.findModel("session-1")?.uiParts).toEqual([]);
      flushFrame?.(0);
      expect(root.sessionRegistry.findModel("session-1")?.uiParts).toEqual([
        expect.objectContaining({ id: "live", text: "token-59" }),
      ]);
    } finally {
      root[Symbol.dispose]();
      vi.unstubAllGlobals();
    }
  });

  it("opens workspace changes in VS Code Source Control", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop);
    store.commandPaneStore.toggle("tree");

    await store.openWorkspaceChanges();

    expect(store.embeddedEditorStore.visible).toBe(true);
    expect(store.commandPaneStore.pane).toBeUndefined();
    expect(desktop.client.openEmbeddedEditor).toHaveBeenCalledWith("/project");
    expect(desktop.client.openEmbeddedEditorSourceControl).toHaveBeenCalledWith("/project");
    root[Symbol.dispose]();
  });

  it("opens embedded VS Code directly from the project workbench", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop);
    store.commandPaneStore.toggle("tree");

    await store.openIde();

    expect(store.embeddedEditorStore.visible).toBe(true);
    expect(store.commandPaneStore.pane).toBeUndefined();
    expect(desktop.client.openEmbeddedEditor).toHaveBeenCalledWith("/project");
    root[Symbol.dispose]();
  });

  it("opens embedded VS Code before a brand-new chat has been persisted by Pi", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop);
    await store.startNewSession();
    expect(store.activeSessionExists).toBe(false);
    vi.mocked(desktop.client.openEmbeddedEditor).mockClear();

    await store.openIde();

    expect(store.embeddedEditorStore.visible).toBe(true);
    expect(desktop.client.openEmbeddedEditor).toHaveBeenCalledWith("/project");
    root[Symbol.dispose]();
  });

  it("toggles only the chat sidebar from the VS Code title-bar control", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop);
    await store.openIde();

    desktop.emit({ type: "embedded-editor-toggle-chat", workspacePath: "/project" });
    await flush();
    expect(store.embeddedEditorStore.visible).toBe(true);
    expect(store.embeddedEditorStore.chatSidebarVisible).toBe(false);

    desktop.emit({ type: "embedded-editor-toggle-chat", workspacePath: "/project" });
    await flush();
    expect(store.embeddedEditorStore.visible).toBe(true);
    expect(store.embeddedEditorStore.chatSidebarVisible).toBe(true);

    desktop.emit({ type: "embedded-editor-toggle-chat", workspacePath: "/other" });
    await flush();
    expect(store.embeddedEditorStore.chatSidebarVisible).toBe(true);
    root[Symbol.dispose]();
  });

  it("returns to Agent mode from VS Code even when the chat sidebar is hidden", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop);
    await store.openIde();
    store.embeddedEditorStore.toggleChatSidebar();

    desktop.emit({ type: "embedded-editor-back-to-agent", workspacePath: "/project" });
    await flush();

    expect(store.embeddedEditorStore.visible).toBe(false);
    expect(store.embeddedEditorStore.chatSidebarVisible).toBe(true);
    root[Symbol.dispose]();
  });

  it("keeps the active VS Code file and selection as visible project-chat context", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop);
    desktop.emit({ type: "pi-state-changed", state: "ready" });
    await store.embeddedEditorStore.show();

    desktop.emit({
      type: "embedded-editor-selection",
      workspacePath: "/project",
      path: "src/main.ts",
      startLine: 10,
      endLine: 10,
    });
    await flush();

    const context = expect.objectContaining({
      kind: "source",
      location: {
        path: "src/main.ts",
        range: { start: { line: 10 }, end: { line: 10 } },
      },
    });
    expect(store.activeSession!.composerStore.visibleAttachments).toEqual([context]);
    store.activeSession!.chatStore.setDraft("What do I have selected?");
    await store.activeSession!.composerStore.submit();
    expect(desktop.client.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "What do I have selected?",
        attachments: [context],
      }),
    );

    desktop.emit({ type: "embedded-editor-selection-cleared", workspacePath: "/project" });
    await flush();
    expect(store.embeddedEditorStore.activeContextAttachment).toBeUndefined();
    expect(store.activeSession!.composerStore.visibleAttachments).toEqual([]);

    store.dismissSecondarySurfaces();
    desktop.emit({
      type: "embedded-editor-selection",
      workspacePath: "/project",
      path: "src/late.ts",
      startLine: 20,
      endLine: 20,
    });
    await flush();
    expect(store.embeddedEditorStore.visible).toBe(false);
    expect(store.activeSession!.composerStore.visibleAttachments).toEqual([]);
    root[Symbol.dispose]();
  });

  it("projects active-session review annotations and opens their authoritative drawer chat", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop);
    const now = new Date(0).toISOString();
    desktop.emit({
      type: "review-thread-updated",
      thread: {
        id: "thread-a",
        workspacePath: "/project",
        sessionId: "session-1",
        anchor: {
          path: "src/main.ts",
          view: "file",
          start: { diffLine: 4, newLine: 5, column: 2 },
          end: { diffLine: 5, newLine: 6, column: 8 },
          selectedText: "calculate()",
          contextBefore: "",
          contextAfter: "",
          diff: "",
        },
        parts: [
          {
            id: "question",
            kind: "text",
            role: "user",
            text: "Why calculate here?",
            status: "complete",
          },
          {
            id: "answer",
            kind: "text",
            role: "assistant",
            text: "It prepares the result.",
            status: "complete",
          },
        ],
        status: "open",
        createdAt: now,
        updatedAt: now,
      },
    });
    await store.embeddedEditorStore.show();

    expect(desktop.client.updateEmbeddedEditorAnnotations).toHaveBeenCalledWith("/project", {
      sessionId: "session-1",
      annotations: [
        {
          id: "thread-a",
          location: {
            path: "src/main.ts",
            range: {
              start: { line: 4, column: 2 },
              end: { line: 5, column: 8 },
            },
          },
          status: "answered",
          replyCount: 1,
          preview: "Why calculate here?",
        },
      ],
    });

    store.embeddedEditorStore.toggleChatSidebar();
    desktop.emit({
      type: "embedded-editor-annotation-opened",
      workspacePath: "/project",
      sessionId: "session-1",
      threadId: "thread-a",
    });
    await flush();

    expect(root.reviewsStore.activeThreadId).toBe("thread-a");
    expect(store.embeddedEditorStore.chatSidebarVisible).toBe(true);

    root.sessionRegistry.prepareNewSession("/project", "session-2");
    store.applySessionSnapshot({ ...snapshot, sessionId: "session-2" }, "session-1");
    await vi.waitFor(() =>
      expect(desktop.client.updateEmbeddedEditorAnnotations).toHaveBeenLastCalledWith("/project", {
        sessionId: "session-2",
        annotations: [],
      }),
    );
    store.embeddedEditorStore.toggleChatSidebar();
    desktop.emit({
      type: "embedded-editor-annotation-opened",
      workspacePath: "/project",
      sessionId: "session-1",
      threadId: "thread-a",
    });
    await flush();
    expect(store.embeddedEditorStore.chatSidebarVisible).toBe(false);
    root[Symbol.dispose]();
  });

  it("projects extension UI only for the active session and clears it on replacement", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop, {
      ...snapshot,
      extensionUi: { title: "Initial", statuses: [{ key: "one", text: "ready" }] },
    });
    desktop.emit({
      type: "extension-ui-received",
      sessionId: "stale",
      event: { kind: "editor-text", text: "stale", mode: "replace" },
    });
    desktop.emit({
      type: "extension-ui-received",
      sessionId: "session-1",
      event: { kind: "notify", id: "notice-1", message: "Hello", tone: "info" },
    });

    expect(store.activeSession!.chatStore.draft).not.toBe("stale");
    expect(root.extensionUiStore.title).toBe("Initial");
    expect(root.extensionUiStore.notifications).toHaveLength(1);

    await store.startNewSession();
    expect(root.extensionUiStore.title).toBeUndefined();
    expect(root.extensionUiStore.notifications).toEqual([]);
    root[Symbol.dispose]();
  });

  it("preserves the draft when an empty Pi runtime reopens with a replacement session id", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop);
    store.activeSession!.chatStore.setDraft("keep this draft");
    desktop.emit({ type: "pi-state-changed", state: "stopped", workspacePath: "/project" });
    desktop.emit({ type: "pi-state-changed", state: "ready", workspacePath: "/project" });
    const inspectId = store.activeOperations.at(-1)!;
    desktop.emit({
      type: "workspace-inspected",
      operationId: inspectId,
      path: "/project",
      trustRequired: false,
    });
    const openId = store.activeOperations.at(-1)!;
    desktop.emit({
      type: "session-snapshot-received",
      operationId: openId,
      snapshot: { ...snapshot, sessionId: "replacement" },
    });
    expect(store.activeSession!.chatStore.draft).toBe("keep this draft");
    root[Symbol.dispose]();
  });

  it("queues prompts locally during a run and steers queued chips on request", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    desktop.emit({ type: "pi-state-changed", state: "ready" });
    await openSnapshot(store, desktop, { ...snapshot, streaming: true });

    store.activeSession!.chatStore.setDraft("Do this next");
    await root.projectWorkbenchStore.activeSession!.composerStore.submit();
    expect(desktop.client.submit).not.toHaveBeenCalled();
    expect(root.projectWorkbenchStore.activeSession!.composerStore.parts).toEqual([]);
    expect(root.projectWorkbenchStore.activeSession!.composerStore.pendingUserMessages).toEqual([]);
    expect(
      root.projectWorkbenchStore.activeSession!.chatStore.queuedPrompts.map((entry) => entry.text),
    ).toEqual(["Do this next"]);

    // Steering a queued chip delivers it immediately as a steer.
    root.projectWorkbenchStore.activeSession!.chatStore.steerQueuedPrompt(
      root.projectWorkbenchStore.activeSession!.chatStore.queuedPrompts[0]!.id,
    );
    await flush();
    expect(desktop.client.submit).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Do this next", delivery: "steer" }),
    );
    expect(root.projectWorkbenchStore.activeSession!.chatStore.queuedPrompts).toEqual([]);
    expect(root.projectWorkbenchStore.activeSession!.composerStore.parts).toEqual([
      expect.objectContaining({ text: "Do this next", deliveryState: "steering" }),
    ]);

    desktop.emit({
      type: "part-updated",
      sessionId: "session-1",
      part: {
        id: "steer-canonical",
        kind: "text",
        role: "user",
        text: "Do this next",
        status: "complete",
      },
    });
    expect(
      root.projectWorkbenchStore.activeSession!.composerStore.parts.map((part) => part.id),
    ).toEqual(["steer-canonical"]);
    root[Symbol.dispose]();
  });

  it("starts code chats immediately without coupling them to the parent composer", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    desktop.emit({ type: "pi-state-changed", state: "ready" });
    await openSnapshot(store, desktop);
    const now = new Date(0).toISOString();
    vi.mocked(desktop.client.createReviewThread).mockResolvedValue({
      id: "review-1",
      workspacePath: "/project",
      sessionId: "session-1",
      status: "open",
      createdAt: now,
      updatedAt: now,
      anchor: {
        path: "src/app.ts",
        view: "file",
        start: { diffLine: 1, newLine: 2 },
        end: { diffLine: 1, newLine: 2 },
        selectedText: "value",
        contextBefore: "",
        contextAfter: "",
        diff: "+value",
      },
      parts: [
        {
          id: "comment-1",
          kind: "text",
          role: "user",
          text: "Why this value?",
          status: "complete",
          deliveryState: "sending",
        },
      ],
    });

    const anchor = {
      path: "src/app.ts",
      view: "file" as const,
      start: { diffLine: 1, newLine: 2 },
      end: { diffLine: 1, newLine: 2 },
      selectedText: "value",
      contextBefore: "",
      contextAfter: "",
      diff: "+value",
    };
    root.reviewsStore.prepareDraft(anchor);
    expect(root.reviewsStore.draftChatStore.parts).toEqual([
      expect.objectContaining({ role: "user", text: "value" }),
    ]);
    await root.reviewsStore.draftChatStore.submit("Why this value?");

    expect(desktop.client.submitReviewThread).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        threadId: "review-1",
        thinkingLevel: "off",
      }),
    );
    expect(desktop.client.submit).not.toHaveBeenCalled();
    expect(store.activeSession!.chatStore.draft).toBe("saved");
    expect(root.reviewsStore.draftAnchor).toBeUndefined();

    const firstOperationId = vi.mocked(desktop.client.submitReviewThread).mock.calls[0]![0]
      .operationId;
    desktop.emit({ type: "operation-completed", operationId: firstOperationId });
    desktop.emit({
      type: "review-thread-updated",
      thread: {
        id: "review-1",
        workspacePath: "/project",
        sessionId: "session-1",
        status: "open",
        createdAt: now,
        updatedAt: now,
        anchor: {
          path: "src/app.ts",
          view: "file",
          start: { diffLine: 1, newLine: 2 },
          end: { diffLine: 1, newLine: 2 },
          selectedText: "value",
          contextBefore: "",
          contextAfter: "",
          diff: "+value",
        },
        parts: [
          {
            id: "comment-1",
            kind: "text",
            role: "user",
            text: "Why this value?",
            status: "complete",
            deliveryState: undefined,
          },
          {
            id: "answer-1",
            kind: "text",
            role: "assistant",
            text: "It carries the state.",
            status: "complete",
          },
        ],
      },
    });
    vi.mocked(desktop.client.replyReviewThread).mockResolvedValue({
      id: "review-1",
      workspacePath: "/project",
      sessionId: "session-1",
      status: "open",
      createdAt: now,
      updatedAt: now,
      anchor: {
        path: "src/app.ts",
        view: "file",
        start: { diffLine: 1, newLine: 2 },
        end: { diffLine: 1, newLine: 2 },
        selectedText: "value",
        contextBefore: "",
        contextAfter: "",
        diff: "+value",
      },
      parts: [
        {
          id: "comment-1",
          kind: "text",
          role: "user",
          text: "Why this value?",
          status: "complete",
        },
        {
          id: "answer-1",
          kind: "text",
          role: "assistant",
          text: "It carries the state.",
          status: "complete",
        },
        {
          id: "comment-2",
          kind: "text",
          role: "user",
          text: "What reads it?",
          status: "complete",
          deliveryState: "sending",
        },
      ],
    });

    const codeChat = root.reviewsStore.chatStore("review-1")!;
    expect(Object.keys(root.reviewsStore.submissionsByOperation)).toHaveLength(0);
    expect(codeChat.canSubmitDraft("What reads it?")).toBe(true);
    await codeChat.submit("What reads it?");

    expect(desktop.client.replyReviewThread).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "review-1", body: "What reads it?" }),
    );
    expect(desktop.client.submitReviewThread).toHaveBeenCalledTimes(2);
    expect(desktop.client.submitReviewThread).toHaveBeenLastCalledWith(
      expect.objectContaining({ threadId: "review-1" }),
    );
    root[Symbol.dispose]();
  });

  it("shows a submitted user message immediately and reconciles it with Pi's canonical part", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    desktop.emit({ type: "pi-state-changed", state: "ready" });
    await openSnapshot(store, desktop);

    store.activeSession!.chatStore.setDraft("Show this now");
    const submission = root.projectWorkbenchStore.activeSession!.composerStore.submit();

    expect(root.projectWorkbenchStore.activeSession!.composerStore.parts).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^optimistic-user-/),
        role: "user",
        text: "Show this now",
      }),
    ]);
    await submission;

    desktop.emit({
      type: "part-updated",
      sessionId: "session-1",
      part: {
        id: "user-canonical",
        kind: "text",
        role: "user",
        text: "Show this now",
        status: "complete",
      },
    });

    expect(root.projectWorkbenchStore.activeSession!.composerStore.parts).toEqual([
      {
        id: "user-canonical",
        kind: "text",
        role: "user",
        text: "Show this now",
        status: "complete",
      },
    ]);
    expect(
      root.projectWorkbenchStore.activeSession!.composerStore.pendingUserMessages,
    ).toHaveLength(0);
    root[Symbol.dispose]();
  });

  it("submits an image without text and keeps it visible while Pi persists it", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    desktop.emit({ type: "pi-state-changed", state: "ready" });
    await openSnapshot(store, desktop);
    store.activeSession!.chatStore.setDraft("");
    root.projectWorkbenchStore.activeSession!.composerStore.attachments.push({
      kind: "image",
      name: "clipboard.png",
      mimeType: "image/png",
      data: "aW1hZ2U=",
    });

    await root.projectWorkbenchStore.activeSession!.composerStore.submit();

    expect(desktop.client.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "",
        attachments: [
          { kind: "image", name: "clipboard.png", mimeType: "image/png", data: "aW1hZ2U=" },
        ],
      }),
    );
    expect(root.projectWorkbenchStore.activeSession!.composerStore.parts).toEqual([
      expect.objectContaining({ kind: "attachment", name: "clipboard.png", data: "aW1hZ2U=" }),
    ]);

    desktop.emit({
      type: "part-updated",
      sessionId: "session-1",
      part: {
        id: "user-image",
        kind: "attachment",
        name: "Image 1",
        mediaType: "image/png",
        attachmentKind: "image",
        data: "aW1hZ2U=",
      },
    });
    expect(root.projectWorkbenchStore.activeSession!.composerStore.parts).toEqual([
      {
        id: "user-image",
        kind: "attachment",
        name: "Image 1",
        mediaType: "image/png",
        attachmentKind: "image",
        data: "aW1hZ2U=",
      },
    ]);
    expect(
      root.projectWorkbenchStore.activeSession!.composerStore.pendingUserMessages,
    ).toHaveLength(0);
    root[Symbol.dispose]();
  });

  it("keeps streamed reasoning below an optimistic user message", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    desktop.emit({ type: "pi-state-changed", state: "ready" });
    await openSnapshot(store, desktop);

    store.activeSession!.chatStore.setDraft("Think about this");
    await root.projectWorkbenchStore.activeSession!.composerStore.submit();
    desktop.emit({
      type: "part-updated",
      sessionId: "session-1",
      part: { id: "reasoning-1", kind: "reasoning", text: "Working it out", status: "streaming" },
    });

    expect(
      root.projectWorkbenchStore.activeSession!.composerStore.parts.map((part) => part.id),
    ).toEqual([expect.stringMatching(/^optimistic-user-/), "reasoning-1"]);
    root[Symbol.dispose]();
  });

  it("does not restore a submitted draft when a session snapshot arrives", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    desktop.emit({ type: "pi-state-changed", state: "ready" });
    await openSnapshot(store, desktop);

    store.activeSession!.chatStore.setDraft("Already sent");
    await root.projectWorkbenchStore.activeSession!.composerStore.submit();
    desktop.emit({
      type: "session-snapshot-received",
      snapshot: { ...snapshot, streaming: false },
    });

    expect(store.activeSession!.chatStore.draft).toBe("");
    expect(store.sessionRegistry.findSession("session-1")!.chatStore.draft).toBe("");
    root[Symbol.dispose]();
  });

  it("shows a temporary empty chat immediately without opening a Pi session", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    const oldSnapshot: SessionSnapshot = {
      ...snapshot,
      parts: [{ id: "old-tool", kind: "tool", name: "old", input: "", state: "success" }],
    };
    await openSnapshot(store, desktop, oldSnapshot);
    expect(root.projectWorkbenchStore.activeSession!.composerStore.parts).toHaveLength(1);

    const openCalls = vi.mocked(desktop.client.openWorkspace).mock.calls.length;
    await store.startNewSession();
    const requestedSessionId = store.activeSession!.sessionId;
    expect(desktop.client.openWorkspace).toHaveBeenCalledTimes(openCalls);
    expect(store.sessionRegistry.isTemporarySession(requestedSessionId)).toBe(true);
    expect(store.session?.sessionId).toBe(requestedSessionId);
    expect(root.projectWorkbenchStore.activeSession!.composerStore.parts).toEqual([]);

    desktop.emit({ type: "session-snapshot-received", snapshot: oldSnapshot });
    desktop.emit({
      type: "session-snapshot-received",
      operationId: crypto.randomUUID(),
      snapshot: oldSnapshot,
    });
    expect(root.projectWorkbenchStore.activeSession!.composerStore.parts).toEqual([]);

    store.activeSession!.chatStore.setDraft("Create it now");
    await store.activeSession!.composerStore.submit();
    expect(desktop.client.submit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionId: requestedSessionId,
        newSession: { path: "/project", configuration: undefined },
      }),
    );

    const newSnapshot = {
      ...snapshot,
      sessionId: requestedSessionId,
      sessionFile: "/sessions/two.jsonl",
      parts: [
        {
          id: "first-user-message",
          kind: "text" as const,
          role: "user" as const,
          text: "Create it now",
          status: "complete" as const,
        },
      ],
    };
    desktop.emit({ type: "session-snapshot-received", snapshot: newSnapshot });
    expect(store.sessionRegistry.isTemporarySession(requestedSessionId)).toBe(false);
    expect(store.session?.sessionId).toBe(requestedSessionId);
    expect(
      root.projectWorkbenchStore.activeSession!.composerStore.parts.map((part) => part.id),
    ).toEqual(["first-user-message"]);
    root[Symbol.dispose]();
  });

  it("keeps the current session visible while a partial target hydrates", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    const oldSnapshot: SessionSnapshot = {
      ...snapshot,
      parts: [
        { id: "old-message", kind: "text", role: "assistant", text: "Old", status: "complete" },
      ],
    };
    await openSnapshot(store, desktop, oldSnapshot);
    root.sessionCatalogStore.replace([
      {
        id: "session-2",
        title: "Session two",
        created: new Date(0).toISOString(),
        modified: new Date(0).toISOString(),
        messageCount: 1,
        resolved: false,
        workspacePath: "/project",
        workspaceName: "Project",
      },
    ]);
    root.sessionRegistry.ensure("session-2");

    await root.openSession("session-2");

    expect(store.session?.sessionId).toBe("session-1");
    expect(store.activeSession?.composerStore.parts.map((part) => part.id)).toEqual([
      "old-message",
    ]);

    const openId = store.activeOperations.at(-1)!;
    desktop.emit({
      type: "session-snapshot-received",
      operationId: openId,
      snapshot: {
        ...snapshot,
        sessionId: "session-2",
        sessionFile: "/sessions/two.jsonl",
        parts: [
          {
            id: "new-message",
            kind: "text",
            role: "assistant",
            text: "New",
            status: "complete",
          },
        ],
      },
    });

    expect(store.session?.sessionId).toBe("session-2");
    expect(store.activeSession?.composerStore.parts.map((part) => part.id)).toEqual([
      "new-message",
    ]);
    root[Symbol.dispose]();
  });

  it("allows another new session as soon as the first prompt is accepted", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop);

    await store.startNewSession();
    const startedSessionId = store.activeSession!.sessionId;
    store.activeSession!.chatStore.setDraft("Hello");
    await store.activeSession!.composerStore.submit();

    expect(store.sessionRegistry.isTemporarySession(startedSessionId)).toBe(false);

    const pendingSnapshot = {
      ...snapshot,
      sessionId: startedSessionId,
      sessionFile: "/sessions/started.jsonl",
      sessionListed: false,
      sessions: [
        {
          id: startedSessionId,
          title: "New chat",
          created: new Date(0).toISOString(),
          modified: new Date(0).toISOString(),
          messageCount: 1,
          resolved: false,
        },
      ],
    };
    desktop.emit({ type: "session-snapshot-received", snapshot: pendingSnapshot });
    expect(root.sessionCatalogStore.find(startedSessionId)).toBeDefined();
    expect(store.sessionRegistry.retainedNewSessionIds("/project")).toContain(startedSessionId);

    await store.startNewSession();

    expect(store.activeSession?.sessionId).not.toBe(startedSessionId);
    expect(store.sessionRegistry.isTemporarySession(store.activeSession!.sessionId)).toBe(true);
    expect(root.sessionCatalogStore.find(startedSessionId)).toBeDefined();
    root[Symbol.dispose]();
  });

  it("keeps multiple pending sessions in one workspace", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop);

    await store.startNewSession("/project");
    const firstSessionId = store.activeSession!.sessionId;
    store.activeSession!.chatStore.setDraft("first draft");

    await store.startNewSession("/project");
    const secondSessionId = store.activeSession!.sessionId;
    store.activeSession!.chatStore.setDraft("second draft");

    expect(secondSessionId).not.toBe(firstSessionId);
    expect(root.sessionCatalogStore.find(firstSessionId)?.title).toBe("New chat");
    expect(root.sessionCatalogStore.find(secondSessionId)?.title).toBe("New chat");

    await store.openSession(firstSessionId);
    expect(store.activeSession?.sessionId).toBe(firstSessionId);
    expect(store.activeSession?.chatStore.draft).toBe("first draft");
    expect(desktop.client.openWorkspace).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(
      vi.mocked(desktop.client.saveWindowState).mock.calls.at(-1)?.[0].pendingProjectSessions,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: firstSessionId, draft: "first draft" }),
        expect.objectContaining({ sessionId: secondSessionId, draft: "second draft" }),
      ]),
    );

    await expect(
      store.createSession("/project", "Started immediately", "Investigate this"),
    ).resolves.toEqual(expect.any(String));
    root[Symbol.dispose]();
  });

  it("keeps drafts per session across projects", async () => {
    const desktop = createDesktopClient();
    const applicationState = {
      schemaVersion: 1 as const,
      resolvedSessionIds: ["session-2"],
      resolvedCakeChatSessionIds: [],
      trustedProjectPaths: [],
      projects: [
        {
          path: "/project",
          name: "Project",
          addedAt: new Date(0).toISOString(),
          lastOpenedAt: new Date(0).toISOString(),
        },
        {
          path: "/other",
          name: "Other",
          addedAt: new Date(0).toISOString(),
          lastOpenedAt: new Date(0).toISOString(),
        },
      ],
    };
    desktop.client.loadApplicationState = vi.fn(async () => applicationState);
    desktop.client.listSessions = vi.fn(async () => ({
      sessions: [
        {
          id: "session-3",
          title: "Alpha elsewhere",
          created: new Date(0).toISOString(),
          modified: new Date(0).toISOString(),
          messageCount: 3,
          resolved: false,
          workspacePath: "/other",
          workspaceName: "Other",
        },
      ],
      reviewThreads: [],
    }));
    desktop.client.registerProject = vi.fn(async () => applicationState);
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    const sessions = [
      {
        id: "session-1",
        title: "Alpha task",
        created: new Date(0).toISOString(),
        modified: new Date(0).toISOString(),
        messageCount: 1,
        resolved: false,
      },
      {
        id: "session-2",
        title: "Beta task",
        created: new Date(0).toISOString(),
        modified: new Date(0).toISOString(),
        messageCount: 2,
        resolved: false,
      },
    ];
    await openSnapshot(store, desktop, { ...snapshot, sessions });
    const firstSession = store.activeSession;
    store.activeSession!.chatStore.setDraft("alpha draft");
    vi.mocked(desktop.client.loadSession).mockResolvedValue({
      workspacePath: "/project",
      sessionId: "session-2",
      sessionFile: "/resolved/session-2.jsonl",
      parts: [],
    });
    await store.openSession("session-2");
    const openId = store.activeOperations.at(-1)!;
    desktop.emit({
      type: "session-snapshot-received",
      operationId: openId,
      snapshot: { ...snapshot, sessionId: "session-2", sessions },
    });
    const secondSession = store.activeSession;
    store.activeSession!.chatStore.setDraft("beta draft");
    expect(secondSession).not.toBe(firstSession);
    expect(secondSession!.composerStore).not.toBe(firstSession!.composerStore);
    expect(secondSession!.configurationStore).not.toBe(firstSession!.configurationStore);
    expect(store.sessionRegistry.findSession("session-1")).toBe(firstSession);
    expect(store.sessionRegistry.findSession("session-1")!.chatStore.draft).toBe("alpha draft");
    expect(root.sidebarStore.projectSessions(store.projectPath!).map((item) => item.id)).toEqual([
      "session-1",
    ]);
    expect(
      root.sidebarStore.projectSessions(store.projectPath!, true).map((item) => item.id),
    ).toEqual(["session-2"]);
    await store.openSession("session-1");
    expect(store.session?.sessionId).toBe("session-1");
    expect(store.activeSession!.chatStore.draft).toBe("alpha draft");
    await store.openSession("session-3");
    expect(desktop.client.inspectWorkspace).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: "/other" }),
    );
    root[Symbol.dispose]();
  });

  it("keeps project order stable when selecting a project", async () => {
    const desktop = createDesktopClient();
    const projects = ["/first", "/second", "/third"].map((path) => ({
      path,
      name: path.slice(1),
      addedAt: new Date(0).toISOString(),
      lastOpenedAt: new Date(0).toISOString(),
    }));
    const applicationState = {
      schemaVersion: 1 as const,
      projects,
      resolvedSessionIds: [],
      resolvedCakeChatSessionIds: [],
      trustedProjectPaths: [],
    };
    desktop.client.loadApplicationState = vi.fn(async () => applicationState);
    desktop.client.loadWindowState = vi.fn(async () => ({
      projectPath: "/first",
      recentProjectPaths: projects.map((project) => project.path),
      draft: "",
      theme: "system" as const,
      workLogViewMode: "auto" as const,
      workLogsExpansion: "collapsed" as const,
      draftsBySession: {},
      pendingProjectSessions: [],
    }));
    desktop.client.registerProject = vi.fn(async () => applicationState);
    const { root, store } = mountTestStore(desktop.client);
    await flush();

    await store.switchProject("/third");
    const inspectId = store.activeOperations.at(-1)!;
    desktop.emit({
      type: "workspace-inspected",
      operationId: inspectId,
      path: "/third",
      trustRequired: false,
    });
    const openId = store.activeOperations.at(-1)!;
    desktop.emit({
      type: "session-snapshot-received",
      operationId: openId,
      snapshot: {
        ...snapshot,
        workspacePath: "/third",
        sessionId: "session-3",
        sessionFile: "/sessions/three.jsonl",
      },
    });
    await flush();

    expect(store.projectPath).toBe("/third");
    expect(root.projectCatalogStore.recentProjectPaths).toEqual(["/first", "/second", "/third"]);
    root[Symbol.dispose]();
  });

  it("keeps inactive session models live and switches back before Pi responds", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop, {
      ...snapshot,
      parts: [{ id: "one", kind: "text", role: "assistant", text: "One", status: "complete" }],
    });
    root.sessionCatalogStore.replace([
      {
        id: "session-2",
        title: "Session two",
        created: new Date(0).toISOString(),
        modified: new Date(0).toISOString(),
        messageCount: 0,
        resolved: false,
        workspacePath: "/project",
        workspaceName: "Project",
      },
    ]);

    await store.openSession("session-2");
    const secondOpenId = store.activeOperations.at(-1)!;
    desktop.emit({
      type: "session-snapshot-received",
      operationId: secondOpenId,
      snapshot: {
        ...snapshot,
        sessionId: "session-2",
        sessionFile: "/sessions/two.jsonl",
        parts: [{ id: "two", kind: "text", role: "assistant", text: "Two", status: "complete" }],
      },
    });
    desktop.emit({
      type: "part-updated",
      sessionId: "session-1",
      part: {
        id: "late-one",
        kind: "text",
        role: "assistant",
        text: "Still live",
        status: "complete",
      },
    });

    await store.openSession("session-1");

    expect(store.session?.sessionId).toBe("session-1");
    expect(
      root.projectWorkbenchStore.activeSession!.composerStore.parts.map((part) => part.id),
    ).toEqual(["one", "late-one"]);
    expect(desktop.client.inspectWorkspace).toHaveBeenCalledTimes(1);
    expect(desktop.client.openWorkspace).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: "session-1" }),
    );
    root[Symbol.dispose]();
  });

  it("tracks running sessions and marks background completions unread until opened", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop);
    root.sessionCatalogStore.replace([
      {
        id: "session-2",
        title: "Session two",
        created: new Date(0).toISOString(),
        modified: new Date(0).toISOString(),
        messageCount: 0,
        resolved: false,
        workspacePath: "/project",
        workspaceName: "Project",
      },
    ]);

    await store.openSession("session-2");
    const secondOpenId = store.activeOperations.at(-1)!;
    desktop.emit({
      type: "session-snapshot-received",
      operationId: secondOpenId,
      snapshot: { ...snapshot, sessionId: "session-2", sessionFile: "/sessions/two.jsonl" },
    });

    desktop.emit({ type: "streaming-changed", sessionId: "session-1", streaming: true });
    expect(root.sidebarStore.sessionActivity("session-1")).toBe("running");

    desktop.emit({ type: "streaming-changed", sessionId: "session-1", streaming: false });
    expect(root.sidebarStore.sessionActivity("session-1")).toBe("unread");

    await store.openSession("session-1");
    expect(root.sidebarStore.sessionActivity("session-1")).toBeUndefined();
    root[Symbol.dispose]();
  });

  it("keeps an idle session stoppable while its subagent runs in the background", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop, { ...snapshot, streaming: false });

    desktop.emit({
      type: "background-work-changed",
      sessionId: snapshot.sessionId,
      active: true,
    });
    expect(store.activeSession!.chatStore.loading).toBe(false);
    expect(store.activeSession!.chatStore.canStop).toBe(true);

    desktop.emit({
      type: "background-work-changed",
      sessionId: snapshot.sessionId,
      active: false,
    });
    expect(store.activeSession!.chatStore.canStop).toBe(false);
    root[Symbol.dispose]();
  });

  it("shows a fast persisted preview while an uncached Pi runtime activates", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    desktop.emit({ type: "pi-state-changed", state: "ready" });
    await openSnapshot(store, desktop);
    root.sessionCatalogStore.replace([
      {
        id: "session-2",
        title: "Session two",
        created: new Date(0).toISOString(),
        modified: new Date(0).toISOString(),
        messageCount: 0,
        resolved: false,
        workspacePath: "/project",
        workspaceName: "Project",
      },
    ]);
    desktop.client.loadSession = vi.fn(
      async () =>
        ({
          workspacePath: "/project",
          sessionId: "session-2",
          sessionFile: "/sessions/two.jsonl",
          parts: [
            {
              id: "preview",
              kind: "text",
              role: "assistant",
              text: "From disk",
              status: "complete",
            },
          ],
        }) satisfies SessionPreview,
    );

    await store.openSession("session-2");
    await flush();

    expect(store.session?.sessionId).toBe("session-2");
    expect(
      root.projectWorkbenchStore.activeSession!.composerStore.parts.map((part) => part.id),
    ).toEqual(["preview"]);
    store.activeSession!.chatStore.setDraft("not ready yet");
    expect(store.activeSession!.canSubmit).toBe(false);

    const openId = store.activeOperations.at(-1)!;
    desktop.emit({
      type: "session-snapshot-received",
      operationId: openId,
      snapshot: {
        ...snapshot,
        sessionId: "session-2",
        sessionFile: "/sessions/two.jsonl",
        parts: [
          {
            id: "authoritative",
            kind: "text",
            role: "assistant",
            text: "Ready",
            status: "complete",
          },
        ],
      },
    });
    expect(
      root.projectWorkbenchStore.activeSession!.composerStore.parts.map((part) => part.id),
    ).toEqual(["authoritative"]);
    expect(store.activeSession!.canSubmit).toBe(true);
    root[Symbol.dispose]();
  });

  it("reveals project sessions in batches without selecting the project", async () => {
    const desktop = createDesktopClient();
    desktop.client.listSessions = vi.fn(async () => ({
      sessions: Array.from({ length: 12 }, (_, index) => ({
        id: `other-${index}`,
        title: `Other task ${index}`,
        created: new Date(0).toISOString(),
        modified: new Date(index).toISOString(),
        messageCount: index,
        resolved: false,
        workspacePath: "/other",
        workspaceName: "Other",
      })),
      reviewThreads: [],
    }));
    const { root, store } = mountTestStore(desktop.client);
    await flush();

    expect(store.projectPath).toBeUndefined();
    expect(root.sidebarStore.projectSessions("/other")).toHaveLength(12);
    expect(
      root.sidebarStore
        .projectSessions("/other")
        .slice(0, root.sidebarStore.sessionLimit("/other")),
    ).toHaveLength(10);
    root.sidebarStore.showMoreSessions("/other");
    expect(
      root.sidebarStore
        .projectSessions("/other")
        .slice(0, root.sidebarStore.sessionLimit("/other")),
    ).toHaveLength(12);
    expect(store.projectPath).toBeUndefined();
    root[Symbol.dispose]();
  });

  it("renames the session targeted from the sidebar", async () => {
    const desktop = createDesktopClient();
    desktop.client.listSessions = vi.fn(async () => ({
      sessions: [
        {
          id: "session-2",
          title: "Old title",
          created: new Date(0).toISOString(),
          modified: new Date(0).toISOString(),
          messageCount: 1,
          resolved: false,
          workspacePath: "/other",
          workspaceName: "Other",
        },
      ],
      reviewThreads: [],
    }));
    const { root, store } = mountTestStore(desktop.client);
    await flush();

    await store.sessionManagementStore.renameSession("session-2", " New title ");

    expect(desktop.client.renameSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-2", name: "New title" }),
    );
    expect(root.sidebarStore.projectSessions("/other")[0]?.title).toBe("New title");
    root[Symbol.dispose]();
  });

  it("uses one session catalog for the sidebar and header and rolls back runtime failures", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop, {
      ...snapshot,
      sessions: [
        {
          id: "session-1",
          title: "Session",
          created: new Date(0).toISOString(),
          modified: new Date(0).toISOString(),
          messageCount: 0,
          resolved: false,
        },
      ],
    });

    await store.sessionManagementStore.renameSession("session-1", "Renamed everywhere");
    const operationId = store.activeOperations.at(-1)!;
    expect(root.sidebarStore.projectSessions("/project")[0]?.title).toBe("Renamed everywhere");
    expect(store.sessionTitle).toBe("Renamed everywhere");

    desktop.emit({ type: "operation-failed", operationId, message: "Rename rejected" });
    expect(root.sidebarStore.projectSessions("/project")[0]?.title).toBe("Session");
    expect(store.sessionTitle).toBe("Session");
    root[Symbol.dispose]();
  });

  it("opens Cake panes locally and forwards Pi resource commands", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    desktop.emit({ type: "pi-state-changed", state: "ready" });
    await openSnapshot(store, desktop, {
      ...snapshot,
      tree: [{ id: "entry-1", type: "message", preview: "Hello", active: true }],
    });
    store.activeSession!.chatStore.setDraft("/tree");
    await root.projectWorkbenchStore.activeSession!.composerStore.submit();

    expect(store.commandPaneStore.pane).toBe("tree");
    expect(desktop.client.submit).not.toHaveBeenCalled();

    store.commandPaneStore.close();
    store.activeSession!.chatStore.setDraft("/changelog");
    await root.projectWorkbenchStore.activeSession!.composerStore.submit();

    expect(store.commandPaneStore.pane).toBe("changelog");
    expect(desktop.client.getChangelog).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1" }),
    );
    expect(desktop.client.submit).not.toHaveBeenCalled();
    const changelogId = store.activeOperations.at(-1)!;
    desktop.emit({
      type: "changelog-received",
      operationId: changelogId,
      workspacePath: "/project",
      sessionId: "session-1",
      markdown: "# Changelog\n\n## 0.84.0",
    });
    expect(store.commandPaneStore.changelogMarkdown).toContain("0.84.0");

    store.commandPaneStore.close();
    store.activeSession!.chatStore.setDraft("/skill:review");
    await root.projectWorkbenchStore.activeSession!.composerStore.submit();

    expect(desktop.client.submit).toHaveBeenCalledWith(
      expect.objectContaining({ text: "/skill:review", delivery: "prompt" }),
    );
    expect(store.commandPaneStore.pane).toBeUndefined();
    expect(store.activeSession!.chatStore.draft).toBe("");
    root[Symbol.dispose]();
  });

  it("releases changelog loading state when the correlated operation fails", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop, snapshot);

    const loading = store.commandPaneStore.open("changelog");
    const operationId = store.activeOperations.at(-1)!;
    expect(store.commandPaneStore.changelogLoading).toBe(true);

    desktop.emit({ type: "operation-failed", operationId, message: "Changelog failed" });
    await loading;

    expect(store.commandPaneStore.changelogLoading).toBe(false);
    expect(store.error).toBe("Changelog failed");
    await store.commandPaneStore.refreshChangelog();
    expect(desktop.client.getChangelog).toHaveBeenCalledTimes(2);
    root[Symbol.dispose]();
  });

  it("restores a selected user message into the composer when navigating the tree", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop, {
      ...snapshot,
      tree: [
        {
          id: "user-entry",
          type: "message",
          messageRole: "user",
          editorText: "Original user message\nwith formatting",
          preview: "Original user message with formatting",
          active: true,
        },
      ],
    });

    await store.commandPaneStore.navigateTo("user-entry");

    expect(desktop.client.navigateSession).toHaveBeenCalledWith(
      expect.objectContaining({ entryId: "user-entry" }),
    );
    expect(store.activeSession!.chatStore.draft).toBe("Original user message\nwith formatting");
    expect(store.commandPaneStore.pane).toBeUndefined();
    root[Symbol.dispose]();
  });

  it("compiles inline widgets and validates a repair before replacing the rendered source", async () => {
    const desktop = createDesktopClient();
    desktop.client.repairInlineWidget = vi.fn(async () => ({
      source: "<strong>Repaired</strong>",
      repairSessionId: "repair-session",
    }));
    const { root } = mountTestStore(desktop.client);
    const widgets = root.inlineWidgetStore;

    widgets.prepare("widget-1", "html", "<strong>Broken</strong>");
    await flush();
    widgets.reportRuntimeError("widget-1", "ReferenceError: missing is not defined");
    await widgets.repair({ id: "widget-1", sessionId: "session-1", context: "Show the result" });

    expect(desktop.client.repairInlineWidget).toHaveBeenCalledWith(
      expect.objectContaining({
        language: "html",
        source: "<strong>Broken</strong>",
        diagnostic: "ReferenceError: missing is not defined",
      }),
    );
    expect(desktop.client.compileInlineWidget).toHaveBeenLastCalledWith(
      "html",
      "<strong>Repaired</strong>",
      "display",
    );
    expect(widgets.state("widget-1")).toMatchObject({
      status: "ready",
      source: "<strong>Repaired</strong>",
      repairSessionId: "repair-session",
    });
    root[Symbol.dispose]();
  });
});
