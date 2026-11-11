import { Store, child, createStore } from "r-state-tree";
import { subagentTitle } from "../lib/subagent-title";
import { ToastContext } from "./context/ToastContext";
import { describeError } from "../lib/error-details";
import { linkedMessageTarget } from "../lib/message-navigation";
import type { ConversationNavigationTarget } from "../lib/conversation-navigation-tree";
import { MessageReferencePreviewStore } from "./MessageReferencePreviewStore";
import { AttachmentReferencePreviewStore } from "./AttachmentReferencePreviewStore";
import {
  CAKE_CHAT_SESSION_ID,
  isCakeChatSessionId,
  isProjectChatSessionId,
  cakeChatSideChatConversationId,
} from "../../contracts/cake-chats/cake-chat-identity";
import { resolveSessionLinkReference } from "../../contracts/project-sessions/session-reference";
import {
  decodeArtifactLineageId,
  decodeArtifactRevisionNumber,
} from "../../contracts/artifacts/artifact-lineage";
import type { AppShellStore, SessionHistoryEntry } from "./AppShellStore";
import type { ArtifactLibraryStore } from "./ArtifactLibraryStore";
import type { ArtifactMenuStore } from "./ArtifactMenuStore";
import type { CakeChatCollectionStore } from "./CakeChatCollectionStore";
import type { NewSessionStore } from "./NewSessionStore";
import { ProjectSessionNavigationContext } from "./context/ProjectSessionNavigationContext";
import { SessionPresentationContext } from "./context/SessionPresentationContext";
import { CommandPaneContext } from "./context/CommandPaneContext";
import { SessionContinuationContext } from "./context/SessionContinuationContext";
import { ProjectOpenContext } from "./context/ProjectOpenContext";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { SessionLayoutStore } from "./SessionLayoutStore";
import type { DiscussionNavigationStore } from "./DiscussionNavigationStore";
import type { SessionMetadataStore } from "./SessionMetadataStore";
import type { SessionRegistryStore } from "./SessionRegistryStore";
import type { SettingsStore } from "./SettingsStore";
import type { SidebarStore } from "./SidebarStore";
import type { AutomationSessionsStore } from "./AutomationSessionsStore";
import type { AutomationsStore } from "./AutomationsStore";
import type {
  AutomationContext,
  AutomationId,
  AutomationRun,
} from "../../contracts/automations/automation-data";
import type { SessionChatConfiguration } from "../../contracts/conversations/conversation-data";

/** Window-local navigation policy. Selection, history and layout stay with their existing owners.
 * Async session opening retains the workbench's concurrency policy; this Store adds no persisted state.
 */
