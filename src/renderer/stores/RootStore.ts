import { Store, child, createStore, mount } from "r-state-tree";
import { jsonValueSchema } from "../../ipc/json-contract";
import type { DesktopClient, DesktopClientEvent } from "../desktop-client";
import { SessionRegistryStore } from "./SessionRegistryStore";
import { ProjectWorkbenchStore } from "./ProjectWorkbenchStore";
import { SidebarStore } from "./SidebarStore";
import { ReviewsStore } from "./ReviewsStore";
import { SettingsStore } from "./SettingsStore";
import { ExtensionUiStore } from "./ExtensionUiStore";
import { AppControlBridge } from "../app-control-bridge";
import { GlobalChatStore } from "./GlobalChatStore";
import { AppShellStore } from "./AppShellStore";
import { CustomizationStore } from "./CustomizationStore";
import { PluginCommandStore } from "./PluginCommandStore";
import { InlineWidgetStore } from "./InlineWidgetStore";
import { SessionCatalogStore } from "./SessionCatalogStore";
import { SessionOperationCoordinator } from "./SessionOperationCoordinator";
import { AppControlOperationStore } from "./AppControlOperationStore";
import { ProjectCatalogStore } from "./ProjectCatalogStore";
import { WindowPersistenceCoordinator } from "./WindowPersistenceCoordinator";

export class RootStore extends Store<{ client: DesktopClient }> {
  readonly appControl: AppControlBridge;

  @child
  get pluginCommandStore(): PluginCommandStore { return createStore(PluginCommandStore); }

  @child
  get inlineWidgetStore(): InlineWidgetStore { return createStore(InlineWidgetStore, { client: this.client }); }

  get client() {
    return this.props.client;
  }

  async openSession(workspacePath: string, sessionId: string) {
    this.showEmptyWorkbench();
    const opening = this.projectWorkbenchStore.openSession(workspacePath, sessionId);
    if (this.projectWorkbenchStore.isActiveSession(workspacePath, sessionId)) {
      this.appShellStore.selectProjectSession(workspacePath, sessionId);
    }
    await opening;
  }

  async openSessionChanges(workspacePath: string, sessionId: string) {
    const selection = this.appShellStore.selection;
    if (selection.kind !== "project-session"
      || selection.workspacePath !== workspacePath
      || selection.sessionId !== sessionId
      || !this.projectWorkbenchStore.isActiveSession(workspacePath, sessionId)) {
      throw new Error("The project session is no longer selected");
    }
    await this.projectWorkbenchStore.openSessionChanges();
  }

  async createSession(workspacePath: string) {
    this.showEmptyWorkbench();
    await this.projectWorkbenchStore.startNewSession(workspacePath);
  }

  async startOneOffChat() {
    this.showEmptyWorkbench();
    await this.projectWorkbenchStore.startOneOffChat();
  }

  async chooseProject() {
    this.showEmptyWorkbench();
    await this.projectWorkbenchStore.chooseProject();
  }

  showWorkbench() {
    this.projectWorkbenchStore.dismissSecondarySurfaces();
    const context = this.projectWorkbenchStore.sessionContext();
    if (context) this.appShellStore.selectProjectSession(context.workspacePath, context.sessionId);
    else this.appShellStore.showWorkbench();
  }
  showGlobalChat(sessionId = this.globalChatStore.sessionId) {
    this.projectWorkbenchStore.dismissSecondarySurfaces();
    this.appShellStore.selectCakeChat(sessionId);
    this.windowPersistence.schedule();
  }
  async openCakeChat(sessionId?: string) {
    this.showGlobalChat(sessionId);
    if (sessionId) await this.globalChatStore.openSession(sessionId);
  }
  async startCakeChat(prompt?: string) {
    this.projectWorkbenchStore.dismissSecondarySurfaces();
    this.appShellStore.selectCakeChat();
    await this.globalChatStore.startNewSession(prompt);
  }
  showSettings() { this.projectWorkbenchStore.dismissSecondarySurfaces(); this.appShellStore.showSettings(); }

  private showEmptyWorkbench() {
    this.projectWorkbenchStore.dismissSecondarySurfaces();
    this.appShellStore.showWorkbench();
  }

  @child
  get customizationStore(): CustomizationStore {
    return createStore(CustomizationStore, { client: this.client });
  }

