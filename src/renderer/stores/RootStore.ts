import { Store, child, createStore, untracked } from "r-state-tree";
import type { CakeHotkeyActionId } from "../../domain/application/cake-settings-data";
import { decodeArtifactLineageId } from "../../domain/artifacts/artifact-lineage";
import type { Client } from "../client/Client";
import { ClientContext } from "./context/ClientContext";
import { ActiveProjectSessionContext } from "./context/ActiveProjectSessionContext";
import type { SessionHistoryEntry } from "./AppShellStore";
import { SessionRegistryStore } from "./SessionRegistryStore";
import { ProjectWorkbenchStore } from "./ProjectWorkbenchStore";
import { SidebarStore } from "./SidebarStore";
import { SessionMetadataStore } from "./SessionMetadataStore";
import { ReviewsStore } from "./ReviewsStore";
import { SettingsStore } from "./SettingsStore";
import { ExtensionUiStore } from "./ExtensionUiStore";
import { FullscreenSurfaceStore } from "./FullscreenSurfaceStore";
import type { AgentControlSource } from "../app-control/AppControlBridge";
import { createRootApplicationControlHost } from "../app-control/RootApplicationControlHost";
import { createSessionPluginOperationAdapter } from "../app-control/SessionPluginOperationAdapter";
import { CakeChatCollectionStore } from "./CakeChatCollectionStore";
import { AppShellStore } from "./AppShellStore";
import { InlineWidgetStore } from "./InlineWidgetStore";
import { SessionPluginStore } from "./SessionPluginStore";
import { SessionCatalogStore } from "./SessionCatalogStore";
import { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import { ApplicationControlStore } from "./ApplicationControlStore";
import { ProjectCatalogStore } from "./ProjectCatalogStore";
import { ProjectSettingsStore } from "./ProjectSettingsStore";
import { NotificationStore } from "./NotificationStore";
import { ToastStore } from "./ToastStore";
import { TerminalStore, type TerminalTarget } from "./TerminalStore";
import { WorkingDirectoryRetirementStore } from "./WorkingDirectoryRetirementStore";
import { SessionLayoutStore, type SessionSplitAxis } from "./SessionLayoutStore";
import { SessionCoordinationStore } from "./SessionCoordinationStore";
import { resolveDraftUpdate } from "../../utils/resolve-draft-update";
import type { RootProjection } from "../models/RootProjection";
import { formatHotkey } from "../lib/hotkeys";
import { UiHintModeStore } from "./UiHintModeStore";
import { ArtifactLibraryStore } from "./ArtifactLibraryStore";
import { ArtifactReferencePreviewStore } from "./ArtifactReferencePreviewStore";
import { DrawControlStore } from "./DrawControlStore";
import { ProjectSessionPlacementStore } from "./ProjectSessionPlacementStore";
import { SessionRetirementStore } from "./SessionRetirementStore";
import { ProjectRemovalStore } from "./ProjectRemovalStore";

export class RootStore extends Store<{
  client: Client;
  projection: RootProjection;
  flushWindowState(): Promise<void>;
}> {
  @child
  get drawControlStore(): DrawControlStore {
    return createStore(DrawControlStore, {
      sessions: () => this.sessionRegistry.sessions,
      findSession: (sessionId) => this.sessionRegistry.findSession(sessionId),
      isResolved: (sessionId) => this.sessionCatalogStore.find(sessionId)?.resolved === true,
      activeSessionId: () => this.projectWorkbenchStore.activeSessionId,
      openActiveDraw: () => this.projectWorkbenchStore.presentationStore.openDraw(),
    });
  }

  get projectCatalogModel() {
    return this.props.projection.projects;
  }
  get sessionCatalogModel() {
    return this.props.projection.sessionCatalog;
  }
  get cakeChatCatalogModel() {
    return this.props.projection.cakeChatCatalog;
  }

  [ClientContext.provide]() {
    return this.client;
  }

  [ActiveProjectSessionContext.provide]() {
    const context = this.projectWorkbenchStore.sessionContext();
    return context
      ? { sessionId: context.sessionId, workingDirectory: context.workspacePath }
      : undefined;
  }

  @child
  get artifactLibraryStore(): ArtifactLibraryStore {
    return createStore(ArtifactLibraryStore, {
      model: this.props.projection.artifacts,
      artifactsChanged: (lineageId) => {
        for (const session of this.sessionRegistry.sessions)
          session.sessionArtifactsStore.receive(lineageId);
      },
      clearReferenceOperationError: (lineageId) =>
        this.artifactReferencePreviewStore.clearOperationError(lineageId),
    });
  }

  @child
  get artifactReferencePreviewStore(): ArtifactReferencePreviewStore {
    return createStore(ArtifactReferencePreviewStore, {
      model: this.props.projection.artifacts,
      artifactsChanged: (lineageId) => {
        for (const session of this.sessionRegistry.sessions)
          session.sessionArtifactsStore.receive(lineageId);
      },
    });
  }

  @child
  get inlineWidgetStore(): InlineWidgetStore {
    return createStore(InlineWidgetStore);
  }

  @child
  get sessionPluginStore(): SessionPluginStore {
    return createStore(SessionPluginStore);
  }

  @child
  get fullscreenSurfaceStore(): FullscreenSurfaceStore {
    return createStore(FullscreenSurfaceStore, {
      setOpen: (surfaceId, open) => this.client.electron.setFullscreenSurfaceOpen(surfaceId, open),
    });
  }

  @child
  get uiHintModeStore(): UiHintModeStore {
    return createStore(UiHintModeStore);
  }

  get client() {
    return this.props.client;
  }

  private worktreeOperation(workspacePath: string) {
    const operation = this.props.projection.worktreeOperations.find(workspacePath);
    if (!operation) return undefined;
    return {
      operationId: operation.operationId,
      workspacePath: operation.workspacePath,
      sessionId: operation.sessionId,
      kind: operation.kind,
      phase: operation.phase,
      strategy: operation.strategy,
      allowDirtyTarget: operation.allowDirtyTarget,
      resolveAfterLanding: operation.resolveAfterLanding,
      pauseReason: operation.pauseReason,
      error: operation.error,
    };
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
    else this.sessionRegistry.observationRetention.retain(sessionId);
  }

  private async prepareProjectSessionChat(sessionId: string) {
    this.retainProjectSessionObservation(sessionId);
    const session = this.sessionRegistry.findSession(sessionId);
    if (!session || !(await session.conversationSessionStore.prepareForCommand()))
      throw new Error("Cake could not open that session");
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
    const message = session.conversationSessionStore.chatStore.parts.find(
      (part) =>
        part.id === messageId ||
        (part.kind === "text" && part.entryId !== undefined && part.entryId === messageId),
    );
    if (!message) return false;
    session.conversationSessionStore.chatStore.transcriptInteraction.navigateToMessage(message.id);
    return true;
  }

  private selectProjectSessionForShell(sessionId: string) {
    if (this.sessionCatalogStore.find(sessionId)?.resolved)
      this.appShellStore.previewResolvedProjectSession(sessionId);
    else this.appShellStore.selectProjectSession(sessionId);
  }

  initialize() {
    this.applicationControlStore.start();
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
    await this.projectWorkbenchStore.startNewSession(workspacePath);
    const sessionId = this.projectWorkbenchStore.activeSession?.sessionId;
    if (sessionId) this.selectProjectSessionForShell(sessionId);
  }

  private projectControlSource(sessionId: string): AgentControlSource {
    const summary = this.sessionCatalogStore.find(sessionId);
    const loaded = this.sessionRegistry.findSession(sessionId);
    const workingDirectory = summary?.workingDirectory ?? loaded?.workspacePath;
    const projectPath =
      summary?.projectPath ??
      (workingDirectory
        ? (this.sessionCatalogStore.projectOfManagedWorktree(workingDirectory) ?? workingDirectory)
        : undefined);
    return {
      kind: "project-session",
      sessionId,
      title: summary?.title ?? "Agent session",
      projectName: summary?.projectName ?? "Unknown project",
      workingDirectory: workingDirectory ?? "Unknown working directory",
      ...(projectPath ? { projectPath } : null),
    };
  }

  async startOneOffChat() {
    this.showEmptyWorkbench();
    await this.projectWorkbenchStore.projectOpenStore.startOneOffChat();
  }

  async chooseProject() {
    this.showEmptyWorkbench();
    await this.projectWorkbenchStore.projectOpenStore.chooseProject();
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

  focusSessionPaneNumber(number: number) {
    if (this.appShellStore.selection.kind === "cake-chat") {
      const pane = this.cakeChatCollectionStore.sessionLayoutStore.panes[number - 1];
      if (pane) this.focusCakeChatPane(pane.paneId);
      return;
    }
    const pane = this.sessionLayoutStore.panes[number - 1];
    if (pane) this.focusSessionPane(pane.paneId);
  }

  handleHotkey(action: CakeHotkeyActionId) {
    if (action !== "show-ui-hints") this.uiHintModeStore.close();
    const selection = this.appShellStore.selection;
    const projectSelected = selection.kind === "project-session";
    const projectResolved =
      projectSelected && this.sessionCatalogStore.find(selection.sessionId)?.resolved === true;
    const chat =
      selection.kind === "cake-chat"
        ? selection.sessionId
          ? this.cakeChatCollectionStore.registry.find(selection.sessionId)
              ?.conversationSessionStore.chatStore
          : undefined
        : projectSelected
          ? this.projectWorkbenchStore.activeSession?.conversationSessionStore.chatStore
          : undefined;
    switch (action) {
      case "toggle-agent-editor":
        if (projectSelected && !projectResolved)
          void this.projectWorkbenchStore.presentationStore.toggleIde();
        break;
      case "open-editor":
        if (projectSelected && !projectResolved)
          void this.projectWorkbenchStore.presentationStore.openIde();
        break;
      case "open-changes":
        if (projectSelected && !projectResolved)
          void this.projectWorkbenchStore.presentationStore.openWorkspaceChanges();
        break;
      case "toggle-terminal":
        if (!projectResolved) void this.terminalStore.toggle();
        break;
      case "new-terminal-tab":
        if (!projectResolved && this.terminalStore.open) void this.terminalStore.newTab();
        break;
      case "toggle-sidebar":
        this.sidebarStore.toggle();
        break;
      case "toggle-session-tree":
        if (projectSelected && !projectResolved)
          this.projectWorkbenchStore.commandPaneStore.toggle("tree");
        break;
      case "split-right":
      case "split-down": {
        const axis = action === "split-right" ? "x" : "y";
        if (selection.kind === "cake-chat") this.splitFocusedCakeChat(axis);
        else if (projectSelected) this.splitFocusedSession(axis);
        break;
      }
      case "focus-left":
        this.focusAdjacentSessionPane("left");
        break;
      case "focus-right":
        this.focusAdjacentSessionPane("right");
        break;
      case "focus-above":
        this.focusAdjacentSessionPane("above");
        break;
      case "focus-below":
        this.focusAdjacentSessionPane("below");
        break;
      case "focus-pane-1":
      case "focus-pane-2":
      case "focus-pane-3":
      case "focus-pane-4":
        this.focusSessionPaneNumber(Number(action.at(-1)));
        break;
      case "history-back":
        this.navigateBack();
        break;
      case "history-forward":
        this.navigateForward();
        break;
      case "show-ui-hints":
        this.uiHintModeStore.toggle();
        break;
      case "toggle-work-logs":
        chat?.workLogPresentation.cycleExpansion();
        break;
      case "cycle-work-log-view":
        chat?.workLogPresentation.cycleViewMode();
        break;
      case "open-hovered-message":
        break;
      case "open-settings":
        this.showSettings();
        break;
    }
  }

  splitFocusedSession(axis: SessionSplitAxis) {
    const source = this.projectWorkbenchStore.activeSession;
    if (!source || !this.sessionLayoutStore.canSplit) return;
    const sessionId = crypto.randomUUID();
    const session = this.sessionRegistry.pendingSessions.prepareStaged(
      source.workspacePath,
      sessionId,
    );
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
      if (this.sessionRegistry.pendingSessions.isStaged(sessionId))
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
    this.projectWorkbenchStore.presentationStore.restore();
  }
  returnToWorkbench() {
    const active = this.appShellStore.activeConversation;
    if (active?.kind === "cake-chat") {
      this.appShellStore.selectCakeChat(active.sessionId);
      return;
    }
    this.showWorkbench();
    this.projectWorkbenchStore.activeSession?.conversationSessionStore.composerStore.draftStore.requestFocus();
  }
  dismissTopSecondarySurface() {
    if (this.projectWorkbenchStore.commandPaneStore.navigationPrompt) {
      this.projectWorkbenchStore.commandPaneStore.cancelNavigation();
      return;
    }
    if (this.projectWorkbenchStore.sessionContinuationStore.prompt) {
      this.projectWorkbenchStore.sessionContinuationStore.cancelPrompt();
      return;
    }
    if (this.projectWorkbenchStore.presentationStore.embeddedEditorStore.visible) {
      this.projectWorkbenchStore.presentationStore.backToAgent();
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

  showArtifactLibrary(sessionId?: string, lineageId?: string) {
    this.projectWorkbenchStore.dismissSecondarySurfaces();
    this.artifactLibraryStore.open(sessionId);
    this.appShellStore.showArtifactLibrary();
    if (lineageId)
      void this.artifactLibraryStore.detailStore.select(decodeArtifactLineageId(lineageId));
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

  private showEmptyWorkbench() {
    this.projectWorkbenchStore.dismissSecondarySurfaces();
    this.appShellStore.showWorkbench();
  }

  @child
  get projectSessionPlacementStore(): ProjectSessionPlacementStore {
    return createStore(ProjectSessionPlacementStore, {
      registry: this.sessionRegistry,
      layout: this.sessionLayoutStore,
      requireWorkingDirectory: (sessionId) => this.requireProjectSessionWorkingDirectory(sessionId),
      dismissSecondarySurfaces: () => this.projectWorkbenchStore.dismissSecondarySurfaces(),
      selectSession: (sessionId) => this.selectProjectSessionForShell(sessionId),
      showLoadedSession: (sessionId) => this.projectWorkbenchStore.showLoadedSession(sessionId),
    });
  }

  @child
  get sessionRetirementStore(): SessionRetirementStore {
    return createStore(SessionRetirementStore, {
      shell: this.appShellStore,
      catalog: this.sessionCatalogStore,
      registry: this.sessionRegistry,
      layout: this.sessionLayoutStore,
      projectSessions: this.projectWorkbenchStore.sessionManagementStore,
      cakeChats: this.cakeChatCollectionStore,
      navigate: (target) => this.navigateToHistoryEntry(target),
      createProjectSession: (projectPath) => this.createSession(projectPath),
      showCakeChat: () => this.showCakeChat(),
    });
  }

  @child
  get projectRemovalStore(): ProjectRemovalStore {
    return createStore(ProjectRemovalStore, {
      catalog: this.sessionCatalogStore,
      registry: this.sessionRegistry,
      shell: this.appShellStore,
      clearOpenProject: (path) => this.projectWorkbenchStore.projectOpenStore.clear(path),
      focusedProjectPath: () => this.sidebarStore.focusedProjectPath,
      leaveProjectFocus: () => this.sidebarStore.leaveProjectFocus(),
      navigate: (target) => this.navigateToHistoryEntry(target),
      showEmptyWorkbench: () => this.showEmptyWorkbench(),
      reportError: (error) => this.projectWorkbenchStore.setError(error),
    });
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
        this.props.projection.projectConversation(sessionId, workingDirectory),
      discussionCatalog: (sessionId) => this.props.projection.discussionCatalog(sessionId),
      subagentCatalog: (sessionId) => this.props.projection.subagentCatalog(sessionId),
      scheduledMessageCatalog: (sessionId) =>
        this.props.projection.scheduledMessageCatalog(sessionId),
      artifactModel: this.props.projection.artifacts,
      canSubmit: (sessionId) => this.projectWorkbenchStore.canSubmitSession(sessionId),
      isActive: (sessionId) =>
        this.appShellStore.selection.kind === "project-session" &&
        this.appShellStore.selection.sessionId === sessionId,
      isVisible: (sessionId) => this.sessionLayoutStore.hasSession(sessionId),
      worktreeOperation: (workspacePath) => this.worktreeOperation(workspacePath),
      openCommandPane: (pane) => this.projectWorkbenchStore.commandPaneStore.open(pane),
      persistNow: () => this.props.flushWindowState(),
      projectName: (workspacePath) => this.projectCatalogStore.nameForPath(workspacePath),
      renameSession: (sessionId, name) =>
        this.projectWorkbenchStore.sessionManagementStore.renameSession(sessionId, name),
      toolCompactSession: (entryId, prompt) =>
        this.projectWorkbenchStore.sessionContinuationStore.toolCompactAt(entryId, prompt),
      modelPresets: () => this.settingsStore.modelPresets.presets,
      assistantTools: () => this.applicationControlStore.sessionAssistantTools(),
      openModelPresetSettings: () => this.showModelPresetSettings(),
      newSessionConfiguration: (sessionId) =>
        this.projectWorkbenchStore.sessionCreationStore.request(sessionId)?.configuration,
      startNewSession: (sessionId, input) =>
        this.projectWorkbenchStore.sessionCreationStore.start(sessionId, input),
      ensureSessionActive: (sessionId) => {
        if (!this.sessionCatalogStore.find(sessionId)?.resolved) return true;
        return this.projectWorkbenchStore.sessionManagementStore.resolveSession(sessionId, false);
      },
      configureDraftActivation: (sessionId, choice) =>
        this.projectWorkbenchStore.sessionCreationStore.configureDraftActivation(sessionId, choice),
      sessionCreationChoice: (sessionId) =>
        this.projectWorkbenchStore.sessionCreationStore.choice(sessionId),
      draftActivationCandidates: (sessionId) =>
        this.projectWorkbenchStore.sessionCreationStore.candidates(sessionId),
      onWorktreeLanded: (_record, result) => {
        this.toastStore.show(
          result.resolved
            ? {
                tone: "info",
                title: "Session merged and resolved",
                message: "This session was merged into the project and resolved.",
              }
            : {
                tone: "info",
                title: "Worktree merged",
                message: "Your work was merged back into the project.",
              },
        );
      },
      onWorktreeDiscarded: () => undefined,
      retirement: this.workingDirectoryRetirementStore,
      onResolveWorktree: (workspacePath, options) =>
        this.projectWorkbenchStore.resolveWorktreeWorkspace(workspacePath, options),
      settings: () => this.settingsStore.appearance,
    });
  }

  private activeTerminalTarget(): TerminalTarget | undefined {
    const selection = this.appShellStore.selection;
    if (selection.kind !== "project-session") return undefined;
    const summary = this.sessionCatalogStore.find(selection.sessionId);
    if (summary?.resolved) return undefined;
    const workingDirectory = this.projectSessionWorkingDirectory(selection.sessionId);
    if (!workingDirectory) return undefined;
    const projectName =
      summary?.projectName || this.projectCatalogStore.nameForPath(workingDirectory);
    const worktreeName =
      summary && "worktreeName" in summary
        ? summary.worktreeName
        : this.sessionCatalogStore
            .managedWorktree(workingDirectory)
            ?.branch.replace(/^agent\//, "");
    return {
      workingDirectory,
      label: worktreeName ? `${projectName} · ${worktreeName}` : projectName,
    };
  }

  @child
  get terminalStore(): TerminalStore {
    return createStore(TerminalStore, {
      activeTarget: () => this.activeTerminalTarget(),
      retirement: () => this.workingDirectoryRetirementStore,
      toggleAcceleratorHint: () =>
        formatHotkey(this.settingsStore.hotkeys.bindingFor("toggle-terminal")),
      newTabHotkey: () => this.settingsStore.hotkeys.bindingFor("new-terminal-tab"),
    });
  }

  @child
  get workingDirectoryRetirementStore(): WorkingDirectoryRetirementStore {
    return createStore(WorkingDirectoryRetirementStore, {
      onRetired: (workingDirectories) =>
        this.terminalStore.releaseWorkingDirectories(workingDirectories),
    });
  }

  @child
  get toastStore(): ToastStore {
    return createStore(ToastStore, {});
  }

  @child
  get notificationStore(): NotificationStore {
    return createStore(NotificationStore, {
      onToast: (toast) => this.toastStore.show(toast),
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
      worktrees: this.props.projection.worktrees,
      pendingSessions: () => this.sessionRegistry.pendingSessions.summaries,
    });
  }

  @child
  get projectCatalogStore(): ProjectCatalogStore {
    return createStore(ProjectCatalogStore, {
      model: this.projectCatalogModel,
      sessions: this.sessionCatalogStore,
    });
  }

  @child
  get projectSettingsStore(): ProjectSettingsStore {
    return createStore(ProjectSettingsStore, {
      projects: this.projectCatalogStore,
    });
  }

  /** Project Session targets currently eligible for Model observation. */
  get projectSessionObservationTargets() {
    const blockedPath = this.projectWorkbenchStore.projectOpenStore.pendingAuthorizationPath;
    return this.sessionRegistry.observationRetention.sessions
      .filter((session) => session.workspacePath !== blockedPath)
      .map((session) => ({
        sessionId: session.sessionId,
        workingDirectory: session.workspacePath,
      }));
  }

  /** Staged Project Sessions whose Discussion catalog is observed before they have a transcript. */
  get stagedProjectSessionTargets() {
    return this.sessionRegistry.targets
      .filter((target) => this.sessionRegistry.pendingSessions.isTemporary(target.sessionId))
      .map((target) => ({ sessionId: target.sessionId, workingDirectory: target.workspacePath }));
  }

  @child
  get sessionOperationCoordinator(): SessionOperationCoordinatorStore {
    return createStore(SessionOperationCoordinatorStore);
  }

  @child
  get sessionCoordinationStore(): SessionCoordinationStore {
    return createStore(SessionCoordinationStore, {
      sessionById: (sessionId) => this.sessionRegistry.findSession(sessionId)?.model,
    });
  }

  @child
  get sessionMetadataStore(): SessionMetadataStore {
    return createStore(SessionMetadataStore, {
      projects: this.projectCatalogStore,
      catalog: this.sessionCatalogStore,
      sessions: this.sessionRegistry,
      worktreeOperations: this.props.projection.worktreeOperations,
      globalLabels: () => this.settingsStore.globalLabels.labels,
    });
  }

  @child
  get sidebarStore(): SidebarStore {
    return createStore(SidebarStore, {
      projects: this.projectCatalogStore,
      catalog: this.sessionCatalogStore,
      sessions: this.sessionRegistry,
      sessionMetadata: this.sessionMetadataStore,
      worktreeOperations: this.props.projection.worktreeOperations,
      cakeChat: () => this.cakeChatCollectionStore,
      selectedConversation: () => {
        const selection = this.appShellStore.selection;
        if (selection.kind === "project-session") return selection;
        return selection.kind === "cake-chat" && selection.sessionId
          ? { kind: "cake-chat", sessionId: selection.sessionId }
          : undefined;
      },
      setSessionResolved: async (sessionId, resolved) => {
        await this.sessionRetirementStore.setProjectSessionResolved(sessionId, resolved);
      },
      setSessionLabels: async (sessionId, labelIds) => {
        await this.projectWorkbenchStore.sessionManagementStore.setSessionLabels(
          sessionId,
          labelIds,
        );
      },
      setCakeChatSessionResolved: (sessionId, resolved) =>
        this.sessionRetirementStore.setCakeChatResolved(sessionId, resolved),
      deleteSession: (sessionId) => this.sessionRetirementStore.deleteProjectSession(sessionId),
      deleteCakeChatSession: (sessionId) => this.sessionRetirementStore.deleteCakeChat(sessionId),
      setSessionUnread: (sessionId, unread) =>
        this.projectWorkbenchStore.sessionManagementStore.setSessionUnread(sessionId, unread),
      embeddedEditorSettings: this.settingsStore.embeddedEditor,
    });
  }

  @child
  get reviewsStore(): ReviewsStore {
    return createStore(ReviewsStore, {
      sessionRegistry: this.sessionRegistry,
      discussionSessionModel: (sessionId, workingDirectory) =>
        this.props.projection.discussionConversation(sessionId, workingDirectory),
      operations: this.sessionOperationCoordinator,
      modelPresets: () => this.settingsStore.modelPresets.presets,
      openModelPresetSettings: () => this.showModelPresetSettings(),
      settings: () => this.settingsStore.appearance,
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
          ? this.cakeChatCollectionStore.registry.find(active.sessionId)
          : undefined;
      },
      workbenchError: () =>
        this.projectWorkbenchStore.error ?? this.projectWorkbenchStore.projectOpenStore.error,
    });
  }

  @child
  get extensionUiStore(): ExtensionUiStore {
    return createStore(ExtensionUiStore, {
      activeSessionModel: () => this.projectWorkbenchStore.activeSession?.model,
      sessionContext: () => this.projectWorkbenchStore.sessionContext(),
      setDraft: (value) => {
        const session = this.projectWorkbenchStore.activeSession;
        if (session)
          session.conversationSessionStore.composerStore.draftStore.setText(
            resolveDraftUpdate(
              value,
              session.conversationSessionStore.composerStore.draftStore.text,
            ),
          );
      },
      requestComposerFocus: () =>
        this.projectWorkbenchStore.activeSession?.conversationSessionStore.composerStore.draftStore.requestFocus(),
    });
  }

  @child
  get projectWorkbenchStore(): ProjectWorkbenchStore {
    return createStore(ProjectWorkbenchStore, {
      retirement: this.workingDirectoryRetirementStore,
      sessionRegistry: this.sessionRegistry,
      operations: this.sessionOperationCoordinator,
      projects: this.projectCatalogStore,
      globalLabels: () => this.settingsStore.globalLabels.labels,
      defaultConfiguration: () => this.settingsStore.modelPresets.defaultConfiguration,
      reviews: () => this.reviewsStore,
      extensionUi: () => this.extensionUiStore,
      catalog: this.sessionCatalogStore,
      startCakeChat: (prompt) => this.startCakeChat(prompt),
      onWorktreeSessionsResolved: (sessionIds, projectPath) =>
        this.sessionRetirementStore.forgetProjectSessions(sessionIds, projectPath),
      openSessionById: async (sessionId) => {
        await this.openSession(sessionId);
      },
      activeSessionId: () => {
        const active = this.appShellStore.activeConversation;
        return active?.kind === "project-session" ? active.sessionId : undefined;
      },
      restoreStagedSession: (projectPath) => {
        const sessionId = this.sessionLayoutStore.focusedSessionHistory.findLast((candidateId) => {
          if (!this.sessionRegistry.pendingSessions.isStaged(candidateId)) return false;
          const session = this.sessionRegistry.findSession(candidateId);
          if (!session) return false;
          const candidateProjectPath =
            this.sessionCatalogStore.projectOfManagedWorktree(session.workspacePath) ??
            session.workspacePath;
          return candidateProjectPath === projectPath;
        });
        if (!sessionId) return undefined;
        return this.sessionLayoutStore.restoreFocusedHistorySession(sessionId)
          ? sessionId
          : undefined;
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
      sessionModel: (sessionId) => this.props.projection.cakeChatConversation(sessionId),
      controlsModel: (sessionId) => this.props.projection.controlsForCakeChat(sessionId),
      tools: () => this.applicationControlStore.tools(),
      modelPresets: () => this.settingsStore.modelPresets.presets,
      defaultConfiguration: () => this.settingsStore.modelPresets.defaultConfiguration,
      openModelPresetSettings: () => this.showModelPresetSettings(),
      settings: () => this.settingsStore.appearance,
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

  @child
  get applicationControlStore(): ApplicationControlStore {
    return createStore(ApplicationControlStore, {
      client: this.client,
      host: createRootApplicationControlHost({
        client: this.client,
        signal: this.signal,
        flushWindowState: this.props.flushWindowState,
        appShellStore: this.appShellStore,
        applicationControlStore: () => this.applicationControlStore,
        cakeChatCollectionStore: this.cakeChatCollectionStore,
        notificationStore: this.notificationStore,
        projectCatalogStore: this.projectCatalogStore,
        projectWorkbenchStore: this.projectWorkbenchStore,
        sessionCatalogStore: this.sessionCatalogStore,
        sessionCoordinationStore: this.sessionCoordinationStore,
        sessionLayoutStore: this.sessionLayoutStore,
        sessionRegistry: this.sessionRegistry,
        settingsStore: this.settingsStore,
        sessionActivity: (sessionId) => this.sessionMetadataStore.sessionActivity(sessionId),
        toastStore: this.toastStore,
        projectSessionWorkingDirectory: (sessionId) =>
          this.projectSessionWorkingDirectory(sessionId),
        requireProjectSessionWorkingDirectory: (sessionId) =>
          this.requireProjectSessionWorkingDirectory(sessionId),
        prepareProjectSessionChat: (sessionId) => this.prepareProjectSessionChat(sessionId),
        openSession: (sessionId, messageId) => this.openSession(sessionId, messageId),
        openCakeChat: (sessionId) => this.openCakeChat(sessionId),
        sessionCreationStore: this.projectWorkbenchStore.sessionCreationStore,
        sessionRetirementStore: this.sessionRetirementStore,
        focusCakeChatPane: (paneId) => this.focusCakeChatPane(paneId),
        focusSessionPane: (paneId) => this.focusSessionPane(paneId),
        splitFocusedCakeChat: (axis) => this.splitFocusedCakeChat(axis),
        splitFocusedSession: (axis) => this.splitFocusedSession(axis),
      }),
      operations: this.sessionOperationCoordinator,
      cakeChatRequests: () =>
        this.cakeChatCollectionStore.registry.sessions.flatMap(
          (session) => session.props.controls.requests,
        ),
      projectContext: (sessionId) => {
        const catalogSession = this.sessionCatalogStore.find(sessionId);
        const loadedSession = this.sessionRegistry.findSession(sessionId);
        const sourceWorkingDirectory =
          catalogSession?.workingDirectory ?? loadedSession?.workspacePath;
        return {
          source: this.projectControlSource(sessionId),
          projectPath:
            catalogSession?.projectPath ??
            (sourceWorkingDirectory
              ? (this.sessionCatalogStore.projectOfManagedWorktree(sourceWorkingDirectory) ??
                sourceWorkingDirectory)
              : undefined),
        };
      },
      forkProjectSession: (sourceSessionId, invocation) =>
        this.projectSessionPlacementStore.fork(sourceSessionId, invocation),
      openProjectChildSession: (parentSessionId, invocation) =>
        this.projectSessionPlacementStore.openChild(parentSessionId, invocation),
      reportProjectError: (error, context) => this.projectWorkbenchStore.setError(error, context),
      reportCakeChatError: (error, context) =>
        this.cakeChatCollectionStore.reportError(error, context),
    });
  }

  get sessionPluginOperations() {
    return createSessionPluginOperationAdapter({
      client: this.client,
      signal: this.signal,
      plugins: this.sessionPluginStore,
      workingDirectory: (sessionId) => this.requireProjectSessionWorkingDirectory(sessionId),
      prepareChat: (sessionId) => this.prepareProjectSessionChat(sessionId),
    });
  }

  constructor(props: RootStore["props"]) {
    super(props);
    this.effect(() => {
      untracked(() => void this.cakeChatCollectionStore.initialize());
    });
  }
}
