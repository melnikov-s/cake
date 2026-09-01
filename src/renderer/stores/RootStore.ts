import { Store, child, createStore, untracked } from "r-state-tree";
import type { CakeChatControlRequest } from "../../domain/cake-chat-data";
import type { ChatConfiguration } from "../../ipc/session-contract";
import type { RendererClient } from "../client/RendererClient";
import { RendererClientContext } from "../client/RendererClientContext";
import { ActiveProjectSessionContext } from "../context/ActiveProjectSessionContext";
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
import { ToastStore } from "./ToastStore";
import { TerminalStore, type TerminalTarget } from "./TerminalStore";
import { resolveDraftUpdate } from "../../utils/resolve-draft-update";
import { ProjectCatalog } from "../models/ProjectCatalog";
import { SessionCatalog } from "../models/SessionCatalog";
import { CakeChatCatalog } from "../models/CakeChatCatalog";

export class RootStore extends Store<{
  rendererClient: RendererClient;
  flushWindowState(): Promise<void>;
}> {
  readonly appControl: AppControlBridge;
  readonly projectCatalogModel = ProjectCatalog.create();
  readonly sessionCatalogModel = SessionCatalog.create();
  readonly cakeChatCatalogModel = CakeChatCatalog.create();

  [RendererClientContext.provide]() {
    return this.client;
  }

  [ActiveProjectSessionContext.provide]() {
    const context = this.projectWorkbenchStore.sessionContext();
    return context
      ? { sessionId: context.sessionId, workingDirectory: context.workspacePath }
      : undefined;
  }
  private readonly respondedCakeChatControlIds = new Set<string>();

  @child
  get pluginCommandStore(): PluginCommandStore {
    return createStore(PluginCommandStore);
  }

  @child
  get inlineWidgetStore(): InlineWidgetStore {
    return createStore(InlineWidgetStore);
  }

  get client() {
    return this.props.rendererClient;
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
    this.projectWorkbenchStore.dismissSecondarySurfaces();
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
    if (this.globalChatStore.summaries.some((session) => session.sessionId === sessionId)) {
      await this.openCakeChat(sessionId);
      return;
    }
    throw new Error("Cake could not find the linked session");
  }

  openExternalUrl(url: string) {
    return this.client.electron.openExternalUrl(url, { signal: this.signal });
  }

  async createSession(workspacePath: string) {
    this.showEmptyWorkbench();
    await this.projectWorkbenchStore.startNewSession(workspacePath);
    const sessionId = this.projectWorkbenchStore.activeSession?.sessionId;
    if (sessionId) this.selectProjectSessionForShell(sessionId);
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
  }
  async openCakeChat(sessionId?: string) {
    this.projectWorkbenchStore.dismissSecondarySurfaces();
    if (sessionId && this.globalChatStore.isSessionResolved(sessionId))
      this.appShellStore.previewResolvedCakeChat(sessionId);
    else this.appShellStore.selectCakeChat(sessionId);
    if (sessionId) await this.globalChatStore.openSession(sessionId);
  }
  async startCakeChat(prompt?: string) {
    this.projectWorkbenchStore.dismissSecondarySurfaces();
    this.appShellStore.selectCakeChat();
    await this.globalChatStore.startNewSession(prompt);
    this.appShellStore.selectCakeChat(this.globalChatStore.sessionId);
  }
  showTranscriptSelectionContextMenu(input: { canChat: boolean; canAnnotate: boolean }) {
    return this.client.electron.showTranscriptSelectionContextMenu(input, { signal: this.signal });
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
    const sessionIds = this.sessionCatalogStore
      .projectSessions(path)
      .map((session) => session.sessionId);
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
    return true;
  }

  private showEmptyWorkbench() {
    this.projectWorkbenchStore.dismissSecondarySurfaces();
    this.appShellStore.showWorkbench();
  }

  private async resolveProjectSession(sessionId: string, resolved: boolean) {
    await this.projectWorkbenchStore.sessionManagementStore.resolveSession(sessionId, resolved);
    if (resolved) await this.forgetResolvedSessions([sessionId]);
  }

  private async deleteProjectSession(sessionId: string) {
    const session = this.sessionCatalogStore.find(sessionId);
    const wasSelected = this.appShellStore.activeConversation?.sessionId === sessionId;
    await this.projectWorkbenchStore.sessionManagementStore.deleteSession(sessionId);
    if (!this.sessionCatalogStore.find(sessionId))
      await this.forgetResolvedSessions(
        [sessionId],
        wasSelected ? session?.workingDirectory : undefined,
      );
  }

  private async deleteCakeChatSession(sessionId: string) {
    const wasSelected = this.appShellStore.activeConversation?.sessionId === sessionId;
    await this.globalChatStore.deleteSession(sessionId);
    if (this.globalChatStore.summaries.some((session) => session.sessionId === sessionId)) return;
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
    return createStore(CustomizationStore);
  }

  @child
  get sessionRegistry(): SessionRegistryStore {
    return createStore(SessionRegistryStore, {
      catalog: this.sessionCatalogStore,
      operations: this.sessionOperationCoordinator,
      reviews: () => this.reviewsStore,
      pluginCommands: () => this.pluginCommandStore,
      canSubmit: (sessionId) => this.projectWorkbenchStore.canSubmitSession(sessionId),
      isActive: (sessionId) => this.projectWorkbenchStore.isActiveSession(sessionId),
      openCommandPane: (pane) => this.projectWorkbenchStore.commandPaneStore.open(pane),
      persistNow: () => this.props.flushWindowState(),
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
      prepareNewSession: (sessionId, firstUserMessage) =>
        this.projectWorkbenchStore.prepareNewSession(sessionId, firstUserMessage),
      configureDraftActivation: (sessionId, choice) =>
        this.projectWorkbenchStore.configureDraftActivation(sessionId, choice),
      draftActivationCandidates: (sessionId) =>
        this.projectWorkbenchStore.draftActivationCandidates(sessionId),
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

  private activeTerminalTarget(): TerminalTarget | undefined {
    const selection = this.appShellStore.selection;
    if (selection.kind === "project-session") {
      if (this.sessionCatalogStore.find(selection.sessionId)?.resolved) return undefined;
      return {
        kind: "project",
        sessionId: selection.sessionId,
        workspacePath: selection.workspacePath,
      };
    }
    if (selection.kind === "cake-chat" && selection.sessionId) {
      if (this.globalChatStore.isSessionResolved(selection.sessionId)) return undefined;
      return { kind: "cake-chat", sessionId: selection.sessionId };
    }
    return undefined;
  }

  @child
  get terminalStore(): TerminalStore {
    return createStore(TerminalStore, {
      activeTarget: () => this.activeTerminalTarget(),
    });
  }

  @child
  get toastStore(): ToastStore {
    return createStore(ToastStore, {});
  }

  @child
  get sessionCatalogStore(): SessionCatalogStore {
    return createStore(SessionCatalogStore, { model: this.sessionCatalogModel });
  }

  @child
  get projectCatalogStore(): ProjectCatalogStore {
    return createStore(ProjectCatalogStore, {
      sessions: this.sessionCatalogStore,
      model: this.projectCatalogModel,
    });
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
      sessionRegistry: this.sessionRegistry,
    });
  }

  @child
  get settingsStore(): SettingsStore {
    return createStore(SettingsStore, {
      operations: this.sessionOperationCoordinator,
    });
  }

  @child
  get extensionUiStore(): ExtensionUiStore {
    return createStore(ExtensionUiStore, {
      activeSessionModel: () => this.projectWorkbenchStore.activeSession?.model,
      sessionContext: () => this.projectWorkbenchStore.sessionContext(),
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
      prepareSessionResolution: (sessionIds) =>
        this.terminalStore.prepareResolution(
          sessionIds.map((sessionId) => ({ kind: "project", sessionId })),
        ),
      sessionRegistry: this.sessionRegistry,
      operations: this.sessionOperationCoordinator,
      projects: this.projectCatalogStore,
      defaultConfiguration: () => this.settingsStore.modelPresets.defaultConfiguration,
      reviews: () => this.reviewsStore,
      extensionUi: () => this.extensionUiStore,
      pluginCommands: () => this.pluginCommandStore,
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
  get globalChatStore(): GlobalChatStore {
    return createStore(GlobalChatStore, {
      catalog: this.cakeChatCatalogModel,
      tools: () => this.appControl.listTools(),
      modelPresets: () => this.settingsStore.modelPresets.presets,
      defaultConfiguration: () => this.settingsStore.modelPresets.defaultConfiguration,
      openModelPresetSettings: () => this.showModelPresetSettings(),
      settings: () => this.settingsStore.appearance,
      prepareSessionResolution: (sessionIds) =>
        this.terminalStore.prepareResolution(
          sessionIds.map((sessionId) => ({ kind: "cake-chat", sessionId })),
        ),
    });
  }

  @child
  get appShellStore(): AppShellStore {
    return createStore(AppShellStore, {
      sessionWorkspacePath: (sessionId) =>
        this.sessionCatalogStore.find(sessionId)?.workingDirectory ??
        this.sessionRegistry.findSession(sessionId)?.workspacePath,
    });
  }

  constructor(props: RootStore["props"]) {
    super(props);
    this.effect(() => () => {
      this.projectCatalogModel[Symbol.dispose]();
      this.sessionCatalogModel[Symbol.dispose]();
      this.cakeChatCatalogModel[Symbol.dispose]();
    });
    this.effect(() => {
      for (const session of this.globalChatStore.loadedSessions)
        for (const request of session.model.controlRequests)
          if (!this.respondedCakeChatControlIds.has(request.controlRequestId)) {
            this.respondedCakeChatControlIds.add(request.controlRequestId);
            void this.respondCakeChatControl(request);
          }
    });
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
        this.appControlOperationStore.run(() => {
          const command =
            delivery === "steer"
              ? this.client.projectSessions.steer
              : delivery === "follow-up"
                ? this.client.projectSessions.followUp
                : this.client.projectSessions.prompt;
          return command(
            {
              sessionId,
              text,
              renderUserMessageAsMarkdown: false,
              attachments: [],
            },
            { signal: this.signal },
          ).then(() => undefined);
        }),
      abortSession: (sessionId) =>
        this.appControlOperationStore.run(() =>
          this.client.projectSessions.abort({ sessionId }, { signal: this.signal }),
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
        this.appControlOperationStore.run(() =>
          this.client.projectSessions.setModel(
            { sessionId, provider, modelId },
            { signal: this.signal },
          ),
        ),
      customizationState: () => this.customizationStore.state,
      plugins: () => this.customizationStore.plugins,
      getPluginAuthoringReference: () => this.client.plugins.getAuthoringReference(),
      listPluginFiles: () => this.client.plugins.listFiles(),
      createPlugin: (input) => this.client.plugins.create(input),
      readPluginFile: (pluginId, path) => this.client.plugins.readFile(pluginId, path),
      writePluginFile: (pluginId, path, content, expectedWorkingRevision) =>
        this.client.plugins.writeFile(pluginId, path, content, expectedWorkingRevision),
      validateCustomization: (expectedBaseRevision, request, expectedSourceRevision) =>
        this.client.plugins.validate(expectedBaseRevision, request, expectedSourceRevision),
      activateCustomization: (revision, expectedSourceRevision, request) =>
        this.client.plugins.activate(revision, expectedSourceRevision, request),
      rollbackCustomization: () => this.client.plugins.rollback(),
      useFactoryCustomization: () => this.client.plugins.useFactory(),
      setPluginEnabled: (pluginId, enabled) => this.client.plugins.setEnabled(pluginId, enabled),
      setActiveScene: (pluginId) => this.client.plugins.setActiveScene(pluginId),
    });
    this.effect(() => {
      void this.customizationStore.hydrate();
    });
    this.effect(() => {
      untracked(() => void this.globalChatStore.initialize());
    });
  }

  private async respondCakeChatControl(request: CakeChatControlRequest) {
    const result = await this.appControl.invoke(request.invocation).catch((error) => ({
      ok: false as const,
      name: request.invocation.name,
      error: error instanceof Error ? error.message : String(error),
    }));
    try {
      await this.client.cakeChats.respondControl(request.controlRequestId, result, {
        signal: this.signal,
      });
    } catch (error) {
      if (!this.signal.aborted)
        this.globalChatStore.reportError(
          error,
          `Cake Chat control response: ${request.invocation.name}`,
        );
    }
  }
}
