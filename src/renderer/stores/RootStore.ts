import { Store, child, createStore, untracked } from "r-state-tree";
import { jsonValueSchema } from "../../ipc/json-contract";
import type { ChatConfiguration, SessionSnapshot, UiPart } from "../../ipc/session-contract";
import type { DesktopClient, DesktopClientEvent } from "../desktop-client";
import type { SessionHistoryEntry } from "./AppShellStore";
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
  private readonly pendingProjectPartUpdates = new Map<string, Map<string, UiPart>>();
  private projectPartFlushFrame: number | undefined;

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

  async openSession(sessionId: string, messageId?: string) {
    this.projectSession(sessionId);
    this.showEmptyWorkbench();
    const opening = this.projectWorkbenchStore.openSession(sessionId);
    if (this.projectWorkbenchStore.isActiveSession(sessionId))
      this.selectProjectSessionForShell(sessionId);
    await opening;
    if (this.projectWorkbenchStore.isActiveSession(sessionId))
      this.selectProjectSessionForShell(sessionId);
    if (!messageId) return true;
    const session = this.sessionRegistry.findSession(sessionId);
    if (!session) return false;
    const message = session.chatStore.parts.find(
      (part) =>
        part.id === messageId ||
        (part.kind === "text" && part.entryId !== undefined && part.entryId === messageId),
    );
    if (!message) return false;
    session.chatStore.navigateToMessage(message.id);
    return true;
  }

  private selectProjectSessionForShell(sessionId: string) {
    if (this.sessionCatalogStore.find(sessionId)?.resolved)
      this.appShellStore.previewResolvedProjectSession(sessionId);
    else this.appShellStore.selectProjectSession(sessionId);
  }

  /** Opens the project or Cake Chat session addressed by a Markdown session link. */
  async openSessionLink(sessionId: string) {
    if (this.sessionCatalogStore.find(sessionId) || this.sessionRegistry.findSession(sessionId)) {
      await this.openSession(sessionId);
      return;
    }
    if (this.globalChatStore.summaries.some((session) => session.id === sessionId)) {
      await this.openCakeChat(sessionId);
      return;
    }
    throw new Error("Cake could not find the linked session");
  }

  openExternalUrl(url: string) {
    return this.client.openExternalUrl(url);
  }

  async createSession(workspacePath: string) {
    this.showEmptyWorkbench();
    await this.projectWorkbenchStore.startNewSession(workspacePath);
  }

  async createPromptedSession(input: {
    workspacePath: string;
    name: string;
    initialPrompt: string;
    model?: ChatConfiguration;
    worktreeName?: string;
    markdown?: boolean;
  }) {
    this.showEmptyWorkbench();
    const managedWorktree = input.worktreeName
      ? await this.projectWorkbenchStore.worktreeCreationStore.create(input.workspacePath, {
          name: input.worktreeName,
        })
      : undefined;
    const workspacePath = managedWorktree?.worktreePath ?? input.workspacePath;
    const sessionId = await this.projectWorkbenchStore.createSession(
      workspacePath,
      input.name,
      input.initialPrompt,
      input.model,
      input.markdown !== false,
    );
    return managedWorktree
      ? { workspacePath, sessionId, managedWorktree }
      : { workspacePath, sessionId };
  }

  async startOneOffChat() {
    this.showEmptyWorkbench();
    await this.projectWorkbenchStore.startOneOffChat();
  }

  async chooseProject() {
    this.showEmptyWorkbench();
    await this.projectWorkbenchStore.chooseProject();
  }

  navigateBack() {
    void this.navigateToHistoryEntry(this.appShellStore.goBack());
  }
  navigateForward() {
    void this.navigateToHistoryEntry(this.appShellStore.goForward());
  }
  private async navigateToHistoryEntry(entry: SessionHistoryEntry | undefined) {
    if (!entry) return;
    if (entry.kind === "cake-chat") await this.openCakeChat(entry.sessionId);
    else await this.openSession(entry.sessionId);
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
  dismissTopSecondarySurface() {
    if (this.projectWorkbenchStore.sessionContinuationStore.prompt) {
      this.projectWorkbenchStore.sessionContinuationStore.cancelPrompt();
      return;
    }
    if (this.projectWorkbenchStore.embeddedEditorStore.visible) {
      this.returnToWorkbench();
      return;
    }
    if (this.projectWorkbenchStore.commandPaneStore.pane)
      this.projectWorkbenchStore.commandPaneStore.close();
  }
  showGlobalChat(sessionId = this.globalChatStore.sessionId) {
    this.projectWorkbenchStore.dismissSecondarySurfaces();
    this.appShellStore.selectCakeChat(sessionId);
    this.windowPersistence.schedule();
  }
  async openCakeChat(sessionId?: string) {
    this.projectWorkbenchStore.dismissSecondarySurfaces();
    if (sessionId && this.globalChatStore.isSessionResolved(sessionId))
      this.appShellStore.previewResolvedCakeChat(sessionId);
    else this.appShellStore.selectCakeChat(sessionId);
    this.windowPersistence.schedule();
    if (sessionId) await this.globalChatStore.openSession(sessionId);
  }
  async startCakeChat(prompt?: string) {
    this.projectWorkbenchStore.dismissSecondarySurfaces();
    this.appShellStore.selectCakeChat();
    await this.globalChatStore.startNewSession(prompt);
    this.appShellStore.selectCakeChat(this.globalChatStore.sessionId);
    this.windowPersistence.schedule();
  }
  showSettings() {
    this.projectWorkbenchStore.dismissSecondarySurfaces();
    this.appShellStore.showSettings();
  }
  showModelPresetSettings() {
    this.settingsStore.modelPresets.requestSection();
    this.showSettings();
  }

  async removeProject(path: string, deleteSessions: boolean) {
    const sessionIds = this.sessionCatalogStore.projectSessions(path).map((session) => session.id);
    const removed = await this.projectWorkbenchStore.removeProject(path, deleteSessions);
    if (!removed) return false;
    const target = this.appShellStore.removeSessionsFromHistory(sessionIds);
    if (deleteSessions) {
      for (const sessionId of sessionIds) {
        this.sessionRegistry.removeSession(sessionId);
        this.sessionCatalogStore.remove(sessionId);
      }
    }
    if (target) await this.navigateToHistoryEntry(target);
    else if (
      this.appShellStore.selection.kind === "project-session" &&
      sessionIds.includes(this.appShellStore.selection.sessionId)
    )
      this.showEmptyWorkbench();
    this.windowPersistence.schedule();
    return true;
  }

  private showEmptyWorkbench() {
    this.projectWorkbenchStore.dismissSecondarySurfaces();
    this.appShellStore.showWorkbench();
  }

  private async resolveProjectSession(sessionId: string, resolved: boolean) {
    const wasTemporary = this.sessionRegistry.isTemporarySession(sessionId);
    await this.projectWorkbenchStore.sessionManagementStore.resolveSession(sessionId, resolved);
    const wasDiscarded = wasTemporary && !this.sessionRegistry.findSession(sessionId);
    if (resolved && (wasDiscarded || this.sessionCatalogStore.find(sessionId)?.resolved))
      await this.forgetResolvedSessions([sessionId]);
  }

  private async deleteProjectSession(sessionId: string) {
    const session = this.sessionCatalogStore.find(sessionId);
    const wasSelected = this.appShellStore.activeConversation?.sessionId === sessionId;
    await this.projectWorkbenchStore.sessionManagementStore.deleteSession(sessionId);
    if (!this.sessionCatalogStore.find(sessionId))
      await this.forgetResolvedSessions(
        [sessionId],
        wasSelected ? session?.workspacePath : undefined,
      );
  }

  private async deleteCakeChatSession(sessionId: string) {
    const wasSelected = this.appShellStore.activeConversation?.sessionId === sessionId;
    await this.globalChatStore.deleteSession(sessionId);
    if (this.globalChatStore.summaries.some((session) => session.id === sessionId)) return;
    await this.forgetResolvedSessions([sessionId]);
    if (wasSelected && this.appShellStore.activeConversation?.sessionId === sessionId)
      this.showGlobalChat();
  }

  private async resolveCakeChatSession(sessionId: string, resolved: boolean) {
    await this.globalChatStore.resolveSession(sessionId, resolved);
    if (!resolved) return;
    if (this.globalChatStore.isSessionResolved(sessionId)) {
      await this.forgetResolvedSessions([sessionId]);
      return;
    }
    if (
      this.appShellStore.activeConversation?.kind === "cake-chat" &&
      this.appShellStore.activeConversation.sessionId === sessionId
    ) {
      this.appShellStore.selectCakeChat(this.globalChatStore.sessionId);
      this.windowPersistence.schedule();
    }
  }

  /** Drops resolved sessions from navigation history and returns to the previous session. */
  private async forgetResolvedSessions(
    sessionIds: readonly string[],
    fallbackProjectPath?: string,
  ) {
    const target = this.appShellStore.removeSessionsFromHistory(sessionIds);
    if (target) {
      await this.navigateToHistoryEntry(target);
      return;
    }
    if (fallbackProjectPath) await this.createSession(fallbackProjectPath);
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
      handoffSession: (entryId, prompt, resolveSource) =>
        this.projectWorkbenchStore.sessionContinuationStore.handoffAt(
          entryId,
          prompt,
          resolveSource,
        ),
      modelPresets: () => this.settingsStore.modelPresets.presets,
      openModelPresetSettings: () => this.showModelPresetSettings(),
      newSessionRequest: (sessionId) => this.projectWorkbenchStore.newSessionRequest(sessionId),
      prepareNewSession: (sessionId) => this.projectWorkbenchStore.prepareNewSession(sessionId),
      worktreeClient: this.client,
      onWorktreeLanded: (record) => {
        this.sessionCatalogStore.noteManagedWorktree(record);
        this.toastStore.show({
          tone: "info",
          title: "Worktree merged",
          message: "Your work was merged back into the project.",
        });
      },
      onWorktreeDiscarded: (record) => this.sessionCatalogStore.noteManagedWorktree(record),
      onResolveWorktree: (workspacePath) =>
        this.projectWorkbenchStore.resolveWorktreeWorkspace(workspacePath),
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
      setSessionResolved: (sessionId, resolved) => this.resolveProjectSession(sessionId, resolved),
      setCakeChatSessionResolved: (sessionId, resolved) =>
        this.resolveCakeChatSession(sessionId, resolved),
      deleteSession: (sessionId) => this.deleteProjectSession(sessionId),
      deleteCakeChatSession: (sessionId) => this.deleteCakeChatSession(sessionId),
      setSessionUnread: (sessionId, unread) =>
        this.projectWorkbenchStore.sessionManagementStore.setSessionUnread(sessionId, unread),
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
      commandPaneClient: this.client,
      embeddedEditorClient: this.client,
      sessionContinuationClient: this.client,
      sessionManagementClient: this.client,
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
      onWorktreeSessionsResolved: (sessionIds, projectPath) =>
        this.forgetResolvedSessions(sessionIds, projectPath),
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
        listSessions: () => this.client.listCakeChatSessions(),
        loadSession: (sessionId) => this.client.loadCakeChatSession(sessionId),
        listModels: () => this.client.listModels(),
        showComposerContextMenu: (input) => this.client.showComposerContextMenu(input),
        rewordComposerSelection: (input) => this.client.rewordComposerSelection(input),
        generateSessionTitle: (firstUserMessage) =>
          this.client.generateSessionTitle?.(firstUserMessage) ?? Promise.resolve(undefined),
        open: (input) => this.client.openGlobalChat(input),
        prompt: (input) => this.client.promptGlobalChat(input),
        editMessage: (input) => {
          if (!this.client.editGlobalChatMessage)
            return Promise.reject(new Error("This Cake client does not support message editing"));
          return this.client.editGlobalChatMessage(input);
        },
        abort: (input) => this.client.abortGlobalChat(input),
        compact: (input) => this.client.compactGlobalChat(input),
        handoff: (input) => this.client.handoffGlobalChat(input),
        setConfiguration: (input) => this.client.setGlobalChatConfiguration(input),
        setModel: (input) => this.client.setGlobalChatModel(input),
        setThinkingLevel: (input) => this.client.setGlobalChatThinkingLevel(input),
        setFastMode: (input) => this.client.setGlobalChatFastMode(input),
        rename: (input) => this.client.renameGlobalChat(input),
        resolveSession: (sessionId, resolved) =>
          this.client.resolveCakeChatSession(sessionId, resolved),
        deleteSession: (sessionId) => this.client.deleteCakeChatSession(sessionId),
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
      openSession: (sessionId, messageId) => this.openSession(sessionId, messageId),
      createSession: (input) => this.createPromptedSession(input),
      sendSessionMessage: (sessionId, text, delivery) =>
        this.appControlOperationStore.run((operationId) =>
          this.client.submit({
            operationId,
            sessionId,
            text,
            delivery,
            renderUserMessageAsMarkdown: false,
            attachments: [],
          }),
        ),
      abortSession: (sessionId) =>
        this.appControlOperationStore.run((operationId) =>
          this.client.abort({ operationId, sessionId }),
        ),
      renameSession: (sessionId, title) =>
        this.projectWorkbenchStore.sessionManagementStore.renameSession(sessionId, title),
      setSessionResolved: (sessionId, resolved) => this.resolveProjectSession(sessionId, resolved),
      setSessionsResolved: async (sessionIds, resolved) => {
        const count = await this.projectWorkbenchStore.sessionManagementStore.resolveSessionsById(
          sessionIds,
          resolved,
        );
        if (resolved) await this.forgetResolvedSessions(sessionIds);
        return count;
      },
      setCakeChatSessionsResolved: async (sessionIds, resolved) => {
        const count = await this.globalChatStore.resolveSessions(sessionIds, resolved);
        if (resolved) await this.forgetResolvedSessions(sessionIds);
        return count;
      },
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
    this.effect(() => () => this.cancelProjectPartFlush());
  }

  private enqueueProjectPartUpdate(sessionId: string, part: UiPart) {
    const sessionUpdates = this.pendingProjectPartUpdates.get(sessionId) ?? new Map();
    sessionUpdates.set(part.id, part);
    this.pendingProjectPartUpdates.set(sessionId, sessionUpdates);
    if (this.projectPartFlushFrame !== undefined) return;

    const frame = globalThis.requestAnimationFrame?.(() => {
      this.projectPartFlushFrame = undefined;
      try {
        this.flushProjectPartUpdates();
      } catch (error) {
        this.projectWorkbenchStore.setError(error, "Desktop event: part-updated");
      }
    });
    if (frame === undefined) {
      this.flushProjectPartUpdates();
      return;
    }
    this.projectPartFlushFrame = frame;
  }

  private flushProjectPartUpdates() {
    if (this.pendingProjectPartUpdates.size === 0) return;
    const updates = [...this.pendingProjectPartUpdates];
    this.pendingProjectPartUpdates.clear();

    for (const [sessionId, parts] of updates) {
      for (const part of parts.values()) {
        const session = this.sessionRegistry.upsertPart(sessionId, part);
        const canReconcileOptimisticMessage =
          (part.kind === "text" && part.role === "user" && part.status === "complete") ||
          part.kind === "annotation" ||
          (part.kind === "attachment" && part.attachmentKind === "image");
        if (canReconcileOptimisticMessage) session?.composerStore.reconcile(sessionId);
      }
    }
  }

  private cancelProjectPartFlush() {
    if (this.projectPartFlushFrame !== undefined)
      globalThis.cancelAnimationFrame?.(this.projectPartFlushFrame);
    this.projectPartFlushFrame = undefined;
    this.pendingProjectPartUpdates.clear();
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
    // Streamed token deltas are frame-coalesced below. Flush them before any other
    // event so snapshots, removals, and streaming state retain desktop event order.
    if (event.type !== "part-updated") this.flushProjectPartUpdates();
    this.customizationStore.receive(event);
    if (event.type === "notification") {
      this.toastStore.show(event);
      return;
    }
    if (event.type === "application-state-changed") {
      const activeProjectSessionId =
        this.appShellStore.activeConversation?.kind === "project-session"
          ? this.appShellStore.activeConversation.sessionId
          : undefined;
      const activeProjectSessionWasResolved = activeProjectSessionId
        ? this.sessionCatalogStore.find(activeProjectSessionId)?.resolved === true
        : false;
      const activeCakeChatSessionId =
        this.appShellStore.activeConversation?.kind === "cake-chat"
          ? this.appShellStore.activeConversation.sessionId
          : undefined;
      const activeCakeChatSessionWasResolved = activeCakeChatSessionId
        ? this.globalChatStore.isSessionResolved(activeCakeChatSessionId)
        : false;
      this.projectCatalogStore.applyApplicationState(event.state);
      this.globalChatStore.applyApplicationState(event.state);
      this.settingsStore.applyApplicationState(event.state);
      if (
        activeProjectSessionId &&
        activeProjectSessionWasResolved &&
        !this.sessionCatalogStore.find(activeProjectSessionId)?.resolved
      )
        this.appShellStore.selectProjectSession(activeProjectSessionId);
      if (
        activeCakeChatSessionId &&
        activeCakeChatSessionWasResolved &&
        !this.globalChatStore.isSessionResolved(activeCakeChatSessionId)
      )
        this.appShellStore.selectCakeChat(activeCakeChatSessionId);
      return;
    }
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
      this.enqueueProjectPartUpdate(event.sessionId, event.part);
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
    this.reviewsStore.receive(event);
    this.settingsStore.receive(event);
    this.extensionUiStore.receive(event);
    if (event.type === "session-snapshot-received") {
      this.recordLastChatConfiguration(event.snapshot);
      const previousSessionId = this.projectWorkbenchStore.session?.sessionId;
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
        );
        if (this.appShellStore.surface === "workbench") {
          this.appShellStore.selectProjectSession(event.snapshot.sessionId);
        }
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
      return;
    }
    this.projectWorkbenchStore.receive(event);
  }
}