export class NavigationStore extends Store<{
  shell: AppShellStore;
  layout: SessionLayoutStore;
  discussionNavigation(): DiscussionNavigationStore;
  activeSecondaryTarget(): ConversationNavigationTarget | undefined;
  registry: SessionRegistryStore;
  catalog: SessionCatalogStore;
  metadata(): SessionMetadataStore;
  sidebar(): SidebarStore;
  cakeChat(): CakeChatCollectionStore;
  newSession(): NewSessionStore;
  settings(): SettingsStore;
  artifacts(): ArtifactLibraryStore;
  artifactMenu(): ArtifactMenuStore;
  automationSessions(): AutomationSessionsStore;
  automations(): AutomationsStore;
  defaultAutomationConfiguration?(): SessionChatConfiguration | undefined;
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
    const discussions = this.props.discussionNavigation();
    const discussionTarget = discussions.targetForSession(sessionId);
    if (discussionTarget || cakeChatSideChatConversationId(sessionId) !== undefined) {
      if (!discussionTarget) await discussions.openBySessionId(sessionId);
      else await this.openConversationTarget(discussionTarget);
      const chat = discussions.session(sessionId)?.chatStore;
      if (!chat) return false;
      if (!messageId) return true;
      const part = linkedMessageTarget(chat.parts, messageId);
      if (part) {
        chat.transcriptInteraction.navigateToMessage(part.id);
        return true;
      }
      return this.messageReferencePreview.open(sessionId, messageId);
    }
    if (this.props.automationSessions().hasSession(sessionId)) {
      if (!this.openAutomationSession(sessionId)) return false;
      if (!messageId) return true;
      const chat =
        this.props.automationSessions().selectedSession?.conversationSessionStore.chatStore;
      const part = chat && linkedMessageTarget(chat.parts, messageId);
      if (part && chat) {
        chat.transcriptInteraction.navigateToMessage(part.id);
        return true;
      }
      return this.messageReferencePreview.open(sessionId, messageId);
    }
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
    // Original entries hidden by a branch change or Tool Prune remain in Pi.
    // Inspect them without changing the branch or injecting old text into the conversation.
    if (!message) return this.messageReferencePreview.open(sessionId, messageId);
    session.conversationSessionStore.chatStore.transcriptInteraction.navigateToMessage(message.id);
    return true;
  }

  /** Select an existing public conversation destination using its authoritative owner facts. */
  async openConversationTarget(target: ConversationNavigationTarget): Promise<void> {
    const discussions = this.props.discussionNavigation();
    discussions.cancelOpening();
    if (
      target.kind === "side-chat" ||
      (target.kind === "subagent" && discussions.sessionIds.includes(target.sessionId))
    ) {
      await discussions.open(target);
      return;
    }
    if (target.kind === "subagent") {
      await this.openSubagentLink(target.sessionId, target.handleId);
      return;
    }
    const owner =
      this.props.cakeChat().registry.find(target.sessionId) ??
      this.props.registry.findSession(target.sessionId);
    if (owner?.conversationSessionStore.sideChatStore.target)
      owner.conversationSessionStore.sideChatStore.close();
    if (target.kind === "cake-chat") await this.openCakeChat(target.sessionId);
    else await this.openSession(target.sessionId);
  }

  showAutomations() {
    this.workbench.dismissSecondarySurfaces();
    this.props.shell.showAutomations();
  }

  async editAutomation(automationId: AutomationId) {
    this.showAutomations();
    await this.props.automations().select(automationId);
  }

  createAutomation(context: AutomationContext = { _tag: "Global" }) {
    this.props.automations().beginCreate({
      name: "New automation",
      context,
      trigger: {
        _tag: "Schedule",
        schedule: {
          _tag: "Interval",
          startsAt: new Date(Date.now() + 3600000).toISOString(),
          everySeconds: 86400,
        },
      },
      task: {
        prompt: "",
        configuration: this.props.defaultAutomationConfiguration?.() ?? {
          provider: "",
          modelId: "",
          thinkingLevel: "off",
          fastMode: false,
        },
        attachments: [],
      },
      overlap: "skip",
      completion: "keep-for-review",
    });
    this.showAutomations();
  }

  openAutomationSession(sessionId: string) {
    if (!this.props.automationSessions().openSession(sessionId)) return false;
    this.commitAutomationSelection();
    return true;
  }

  openAutomationRun(run: AutomationRun, title?: string) {
    this.props.automationSessions().openRun(run, title);
    this.commitAutomationSelection();
  }

  private commitAutomationSelection() {
    this.props.shell.selectWorkspace("automation-sessions");
    this.props.shell.recordCurrentConversationVisit();
    const session = this.props.automationSessions().selectedSession;
    if (
      session &&
      this.props
        .automationSessions()
        .catalog.unresolvedSessions.some(
          (item) => item.sessionId === session.sessionId && item.unread,
        )
    )
      void session.setUnread(false);
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
      ...this.props.discussionNavigation().sessionIds,
      ...this.props
        .automationSessions()
        .catalog.unresolvedSessions.map((session) => session.sessionId),
      ...this.props.automationSessions().identities.map((identity) => identity.sessionId),
    ]);
    if (!resolved.ok) throw new Error(resolved.error);
    const { sessionId } = resolved;
    const discussions = this.props.discussionNavigation();
    const discussionTarget = discussions.targetForSession(sessionId);
    if (discussionTarget && !attachmentId) {
      await this.openConversationTarget(discussionTarget);
      if (!messageId) return;
      const chat = discussions.session(sessionId)?.chatStore;
      const target = chat && linkedMessageTarget(chat.parts, messageId);
      if (!target) throw new Error("The linked message is unavailable in the side chat");
      chat.transcriptInteraction.navigateToMessage(target.id);
      return;
    }
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
    // Links select the conversation, not the standalone original-message reader.
    // Keep openSession's explicit inspection fallback separate from link navigation.
    // Reset retained presentation before opening so restore cannot reopen its browser/editor.
    const retained =
      this.props.cakeChat().registry.find(sessionId) ?? this.props.registry.findSession(sessionId);
    retained?.showPresentation("normal");
    if (!(await this.openSession(sessionId)))
      throw new Error("Cake could not open the linked session");
    const discussion = this.props.discussionNavigation().session(sessionId);
    if (discussion) {
      if (!messageId) return;
      const target = linkedMessageTarget(discussion.chatStore.parts, messageId);
      if (!target) throw new Error("The linked message is unavailable in the current conversation");
      discussion.chatStore.transcriptInteraction.navigateToMessage(target.id);
      return;
    }
    const session =
      this.props.cakeChat().registry.find(sessionId) ?? this.props.registry.findSession(sessionId);
    session?.showPresentation("normal");
    const conversation =
      session?.conversationSessionStore ??
      this.props.automationSessions().selectedSession?.conversationSessionStore;
    if (conversation?.sideChatStore.target) conversation.sideChatStore.close();
    if (!messageId) return;
    const chat = conversation?.chatStore;
    const target = chat && linkedMessageTarget(chat.parts, messageId);
    if (!target) throw new Error("The linked message is unavailable in the current conversation");
    chat.transcriptInteraction.navigateToMessage(target.id);
  }

  /** Inspect the public worker in its parent; never navigate to its private Pi session. */
  async openSubagentLink(parentReference: string, handleId: string, messageId?: string) {
    const resolved = resolveSessionLinkReference(parentReference, [
      ...this.props.catalog.sessions.map((session) => session.sessionId),
      ...this.props.cakeChat().summaries.map((session) => session.sessionId),
      ...this.props.discussionNavigation().sessionIds,
    ]);
    if (!resolved.ok) throw new Error(resolved.error);
    const parentSessionId = resolved.sessionId;
    const discussions = this.props.discussionNavigation();
    if (discussions.sessionIds.includes(parentSessionId)) {
      this.messageReferencePreview.close();
      this.attachmentReferencePreview.close();
      await discussions.open({ kind: "subagent", sessionId: parentSessionId, handleId });
      if (messageId) {
        const chat = discussions.subagents
          .find((workers) => workers.parentSessionId === parentSessionId)
          ?.chatStore(handleId);
        const target = chat && linkedMessageTarget(chat.parts, messageId);
        if (!target)
          throw new Error(
            "The linked message is unavailable in the retained subagent conversation",
          );
        chat?.transcriptInteraction.navigateToMessage(target.id);
      }
      return;
    }
    // Header inspection in the already focused owner must retain Browser/VS Code mode.
    if (this.props.shell.activeConversation?.sessionId !== parentSessionId)
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
      navigationTarget: { kind: "subagent", sessionId: parentSessionId, handleId },
      title: subagentTitle(run),
      currentTitle: () => subagentTitle(subagents.run(handleId) ?? run),
      eyebrow: () => `Subagent · ${subagents.run(handleId)?.status ?? run.status}`,
      model: () => subagents.model(handleId),
      chatStore,
    });
  }

  /** Explicit global home intent; generic workspace/history switches retain inspection. */
  async openGlobalChat() {
    this.props.discussionNavigation().cancelOpening();
    const home = this.props.cakeChat().registry.load(CAKE_CHAT_SESSION_ID);
    if (home.conversationSessionStore.sideChatStore.target)
      home.conversationSessionStore.sideChatStore.close();
    home.showPresentation("normal");
    return this.openCakeChat(CAKE_CHAT_SESSION_ID);
  }

  /** Explicit project home intent; does not reset the conversation or its runtime. */
  async openProjectChat(projectPath: string) {
    try {
      this.props.discussionNavigation().cancelOpening();
      const collection = this.props.cakeChat();
      const chat = collection.projectChat(projectPath);
      if (!chat)
        throw new Error(
          "Project Chat is unavailable in the current catalog. Retry after the project list has loaded.",
        );
      const home = collection.registry.load(chat.sessionId);
      if (home.conversationSessionStore.sideChatStore.target)
        home.conversationSessionStore.sideChatStore.close();
      home.showPresentation("normal");
      if ((await this.openCakeChat(chat.sessionId)) === false) return false;
      return true;
    } catch (error) {
      this.reportChatOpenError(error, "Could not open Project Chat", () =>
        this.openProjectChat(projectPath),
      );
      return false;
    }
  }

  private reportChatOpenError(error: unknown, title: string, retry: () => Promise<boolean | void>) {
    if (this.signal.aborted) return;
    const described = describeError(error);
    ToastContext.consume(this)?.show({
      tone: "error",
      title,
      message: described.message,
      details: described.details,
      autoDismiss: false,
      coalesceKey: "chat-open",
      action: {
        label: "Retry",
        run: async () => {
          await retry();
        },
      },
    });
  }

  /** Direct conversation home, independent of visit history and Session Family ancestry. */
  get sessionChatHome(): { projectPath: string | undefined; sourceSessionId?: string } | undefined {
    const active = this.props.shell.activeConversation;
    if (!active || this.props.shell.applicationSurface) return undefined;
    const secondary = this.props.activeSecondaryTarget();
    if (secondary?.kind === "subagent")
      return {
        projectPath:
          this.props.catalog.find(secondary.sessionId)?.projectPath ??
          this.props.cakeChat().summaries.find((chat) => chat.sessionId === secondary.sessionId)
            ?.projectPath,
        sourceSessionId: secondary.sessionId,
      };
    if (active.kind === "cake-chat") return undefined;
    if (active.kind === "automation-session") {
      const context = this.props.automationSessions().selectedSession?.identity.context;
      return context
        ? { projectPath: context._tag === "Project" ? context.projectPath : undefined }
        : undefined;
    }
    const session = this.props.catalog.find(active.sessionId);
    const loaded = this.props.registry.findSession(active.sessionId);
    return {
      projectPath:
        session?.projectPath ??
        (loaded ? this.props.catalog.projectPathFor(loaded.workspacePath) : undefined),
    };
  }

  async returnToChatHome() {
    const home = this.sessionChatHome;
    if (!home) return;
    if (home.sourceSessionId && (await this.openImmediateOwner(home.sourceSessionId))) return;
    if (home.projectPath) await this.openProjectChat(home.projectPath);
    else await this.openSessionLink(CAKE_CHAT_SESSION_ID);
  }

  /** One ownership edge per invocation; never substitute a project home for a missing parent. */
  async goUpOneLevel(): Promise<boolean> {
    const active = this.props.shell.activeConversation;
    if (!active) return false;
    const secondary = this.props.activeSecondaryTarget();
    if (secondary?.kind === "side-chat") return this.openImmediateOwner(secondary.parentSessionId);
    // A public worker target names its owner, not its private Pi session.
    if (secondary?.kind === "subagent") return this.openImmediateOwner(secondary.sessionId);
    if (active.kind === "cake-chat") {
      // Global Cake Chat is the root. The app-wide companion has no declared parent.
      if (!isProjectChatSessionId(active.sessionId)) return false;
      return this.openImmediateOwner(CAKE_CHAT_SESSION_ID);
    }
    if (active.kind === "automation-session") {
      const session = this.props.automationSessions().selectedSession;
      if (session?.sessionId !== active.sessionId) return false;
      const context = session.identity.context;
      return context._tag === "Project"
        ? this.openProjectChat(context.projectPath)
        : this.openImmediateOwner(CAKE_CHAT_SESSION_ID);
    }
    const session = this.props.catalog.find(active.sessionId);
    if (!session) return false;
    const parentId = session.familyParentSessionId;
    // Family roots explicitly name themselves as parent in the catalog.
    if (parentId && parentId !== active.sessionId) return this.openImmediateOwner(parentId);
    return this.openProjectChat(session.projectPath);
  }

  private async openImmediateOwner(sessionId: string): Promise<boolean> {
    const discussion = this.props.discussionNavigation().targetForSession(sessionId);
    if (discussion) {
      await this.openConversationTarget(discussion);
      return true;
    }
    if (!isCakeChatSessionId(sessionId) && !this.props.catalog.find(sessionId)) return false;
    // Select header, transcript and composer together, closing any retained secondary target.
    // Session links reuse the existing normal-chat navigation without resetting drafts/history.
    await this.openSessionLink(sessionId);
    return true;
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

  navigateBack() {
    // Traverse focused conversation visits; covered surfaces use window-wide history.
    const sessionId =
      this.props.shell.workspace === "project-sessions" &&
      !this.props.shell.applicationSurface &&
      this.props.layout.goBack();
    if (sessionId) {
      this.props.shell.prepareProjectSessionTraversal(sessionId, -1);
      void this.openSession(sessionId);
    } else void this.navigateToHistoryEntry(this.props.shell.goBack());
  }

  navigateForward() {
    const sessionId =
      this.props.shell.workspace === "project-sessions" &&
      !this.props.shell.applicationSurface &&
      this.props.layout.goForward();
    if (sessionId) {
      this.props.shell.prepareProjectSessionTraversal(sessionId, 1);
      void this.openSession(sessionId);
    } else void this.navigateToHistoryEntry(this.props.shell.goForward());
  }

  navigateActiveSession(direction: "next" | "previous") {
    const sidebar = this.props.sidebar();
    const target = sidebar.sessionListStore.adjacentActiveSession(direction);
    if (!target) return;
    if (target.kind === "cake-chat") void this.openCakeChat(target.sessionId);
    else void this.openSession(target.sessionId);
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
    this.props.shell.returnToConversation();
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
    if (this.props.artifactMenu().visible) {
      this.props.artifactMenu().close();
      return;
    }
    if (this.props.shell.surface === "artifact-library") {
      this.returnToWorkbench();
      return;
    }
    if (this.commands.tryClose()) return;
    const sessionId = this.props.layout.focusedSessionId;
    if (sessionId) {
      const panel =
        this.props.registry.findSession(sessionId)?.conversationSessionStore.sideChatStore;
      panel?.target?.changes?.close();
    }
  }

  /** Selects a Cake Chat or Project Chat in its conversation workspace. */
  selectCakeChat(sessionId: string) {
    this.props.cakeChat().layoutFor(sessionId).showSession(sessionId);
    this.commitCakeChatSelection(sessionId);
  }

  private commitCakeChatSelection(sessionId: string) {
    this.props.shell.selectWorkspace(
      isProjectChatSessionId(sessionId) ? "project-sessions" : "cake-chat",
    );
    this.props.shell.recordCurrentConversationVisit();
  }

  async openCakeChat(sessionId?: string) {
    try {
      if (!sessionId) return this.startCakeChat();
      this.workbench.dismissSecondarySurfaces();
      const projectChat = isProjectChatSessionId(sessionId);
      if (!projectChat) this.props.shell.selectWorkspace("cake-chat");
      const collection = this.props.cakeChat();
      const opening = collection.openSession(sessionId);
      this.commitCakeChatSelection(sessionId);
      this.presentation.restore();
      // Sidebar activation runs on mousedown. Restore input focus after the native
      // button default, not in the microtask that it can overwrite.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (
        this.props.shell.activeConversation?.sessionId === sessionId &&
        !this.props.shell.applicationSurface
      )
        collection.registry
          .find(sessionId)
          ?.conversationSessionStore.composerStore.draftStore.requestFocus();
      await opening;
    } catch (error) {
      this.reportChatOpenError(
        error,
        sessionId && isProjectChatSessionId(sessionId)
          ? "Could not open Project Chat"
          : "Could not open Cake Chat",
        () => this.openCakeChat(sessionId),
      );
      return false;
    }
  }

  async startCakeChat(prompt?: string) {
    this.workbench.dismissSecondarySurfaces();
    this.props.shell.selectWorkspace("cake-chat");
    await this.props.cakeChat().activate(prompt);
    this.commitCakeChatSelection(CAKE_CHAT_SESSION_ID);
    this.presentation.restore();
    this.props
      .cakeChat()
      .registry.find(CAKE_CHAT_SESSION_ID)
      ?.conversationSessionStore.composerStore.draftStore.requestFocus();
  }

  openArtifact(sessionId: string | undefined, lineageId: string, revision?: number) {
    this.commands.dismiss();
    const session = sessionId
      ? (this.props.registry.findSession(sessionId) ??
        this.props.cakeChat().registry.find(sessionId))
      : undefined;
    this.props
      .artifactMenu()
      .open(
        sessionId,
        decodeArtifactLineageId(lineageId),
        revision === undefined ? undefined : decodeArtifactRevisionNumber(revision),
        session?.conversationSessionStore.sideChatStore,
      );
  }

  showArtifactLibrary(sessionId?: string, lineageId?: string, revision?: number) {
    const active = this.props.shell.activeConversation;
    const targetSessionId =
      sessionId ?? (active?.kind === "automation-session" ? undefined : active?.sessionId);
    this.workbench.dismissSecondarySurfaces();
    const artifacts = this.props.artifacts();
    artifacts.open(targetSessionId);
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