  @child
  get sessionRegistry(): SessionRegistryStore {
    return createStore(SessionRegistryStore, {
      client: this.client,
      operations: this.sessionOperationCoordinator,
      reviews: () => this.reviewsStore,
      pluginCommands: () => this.pluginCommandStore,
      canSubmit: (target) => this.projectWorkbenchStore.canSubmitSession(target),
      isActive: (target) => this.projectWorkbenchStore.isActiveSession(target.workspacePath, target.sessionId),
      openCommandPane: (pane) => this.projectWorkbenchStore.openCommandPane(pane),
      persist: () => this.windowPersistence.schedule(),
      projectName: (workspacePath) => this.projectCatalogStore.nameForPath(workspacePath),
      abort: () => this.projectWorkbenchStore.abort()
    });
  }

  @child
  get sessionCatalogStore(): SessionCatalogStore {
    return createStore(SessionCatalogStore);
  }

  @child
  get projectCatalogStore(): ProjectCatalogStore {
    return createStore(ProjectCatalogStore, { sessions: this.sessionCatalogStore });
  }

  @child
  get sessionOperationCoordinator(): SessionOperationCoordinator {
    return createStore(SessionOperationCoordinator);
  }

  @child
  get appControlOperationStore(): AppControlOperationStore {
    return createStore(AppControlOperationStore, { operations: this.sessionOperationCoordinator });
  }

  @child
  get sidebarStore(): SidebarStore {
    return createStore(SidebarStore, {
      projects: this.projectCatalogStore,
      catalog: this.sessionCatalogStore,
      sessions: this.sessionRegistry
    });
  }

  @child
  get reviewsStore(): ReviewsStore {
    return createStore(ReviewsStore, {
      client: this.client,
      sessionRegistry: this.sessionRegistry,
      operations: this.sessionOperationCoordinator,
      context: () => this.projectWorkbenchStore.sessionContext(),
      model: () => this.projectWorkbenchStore.session?.model,
      thinkingLevel: () => this.projectWorkbenchStore.session?.thinkingLevel,
      configuration: () => this.projectWorkbenchStore.activeSession?.configurationStore
    });
  }

  @child
  get settingsStore(): SettingsStore {
    return createStore(SettingsStore, {
      client: this.client,
      sessionContext: () => this.projectWorkbenchStore.sessionContext(),
      operations: this.sessionOperationCoordinator
    });
  }

  @child
  get extensionUiStore(): ExtensionUiStore {
    return createStore(ExtensionUiStore, {
      client: this.client,
      activeSessionId: () => this.projectWorkbenchStore.session?.sessionId,
      sessionContext: () => this.projectWorkbenchStore.sessionContext(),
      operationActive: (operationId) => this.sessionOperationCoordinator.includes(operationId),
      setDraft: (value) => {
        const session = this.projectWorkbenchStore.activeSession;
        if (session) session.chatStore.setDraft(resolveDraftUpdate(value, session.chatStore.draft));
      },
      requestComposerFocus: () => this.projectWorkbenchStore.activeSession?.composerStore.requestFocus()
    });
  }

  @child
  get projectWorkbenchStore(): ProjectWorkbenchStore {
    return createStore(ProjectWorkbenchStore, {
      client: this.client,
      sessionRegistry: this.sessionRegistry,
      operations: this.sessionOperationCoordinator,
      projects: this.projectCatalogStore,
      reviews: () => this.reviewsStore,
      extensionUi: () => this.extensionUiStore,
      pluginCommands: () => this.pluginCommandStore,
      persistence: () => this.windowPersistence,
      catalog: this.sessionCatalogStore
    });
  }

  @child
  get windowPersistence(): WindowPersistenceCoordinator {
    return createStore(WindowPersistenceCoordinator, {
      client: this.client,
      projects: this.projectCatalogStore,
      sessions: this.sessionCatalogStore,
      registry: this.sessionRegistry,
      sidebar: () => this.sidebarStore,
      settings: () => this.settingsStore,
      workbench: () => this.projectWorkbenchStore,
      shell: () => this.appShellStore,
      globalChat: () => this.globalChatStore
    });
  }

  @child
  get globalChatStore(): GlobalChatStore {
    return createStore(GlobalChatStore, {
      port: {
        open: (input) => this.client.openGlobalChat(input),
        prompt: (input) => this.client.promptGlobalChat(input),
        abort: (input) => this.client.abortGlobalChat(input),
        setModel: (input) => this.client.setGlobalChatModel(input),
        setThinkingLevel: (input) => this.client.setGlobalChatThinkingLevel(input)
      },
      tools: () => this.appControl.listTools(),
      sessions: () => this.sessionRegistry,
      operations: this.sessionOperationCoordinator
    });
  }

