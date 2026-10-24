import { Store, child, createStore } from "r-state-tree";
import { linkedMessageTarget } from "../lib/message-navigation";
import { MessageReferencePreviewStore } from "./MessageReferencePreviewStore";
import { AttachmentReferencePreviewStore } from "./AttachmentReferencePreviewStore";
import { isCakeChatSessionId } from "../../contracts/cake-chats/cake-chat-identity";
import { resolveSessionLinkReference } from "../../contracts/project-sessions/session-reference";
import {
  decodeArtifactLineageId,
  decodeArtifactRevisionNumber,
} from "../../contracts/artifacts/artifact-lineage";
import type { AppShellStore, SessionHistoryEntry } from "./AppShellStore";
import type { ArtifactLibraryStore } from "./ArtifactLibraryStore";
import type { ArtifactPaneStore } from "./ArtifactPaneStore";
import type { CakeChatCollectionStore } from "./CakeChatCollectionStore";
import type { NewSessionStore } from "./NewSessionStore";
import { ProjectSessionNavigationContext } from "./context/ProjectSessionNavigationContext";
import { SessionPresentationContext } from "./context/SessionPresentationContext";
import { CommandPaneContext } from "./context/CommandPaneContext";
import { SessionContinuationContext } from "./context/SessionContinuationContext";
import { ProjectOpenContext } from "./context/ProjectOpenContext";
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
  sidebar(): SidebarStore;
  cakeChat(): CakeChatCollectionStore;
  newSession(): NewSessionStore;
  settings(): SettingsStore;
  artifacts(): ArtifactLibraryStore;
  artifactPane(): ArtifactPaneStore;
}> {
  private get workbench() {
    return ProjectSessionNavigationContext.consume(this)!;
  }

  private get presentation() {
    return SessionPresentationContext.consume(this)!;
  }

  private get commands() {
    return CommandPaneContext.consume(this)!;
  }

  @child
  get messageReferencePreview(): MessageReferencePreviewStore {
    return createStore(MessageReferencePreviewStore);
  }

  @child
  get attachmentReferencePreview(): AttachmentReferencePreviewStore {
    return createStore(AttachmentReferencePreviewStore);
  }

  async openSession(sessionId: string, messageId?: string) {
    this.messageReferencePreview.close();
    this.attachmentReferencePreview.close();
    if (isCakeChatSessionId(sessionId)) {
      await this.openCakeChat(sessionId);
      if (!messageId) return true;
      const chat = this.props.cakeChat().registry.find(sessionId)
        ?.conversationSessionStore.chatStore;
      const part = chat && linkedMessageTarget(chat.parts, messageId);
      if (part && chat) {
        chat.transcriptInteraction.navigateToMessage(part.id);
        return true;
      }
      return this.messageReferencePreview.open(sessionId, messageId);
    }
    const workbench = this.workbench;
    workbench.dismissSecondarySurfaces();
    const opened = await workbench.openSession(sessionId);
    if (opened === false || workbench.activeSessionId !== sessionId) return false;
    const session = this.props.registry.findSession(sessionId);
    if (!session) return false;
    if (!messageId) return true;
    const message = linkedMessageTarget(
      session.conversationSessionStore.chatStore.parts,
      messageId,
    );
    // Original entries hidden by a branch change or Tool Compact remain in Pi.
    // Inspect them without changing the branch or injecting old text into the conversation.
    if (!message) return this.messageReferencePreview.open(sessionId, messageId);
    session.conversationSessionStore.chatStore.transcriptInteraction.navigateToMessage(message.id);
    return true;
  }

  selectProjectSession(sessionId: string) {
    this.props.layout.showSession(sessionId);
    this.commitProjectSelection();
  }

  showLoadedProjectSession(sessionId: string) {
    this.props.layout.ensureSession(sessionId);
    this.workbench.showLoadedSession(sessionId);
    this.commitProjectSelection();
  }

  restoreStagedSession(projectPath: string) {
    const sessionId = this.props.layout.focusedSessionHistory.findLast((candidateId) => {
      if (!this.props.registry.pendingSessions.isStaged(candidateId)) return false;
      const session = this.props.registry.findSession(candidateId);
      if (!session) return false;
      const candidateProjectPath = this.props.catalog.projectPathFor(session.workspacePath);
      return candidateProjectPath === projectPath;
    });
    if (!sessionId) return undefined;
    return this.props.layout.restoreFocusedHistorySession(sessionId) ? sessionId : undefined;
  }

  private commitProjectSelection() {
    this.props.shell.selectWorkspace("project-sessions");
    this.props.shell.recordCurrentConversationVisit();
  }

  /** Opens either kind of Cake Session addressed by a Markdown session link.
   * Short references resolve against the same roster as agent session targeting. */
  async openSessionLink(reference: string, messageId?: string, attachmentId?: string) {
    const resolved = resolveSessionLinkReference(reference, [
      ...this.props.catalog.sessions.map((session) => session.sessionId),
      ...this.props.cakeChat().summaries.map((session) => session.sessionId),
    ]);
    if (!resolved.ok) throw new Error(resolved.error);
    const { sessionId } = resolved;
    if (attachmentId) {
      if (isCakeChatSessionId(sessionId)) await this.openCakeChat(sessionId);
      else if (!(await this.openSession(sessionId)))
        throw new Error("Cake could not open the linked session");
      this.messageReferencePreview.close();
      this.attachmentReferencePreview.close();
      if (!(await this.attachmentReferencePreview.open(sessionId, attachmentId)))
        throw new Error(
          this.attachmentReferencePreview.error ?? "Cake could not open the linked attachment",
        );
      return;
    }
    if (this.props.cakeChat().summaries.some((session) => session.sessionId === sessionId)) {
      if (messageId) {
        if (!(await this.openSession(sessionId, messageId)))
          throw new Error("Cake could not find the linked message");
      } else await this.openCakeChat(sessionId);
      return;
    }
    if (!(await this.openSession(sessionId, messageId)))
      throw new Error(
        messageId
          ? "Cake could not find the linked message"
          : "Cake could not open the linked session",
      );
  }

  /** Inspect the public worker in its parent; never navigate to its private Pi session. */
  async openSubagentLink(parentReference: string, handleId: string, messageId?: string) {
    const resolved = resolveSessionLinkReference(parentReference, [
      ...this.props.catalog.sessions.map((session) => session.sessionId),
      ...this.props.cakeChat().summaries.map((session) => session.sessionId),
    ]);
    if (!resolved.ok) throw new Error(resolved.error);
    const parentSessionId = resolved.sessionId;
    await this.openSessionLink(parentSessionId);
    const parent = isCakeChatSessionId(parentSessionId)
      ? this.props.cakeChat().registry.find(parentSessionId)
      : this.props.registry.findSession(parentSessionId);
    const subagents = parent?.subagentActivityStore;
    if (!parent || !subagents) throw new Error("Cake could not open the subagent's parent");
    await subagents.ready();
    const run = subagents.run(handleId);
    const chatStore = subagents.chatStore(handleId);
    if (!run)
      throw new Error(
        "The linked subagent conversation is unavailable: no retained handle-to-Pi mapping was found. Cake cannot safely infer a private session from a parent report.",
      );
    if (messageId) {
      const target = chatStore && linkedMessageTarget(chatStore.parts, messageId);
      if (!target)
        throw new Error("The linked message is unavailable in the retained subagent conversation");
      chatStore.transcriptInteraction.navigateToMessage(target.id);
    }
    if (!chatStore) {
      parent.conversationSessionStore.chatStore.transcriptInteraction.navigateToMessage(
        run.anchorPartId,
      );
      return;
    }
    parent.conversationSessionStore.sideChatStore.open({
      key: `subagent:${handleId}`,
      title: run.task,
      eyebrow: () => `Subagent · ${subagents.run(handleId)?.status ?? run.status}`,
      chatStore,
    });
  }

  async createSession(workspacePath: string) {
    this.props.newSession().rememberProject(workspacePath);
    await this.workbench.startNewSession(workspacePath);
    const sessionId = this.workbench.activeSessionId;
    if (sessionId && this.props.registry.findSession(sessionId))
      this.selectProjectSession(sessionId);
  }

  async startOneOffChat() {
    this.showEmptyWorkbench();
    await ProjectOpenContext.consume(this)!.startOneOffChat();
  }

  async chooseProject() {
    this.showEmptyWorkbench();
    await ProjectOpenContext.consume(this)!.chooseProject();
  }

  sessionInNavigationScope(entry: SessionHistoryEntry) {
    const projectPath = this.props.sidebar().focusModeProjectPath;
    if (projectPath === undefined) return true;
    if (entry.kind === "cake-chat")
      return (
        this.props.cakeChat().summaries.find((chat) => chat.sessionId === entry.sessionId)
          ?.projectPath === projectPath
      );
    if (entry.kind !== "project-session") return false;
    const summary = this.props.catalog.find(entry.sessionId);
    const workingDirectory = this.props.metadata().workingDirectory(entry.sessionId);
    const entryProjectPath =
      summary?.projectPath ??
      (workingDirectory ? this.props.catalog.projectPathFor(workingDirectory) : undefined);
    return entryProjectPath === projectPath;
  }

  navigateBack() {
    // Project focus uses scoped visit history rather than unfiltered pane history.
    const sessionId =
      !this.props.sidebar().focusModeProjectPath &&
      this.props.shell.surface === "workbench" &&
      this.props.layout.goBack();
    if (sessionId) {
      this.props.shell.prepareProjectSessionTraversal(sessionId, -1);
      void this.openSession(sessionId);
    } else void this.navigateToHistoryEntry(this.props.shell.goBack());
  }

  navigateForward() {
    const sessionId =
      !this.props.sidebar().focusModeProjectPath &&
      this.props.shell.surface === "workbench" &&
      this.props.layout.goForward();
    if (sessionId) {
      this.props.shell.prepareProjectSessionTraversal(sessionId, 1);
      void this.openSession(sessionId);
    } else void this.navigateToHistoryEntry(this.props.shell.goForward());
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
    const previousSessionId = this.workbench.activeSessionId;
    const sessionId = this.props.layout.focusPane(paneId);
    if (!sessionId || previousSessionId === sessionId) return;
    this.commitProjectSelection();
    this.workbench.showLoadedSession(sessionId);
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
    const source = this.workbench.activeSessionId
      ? this.props.registry.findSession(this.workbench.activeSessionId)
      : undefined;
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
    this.commitProjectSelection();
    this.workbench.showLoadedSession(sessionId);
    void session.stagedCommandStore.load(source.workspacePath);
    return { paneId, sessionId };
  }

  focusCakeChatPane(paneId: string) {
    const sessionId = this.props.cakeChat().focusPane(paneId);
    if (sessionId) this.commitCakeChatSelection();
  }

  closeCakeChatPane(paneId: string) {
    const result = this.props.cakeChat().closePane(paneId);
    if (result?.focusedSessionId) this.commitCakeChatSelection();
  }

  closeSessionPane(paneId: string) {
    const result = this.props.layout.closePane(paneId);
    if (!result) return;
    for (const sessionId of result.removedSessionIds) {
      if (this.props.registry.pendingSessions.isStaged(sessionId))
        this.props.registry.removeSession(sessionId);
    }
    if (result.focusedSessionId) {
      this.commitProjectSelection();
      this.workbench.showLoadedSession(result.focusedSessionId);
    }
  }

  async navigateToHistoryEntry(entry: SessionHistoryEntry | undefined) {
    if (!entry) return;
    if (entry.kind === "cake-chat") await this.openCakeChat(entry.sessionId);
    else await this.openSession(entry.sessionId);
  }

  showWorkbench() {
    const workbench = this.workbench;
    workbench.dismissSecondarySurfaces();
    this.props.shell.selectWorkspace(
      this.props.layout.focusedSessionId ? "project-sessions" : "home",
    );
    this.presentation.restore();
  }

  returnToWorkbench() {
    this.props.shell.dismissCoveringSurface();
    this.presentation.restore();
    if (this.props.shell.workspace === "project-sessions") this.workbench.requestComposerFocus();
  }

  dismissTopSecondarySurface() {
    if (this.attachmentReferencePreview.content) {
      this.attachmentReferencePreview.close();
      return;
    }
    if (this.messageReferencePreview.page) {
      this.messageReferencePreview.close();
      return;
    }
    if (this.props.newSession().open) {
      this.props.newSession().close();
      return;
    }
    if (this.commands.tryCancelNavigation()) return;
    if (SessionContinuationContext.consume(this)!.tryCancelPrompt()) return;
    if (this.props.artifactPane().sessionId) {
      this.props.artifactPane().close();
      return;
    }
    if (this.props.shell.surface === "artifact-library") {
      this.returnToWorkbench();
      return;
    }
    if (this.presentation.tryBackToAgent()) return;
    this.commands.tryClose();
  }

  /** Selects a Cake Chat or Project Chat in its conversation workspace. */
  selectCakeChat(sessionId: string) {
    this.props.cakeChat().sessionLayoutStore.showSession(sessionId);
    this.commitCakeChatSelection();
  }

  private commitCakeChatSelection() {
    this.props.shell.selectWorkspace("cake-chat");
    this.props.shell.recordCurrentConversationVisit();
  }

  async openCakeChat(sessionId?: string) {
    if (!sessionId) return this.startCakeChat();
    this.workbench.dismissSecondarySurfaces();
    this.props.shell.selectWorkspace("cake-chat");
    await this.props.cakeChat().openSession(sessionId);
    this.commitCakeChatSelection();
    this.presentation.restore();
  }

  async startCakeChat(prompt?: string) {
    this.workbench.dismissSecondarySurfaces();
    this.props.shell.selectWorkspace("cake-chat");
    await this.props.cakeChat().activate(prompt);
    this.commitCakeChatSelection();
    this.presentation.restore();
  }

  openArtifact(sessionId: string, lineageId: string, revision?: number) {
    this.commands.dismiss();
    this.props
      .artifactPane()
      .open(
        sessionId,
        decodeArtifactLineageId(lineageId),
        revision === undefined ? undefined : decodeArtifactRevisionNumber(revision),
      );
  }

  showArtifactLibrary(sessionId?: string, lineageId?: string, revision?: number) {
    this.workbench.dismissSecondarySurfaces();
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
    this.workbench.dismissSecondarySurfaces();
    this.props.shell.showSettings();
  }

  showModelPresetSettings() {
    const settings = this.props.settings();
    settings.selectPage("models");
    settings.modelPresets.requestSection();
    this.showSettings();
  }

  showEmptyWorkbench() {
    this.workbench.dismissSecondarySurfaces();
    this.props.shell.selectWorkspace("home");
  }
}
