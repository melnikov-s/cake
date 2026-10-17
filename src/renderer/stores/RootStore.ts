import { DictationStore } from "./DictationStore";
import { ScreenCaptureAttachmentStore } from "./ScreenCaptureAttachmentStore";
import { WidgetViewAttachmentContext } from "./context/WidgetViewAttachmentContext";
import { microphone, type Microphone } from "../dictation/microphone";
import { createSpeechPlayback, type SpeechPlayback } from "../speech/playback";
import { ConversationModeStore, ConversationModeContext } from "./ConversationModeStore";
import { SpeechInputSettingsStore } from "./SpeechInputSettingsStore";
import { SpeechSettingsStore } from "./SpeechSettingsStore";
import type { DesktopConnectionStore } from "./DesktopConnectionStore";
import { Store, child, createStore, untracked } from "r-state-tree";
import { createApplicationCommandRegistry } from "../commands/application-commands";
import { NavigationStore } from "./NavigationStore";
import type { Client } from "../client/Client";
import { ClientContext } from "./context/ClientContext";
import { SessionMetadataContext } from "./context/SessionMetadataContext";
import { SessionRegistryContext } from "./context/SessionRegistryContext";
import { ToastContext } from "./context/ToastContext";
import { ProjectCatalogContext } from "./context/ProjectCatalogContext";
import { TerminalTopInsetContext } from "./context/TerminalTopInsetContext";
import { DeliveryAvailabilityContext } from "./context/DeliveryAvailabilityContext";
import { ActiveProjectSessionContext } from "./context/ActiveProjectSessionContext";
import { SessionRegistryStore } from "./SessionRegistryStore";
import { ProjectWorkbenchStore } from "./ProjectWorkbenchStore";
import { SessionManagementStore } from "./SessionManagementStore";
import { ProjectSessionCreationStore } from "./ProjectSessionCreationStore";
import { SessionManagementContext } from "./context/SessionManagementContext";
import { ProjectPendingSessionsContext } from "./context/ProjectPendingSessionsContext";
import { ProjectSessionCreationContext } from "./context/ProjectSessionCreationContext";
import { SessionRetirementContext } from "./context/SessionRetirementContext";
import { ProjectSessionNavigationContext } from "./context/ProjectSessionNavigationContext";
import { SessionPresentationContext } from "./context/SessionPresentationContext";
import { CommandPaneContext } from "./context/CommandPaneContext";
import { SessionContinuationContext } from "./context/SessionContinuationContext";
import { ProjectOpenContext } from "./context/ProjectOpenContext";
import { SidebarStore } from "./SidebarStore";
import { SessionMetadataStore } from "./SessionMetadataStore";
import { ConversationActivityStore } from "./ConversationActivityStore";
import { ReviewsStore } from "./ReviewsStore";
import { SettingsStore } from "./SettingsStore";
import { ExtensionUiStore } from "./ExtensionUiStore";
import { FullscreenSurfaceStore } from "./FullscreenSurfaceStore";
import type { AgentControlSource } from "../app-control/app-control-data";
import { createRootApplicationControlHost } from "../app-control/RootApplicationControlHost";
import { createSessionPluginOperationAdapter } from "../app-control/SessionPluginOperationAdapter";
import { CakeChatCollectionStore } from "./CakeChatCollectionStore";
import { AppShellStore } from "./AppShellStore";
import { InlineWidgetStore } from "./InlineWidgetStore";
import { InlineArtifactPreviewStore } from "./InlineArtifactPreviewStore";
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
import { SessionLayoutStore } from "./SessionLayoutStore";
import { resolveDraftUpdate } from "../../utils/resolve-draft-update";
import type { RootProjection } from "../models/RootProjection";
import { formatHotkey } from "../lib/hotkeys";
import { UiHintModeStore } from "./UiHintModeStore";
import { ArtifactLibraryStore } from "./ArtifactLibraryStore";
import { ArtifactPaneStore } from "./ArtifactPaneStore";
import { ArtifactReferencePreviewStore } from "./ArtifactReferencePreviewStore";
import { ProjectSessionPlacementStore } from "./ProjectSessionPlacementStore";
import { SessionRetirementStore } from "./SessionRetirementStore";
import { ProjectRemovalStore } from "./ProjectRemovalStore";
import { NewSessionStore } from "./NewSessionStore";