  @child
  get appShellStore(): AppShellStore {
    return createStore(AppShellStore);
  }

  constructor(props: RootStore["props"]) {
    super(props);
    this.appControl = new AppControlBridge({
      currentSession: () => this.projectWorkbenchStore.projectPath && this.projectWorkbenchStore.selectedSessionId
        ? { workspacePath: this.projectWorkbenchStore.projectPath, sessionId: this.projectWorkbenchStore.selectedSessionId }
        : undefined,
      projects: () => this.projectCatalogStore.projects,
      sessions: () => this.sessionCatalogStore.sessions,
      sessionActivity: (workspacePath, sessionId) => this.sidebarStore.sessionActivity(workspacePath, sessionId),
      readSession: async (workspacePath, sessionId) => {
        const cached = this.sessionRegistry.findModel(sessionId, workspacePath);
        if (cached?.sessionFile) return cached.uiParts;
        return (await this.client.loadSession(workspacePath, sessionId))?.parts;
      },
      openSession: async (workspacePath, sessionId) => {
        await this.openSession(workspacePath, sessionId);
      },
      createSession: async (workspacePath) => {
        await this.createSession(workspacePath);
      },
      sendSessionMessage: (workspacePath, sessionId, text, delivery) => this.appControlOperationStore.run((operationId) =>
        this.client.submit({ operationId, workspacePath, sessionId, text, delivery, attachments: [] })),
      abortSession: (workspacePath, sessionId) => this.appControlOperationStore.run((operationId) =>
        this.client.abort({ operationId, workspacePath, sessionId })),
      renameSession: (workspacePath, sessionId, title) => this.projectWorkbenchStore.renameSession(workspacePath, sessionId, title),
      setSessionArchived: (workspacePath, sessionId, archived) => this.projectWorkbenchStore.archiveSession(workspacePath, sessionId, archived),
      setSessionModel: (workspacePath, sessionId, provider, modelId) => this.appControlOperationStore.run((operationId) =>
        this.client.setModel({ operationId, workspacePath, sessionId, provider, modelId })),
      customizationState: () => this.customizationStore.state,
      plugins: () => this.customizationStore.plugins,
      getPluginAuthoringReference: () => this.client.getPluginAuthoringReference(),
      listPluginFiles: () => this.client.listPluginFiles(),
      createPlugin: (input) => this.client.createPlugin(input),
      readPluginFile: (pluginId, path) => this.client.readPluginFile(pluginId, path),
      writePluginFile: (pluginId, path, content, expectedWorkingRevision) => this.client.writePluginFile(pluginId, path, content, expectedWorkingRevision),
      validateCustomization: (expectedBaseRevision, request, expectedSourceRevision) => this.client.validateCustomization(expectedBaseRevision, request, expectedSourceRevision),
      activateCustomization: (revision, expectedSourceRevision, request) => this.client.activateCustomization(revision, expectedSourceRevision, request),
      rollbackCustomization: () => this.client.rollbackCustomization(),
      useFactoryCustomization: () => this.client.useFactoryCustomization(),
      setPluginEnabled: (pluginId, enabled) => this.client.setPluginEnabled(pluginId, enabled),
      setActiveScene: (pluginId) => this.client.setActiveScene(pluginId)
    });
    this.effect(() => this.client.subscribe((event) => {
      try {
        this.receive(event);
      } catch (error) {
        const context = `Desktop event: ${event.type}`;
        if (event.type.startsWith("global-chat-")) this.globalChatStore.reportError(error, context);
        else this.projectWorkbenchStore.setError(error, context);
      }
    }));
    this.effect(() => { void this.customizationStore.hydrate(); });
  }

