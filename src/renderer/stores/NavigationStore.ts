import { Store } from "r-state-tree";
import {
  decodeArtifactLineageId,
  decodeArtifactRevisionNumber,
} from "../../services/storage/artifact-lineage";
import type { AppShellStore, SessionHistoryEntry } from "./AppShellStore";
import type { ArtifactLibraryStore } from "./ArtifactLibraryStore";
import type { CakeChatCollectionStore } from "./CakeChatCollectionStore";
import type { NewSessionStore } from "./NewSessionStore";
import type { ProjectWorkbenchStore } from "./ProjectWorkbenchStore";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { SessionLayoutStore, SessionSplitAxis } from "./SessionLayoutStore";
import type { SessionMetadataStore } from "./SessionMetadataStore";
import type { SessionRegistryStore } from "./SessionRegistryStore";
import type { SettingsStore } from "./SettingsStore";
import type { SidebarStore } from "./SidebarStore";

/** Window-local navigation policy. Selection, history and layout stay with their existing owners.
 * Async session opening retains the workbench's concurrency policy; this Store adds no persisted state.
 */
export class NavigationStore extends Store<{
  shell: AppShellStore;
  layout: SessionLayoutStore;
  registry: SessionRegistryStore;
  catalog: SessionCatalogStore;
  metadata(): SessionMetadataStore;
  workbench(): ProjectWorkbenchStore;
  sidebar(): SidebarStore;
  cakeChat(): CakeChatCollectionStore;
  newSession(): NewSessionStore;
  settings(): SettingsStore;
  artifacts(): ArtifactLibraryStore;
}> {
  async openSession(sessionId: string, messageId?: string) {
    if (!this.props.metadata().workingDirectory(sessionId))
      throw new Error("Cake could not find that session");
    const workbench = this.props.workbench();
    workbench.dismissSecondarySurfaces();
    this.props.layout.focusSession(sessionId);
    const opened = await workbench.openSession(sessionId);
    if (opened === false || workbench.activeSession?.sessionId !== sessionId) return false;
    if (!messageId) return true;
    const session = this.props.registry.findSession(sessionId);
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

  selectProjectSession(sessionId: string) {
    this.props.layout.showSession(sessionId);
    this.selectProjectSessionForShell(sessionId);
  }

  showLoadedProjectSession(sessionId: string) {
    this.props.layout.ensureSession(sessionId);
    this.props.workbench().showLoadedSession(sessionId);
    this.selectProjectSessionForShell(sessionId);
  }

  restoreStagedSession(projectPath: string) {
    const sessionId = this.props.layout.focusedSessionHistory.findLast((candidateId) => {
      if (!this.props.registry.pendingSessions.isStaged(candidateId)) return false;
      const session = this.props.registry.findSession(candidateId);
      if (!session) return false;
      const candidateProjectPath =
        this.props.catalog.projectOfManagedWorktree(session.workspacePath) ?? session.workspacePath;
      return candidateProjectPath === projectPath;
    });
    if (!sessionId) return undefined;
    return this.props.layout.restoreFocusedHistorySession(sessionId) ? sessionId : undefined;
  }

  selectProjectSessionForShell(sessionId: string) {
    if (this.props.metadata().isResolved(sessionId))
      this.props.shell.previewResolvedProjectSession(sessionId);
    else this.props.shell.selectProjectSession(sessionId);
  }

  /** Opens either kind of Cake Session addressed by a Markdown session link. */
  async openSessionLink(sessionId: string) {
    if (this.props.metadata().exists(sessionId)) {
      await this.openSession(sessionId);
      return;
    }
    if (this.props.cakeChat().summaries.some((session) => session.sessionId === sessionId)) {
      await this.openCakeChat(sessionId);
      return;
    }
    throw new Error("Cake could not find the linked session");
  }

  async createSession(workspacePath: string) {
    this.props.newSession().rememberProject(workspacePath);
    const workbench = this.props.workbench();
    await workbench.startNewSession(workspacePath);
    const sessionId = workbench.activeSession?.sessionId;
    if (sessionId) this.selectProjectSessionForShell(sessionId);
  }

  async startOneOffChat() {
    this.showEmptyWorkbench();
    await this.props.workbench().projectOpenStore.startOneOffChat();
  }

  async chooseProject() {
    this.showEmptyWorkbench();
    await this.props.workbench().projectOpenStore.chooseProject();
  }

  sessionInNavigationScope(entry: SessionHistoryEntry) {
    const projectPath = this.props.sidebar().focusModeProjectPath;
    if (projectPath === undefined) return true;
    if (entry.kind !== "project-session") return false;
    const summary = this.props.catalog.find(entry.sessionId);
    const workingDirectory = this.props.metadata().workingDirectory(entry.sessionId);
    const entryProjectPath =
      summary?.projectPath ??
      (workingDirectory
        ? (this.props.catalog.projectOfManagedWorktree(workingDirectory) ?? workingDirectory)
        : undefined);
    return entryProjectPath === projectPath;
  }

  navigateBack() {
    // Project focus uses scoped visit history rather than unfiltered pane history.
    const sessionId =
      !this.props.sidebar().focusModeProjectPath &&
      this.props.shell.surface === "workbench" &&
      this.props.layout.goBack();
    if (sessionId) void this.openSession(sessionId);
    else void this.navigateToHistoryEntry(this.props.shell.goBack());
  }

  navigateForward() {
    const sessionId =
      !this.props.sidebar().focusModeProjectPath &&
      this.props.shell.surface === "workbench" &&
      this.props.layout.goForward();
    if (sessionId) void this.openSession(sessionId);
    else void this.navigateToHistoryEntry(this.props.shell.goForward());
  }

  navigateActiveSession(direction: "next" | "previous") {
    const sidebar = this.props.sidebar();
    const target = sidebar.sessionListStore.adjacentActiveSession(
      direction,
      sidebar.focusModeProjectPath,
    );
    if (!target) return;
    if (target.kind === "cake-chat") void this.openCakeChat(target.sessionId);
    else void this.openSession(target.sessionId);
  }

  focusSessionPane(paneId: string) {
    const sessionId = this.props.layout.focusPane(paneId);
    if (!sessionId || this.props.workbench().activeSessionId === sessionId) return;
    this.selectProjectSessionForShell(sessionId);
    this.props.workbench().showLoadedSession(sessionId);
  }

  focusAdjacentSessionPane(direction: "left" | "right" | "above" | "below") {
    const cakeChatSelected = this.props.shell.selection.kind === "cake-chat";
    const layout = cakeChatSelected ? this.props.cakeChat().sessionLayoutStore : this.props.layout;
    const sessionId = layout.focusedSessionId;
    const target = sessionId ? layout.neighbors(sessionId)[direction][0] : undefined;
    if (!target) return;
    if (cakeChatSelected) this.focusCakeChatPane(target.paneId);
    else this.focusSessionPane(target.paneId);
  }

  focusSessionPaneNumber(number: number) {
    const cakeChatSelected = this.props.shell.selection.kind === "cake-chat";
    const layout = cakeChatSelected ? this.props.cakeChat().sessionLayoutStore : this.props.layout;
    const pane = layout.panes[number - 1];
    if (!pane) return;
    if (cakeChatSelected) this.focusCakeChatPane(pane.paneId);
    else this.focusSessionPane(pane.paneId);
  }

  splitFocusedSession(axis: SessionSplitAxis) {
    const source = this.props.workbench().activeSession;
    if (!source || !this.props.layout.canSplit) return;
    const sessionId = crypto.randomUUID();
    const session = this.props.registry.pendingSessions.prepareStaged(
      source.workspacePath,
      sessionId,
    );
    const paneId = this.props.layout.splitFocused(sessionId, axis);
    if (!paneId) {
      this.props.registry.removeSession(sessionId);
      return;
    }
    this.selectProjectSessionForShell(sessionId);
    this.props.workbench().showLoadedSession(sessionId);
    void session.stagedCommandStore.load(source.workspacePath);
    return { paneId, sessionId };
  }

  focusCakeChatPane(paneId: string) {
    const sessionId = this.props.cakeChat().focusPane(paneId);
    if (sessionId) this.props.shell.selectCakeChat(sessionId);
  }

  closeCakeChatPane(paneId: string) {
    const result = this.props.cakeChat().closePane(paneId);
    if (result?.focusedSessionId) this.props.shell.selectCakeChat(result.focusedSessionId);
  }

  closeSessionPane(paneId: string) {
    const result = this.props.layout.closePane(paneId);
    if (!result) return;
    for (const sessionId of result.removedSessionIds) {
      if (this.props.registry.pendingSessions.isStaged(sessionId))
        this.props.registry.removeSession(sessionId);
    }
    if (result.focusedSessionId) {
      this.selectProjectSessionForShell(result.focusedSessionId);
      this.props.workbench().showLoadedSession(result.focusedSessionId);
    }
  }

  async navigateToHistoryEntry(entry: SessionHistoryEntry | undefined) {
    if (!entry) return;
    if (entry.kind === "cake-chat") await this.openCakeChat(entry.sessionId);
    else await this.openSession(entry.sessionId);
  }

  showWorkbench() {
    const workbench = this.props.workbench();
    workbench.dismissSecondarySurfaces();
    const context = workbench.sessionContext();
    if (context) this.props.shell.selectProjectSession(context.sessionId);
    else this.props.shell.showWorkbench();
    workbench.presentationStore.restore();
  }

  returnToWorkbench() {
    const active = this.props.shell.activeConversation;
    if (active?.kind === "cake-chat") {
      this.props.shell.selectCakeChat(active.sessionId);
      return;
    }
    this.showWorkbench();
    this.props
      .workbench()
      .activeSession?.conversationSessionStore.composerStore.draftStore.requestFocus();
  }

  dismissTopSecondarySurface() {
    if (this.props.newSession().open) {
      this.props.newSession().close();
      return;
    }
    const workbench = this.props.workbench();
    if (workbench.commandPaneStore.navigationPrompt) {
      workbench.commandPaneStore.cancelNavigation();
      return;
    }
    if (workbench.sessionContinuationStore.prompt) {
      workbench.sessionContinuationStore.cancelPrompt();
      return;
    }
    if (workbench.presentationStore.embeddedEditorStore.visible) {
      workbench.presentationStore.backToAgent();
      return;
    }
    if (workbench.commandPaneStore.pane) workbench.commandPaneStore.close();
  }

  async openCakeChat(sessionId?: string) {
    if (!sessionId) return this.startCakeChat();
    this.props.workbench().dismissSecondarySurfaces();
    this.props.shell.selectCakeChat(sessionId);
    await this.props.cakeChat().openSession(sessionId);
  }

  async startCakeChat(prompt?: string) {
    this.props.workbench().dismissSecondarySurfaces();
    this.props.shell.selectCakeChat();
    await this.props.cakeChat().activate(prompt);
    this.props.shell.selectCakeChat(this.props.cakeChat().sessionId);
  }

  showArtifactLibrary(sessionId?: string, lineageId?: string, revision?: number) {
    this.props.workbench().dismissSecondarySurfaces();
    const artifacts = this.props.artifacts();
    artifacts.open(sessionId);
    this.props.shell.showArtifactLibrary();
    if (lineageId)
      void artifacts.detailStore.select(
        decodeArtifactLineageId(lineageId),
        revision === undefined ? undefined : decodeArtifactRevisionNumber(revision),
      );
  }

  showSettings() {
    this.props.workbench().dismissSecondarySurfaces();
    this.props.shell.showSettings();
  }

  showModelPresetSettings() {
    const settings = this.props.settings();
    settings.selectPage("models");
    settings.modelPresets.requestSection();
    this.showSettings();
  }

  showEmptyWorkbench() {
    this.props.workbench().dismissSecondarySurfaces();
    this.props.shell.showWorkbench();
  }
}