export class RootStore extends Store<{
  client: Client;
  desktopConnection?: DesktopConnectionStore;
  projection: RootProjection;
  flushWindowState(): Promise<void>;
  canDeliver?(): boolean;
  browserHost: boolean;
  microphone?: Microphone;
  speechPlayback?: SpeechPlayback;
}> {
  // Typed Context.consume(), not dynamic symbol lookup, owns each provider's value contract.
  [key: symbol]: () => void;
  private readonly defaultSpeechPlayback = createSpeechPlayback();
  readonly commands = createApplicationCommandRegistry({
    shell: () => this.appShellStore,
    metadata: () => this.sessionMetadataStore,
    workbench: () => this.projectWorkbenchStore,
    cakeChat: () => this.cakeChatCollectionStore,
    navigation: () => this.navigationStore,
    newSession: () => this.newSessionStore,
    sidebar: () => this.sidebarStore,
    terminal: () => this.terminalStore,
    hints: () => this.uiHintModeStore,
  });

  @child
  get navigationStore(): NavigationStore {
    return createStore(NavigationStore, {
      shell: this.appShellStore,
      layout: this.sessionLayoutStore,
      registry: this.sessionRegistry,
      catalog: this.sessionCatalogStore,
      metadata: () => this.sessionMetadataStore,
      sidebar: () => this.sidebarStore,
      cakeChat: () => this.cakeChatCollectionStore,
      newSession: () => this.newSessionStore,
      settings: () => this.settingsStore,
      artifacts: () => this.artifactLibraryStore,
      artifactPane: () => this.artifactPaneStore,
    });
  }
  @child
  get screenCaptureStore(): ScreenCaptureAttachmentStore {
    return createStore(ScreenCaptureAttachmentStore, {
      client: this.client.electron,
      shell: this.appShellStore,
      projects: this.projectCatalogStore,
      catalog: this.sessionCatalogStore,
      registry: this.sessionRegistry,
      sidebar: () => this.sidebarStore,
      metadata: () => this.sessionMetadataStore,
      settings: () => this.settingsStore.appearance,
      cakeChat: () => this.cakeChatCollectionStore,
      cakeChatCatalog: this.cakeChatCatalogModel,
      navigation: () => this.navigationStore,
    });
  }

  get desktopConnection() {
    return this.props.desktopConnection;
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

  [WidgetViewAttachmentContext.provide]() {
    return this.screenCaptureStore;
  }

  [ClientContext.provide]() {
    return this.client;
  }

  [SessionMetadataContext.provide]() {
    return this.sessionMetadataStore;
  }

  [SessionRegistryContext.provide]() {
    return this.sessionRegistry;
  }

  [ProjectPendingSessionsContext.provide]() {
    return this.sessionRegistry.pendingSessions;
  }

  [SessionManagementContext.provide]() {
    return this.sessionManagementStore;
  }

  [ProjectSessionCreationContext.provide]() {
    return this.projectSessionCreationStore;
  }

  [SessionRetirementContext.provide]() {
    return this.sessionRetirementStore;
  }

  [ProjectSessionNavigationContext.provide]() {
    return this.projectWorkbenchStore;
  }

  [SessionPresentationContext.provide]() {
    return this.projectWorkbenchStore.presentationStore;
  }

  [CommandPaneContext.provide]() {
    return this.projectWorkbenchStore.commandPaneStore;
  }

  [SessionContinuationContext.provide]() {
    return this.projectWorkbenchStore.sessionContinuationStore;
  }

  [ProjectOpenContext.provide]() {
    return this.projectWorkbenchStore.projectOpenStore;
  }

  [ToastContext.provide]() {
    return this.toastStore;
  }

  [ProjectCatalogContext.provide]() {
    return this.projectCatalogStore;
  }

  [TerminalTopInsetContext.provide]() {
    return this.terminalStore.editorTopInset;
  }

  [DeliveryAvailabilityContext.provide]() {
    return () => this.props.canDeliver?.() ?? true;
  }

  [ActiveProjectSessionContext.provide]() {
    const context = this.projectWorkbenchStore.sessionContext();
    return context
      ? { sessionId: context.sessionId, workingDirectory: context.workspacePath }
      : undefined;
  }

  @child
  get artifactPaneStore(): ArtifactPaneStore {
    return createStore(ArtifactPaneStore, {
      model: this.props.projection.artifacts,
      currentSessionId: () => {
        const selection = this.appShellStore.selection;
        return selection.kind === "project-session" || selection.kind === "cake-chat"
          ? selection.sessionId
          : undefined;
      },
      artifactsChanged: () => this.props.projection.artifacts.invalidate(),
      clearReferenceOperationError: (lineageId) =>
        this.artifactReferencePreviewStore.clearOperationError(lineageId),
    });
  }

  @child
  get artifactLibraryStore(): ArtifactLibraryStore {
    return createStore(ArtifactLibraryStore, {
      model: this.props.projection.artifacts,
      artifactsChanged: () => this.props.projection.artifacts.invalidate(),
      clearReferenceOperationError: (lineageId) =>
        this.artifactReferencePreviewStore.clearOperationError(lineageId),
    });
  }

  @child
  get artifactReferencePreviewStore(): ArtifactReferencePreviewStore {
    return createStore(ArtifactReferencePreviewStore, {
      model: this.props.projection.artifacts,
      artifactsChanged: () => this.props.projection.artifacts.invalidate(),
    });
  }

  @child
  get inlineArtifactPreviewStore(): InlineArtifactPreviewStore {
    return createStore(InlineArtifactPreviewStore, {
      model: this.props.projection.artifacts,
      references: this.artifactReferencePreviewStore,
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
  get newSessionStore(): NewSessionStore {
    return createStore(NewSessionStore, {
      createCakeChat: () => {
        void this.navigationStore.startCakeChat();
      },
      createProjectSession: (path) => {
        void this.navigationStore.createSession(path);
      },
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
      resolvedSessionIds: operation.resolvedSessionIds,
      cleanupFailures: operation.cleanupFailures,
      pauseReason: operation.pauseReason,
      error: operation.error,
    };
  }

  private requireProjectSessionWorkingDirectory(sessionId: string) {
    const workingDirectory = this.sessionMetadataStore.workingDirectory(sessionId);
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

  openExternalUrl(url: string) {
    return this.client.electron.openExternalUrl(url, { signal: this.signal });
  }

  private projectControlSource(sessionId: string): AgentControlSource {
    const summary = this.sessionCatalogStore.find(sessionId);
    const workingDirectory = this.sessionMetadataStore.workingDirectory(sessionId);
    const projectPath =
      summary?.projectPath ??
      (workingDirectory ? this.sessionCatalogStore.projectPathFor(workingDirectory) : undefined);
    return {
      kind: "project-session",
      sessionId,
      title: summary?.title ?? "Agent session",
      projectName: summary?.projectName ?? "Unknown project",
      workingDirectory: workingDirectory ?? "Unknown working directory",
      ...(projectPath ? { projectPath } : null),
    };
  }

  showTranscriptSelectionContextMenu(input: { canChat: boolean; canAnnotate: boolean }) {
    return this.client.electron.showTranscriptSelectionContextMenu(input, { signal: this.signal });
  }

  @child
  get projectSessionPlacementStore(): ProjectSessionPlacementStore {
    return createStore(ProjectSessionPlacementStore, {
      layout: this.sessionLayoutStore,
      dismissSecondarySurfaces: () => this.projectWorkbenchStore.dismissSecondarySurfaces(),
      selectSession: (sessionId) => this.navigationStore.selectProjectSessionForShell(sessionId),
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
      navigate: (target) => this.navigationStore.navigateToHistoryEntry(target),
      createProjectSession: (projectPath) => this.navigationStore.createSession(projectPath),
    });
  }

  @child
  get projectRemovalStore(): ProjectRemovalStore {
    return createStore(ProjectRemovalStore, {
      cakeChat: () => this.cakeChatCollectionStore,
      catalog: this.sessionCatalogStore,
      registry: this.sessionRegistry,
      shell: this.appShellStore,
      focusedProjectPath: () => this.sidebarStore.focusedProjectPath,
      leaveProjectFocus: () => this.sidebarStore.leaveProjectFocus(),
      navigate: (target) => this.navigationStore.navigateToHistoryEntry(target),
      showEmptyWorkbench: () => this.navigationStore.showEmptyWorkbench(),
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
      savedDrafts: this.client.savedDrafts,
      operations: this.sessionOperationCoordinator,
      reviews: () => this.reviewsStore,
      sessionModel: (sessionId, workingDirectory) =>
        this.props.projection.projectConversation(sessionId, workingDirectory),
      discussionCatalog: (sessionId) => this.props.projection.discussionCatalog(sessionId),
      subagentCatalog: (sessionId) => this.props.projection.subagentCatalog(sessionId),
      workflowCatalog: (sessionId) => this.props.projection.workflowCatalog(sessionId),
      scheduledMessageCatalog: (sessionId) =>
        this.props.projection.scheduledMessageCatalog(sessionId),
      artifactModel: this.props.projection.artifacts,

      isActive: (sessionId) =>
        this.appShellStore.selection.kind === "project-session" &&
        this.appShellStore.selection.sessionId === sessionId,
      isVisible: (sessionId) => this.sessionLayoutStore.hasSession(sessionId),
      worktreeOperation: (workspacePath) => this.worktreeOperation(workspacePath),
      persistNow: () => this.props.flushWindowState(),
      modelPresets: () => this.settingsStore.modelPresets.presets,
      assistantTools: () => this.applicationControlStore.sessionAssistantTools(),
      openModelPresetSettings: () => this.navigationStore.showModelPresetSettings(),
      retirement: this.workingDirectoryRetirementStore,
      settings: () => this.settingsStore.appearance,
    });
  }

  get workspaceSession() {
    const active = this.appShellStore.activeConversation;
    return active?.kind === "cake-chat"
      ? this.cakeChatCollectionStore.registry.find(active.sessionId)
      : this.projectWorkbenchStore.activeSession;
  }

  get workspaceProjectPath() {
    const active = this.appShellStore.activeConversation;
    return active?.kind === "cake-chat"
      ? this.cakeChatCollectionStore.summaries.find((chat) => chat.sessionId === active.sessionId)
          ?.projectPath
      : this.projectWorkbenchStore.projectOpenStore.projectPath;
  }

  private activeTerminalTarget(): TerminalTarget | undefined {
    const selection = this.appShellStore.selection;
    if (selection.kind === "cake-chat") {
      const projectPath = this.workspaceProjectPath;
      return projectPath
        ? {
            workingDirectory: projectPath,
            label: this.projectCatalogStore.nameForPath(projectPath),
          }
        : undefined;
    }
    if (selection.kind !== "project-session") return undefined;
    const summary = this.sessionCatalogStore.find(selection.sessionId);
    if (this.sessionMetadataStore.isResolved(selection.sessionId)) return undefined;
    const workingDirectory = this.sessionMetadataStore.workingDirectory(selection.sessionId);
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
    return createStore(NotificationStore);
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
  get conversationActivityStore(): ConversationActivityStore {
    return createStore(ConversationActivityStore, {
      catalog: this.sessionCatalogStore,
      metadata: () => this.sessionMetadataStore,
      openSession: (sessionId) => this.navigationStore.openSessionLink(sessionId),
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
    return createStore(ProjectSettingsStore);
  }

  /** Project Session targets currently eligible for Model observation. */
  get projectSessionObservationTargets() {
    return this.sessionRegistry.observationRetention.sessions
      .filter((session) =>
        this.projectWorkbenchStore.canObserveWorkingDirectory(session.workspacePath),
      )
      .map((session) => ({
        sessionId: session.sessionId,
        workingDirectory: session.workspacePath,
        allowCreate: this.sessionRegistry.pendingSessions.canCreateRuntime(session.sessionId),
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
      catalog: this.sessionCatalogStore,
      cakeChat: () => this.cakeChatCollectionStore,
      selectedConversation: () => {
        const selection = this.appShellStore.selection;
        if (selection.kind === "project-session") return selection;
        return selection.kind === "cake-chat" && selection.sessionId
          ? { kind: "cake-chat", sessionId: selection.sessionId }
          : undefined;
      },
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
      openModelPresetSettings: () => this.navigationStore.showModelPresetSettings(),
      settings: () => this.settingsStore.appearance,
    });
  }

  [ConversationModeContext.provide]() {
    return this.props.browserHost ? undefined : this.conversationModeStore;
  }

  @child
  get speechSettingsStore(): SpeechSettingsStore {
    return createStore(SpeechSettingsStore, {
      client: this.client.speechOutput,
      copyText: (text) => navigator.clipboard.writeText(text),
    });
  }

  @child
  get speechInputSettingsStore(): SpeechInputSettingsStore {
    return createStore(SpeechInputSettingsStore);
  }

  @child
  get conversationModeStore(): ConversationModeStore {
    return createStore(ConversationModeStore, {
      preferences: this.speechInputSettingsStore,
      speech: this.client.speechOutput,
      recognition: this.client.dictation,
      postProcess: (input, options) => this.client.workspaces.postProcessDictation(input, options),
      textProcessingMode: () => this.dictationStore.textProcessingMode,
      microphone: this.props.microphone ?? microphone,
      playback: this.props.speechPlayback ?? this.defaultSpeechPlayback,
      settings: () => this.speechSettingsStore.settings,
      enabled: () => this.speechSettingsStore.enabled,
      onError: (message, details) =>
        this.toastStore.show({
          tone: "error",
          title: "Conversation mode unavailable",
          message,
          details,
          coalesceKey: "conversation-mode-error",
          action: {
            label: "Open Voice & Dictation settings",
            run: () => {
              this.settingsStore.selectPage("voice");
              this.navigationStore.showSettings();
            },
          },
        }),
      // Voice mode follows the window's focused conversation: a Project Session or Cake Chat.
      activeSessionId: () => this.appShellStore.activeConversation?.sessionId,
      deviceId: () => this.dictationStore.deviceId,
      suspendDictation: async () => this.dictationStore.pauseCapture(),
      canReleaseRecognition: () => !this.dictationStore.enabled,
    });
  }

  @child
  get dictationStore(): DictationStore {
    return createStore(DictationStore, {
      preferences: this.speechInputSettingsStore,
      client: this.client.dictation,
      postProcess: (input, options) => this.client.workspaces.postProcessDictation(input, options),
      microphone: this.props.microphone ?? microphone,
      beforeCapture: () => this.conversationModeStore.exit(),
      canReleaseRecognition: () =>
        this.conversationModeStore.phase !== "active" &&
        this.conversationModeStore.phase !== "preparing",
    });
  }

  @child
  get settingsStore(): SettingsStore {
    return createStore(SettingsStore, {
      dictation: this.dictationStore,
      experimentalFeatures: this.props.projection.experimentalFeatures,
      speech: this.speechSettingsStore,
      speechInput: this.speechInputSettingsStore,
      screenCapture: this.screenCaptureStore,
      desktopConnection: this.props.desktopConnection,
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
    });
  }

  @child
  get extensionUiStore(): ExtensionUiStore {
    return createStore(ExtensionUiStore, {
      experimentalFeatures: this.props.projection.experimentalFeatures,
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
  get sessionManagementStore(): SessionManagementStore {
    return createStore(SessionManagementStore, {
      operations: this.sessionOperationCoordinator,
      catalog: this.sessionCatalogStore,
      globalLabels: () => this.settingsStore.globalLabels.labels,
      reportError: (error) => this.projectWorkbenchStore.setError(error),
    });
  }

  @child
  get projectSessionCreationStore(): ProjectSessionCreationStore {
    return createStore(ProjectSessionCreationStore, {
      operations: this.sessionOperationCoordinator,
      catalog: this.sessionCatalogStore,
      defaultConfiguration: () => this.settingsStore.modelPresets.defaultConfiguration,
      reportError: (error) => this.projectWorkbenchStore.setError(error),
    });
  }

  @child
  get projectWorkbenchStore(): ProjectWorkbenchStore {
    return createStore(ProjectWorkbenchStore, {
      retirement: this.workingDirectoryRetirementStore,
      operations: this.sessionOperationCoordinator,
      reviews: () => this.reviewsStore,
      extensionUi: () => this.extensionUiStore,
      catalog: this.sessionCatalogStore,
      startCakeChat: (prompt) => this.navigationStore.startCakeChat(prompt),
      presentationSession: () => this.workspaceSession,
      presentationProjectPath: () => this.workspaceProjectPath,
      browserHost: this.props.browserHost,
      onBrowserUnavailable: () =>
        this.toastStore.show({
          title: "Browser Mode is desktop-only",
          message: "Open Cake desktop to use Browser Mode.",
          coalesceKey: "browser-mode-unavailable",
        }),
      onWorktreeSessionsResolved: (sessionIds, projectPath) =>
        this.sessionRetirementStore.forgetProjectSessions(sessionIds, projectPath),
      openSessionById: async (sessionId) => {
        await this.navigationStore.openSession(sessionId);
      },
      activeSessionId: () => {
        const active = this.appShellStore.activeConversation;
        return active?.kind === "project-session" ? active.sessionId : undefined;
      },
      restoreStagedSession: (projectPath) => this.navigationStore.restoreStagedSession(projectPath),
      selectSession: (sessionId) => this.navigationStore.selectProjectSession(sessionId),
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
      artifactModel: this.props.projection.artifacts,
      isSelected: () => this.appShellStore.selection.kind === "cake-chat",
      sessionModel: (sessionId) => this.props.projection.cakeChatConversation(sessionId),
      controlsModel: (sessionId) => this.props.projection.controlsForCakeChat(sessionId),
      subagentCatalog: (sessionId) => this.props.projection.subagentCatalog(sessionId),
      workflowCatalog: (sessionId) => this.props.projection.workflowCatalog(sessionId),
      discussionCatalog: (sessionId) => this.props.projection.discussionCatalog(sessionId),
      discussionSessionModel: (sessionId, workingDirectory, parentSessionId) =>
        this.props.projection.discussionConversation(sessionId, workingDirectory, parentSessionId),
      tools: () => this.applicationControlStore.tools(),
      modelPresets: () => this.settingsStore.modelPresets.presets,
      defaultConfiguration: () => this.settingsStore.modelPresets.defaultConfiguration,
      openModelPresetSettings: () => this.navigationStore.showModelPresetSettings(),
      settings: () => this.settingsStore.appearance,
    });
  }

  @child
  get appShellStore(): AppShellStore {
    return createStore(AppShellStore, {
      sessionInNavigationScope: (entry) => this.navigationStore.sessionInNavigationScope(entry),
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
        projectRemovalStore: this.projectRemovalStore,
        sessionManagementStore: this.sessionManagementStore,
        projectSessionCreationStore: this.projectSessionCreationStore,
        sessionCatalogStore: this.sessionCatalogStore,
        sessionLayoutStore: this.sessionLayoutStore,
        sessionRegistry: this.sessionRegistry,
        settingsStore: this.settingsStore,
        sessionMetadataStore: this.sessionMetadataStore,
        toastStore: this.toastStore,
        requireProjectSessionWorkingDirectory: (sessionId) =>
          this.requireProjectSessionWorkingDirectory(sessionId),
        prepareProjectSessionChat: (sessionId) => this.prepareProjectSessionChat(sessionId),
        navigationStore: this.navigationStore,
        sessionRetirementStore: this.sessionRetirementStore,
      }),
      operations: this.sessionOperationCoordinator,
      cakeChatRequests: () =>
        this.cakeChatCollectionStore.registry.sessions.flatMap(
          (session) => session.props.controls.requests,
        ),
      projectContext: (sessionId) => {
        const catalogSession = this.sessionCatalogStore.find(sessionId);
        const sourceWorkingDirectory = this.sessionMetadataStore.workingDirectory(sessionId);
        return {
          source: this.projectControlSource(sessionId),
          projectPath:
            catalogSession?.projectPath ??
            (sourceWorkingDirectory
              ? this.sessionCatalogStore.projectPathFor(sourceWorkingDirectory)
              : undefined),
        };
      },
      forkProjectSession: (sourceSessionId, invocation) =>
        this.projectSessionPlacementStore.fork(sourceSessionId, invocation),
      presentForkSession: (invocation) => this.projectSessionPlacementStore.presentFork(invocation),
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