  private receive(event: DesktopClientEvent) {
    this.customizationStore.receive(event);
    if (event.type === "global-chat-control-requested") {
      void this.appControl.invoke(event.invocation)
        .catch((error) => ({ ok: false as const, name: event.invocation.name, error: error instanceof Error ? error.message : String(error) }))
        .then((result) => {
          try {
            return jsonValueSchema.parse(result);
          } catch {
            return { ok: false as const, name: event.invocation.name, error: "Cake produced a control result that could not be serialized." };
          }
        })
        .then((result) => this.client.respondToGlobalChatControl(event.controlRequestId, result))
        .catch((error) => this.globalChatStore.reportError(error, `Cake Chat control response: ${event.invocation.name}`));
      return;
    }
    if (event.type.startsWith("global-chat-")) {
      for (const session of this.globalChatStore.loadedSessions) session.configurationStore.receive(event);
      this.globalChatStore.receive(event);
      if (event.type === "global-chat-snapshot-received" && this.appShellStore.selection.kind === "cake-chat") {
        const requestedSessionId = this.appShellStore.selection.sessionId;
        if (!requestedSessionId || requestedSessionId === event.snapshot.sessionId) {
          this.appShellStore.selectCakeChat(event.snapshot.sessionId);
          this.windowPersistence.schedule();
        }
      }
      return;
    }
    const sessionReceivers = event.type === "pi-state-changed" && event.workspacePath
      ? this.sessionRegistry.sessions.filter((session) => session.workspacePath === event.workspacePath)
      : this.sessionRegistry.sessions;
    for (const session of sessionReceivers) {
      session.configurationStore.receive(event);
      session.composerStore.receive(event);
      session.artifactInteractionStore.receive(event);
    }
    this.appControlOperationStore.receive(event);
    this.projectWorkbenchStore.changesStore.receive(event);
    this.reviewsStore.receive(event);
    this.settingsStore.receive(event);
    this.extensionUiStore.receive(event);
    if (event.type === "session-snapshot-received") {
      const previousSessionId = this.projectWorkbenchStore.session?.sessionId;
      if (event.operationId && !this.projectWorkbenchStore.acceptSessionSnapshot(event)) return;
      const previous = this.sessionRegistry.findModel(event.snapshot.sessionId, event.snapshot.workspacePath);
      const wasStreaming = previous?.streaming ?? false;
      this.sessionRegistry.upsert(event.snapshot);
      const session = this.sessionRegistry.findSession(event.snapshot.sessionId, event.snapshot.workspacePath)!;
      session.updateActivity(event.snapshot.streaming, wasStreaming);
      session.composerStore.reconcile(event.snapshot.sessionId);
      if (event.operationId || this.projectWorkbenchStore.isActiveSession(event.snapshot.workspacePath, event.snapshot.sessionId)) {
        this.projectWorkbenchStore.applySessionSnapshot(event.snapshot, event.operationId ? previousSessionId : undefined, Boolean(event.operationId));
        if (this.appShellStore.surface === "workbench") {
          this.appShellStore.selectProjectSession(event.snapshot.workspacePath, event.snapshot.sessionId);
        }
        void this.projectWorkbenchStore.changesStore.refresh();
      }
      return;
    }
    if (event.type === "part-updated") {
      const session = this.sessionRegistry.findSession(event.sessionId);
      session?.model.upsertPart(event.part);
      session?.composerStore.reconcile(event.sessionId);
      return;
    }
    if (event.type === "part-removed") {
      this.sessionRegistry.findModel(event.sessionId)?.removePart(event.partId);
      return;
    }
    if (event.type === "streaming-changed") {
      const session = this.sessionRegistry.findSession(event.sessionId);
      const wasStreaming = session?.model.streaming ?? false;
      session?.model.setStreaming(event.streaming);
      if (session) {
        session.updateActivity(event.streaming, wasStreaming);
      }
      return;
    }
    if (event.type === "artifact-updated" || event.type === "artifact-requested") {
      this.sessionRegistry.findModel(event.record.artifact.sessionId, event.record.workspacePath)?.upsertArtifact(event.record);
      if (event.type === "artifact-updated") return;
    }
    if (event.type === "review-threads-received") {
      this.sessionRegistry.applyReviewThreads(event.workspacePath, event.sessionId, event.threads);
      this.projectWorkbenchStore.receive(event);
      return;
    }
    if (event.type === "review-thread-updated") {
      this.sessionRegistry.upsertReviewThread(event.thread);
      this.projectWorkbenchStore.receive(event);
      if (this.projectWorkbenchStore.changesStore.path !== undefined && event.thread.workspacePath === this.projectWorkbenchStore.projectPath) void this.projectWorkbenchStore.changesStore.refresh();
      return;
    }
    this.projectWorkbenchStore.receive(event);
  }

}

function resolveDraftUpdate(value: string | ((current: string) => string), current: string) {
  return isDraftUpdater(value) ? value(current) : value;
}

function isDraftUpdater(value: string | ((current: string) => string)): value is (current: string) => string {
  return typeof value === "function";
}

export function mountRootStore(client: DesktopClient) {
  const root = mount(createStore(RootStore, { client }));
  void root.windowPersistence.hydrate();
  return root;
}
