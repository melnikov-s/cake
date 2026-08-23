import { describe, expect, it, vi } from "vitest";
import { StoreProvider } from "r-state-tree/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { jsonValueSchema } from "../../../../src/ipc/json-contract";
import type {
  ChangedFile,
  SessionPreview,
  SessionSnapshot,
} from "../../../../src/ipc/session-contract";
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
    listWorkspaceFiles: vi.fn(async () => []),
    readWorkspaceFile: vi.fn(async () => ""),
    openFileInEditor: vi.fn(async () => undefined),
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
      newSessionDraftsByProject: {},
    })),
    saveWindowState: vi.fn(async () => undefined),
    loadApplicationState: vi.fn(async () => ({
      schemaVersion: 1 as const,
      projects: [],
      resolvedSessionIds: [],
      resolvedCakeChatSessionIds: [],
      trustedProjectPaths: [],
    })),
    setEditorCommand: vi.fn(async () => ({
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
    forkWorktreeSession: vi.fn(async () => ({ sessionId: "forked", workspacePath: "/tmp/forked" })),
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
    renameSession: vi.fn(async () => undefined),
    forkSession: vi.fn(async () => undefined),
    navigateSession: vi.fn(async () => undefined),
    inspectChanges: vi.fn(async () => undefined),
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
  changes: ChangedFile[] = [],
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
  const changesRequest = vi.mocked(desktop.client.inspectChanges).mock.calls.at(-1)?.[0];
  if (changesRequest)
    desktop.emit({
      type: "changes-received",
      ...changesRequest,
      workspacePath: nextSnapshot.workspacePath,
      files: changes,
    });
}

describe("ProjectWorkbenchStore", () => {
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

  it("gives project-session plugins the selected workspace and native Changes intent", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop);
    vi.mocked(desktop.client.inspectChanges).mockClear();
    let pluginSession: CakePluginSession | undefined;
    function Probe() {
      pluginSession = usePluginSession();
      return createElement("span", null, pluginSession.workspacePath);
    }

    const markup = renderToStaticMarkup(
      createElement(StoreProvider, { store: root }, createElement(Probe)),
    );

    expect(markup).toContain("/project");
    expect(pluginSession).toMatchObject({ workspacePath: "/project", sessionId: "session-1" });
    await pluginSession!.openChanges();
    expect(desktop.client.inspectChanges).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1" }),
    );
    root.showGlobalChat();
    await expect(pluginSession!.openChanges()).rejects.toThrow("no longer selected");
    root[Symbol.dispose]();
  });

  it("starts recovery work in a new Cake Chat session", async () => {
    const desktop = createDesktopClient();
    const { root } = mountTestStore(desktop.client);
    await flush();
    vi.mocked(desktop.client.openGlobalChat).mockClear();

    await root.startCakeChat("Repair the current Cake customization.");

    expect(root.appShellStore.surface).toBe("global-chat");
    expect(root.appShellStore.selection).toEqual({ kind: "cake-chat", sessionId: undefined });
    expect(desktop.client.openGlobalChat).toHaveBeenCalledWith(
      expect.objectContaining({ newSession: true }),
    );
    expect(desktop.client.openGlobalChat).toHaveBeenCalledWith(
      expect.objectContaining({ initialPrompt: "Repair the current Cake customization." }),
    );

    const operationId = vi.mocked(desktop.client.openGlobalChat).mock.calls.at(-1)![0].operationId;
    desktop.emit({
      type: "global-chat-snapshot-received",
      operationId,
      snapshot: { ...snapshot, workspacePath: "/home/user", sessionId: "cake-chat-1" },
    });

    expect(root.appShellStore.selection).toEqual({ kind: "cake-chat", sessionId: "cake-chat-1" });
    expect(root.sessionRegistry.findSession("cake-chat-1")).toBeUndefined();
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
      newSessionDraftsByProject: {},
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

  it("replaces a selected empty session that Pi never persisted", async () => {
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
      newSessionDraftsByProject: { "/project": "restored temporary draft" },
    }));
    const { root, store } = mountTestStore(desktop.client);
    await flush();

    const inspectOperationId = store.activeOperations.at(-1)!;
    desktop.emit({
      type: "workspace-inspected",
      operationId: inspectOperationId,
      path: "/project",
      trustRequired: false,
    });

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
        required: ["answer"],
        properties: { answer: { type: "string" as const } },
      },
      view: {
        type: "form" as const,
        fields: [{ id: "answer", label: "Answer", type: "text" as const, required: true }],
        submitLabel: "Send",
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

  it("cancels a pending artifact request before replacing the active session", async () => {
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
        required: ["answer"],
        properties: { answer: { type: "string" as const } },
      },
      view: {
        type: "form" as const,
        fields: [{ id: "answer", label: "Answer", type: "text" as const, required: true }],
        submitLabel: "Send",
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
    expect(
      root.projectWorkbenchStore.activeSession!.artifactInteractionStore.request,
    ).toBeDefined();
    await store.startNewSession();
    expect(desktop.client.respondToArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ operationId, cancelled: true }),
    );
    expect(
      root.projectWorkbenchStore.activeSession!.artifactInteractionStore.request,
    ).toBeUndefined();
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
        required: ["answer"],
        properties: { answer: { type: "string" as const, minLength: 1 } },
      },
      view: {
        type: "form" as const,
        fields: [{ id: "answer", label: "Answer", type: "text" as const }],
        submitLabel: "Send",
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

    await root.projectWorkbenchStore.activeSession!.artifactInteractionStore.respond({});
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

  it("uses the Git workspace snapshot instead of accumulating edit tool patches", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop, snapshot, [
      { path: "src/one.ts", status: "modified", additions: 1, deletions: 1, diff: "-old\n+new" },
    ]);

    desktop.emit({
      type: "part-updated",
      sessionId: "session-1",
      part: {
        id: "tool-edit-2",
        kind: "tool",
        name: "edit",
        input: "",
        filePath: "src/two.ts",
        diff: "+2 added",
        state: "success",
      },
    });

    expect(store.changesStore.changes).toEqual([
      expect.objectContaining({ path: "src/one.ts", additions: 1, deletions: 1 }),
    ]);
    root[Symbol.dispose]();
  });

  it("keeps the Changes surface closed when its startup refresh completes", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop, snapshot, [
      { path: "src/one.ts", status: "modified", additions: 1, deletions: 0, diff: "+new" },
    ]);

    expect(store.changesStore.changes).toHaveLength(1);
    expect(store.changesStore.path).toBeUndefined();
    root[Symbol.dispose]();
  });

  it("resolves a review anchored to the old side of a Git rename", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop, snapshot, [
      {
        path: "docs/plan.md",
        previousPath: "PLAN.md",
        status: "renamed",
        additions: 0,
        deletions: 0,
        diff: "similarity index 100%",
      },
    ]);

    await store.changesStore.open("PLAN.md");
    expect(store.changesStore.selected).toMatchObject({
      path: "docs/plan.md",
      previousPath: "PLAN.md",
    });
    expect(store.commandPaneStore.pane).toBeUndefined();
    store.changesStore.close();
    expect(store.changesStore.path).toBeUndefined();
    root[Symbol.dispose]();
  });

  it("opens the fullscreen change explorer and refreshes Git workspace changes", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop, snapshot, [
      { path: "PLAN.md", status: "modified", additions: 1, deletions: 0, diff: "+plan" },
    ]);
    vi.mocked(desktop.client.inspectChanges).mockClear();

    await store.openSessionChanges();
    expect(store.changesStore.path).toBe("PLAN.md");
    expect(desktop.client.inspectChanges).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1" }),
    );

    store.changesStore.close();
    expect(store.changesStore.path).toBeUndefined();
    root[Symbol.dispose]();
  });

  it("loads the full project tree for the workspace browser and keeps selection window-local", async () => {
    const desktop = createDesktopClient();
    vi.mocked(desktop.client.listWorkspaceFiles).mockResolvedValue([
      "PLAN.md",
      "src/app.ts",
      "src/main.ts",
    ]);
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop);

    await store.openWorkspaceBrowser();

    expect(desktop.client.listWorkspaceFiles).toHaveBeenCalledWith("/project");
    expect(store.browseStore.files).toEqual(["PLAN.md", "src/app.ts", "src/main.ts"]);
    expect(store.browseStore.path).toBeNull();
    store.browseStore.select("src/main.ts");
    expect(store.browseStore.path).toBe("src/main.ts");
    store.browseStore.close();
    expect(store.browseStore.path).toBeUndefined();
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
        view: "diff",
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
      view: "diff" as const,
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
          view: "diff",
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
        view: "diff",
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

  it("keeps a new session pending until Pi lists it, not merely until it has parts", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop);

    await store.startNewSession();
    const pendingSessionId = store.activeSession!.sessionId;
    store.activeSession!.chatStore.setDraft("Hello");
    await store.activeSession!.composerStore.submit();
    const pendingSnapshot = {
      ...snapshot,
      sessionId: pendingSessionId,
      sessionFile: "",
      sessionListed: false,
      sessions: [
        {
          id: pendingSessionId,
          title: "New chat",
          created: new Date(0).toISOString(),
          modified: new Date(0).toISOString(),
          messageCount: 0,
          resolved: false,
        },
      ],
    };
    desktop.emit({ type: "session-snapshot-received", snapshot: pendingSnapshot });
    desktop.emit({
      type: "session-snapshot-received",
      snapshot: {
        ...pendingSnapshot,
        parts: [
          {
            id: "user-1",
            kind: "text",
            role: "user",
            text: "Hello",
            status: "complete",
          },
        ],
      },
    });

    expect(store.sessionRegistry.pendingNewSessionId("/project")).toBe(pendingSessionId);
    expect(root.sessionCatalogStore.find(pendingSessionId)).toBeDefined();

    desktop.emit({
      type: "session-snapshot-received",
      snapshot: { ...pendingSnapshot, sessionListed: true },
    });
    expect(store.sessionRegistry.pendingNewSessionId("/project")).toBeUndefined();
    root[Symbol.dispose]();
  });

  it("restores the pending new-session draft for each project", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop);

    await store.startNewSession("/project");
    const projectTemporarySessionId = store.activeSession!.sessionId;
    store.activeSession!.chatStore.setDraft("draft for project");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(
      vi.mocked(desktop.client.saveWindowState).mock.calls.at(-1)?.[0].newSessionDraftsByProject,
    ).toEqual({ "/project": "draft for project" });

    await store.startNewSession("/other");
    const inspectId = store.activeOperations.at(-1)!;
    desktop.emit({
      type: "workspace-inspected",
      operationId: inspectId,
      path: "/other",
      trustRequired: false,
    });
    store.activeSession!.chatStore.setDraft("draft for other");

    await store.startNewSession("/project");

    expect(store.activeSession?.sessionId).toBe(projectTemporarySessionId);
    expect(store.activeSession?.chatStore.draft).toBe("draft for project");
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
      newSessionDraftsByProject: {},
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
