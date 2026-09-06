import { Store, child, createStore, untracked } from "r-state-tree";
import type { CakeChatControlRequest } from "../../domain/cake-chat-data";
import type { ProjectSessionControlRequest } from "../../domain/project-session-data";
import type { ChatConfiguration } from "../../ipc/session-contract";
import type { RendererClient } from "../client/RendererClient";
import { RendererClientContext } from "../client/RendererClientContext";
import { ActiveProjectSessionContext } from "../context/ActiveProjectSessionContext";
import { SettingsSessionContext } from "../context/SettingsSessionContext";
import type { SessionHistoryEntry } from "./AppShellStore";
import { SessionRegistryStore } from "./SessionRegistryStore";
import { ProjectWorkbenchStore } from "./ProjectWorkbenchStore";
import { SidebarStore } from "./SidebarStore";
import { ReviewsStore } from "./ReviewsStore";
import { SettingsStore } from "./SettingsStore";
import { ExtensionUiStore } from "./ExtensionUiStore";
import { AppControlBridge, type AgentControlSource } from "../app-control-bridge";
import { CakeChatCollectionStore } from "./CakeChatCollectionStore";
import { AppShellStore } from "./AppShellStore";
import { InlineWidgetStore } from "./InlineWidgetStore";
import { SessionCatalogStore } from "./SessionCatalogStore";
import { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import { AppControlOperationStore } from "./AppControlOperationStore";
import { ProjectCatalogStore } from "./ProjectCatalogStore";
import { ProjectSettingsStore } from "./ProjectSettingsStore";
import { NotificationStore } from "./NotificationStore";
import { ToastStore } from "./ToastStore";
import { TerminalStore, type TerminalTarget } from "./TerminalStore";
import { SessionLayoutStore, type SessionSplitAxis } from "./SessionLayoutStore";
import { SessionCoordinationStore } from "./SessionCoordinationStore";
import { resolveDraftUpdate } from "../../utils/resolve-draft-update";
import type { RendererModels } from "../RendererModels";

export class RootStore extends Store<{
  rendererClient: RendererClient;
  models: RendererModels;
  flushWindowState(): Promise<void>;
}> {
  readonly appControl: AppControlBridge;

  get projectCatalogModel() {
    return this.props.models.projects;
  }
  get sessionCatalogModel() {
    return this.props.models.sessionCatalog;
  }
  get cakeChatCatalogModel() {
    return this.props.models.cakeChatCatalog;
  }

  [RendererClientContext.provide]() {
    return this.client;
  }

  [ActiveProjectSessionContext.provide]() {
    const context = this.projectWorkbenchStore.sessionContext();
    return context
      ? { sessionId: context.sessionId, workingDirectory: context.workspacePath }
      : undefined;
  }

  [SettingsSessionContext.provide]() {
    const active = this.appShellStore.activeConversation;
    if (active?.kind === "project-session") {
      const context = this.projectWorkbenchStore.sessionContext();
      return context?.sessionId === active.sessionId
        ? {
            kind: "project-session" as const,
            sessionId: context.sessionId,
            workingDirectory: context.workspacePath,
          }
        : undefined;
    }
    if (active?.kind === "cake-chat") {
      const session = this.cakeChatCollectionStore.findSession(active.sessionId);
      return session
        ? { kind: "cake-chat" as const, ...this.cakeChatCollectionStore.target(active.sessionId) }
        : undefined;
    }
    return undefined;
  }
  private readonly respondedCakeChatControlIds = new Set<string>();
  private readonly respondedProjectSessionControlIds = new Set<string>();

  @child
  get inlineWidgetStore(): InlineWidgetStore {
    return createStore(InlineWidgetStore);
  }

  get client() {
    return this.props.rendererClient;
  }

  private projectSessionWorkingDirectory(sessionId: string) {
    return (
      this.sessionCatalogStore.find(sessionId)?.workingDirectory ??
      this.sessionRegistry.findSession(sessionId)?.workspacePath
    );
  }

  private requireProjectSessionWorkingDirectory(sessionId: string) {
    const workingDirectory = this.projectSessionWorkingDirectory(sessionId);
    if (!workingDirectory) throw new Error("Cake could not find that session");
    return workingDirectory;
  }

  private retainProjectSessionObservation(sessionId: string) {
    const summary = this.sessionCatalogStore.find(sessionId);
    if (summary) this.sessionRegistry.load(sessionId, summary.workingDirectory);
    else this.sessionRegistry.retainObservation(sessionId);
  }

  async openSession(sessionId: string, messageId?: string) {
    this.requireProjectSessionWorkingDirectory(sessionId);
    this.projectWorkbenchStore.dismissSecondarySurfaces();
    this.sessionLayoutStore.focusSession(sessionId);
    await this.projectWorkbenchStore.openSession(sessionId);
    if (this.projectWorkbenchStore.activeSession?.sessionId !== sessionId) return false;
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

  initialize() {
    const selection = this.appShellStore.selection;
    if (selection.kind === "project-session") {
      this.sessionLayoutStore.ensureSession(selection.sessionId);
      return this.projectWorkbenchStore.initialize({
        sessionId: selection.sessionId,
        workspacePath: this.requireProjectSessionWorkingDirectory(selection.sessionId),
      });
    }
    if (selection.kind === "workbench") return this.projectWorkbenchStore.initialize();
    return Promise.resolve();
  }

  /** Opens the project or Cake Chat session addressed by a Markdown session link. */
  async openSessionLink(sessionId: string) {
    if (this.sessionCatalogStore.find(sessionId) || this.sessionRegistry.findSession(sessionId)) {
      await this.openSession(sessionId);
      return;
    }
    if (this.cakeChatCollectionStore.summaries.some((session) => session.sessionId === sessionId)) {
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

  async createDraftSession(input: {
    workspacePath: string;
    name: string;
    initialPrompt: string;
    model?: ChatConfiguration;
  }) {
    const sessionId = await this.projectWorkbenchStore.createDraftSession(
      input.workspacePath,
      input.name,
      input.initialPrompt,
      input.model,
    );
    return { workspacePath: input.workspacePath, sessionId };
  }

  private projectControlSource(sessionId: string): AgentControlSource {
    const summary = this.sessionCatalogStore.find(sessionId);
    const loaded = this.sessionRegistry.findSession(sessionId);
    return {
      kind: "project-session",
      sessionId,
      title: summary?.title ?? "Agent session",
      projectName: summary?.projectName ?? "Unknown project",
      workingDirectory:
        summary?.workingDirectory ?? loaded?.workspacePath ?? "Unknown working directory",
    };
  }

  private cakeChatControlSource(sessionId: string): AgentControlSource {
    return {
      kind: "cake-chat",
      sessionId,
      title:
        this.cakeChatCollectionStore.summaries.find((session) => session.sessionId === sessionId)
          ?.title ?? "Cake Chat",
    };
  }

  async respondProjectSessionControl(request: ProjectSessionControlRequest) {
    if (this.respondedProjectSessionControlIds.has(request.controlRequestId)) return;
    this.respondedProjectSessionControlIds.add(request.controlRequestId);
    const catalogSession = this.sessionCatalogStore.find(request.sessionId);
    const loadedSession = this.sessionRegistry.findSession(request.sessionId);
    const sourceWorkingDirectory = catalogSession?.workingDirectory ?? loadedSession?.workspacePath;
    const projectPath =
      catalogSession?.projectPath ??
      (sourceWorkingDirectory
        ? (this.sessionCatalogStore.projectOfManagedWorktree(sourceWorkingDirectory) ??
          sourceWorkingDirectory)
        : undefined);
    const invocation = request.invocation;
    const appInvocation =
      invocation._tag === "InvokeAppControl"
        ? { name: invocation.command, arguments: invocation.input }
        : projectPath
          ? {
              name:
                invocation._tag === "CreateSession" ? "sessions.create" : "sessions.create-draft",
              arguments: invocation.model
                ? {
                    workspacePath: projectPath,
                    name: invocation.name,
                    initialPrompt: invocation.initialPrompt,
                    model: invocation.model,
                  }
                : {
                    workspacePath: projectPath,
                    name: invocation.name,
                    initialPrompt: invocation.initialPrompt,
                  },
            }
          : undefined;
    const result = appInvocation
      ? await this.appControl
          .invoke(appInvocation, this.projectControlSource(request.sessionId))
          .catch((error) => ({
            ok: false as const,
            name: appInvocation.name,
            error: error instanceof Error ? error.message : String(error),
          }))
      : {
          ok: false as const,
          name: invocation._tag === "CreateSession" ? "sessions.create" : "sessions.create-draft",
          error: "Cake could not find the calling Project Session.",
        };
    await this.client.projectSessions.respondControl(
      request.sessionId,
      request.controlRequestId,
      result,
      { signal: this.signal },
    );
  }

  async createPromptedSession(input: {
    workspacePath: string;
    name: string;
    initialPrompt: string;
    model?: ChatConfiguration;
    worktreeName?: string;
    markdown?: boolean;
  }) {
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
    const sessionId =
      this.appShellStore.surface === "workbench" && this.sessionLayoutStore.goBack();
    if (sessionId) void this.openSession(sessionId);
    else void this.navigateToHistoryEntry(this.appShellStore.goBack());
  }
  navigateForward() {
    const sessionId =
      this.appShellStore.surface === "workbench" && this.sessionLayoutStore.goForward();
    if (sessionId) void this.openSession(sessionId);
    else void this.navigateToHistoryEntry(this.appShellStore.goForward());
  }

  focusSessionPane(paneId: string) {
    const sessionId = this.sessionLayoutStore.focusPane(paneId);
    if (!sessionId || this.projectWorkbenchStore.activeSessionId === sessionId) return;
    this.selectProjectSessionForShell(sessionId);
    this.projectWorkbenchStore.showLoadedSession(sessionId);
  }

  focusAdjacentSessionPane(direction: "left" | "right" | "above" | "below") {
    if (this.appShellStore.selection.kind === "cake-chat") {
      const layout = this.cakeChatCollectionStore.sessionLayoutStore;
      const sessionId = layout.focusedSessionId;
      const target = sessionId ? layout.neighbors(sessionId)[direction][0] : undefined;
      if (target) this.focusCakeChatPane(target.paneId);
      return;
    }
    const sessionId = this.sessionLayoutStore.focusedSessionId;
    const target = sessionId
      ? this.sessionLayoutStore.neighbors(sessionId)[direction][0]
      : undefined;
    if (target) this.focusSessionPane(target.paneId);
  }

  splitFocusedSession(axis: SessionSplitAxis) {
    const source = this.projectWorkbenchStore.activeSession;
    if (!source || !this.sessionLayoutStore.canSplit) return;
    const sessionId = crypto.randomUUID();
    const session = this.sessionRegistry.prepareStagedSession(source.workspacePath, sessionId);
    const paneId = this.sessionLayoutStore.splitFocused(sessionId, axis);
    if (!paneId) {
      this.sessionRegistry.removeSession(sessionId);
      return;
    }
    this.selectProjectSessionForShell(sessionId);
    this.projectWorkbenchStore.showLoadedSession(sessionId);
    void session.stagedCommandStore.load(source.workspacePath);
    return { paneId, sessionId };
  }

  focusCakeChatPane(paneId: string) {
    const sessionId = this.cakeChatCollectionStore.focusPane(paneId);
    if (sessionId) this.appShellStore.selectCakeChat(sessionId);
  }

  splitFocusedCakeChat(axis: SessionSplitAxis) {
    const result = this.cakeChatCollectionStore.splitFocused(axis);
    if (result) this.appShellStore.selectCakeChat(result.sessionId);
    return result;
  }

  closeCakeChatPane(paneId: string) {
    const result = this.cakeChatCollectionStore.closePane(paneId);
    if (result?.focusedSessionId) this.appShellStore.selectCakeChat(result.focusedSessionId);
  }

  closeSessionPane(paneId: string) {
    const result = this.sessionLayoutStore.closePane(paneId);
    if (!result) return;
    for (const sessionId of result.removedSessionIds) {
      if (this.sessionRegistry.isStagedSession(sessionId))
        this.sessionRegistry.removeSession(sessionId);
    }
    if (result.focusedSessionId) {
      this.selectProjectSessionForShell(result.focusedSessionId);
      this.projectWorkbenchStore.showLoadedSession(result.focusedSessionId);
    }
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
    this.projectWorkbenchStore.restoreSessionPresentation();
  }
  returnToWorkbench() {
    const active = this.appShellStore.activeConversation;
    if (active?.kind === "cake-chat") {
      this.appShellStore.selectCakeChat(active.sessionId);
      return;
    }
    this.showWorkbench();
    this.projectWorkbenchStore.activeSession?.composerStore.requestFocus();
  }
  dismissTopSecondarySurface() {
    if (this.projectWorkbenchStore.sessionContinuationStore.prompt) {
      this.projectWorkbenchStore.sessionContinuationStore.cancelPrompt();
      return;
    }
    if (this.projectWorkbenchStore.embeddedEditorStore.visible) {
      this.projectWorkbenchStore.backToAgent();
      return;
    }
    if (this.projectWorkbenchStore.commandPaneStore.pane)
      this.projectWorkbenchStore.commandPaneStore.close();
  }
  showCakeChat(sessionId = this.cakeChatCollectionStore.sessionId) {
    this.projectWorkbenchStore.dismissSecondarySurfaces();
    this.appShellStore.selectCakeChat(sessionId);
  }
  async openCakeChat(sessionId?: string) {
    this.projectWorkbenchStore.dismissSecondarySurfaces();
    if (sessionId && this.cakeChatCollectionStore.isSessionResolved(sessionId))
      this.appShellStore.previewResolvedCakeChat(sessionId);
    else this.appShellStore.selectCakeChat(sessionId);
    if (sessionId) await this.cakeChatCollectionStore.openSession(sessionId);
  }
  async startCakeChat(prompt?: string) {
    this.projectWorkbenchStore.dismissSecondarySurfaces();
    this.appShellStore.selectCakeChat();
    await this.cakeChatCollectionStore.startNewSession(prompt);
    this.appShellStore.selectCakeChat(this.cakeChatCollectionStore.sessionId);
  }
  showTranscriptSelectionContextMenu(input: { canChat: boolean; canAnnotate: boolean }) {
    return this.client.electron.showTranscriptSelectionContextMenu(input, { signal: this.signal });
  }

  showSettings() {
    this.projectWorkbenchStore.dismissSecondarySurfaces();
    this.appShellStore.showSettings();
  }
  showModelPresetSettings() {
    this.settingsStore.selectPage("models");
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
    const rendererDraft = this.sessionRegistry.isDraftSession(sessionId);
    const changed = await this.projectWorkbenchStore.sessionManagementStore.resolveSession(
      sessionId,
      resolved,
    );
    if (resolved && changed && !rendererDraft)
      await this.forgetResolvedProjectSessions([sessionId]);
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
    await this.cakeChatCollectionStore.deleteSession(sessionId);
    if (this.cakeChatCollectionStore.summaries.some((session) => session.sessionId === sessionId))
      return;
    await this.forgetResolvedSessions([sessionId]);
    if (wasSelected && this.appShellStore.activeConversation?.sessionId === sessionId)
      this.showCakeChat();
  }

  private async resolveCakeChatSession(sessionId: string, resolved: boolean) {
    await this.cakeChatCollectionStore.resolveSession(sessionId, resolved);
    if (!resolved) return;
    if (this.cakeChatCollectionStore.isSessionResolved(sessionId)) {
      await this.forgetResolvedSessions([sessionId]);
      return;
    }
    if (
      this.appShellStore.activeConversation?.kind === "cake-chat" &&
      this.appShellStore.activeConversation.sessionId === sessionId
    ) {
      this.appShellStore.selectCakeChat(this.cakeChatCollectionStore.sessionId);
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

  /** Ends live renderer ownership before navigating away from archived Pi sessions. */
  private async forgetResolvedProjectSessions(
    sessionIds: readonly string[],
    fallbackProjectPath?: string,
  ) {
    const active = this.appShellStore.activeConversation;
    const activeSessionId =
      active?.kind === "project-session" && sessionIds.includes(active.sessionId)
        ? active.sessionId
        : undefined;
    const activeProjectPath = activeSessionId
      ? this.sessionCatalogStore.find(activeSessionId)?.projectPath
      : undefined;
    this.sessionLayoutStore.removeSessions(sessionIds);
    for (const sessionId of sessionIds) this.sessionRegistry.removeSession(sessionId);
    await this.forgetResolvedSessions(sessionIds, fallbackProjectPath ?? activeProjectPath);
  }

  @child
  get sessionLayoutStore(): SessionLayoutStore {
    return createStore(SessionLayoutStore);
  }

  @child
  get sessionRegistry(): SessionRegistryStore {
    return createStore(SessionRegistryStore, {
      catalog: this.sessionCatalogStore,
      operations: this.sessionOperationCoordinator,
      reviews: () => this.reviewsStore,
      sessionModel: (sessionId, workingDirectory) =>
        this.props.models.projectSession(sessionId, workingDirectory),
      canSubmit: (sessionId) => this.projectWorkbenchStore.canSubmitSession(sessionId),
      isActive: (sessionId) =>
        this.appShellStore.selection.kind === "project-session" &&
        this.appShellStore.selection.sessionId === sessionId,
      isVisible: (sessionId) => this.sessionLayoutStore.hasSession(sessionId),
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
      sessionCreationChoice: (sessionId) =>
        this.projectWorkbenchStore.sessionCreationChoice(sessionId),
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
      const workspacePath = this.projectSessionWorkingDirectory(selection.sessionId);
      return workspacePath
        ? { kind: "project", sessionId: selection.sessionId, workspacePath }
        : undefined;
    }
    if (selection.kind === "cake-chat" && selection.sessionId) {
      if (this.cakeChatCollectionStore.isSessionResolved(selection.sessionId)) return undefined;
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
  get notificationStore(): NotificationStore {
    return createStore(NotificationStore, {
      onError: (error) =>
        this.toastStore.show({
          tone: "error",
          title: "Notification failed",
          message: error instanceof Error ? error.message : String(error),
        }),
    });
  }

  @child
  get sessionCatalogStore(): SessionCatalogStore {
    return createStore(SessionCatalogStore, {
      model: this.sessionCatalogModel,
      pendingSessions: () => this.sessionRegistry.pendingSummaries,
    });
  }

  @child
  get projectCatalogStore(): ProjectCatalogStore {
    return createStore(ProjectCatalogStore, {
      sessions: this.sessionCatalogStore,
      model: this.projectCatalogModel,
    });
  }

  @child
  get projectSettingsStore(): ProjectSettingsStore {
    return createStore(ProjectSettingsStore, { projects: this.projectCatalogStore });
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
  get sessionCoordinationStore(): SessionCoordinationStore {
    return createStore(SessionCoordinationStore, {
      sessionById: (sessionId) => this.sessionRegistry.findSession(sessionId)?.model,
    });
  }

  @child
  get sidebarStore(): SidebarStore {
    return createStore(SidebarStore, {
      projects: this.projectCatalogStore,
      catalog: this.sessionCatalogStore,
      sessions: this.sessionRegistry,
      cakeChat: () => this.cakeChatCollectionStore,
      setSessionResolved: (sessionId, resolved) => this.resolveProjectSession(sessionId, resolved),
      setCakeChatSessionResolved: (sessionId, resolved) =>
        this.resolveCakeChatSession(sessionId, resolved),
      deleteSession: (sessionId) => this.deleteProjectSession(sessionId),
      deleteCakeChatSession: (sessionId) => this.deleteCakeChatSession(sessionId),
      setSessionUnread: (sessionId, unread) =>
        this.projectWorkbenchStore.sessionManagementStore.setSessionUnread(sessionId, unread),
      embeddedEditorSettings: this.settingsStore.embeddedEditor,
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
      activeSession: () => {
        const active = this.appShellStore.activeConversation;
        if (active?.kind === "project-session") {
          const session = this.projectWorkbenchStore.activeSession;
          return session?.sessionId === active.sessionId ? session : undefined;
        }
        return active?.kind === "cake-chat"
          ? this.cakeChatCollectionStore.findSession(active.sessionId)
          : undefined;
      },
      workbenchError: () => this.projectWorkbenchStore.error,
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
      catalog: this.sessionCatalogStore,
      startCakeChat: (prompt) => this.startCakeChat(prompt),
      onWorktreeSessionsResolved: (sessionIds, projectPath) =>
        this.forgetResolvedProjectSessions(sessionIds, projectPath),
      openSessionById: async (sessionId) => {
        await this.openSession(sessionId);
      },
      activeSessionId: () => {
        const active = this.appShellStore.activeConversation;
        return active?.kind === "project-session" ? active.sessionId : undefined;
      },
      selectSession: (sessionId) => {
        this.sessionLayoutStore.showSession(sessionId);
        this.selectProjectSessionForShell(sessionId);
      },
      toggleProjectSidebar: () => this.sidebarStore.toggle(),
      enterIdeSidebarMode: () => this.sidebarStore.enterIdeMode(),
      leaveIdeSidebarMode: () => this.sidebarStore.leaveIdeMode(),
      projectSidebarWidth: () => this.sidebarStore.width,
      paneNumber: (sessionId) => this.sessionLayoutStore.paneNumber(sessionId),
    });
  }

  @child
  get cakeChatCollectionStore(): CakeChatCollectionStore {
    return createStore(CakeChatCollectionStore, {
      catalog: this.cakeChatCatalogModel,
      sessionModel: (sessionId) => this.props.models.cakeChat(sessionId),
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
      projectSessionResolved: (sessionId) => this.sessionCatalogModel.find(sessionId)?.resolved,
      cakeChatSessionResolved: (sessionId) => this.cakeChatCatalogModel.find(sessionId)?.resolved,
      onProjectSessionDeparted: (sessionId) =>
        this.sessionRegistry.findSession(sessionId)?.depart(),
    });
  }

  constructor(props: RootStore["props"]) {
    super(props);
    this.reaction(
      () => [
        ...this.sessionCatalogModel.sessions.map((session) => ({
          kind: "project" as const,
          sessionId: session.sessionId,
          resolved: session.resolved,
        })),
        ...this.cakeChatCatalogModel.sessions.map((session) => ({
          kind: "cake-chat" as const,
          sessionId: session.sessionId,
          resolved: session.resolved,
        })),
      ],
      (sessions) =>
        this.terminalStore.discardResolvedSessions(
          sessions
            .filter((session) => session.resolved)
            .map(({ kind, sessionId }) => ({ kind, sessionId })),
        ),
    );
    this.effect(() => {
      for (const session of this.cakeChatCollectionStore.loadedSessions)
        for (const request of session.model.controlRequests)
          if (!this.respondedCakeChatControlIds.has(request.controlRequestId)) {
            this.respondedCakeChatControlIds.add(request.controlRequestId);
            void this.respondCakeChatControl(request);
          }
    });
    this.appControl = new AppControlBridge({
      sessionCoordination: this.sessionCoordinationStore,
      currentSelection: () => {
        const selection = this.appShellStore.selection;
        if (selection.kind === "project-session") {
          if (
            this.sessionRegistry.isTemporarySession(selection.sessionId) &&
            !this.sessionRegistry.isDraftSession(selection.sessionId)
          )
            return { kind: "new-project-chat" as const };
          const summary = this.sessionCatalogStore.find(selection.sessionId);
          const workspacePath = this.projectSessionWorkingDirectory(selection.sessionId) ?? "";
          return {
            kind: "project-session" as const,
            sessionId: selection.sessionId,
            title: summary?.title ?? "New chat",
            workspacePath,
            workspaceName:
              summary?.projectName ?? this.projectCatalogStore.nameForPath(workspacePath),
          };
        }
        if (selection.kind === "cake-chat") {
          if (
            !selection.sessionId ||
            (this.cakeChatCollectionStore.isPendingSession(selection.sessionId) &&
              !this.cakeChatCollectionStore.isDraftSession(selection.sessionId))
          )
            return { kind: "new-cake-chat" as const };
          return {
            kind: "cake-chat" as const,
            sessionId: selection.sessionId,
            title:
              this.cakeChatCollectionStore.summaries.find(
                (session) => session.sessionId === selection.sessionId,
              )?.title ?? "Cake Chat",
          };
        }
        if (selection.kind === "settings")
          return { kind: "settings" as const, page: this.settingsStore.activePage };
        return { kind: "workbench" as const };
      },
      sessionLayout: (source) => {
        const layout =
          source?.kind === "cake-chat"
            ? this.cakeChatCollectionStore.sessionLayoutStore
            : this.sessionLayoutStore;
        const relativeSessionId =
          source?.sessionId && layout.hasSession(source.sessionId)
            ? source.sessionId
            : layout.focusedSessionId;
        return {
          focusedSessionId: layout.focusedSessionId,
          ...(relativeSessionId ? { originSessionId: relativeSessionId } : null),
          panes: layout.panePlacements.map((pane) => ({ ...pane })),
          ...(relativeSessionId ? { neighbors: layout.neighbors(relativeSessionId) } : null),
        };
      },
      projects: () => this.projectCatalogStore.projects,
      sessions: () => this.sessionCatalogStore.sessions,
      cakeChatSessions: () => this.cakeChatCollectionStore.summaries,
      sessionActivity: (sessionId) => this.sidebarStore.sessionActivity(sessionId),
      openSession: (sessionId, messageId) => this.openSession(sessionId, messageId),
      createSession: (input) => this.createPromptedSession(input),
      createDraftSession: (input) => this.createDraftSession(input),
      sendSessionMessage: (sessionId, text, delivery, crossSession) =>
        this.appControlOperationStore.run(() => {
          this.retainProjectSessionObservation(sessionId);
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
              ...(crossSession ? { crossSession } : null),
            },
            { signal: this.signal },
          );
        }),
      compactSession: (sessionId, instructions) =>
        this.appControlOperationStore.run(() =>
          this.client.projectSessions.compact({ sessionId, instructions }, { signal: this.signal }),
        ),
      scheduleSessionMessage: (input) =>
        this.appControlOperationStore.run(() =>
          this.client.scheduledMessages.schedule(input, { signal: this.signal }),
        ),
      listScheduledMessages: (sessionId) =>
        this.client.scheduledMessages.list(sessionId, { signal: this.signal }),
      cancelScheduledMessage: (id) =>
        this.appControlOperationStore.run(() =>
          this.client.scheduledMessages.cancel(id, { signal: this.signal }),
        ),
      listPendingMessages: (sessionId) =>
        this.client.projectSessions.listQueuedMessages({ sessionId }, { signal: this.signal }),
      dequeuePendingMessages: (sessionId) =>
        this.appControlOperationStore.run(() =>
          this.client.projectSessions.clearQueue({ sessionId }, { signal: this.signal }),
        ),
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
        if (resolved && count === sessionIds.length)
          await this.forgetResolvedProjectSessions(sessionIds);
        return count;
      },
      setCakeChatSessionsResolved: async (sessionIds, resolved) => {
        const count = await this.cakeChatCollectionStore.resolveSessions(sessionIds, resolved);
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
      splitView: (source, direction) => {
        const axis = direction === "right" ? "x" : "y";
        if (source.kind === "cake-chat") {
          const pane = this.cakeChatCollectionStore.sessionLayoutStore.paneForSession(
            source.sessionId,
          );
          if (!pane) return undefined;
          this.focusCakeChatPane(pane.paneId);
          const split = this.splitFocusedCakeChat(axis);
          return split ? { kind: source.kind, ...split } : undefined;
        }
        const pane = this.sessionLayoutStore.paneForSession(source.sessionId);
        if (!pane) return undefined;
        this.focusSessionPane(pane.paneId);
        const split = this.splitFocusedSession(axis);
        return split ? { kind: source.kind, ...split } : undefined;
      },
      showNotification: (input) => this.notificationStore.enqueue(input),
      showAgentAction: ({ source, message, targetSessionId, targetKind, coalesceKey }) => {
        const action =
          targetSessionId && targetKind
            ? {
                label: "View",
                run: async () => {
                  if (targetKind === "cake-chat") await this.openCakeChat(targetSessionId);
                  else await this.openSession(targetSessionId);
                },
              }
            : undefined;
        this.toastStore.show({
          title: `Agent action · ${source.title}`,
          message,
          action,
          coalesceKey: `agent:${source.sessionId}:${coalesceKey}`,
        });
      },
    });
    this.effect(() => {
      untracked(() => void this.cakeChatCollectionStore.initialize());
    });
  }

  private async respondCakeChatControl(request: CakeChatControlRequest) {
    const result = await this.appControl
      .invoke(request.invocation, this.cakeChatControlSource(request.sessionId))
      .catch((error) => ({
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
        this.cakeChatCollectionStore.reportError(
          error,
          `Cake Chat control response: ${request.invocation.name}`,
        );
    }
  }
}
