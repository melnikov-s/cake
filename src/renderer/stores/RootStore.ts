import { Store, child, createStore, untracked } from "r-state-tree";
import { jsonValueSchema } from "../../ipc/json-contract";
import type { SessionSnapshot } from "../../ipc/session-contract";
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
import { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import { AppControlOperationStore } from "./AppControlOperationStore";
import { ProjectCatalogStore } from "./ProjectCatalogStore";
import { WindowPersistenceCoordinatorStore } from "./WindowPersistenceCoordinatorStore";
import { ToastStore } from "./ToastStore";
import { resolveDraftUpdate } from "../../utils/resolve-draft-update";

export class RootStore extends Store<{ client: DesktopClient }> {
  readonly appControl: AppControlBridge;

  @child
  get pluginCommandStore(): PluginCommandStore {
    return createStore(PluginCommandStore);
  }

  @child
  get inlineWidgetStore(): InlineWidgetStore {
    return createStore(InlineWidgetStore, { client: this.client });
  }

  get client() {
    return this.props.client;
  }

  private projectSession(sessionId: string) {
    const catalogSession = this.sessionCatalogStore.find(sessionId);
    if (catalogSession) return catalogSession;
    const loadedSession = this.sessionRegistry.findSession(sessionId);
    if (loadedSession) return { workspacePath: loadedSession.workspacePath };
    throw new Error("Cake could not find that session");
  }

  async openSession(sessionId: string) {
    this.projectSession(sessionId);
    this.showEmptyWorkbench();
    const opening = this.projectWorkbenchStore.openSession(sessionId);
    if (this.projectWorkbenchStore.isActiveSession(sessionId)) {
      this.appShellStore.selectProjectSession(sessionId);
    }
    await opening;
  }

  async openSessionChanges(sessionId: string) {
    this.projectSession(sessionId);
    const selection = this.appShellStore.selection;
    if (
      selection.kind !== "project-session" ||
      selection.sessionId !== sessionId ||
      !this.projectWorkbenchStore.isActiveSession(sessionId)
    ) {
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
    if (context) this.appShellStore.selectProjectSession(context.sessionId);
    else this.appShellStore.showWorkbench();
  }
  returnToWorkbench() {
    this.showWorkbench();
    this.projectWorkbenchStore.activeSession?.composerStore.requestFocus();
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
  showSettings() {
    this.projectWorkbenchStore.dismissSecondarySurfaces();
    this.appShellStore.showSettings();
  }
  showModelPresetSettings() {
    this.settingsStore.modelPresets.requestSection();
    this.showSettings();
  }

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
      catalog: this.sessionCatalogStore,
      operations: this.sessionOperationCoordinator,
      reviews: () => this.reviewsStore,
      pluginCommands: () => this.pluginCommandStore,
      canSubmit: (sessionId) => this.projectWorkbenchStore.canSubmitSession(sessionId),
      isActive: (sessionId) => this.projectWorkbenchStore.isActiveSession(sessionId),
      openCommandPane: (pane) => this.projectWorkbenchStore.commandPaneStore.open(pane),
      persist: () => this.windowPersistence.schedule(),
      projectName: (workspacePath) => this.projectCatalogStore.nameForPath(workspacePath),
      abort: () => this.projectWorkbenchStore.abort(),
      renameSession: (sessionId, name) =>
        this.projectWorkbenchStore.sessionManagementStore.renameSession(sessionId, name),
      modelPresets: () => this.settingsStore.modelPresets.presets,
      openModelPresetSettings: () => this.showModelPresetSettings(),
      newSessionRequest: (sessionId) => this.projectWorkbenchStore.newSessionRequest(sessionId),
      settings: () => this.settingsStore.appearance,
    });
  }

  @child
  get toastStore(): ToastStore {
    return createStore(ToastStore, {});
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
  get sessionOperationCoordinator(): SessionOperationCoordinatorStore {
    return createStore(SessionOperationCoordinatorStore);
  }

  @child
  get appControlOperationStore(): AppControlOperationStore {
    return createStore(AppControlOperationStore, { operations: this.sessionOperationCoordinator });
  }

  @child
  get sidebarStore(): SidebarStore {
    return createStore(SidebarStore, {
      client: this.client,
      projects: this.projectCatalogStore,
      catalog: this.sessionCatalogStore,
      sessions: this.sessionRegistry,
      cakeChat: () => this.globalChatStore,
      setSessionResolved: (sessionId, resolved) =>
        this.projectWorkbenchStore.sessionManagementStore.resolveSession(sessionId, resolved),
      setCakeChatSessionResolved: (sessionId, resolved) =>
        this.globalChatStore.resolveSession(sessionId, resolved),
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
      configuration: () => this.projectWorkbenchStore.activeSession?.configurationStore,
    });
  }

  @child
  get settingsStore(): SettingsStore {
    return createStore(SettingsStore, {
      client: this.client,
      sessionContext: () => this.projectWorkbenchStore.sessionContext(),
      operations: this.sessionOperationCoordinator,
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
      requestComposerFocus: () =>
        this.projectWorkbenchStore.activeSession?.composerStore.requestFocus(),
    });
  }

  @child
  get projectWorkbenchStore(): ProjectWorkbenchStore {
    return createStore(ProjectWorkbenchStore, {
      client: this.client,
      changesClient: this.client,
      commandPaneClient: this.client,
      embeddedEditorClient: this.client,
      sessionForkClient: this.client,
      sessionManagementClient: this.client,
      worktreeClient: this.client,
      worktreeCreationClient: this.client,
      sessionRegistry: this.sessionRegistry,
      operations: this.sessionOperationCoordinator,
      projects: this.projectCatalogStore,
      defaultConfiguration: () => this.settingsStore.modelPresets.defaultConfiguration,
      reviews: () => this.reviewsStore,
      extensionUi: () => this.extensionUiStore,
      pluginCommands: () => this.pluginCommandStore,
      persistence: () => this.windowPersistence,
      catalog: this.sessionCatalogStore,
      startCakeChat: (prompt) => this.startCakeChat(prompt),
      startFreshSessionInProject: async (path) => {
        this.toastStore.show({
          tone: "info",
          title: "Worktree merged",
          message: "Your work was merged back into the project.",
        });
        await this.createSession(path);
      },
      openSessionById: async (sessionId) => {
        await this.openSession(sessionId);
      },
    });
  }

  @child
  get windowPersistence(): WindowPersistenceCoordinatorStore {
    return createStore(WindowPersistenceCoordinatorStore, {
      client: this.client,
      projects: this.projectCatalogStore,
      sessions: this.sessionCatalogStore,
      registry: this.sessionRegistry,
      sidebar: () => this.sidebarStore,
      settings: () => this.settingsStore,
      workbench: () => this.projectWorkbenchStore,
      shell: () => this.appShellStore,
      globalChat: () => this.globalChatStore,
    });
  }

  @child
  get globalChatStore(): GlobalChatStore {
    return createStore(GlobalChatStore, {
      port: {
        open: (input) => this.client.openGlobalChat(input),
        prompt: (input) => this.client.promptGlobalChat(input),
        abort: (input) => this.client.abortGlobalChat(input),
        compact: (input) => this.client.compactGlobalChat(input),
        setConfiguration: (input) => this.client.setGlobalChatConfiguration(input),
        setModel: (input) => this.client.setGlobalChatModel(input),
        setThinkingLevel: (input) => this.client.setGlobalChatThinkingLevel(input),
        setFastMode: (input) => this.client.setGlobalChatFastMode(input),
        resolveSession: (sessionId, resolved) =>
          this.client.resolveCakeChatSession(sessionId, resolved),
      },
      tools: () => this.appControl.listTools(),
      modelPresets: () => this.settingsStore.modelPresets.presets,
      defaultConfiguration: () => this.settingsStore.modelPresets.defaultConfiguration,
      openModelPresetSettings: () => this.showModelPresetSettings(),
      settings: () => this.settingsStore.appearance,
      persist: () => this.windowPersistence.schedule(),
    });
  }

  @child
  get appShellStore(): AppShellStore {
    return createStore(AppShellStore, {
      sessionWorkspacePath: (sessionId) =>
        this.sessionCatalogStore.find(sessionId)?.workspacePath ??
        this.sessionRegistry.findSession(sessionId)?.workspacePath,
    });
  }

  constructor(props: RootStore["props"]) {
    super(props);
    this.appControl = new AppControlBridge({
      currentSession: () =>
        this.projectWorkbenchStore.projectPath && this.projectWorkbenchStore.selectedSessionId
          ? {
              workspacePath: this.projectWorkbenchStore.projectPath,
              sessionId: this.projectWorkbenchStore.selectedSessionId,
            }
          : undefined,
      projects: () => this.projectCatalogStore.projects,
      sessions: () => this.sessionCatalogStore.sessions,
      cakeChatSessions: () => this.globalChatStore.summaries,
      sessionActivity: (sessionId) => this.sidebarStore.sessionActivity(sessionId),
      openSession: async (sessionId) => {
        await this.openSession(sessionId);
      },
      createSession: async (workspacePath) => {
        await this.createSession(workspacePath);
      },
      sendSessionMessage: (sessionId, text, delivery) =>
        this.appControlOperationStore.run((operationId) =>
          this.client.submit({ operationId, sessionId, text, delivery, attachments: [] }),
        ),
      abortSession: (sessionId) =>
        this.appControlOperationStore.run((operationId) =>
          this.client.abort({ operationId, sessionId }),
        ),
      renameSession: (sessionId, title) =>
        this.projectWorkbenchStore.sessionManagementStore.renameSession(sessionId, title),
      setSessionResolved: (sessionId, resolved) =>
        this.projectWorkbenchStore.sessionManagementStore.resolveSession(sessionId, resolved),
      setSessionsResolved: (sessionIds, resolved) =>
        this.projectWorkbenchStore.sessionManagementStore.resolveSessionsById(sessionIds, resolved),
      setCakeChatSessionsResolved: (sessionIds, resolved) =>
        this.globalChatStore.resolveSessions(sessionIds, resolved),
      setSessionModel: (sessionId, provider, modelId) =>
        this.appControlOperationStore.run((operationId) =>
          this.client.setModel({ operationId, sessionId, provider, modelId }),
        ),
      customizationState: () => this.customizationStore.state,
      plugins: () => this.customizationStore.plugins,
      getPluginAuthoringReference: () => this.client.getPluginAuthoringReference(),
      listPluginFiles: () => this.client.listPluginFiles(),
      createPlugin: (input) => this.client.createPlugin(input),
      readPluginFile: (pluginId, path) => this.client.readPluginFile(pluginId, path),
      writePluginFile: (pluginId, path, content, expectedWorkingRevision) =>
        this.client.writePluginFile(pluginId, path, content, expectedWorkingRevision),
      validateCustomization: (expectedBaseRevision, request, expectedSourceRevision) =>
        this.client.validateCustomization(expectedBaseRevision, request, expectedSourceRevision),
      activateCustomization: (revision, expectedSourceRevision, request) =>
        this.client.activateCustomization(revision, expectedSourceRevision, request),
      rollbackCustomization: () => this.client.rollbackCustomization(),
      useFactoryCustomization: () => this.client.useFactoryCustomization(),
      setPluginEnabled: (pluginId, enabled) => this.client.setPluginEnabled(pluginId, enabled),
      setActiveScene: (pluginId) => this.client.setActiveScene(pluginId),
    });
    this.effect(() =>
      this.client.subscribe((event) => {
        try {
          this.receive(event);
        } catch (error) {
          const context = `Desktop event: ${event.type}`;
          if (event.type.startsWith("global-chat-"))
            this.globalChatStore.reportError(error, context);
          else this.projectWorkbenchStore.setError(error, context);
        }
      }),
    );
    this.effect(() => {
      void this.customizationStore.hydrate();
    });
    this.effect(() => {
      untracked(() => void this.globalChatStore.initialize());
    });
  }

  /** Tracks the most recent chat configuration so new sessions can fall back to it. */
  private recordLastChatConfiguration(snapshot: SessionSnapshot) {
    if (!snapshot.model) return;
    this.settingsStore.modelPresets.recordUsage({
      provider: snapshot.model.provider,
      modelId: snapshot.model.id,
      thinkingLevel: snapshot.thinkingLevel,
      fastMode: snapshot.fastMode ?? false,
    });
    this.windowPersistence.schedule();
  }

  private receive(event: DesktopClientEvent) {
    this.customizationStore.receive(event);
    if (event.type === "application-state-changed") {
      this.projectCatalogStore.applyApplicationState(event.state);
      this.globalChatStore.applyApplicationState(event.state);
      this.settingsStore.applyApplicationState(event.state);
      return;
    }
    if (event.type === "context-menu-action") return;
    if (event.type === "global-chat-control-requested") {
      void this.appControl
        .invoke(event.invocation)
        .catch((error) => ({
          ok: false as const,
          name: event.invocation.name,
          error: error instanceof Error ? error.message : String(error),
        }))
        .then((result) => {
          try {
            return jsonValueSchema.parse(result);
          } catch {
            return {
              ok: false as const,
              name: event.invocation.name,
              error: "Cake produced a control result that could not be serialized.",
            };
          }
        })
        .then((result) => this.client.respondToGlobalChatControl(event.controlRequestId, result))
        .catch((error) =>
          this.globalChatStore.reportError(
            error,
            `Cake Chat control response: ${event.invocation.name}`,
          ),
        );
      return;
    }
    if (event.type.startsWith("global-chat-")) {
      // Transcript deltas are the hot streaming path. Route them directly instead
      // of waking every loaded chat's configuration workflow for every token.
      if (
        event.type === "global-chat-part-updated" ||
        event.type === "global-chat-part-removed" ||
        event.type === "global-chat-streaming-changed"
      ) {
        this.globalChatStore.receive(event);
        return;
      }
      this.globalChatStore.receive(event);
      if (event.type === "global-chat-snapshot-received") {
        this.recordLastChatConfiguration(event.snapshot);
        if (this.appShellStore.selection.kind === "cake-chat") {
          const requestedSessionId = this.appShellStore.selection.sessionId;
          if (!requestedSessionId || requestedSessionId === event.snapshot.sessionId) {
            this.appShellStore.selectCakeChat(event.snapshot.sessionId);
            this.windowPersistence.schedule();
          }
        }
      }
      return;
    }
    // Keep high-frequency transcript events off the general event fan-out. During
    // streaming this avoids invoking unrelated workflows and materializing their
    // lazy child Stores once per token.
    if (event.type === "part-updated") {
      const session = this.sessionRegistry.upsertPart(event.sessionId, event.part);
      const canReconcileOptimisticMessage =
        (event.part.kind === "text" &&
          event.part.role === "user" &&
          event.part.status === "complete") ||
        (event.part.kind === "attachment" && event.part.attachmentKind === "image");
      if (canReconcileOptimisticMessage) session?.composerStore.reconcile(event.sessionId);
      if (
        this.projectWorkbenchStore.isActiveSession(event.sessionId) &&
        (event.part.kind === "tool" || (event.part.kind === "text" && event.part.role === "user"))
      )
        void this.projectWorkbenchStore.embeddedEditorStore.syncAgentChanges();
      return;
    }
    if (event.type === "part-removed") {
      this.sessionRegistry.removePart(event.sessionId, event.partId);
      return;
    }
    if (event.type === "streaming-changed") {
      const wasStreaming = this.sessionRegistry.findModel(event.sessionId)?.streaming ?? false;
      const session = this.sessionRegistry.setStreaming(event.sessionId, event.streaming);
      if (session) session.updateActivity(event.streaming, wasStreaming);
      return;
    }
    if (event.type === "background-work-changed") {
      this.sessionRegistry.findSession(event.sessionId)?.setBackgroundWorkActive(event.active);
      return;
    }
    if (event.type === "subagent-activity-received") {
      this.sessionRegistry.findSession(event.activity.parentSessionId)?.receive(event);
      return;
    }
    if (event.type === "subagent-activity-removed") {
      this.sessionRegistry.findSession(event.parentSessionId)?.receive(event);
      return;
    }
    if (
      event.type === "operation-completed" ||
      event.type === "operation-failed" ||
      event.type === "pi-state-changed"
    ) {
      const sessionReceivers =
        event.type === "pi-state-changed" && event.workspacePath
          ? this.sessionRegistry.sessions.filter(
              (session) => session.workspacePath === event.workspacePath,
            )
          : this.sessionRegistry.sessions;
      for (const session of sessionReceivers) session.receive(event);
    }
    this.appControlOperationStore.receive(event);
    this.projectWorkbenchStore.changesStore.receive(event);
    this.reviewsStore.receive(event);
    this.settingsStore.receive(event);
    this.extensionUiStore.receive(event);
    if (event.type === "session-snapshot-received") {
      this.recordLastChatConfiguration(event.snapshot);
      const previousSessionId = this.projectWorkbenchStore.session?.sessionId;
      const newSession = event.operationId
        ? this.projectWorkbenchStore.isOpeningNewSession(event.operationId)
        : false;
      if (event.operationId && !this.projectWorkbenchStore.acceptSessionSnapshot(event)) return;
      const previous = this.sessionRegistry.findModel(event.snapshot.sessionId);
      const wasStreaming = previous?.streaming ?? false;
      this.sessionRegistry.upsert(event.snapshot);
      const session = this.sessionRegistry.findSession(event.snapshot.sessionId)!;
      session.receive(event);
      session.updateActivity(session.model.streaming, wasStreaming);
      session.composerStore.reconcile(event.snapshot.sessionId);
      if (
        event.operationId ||
        this.projectWorkbenchStore.isActiveSession(event.snapshot.sessionId)
      ) {
        this.projectWorkbenchStore.applySessionSnapshot(
          event.snapshot,
          event.operationId ? previousSessionId : undefined,
          Boolean(event.operationId),
          newSession,
        );
        if (this.appShellStore.surface === "workbench") {
          this.appShellStore.selectProjectSession(event.snapshot.sessionId);
        }
        void this.projectWorkbenchStore.changesStore.refresh();
        void this.projectWorkbenchStore.embeddedEditorStore.syncAgentChanges();
      }
      return;
    }
    if (event.type === "artifact-updated" || event.type === "artifact-requested") {
      this.sessionRegistry.upsertArtifact(event.record);
      if (event.type === "artifact-updated") return;
      this.sessionRegistry.findSession(event.record.artifact.sessionId)?.receive(event);
    }
    if (event.type === "review-threads-received") {
      this.sessionRegistry.applyReviewThreads(event.sessionId, event.threads);
      this.projectWorkbenchStore.receive(event);
      return;
    }
    if (event.type === "review-thread-updated") {
      this.sessionRegistry.upsertReviewThread(event.thread);
      this.projectWorkbenchStore.receive(event);
      if (
        this.projectWorkbenchStore.changesStore.path !== undefined &&
        event.thread.workspacePath === this.projectWorkbenchStore.projectPath
      )
        void this.projectWorkbenchStore.changesStore.refresh();
      return;
    }
    this.projectWorkbenchStore.receive(event);
  }
}
