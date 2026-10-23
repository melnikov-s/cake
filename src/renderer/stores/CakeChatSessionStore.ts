import type { Project } from "../models/Project";
import { parseScheduledMessage } from "../../utils/scheduled-message-time";
import { ProjectTodosStore } from "./ProjectTodosStore";
import { Store, child, createStore, snapshot } from "r-state-tree";
import type { ProjectSessionPresentationMode } from "../../contracts/project-sessions/project-session-presentation";
import { EditorSelectionsStore } from "./EditorSelectionsStore";
import { SessionPresentationContext } from "./context/SessionPresentationContext";
import type { Conversation } from "../models/Conversation";
import type { ModelPreset } from "../../contracts/conversations/session-contract";
import { ClientContext } from "./context/ClientContext";
import { ConversationHistoryStore } from "./ConversationHistoryStore";
import { ConversationSessionStore } from "./ConversationSessionStore";
import type { ComposerDeliveryInput } from "./ConversationComposerStore";
import type { AppearanceSettingsStore } from "./AppearanceSettingsStore";
import type { CakeChatPendingSessionsStore } from "./CakeChatPendingSessionsStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import type { CakeChatTarget } from "../../contracts/cake-chats/cake-chat-data";
import type { CakeChatControls } from "../models/CakeChatControls";
import type { WorkflowCatalog } from "../models/WorkflowCatalog";
import type { SubagentCatalog } from "../models/SubagentCatalog";
import type { ScheduledMessageCatalog } from "../models/ScheduledMessageCatalog";
import { SubagentActivityStore } from "./SubagentActivityStore";
import { WorkflowRunStore } from "./WorkflowRunStore";
import { workflowOwnerReferences } from "../../utils/workflow-references";
import { SessionArtifactsStore } from "./SessionArtifactsStore";
import type { ArtifactCatalog } from "../models/ArtifactCatalog";
import type { DiscussionCatalog } from "../models/DiscussionCatalog";
import { CakeChatSideChatsStore } from "./CakeChatSideChatsStore";
import { MessageCommentsStore } from "./MessageCommentsStore";
import { ConversationModeContext, conversationModeTarget } from "./ConversationModeStore";

export interface CakeChatSessionStoreProps {
  sessionId: string;
  project?(): Project | undefined;
  model: Conversation;
  artifactModel: ArtifactCatalog;
  controls: CakeChatControls;
  subagentCatalog: SubagentCatalog;
  /** Durable scheduled messages addressed to this chat, including its own check-ins. */
  scheduledMessageCatalog: ScheduledMessageCatalog;
  workflowCatalog(sessionId: string): WorkflowCatalog;
  /** Side chats branched from this Cake Chat's messages. */
  discussionCatalog: DiscussionCatalog;
  discussionSessionModel(
    sessionId: string,
    workingDirectory: string,
    parentSessionId: string,
  ): Conversation;
  target(): CakeChatTarget;
  pendingSessions: CakeChatPendingSessionsStore;
  operations: SessionOperationCoordinatorStore;
  modelPresets(): readonly ModelPreset[];
  openModelPresetSettings(): void;
  settings?(): AppearanceSettingsStore | undefined;
}

/** Owns the configuration and shared conversation input workflow for one Cake Chat session. */
export class CakeChatSessionStore extends Store<CakeChatSessionStoreProps> {
  @snapshot presentationMode: ProjectSessionPresentationMode = "normal";
  @snapshot workspaceChatSidebarVisible = true;
  @snapshot workspaceChatSidebarWidth = 420;

  showPresentation(mode: ProjectSessionPresentationMode) {
    this.presentationMode = mode;
  }
  toggleWorkspaceChatSidebar() {
    this.workspaceChatSidebarVisible = !this.workspaceChatSidebarVisible;
  }
  showWorkspaceChatSidebar() {
    this.workspaceChatSidebarVisible = true;
  }
  setWorkspaceChatSidebarWidth(width: number) {
    this.workspaceChatSidebarWidth = width;
  }

  @child
  get editorSelectionsStore(): EditorSelectionsStore {
    return createStore(EditorSelectionsStore, {
      sessionId: this.sessionId,
      openLocation: (location, signal) =>
        SessionPresentationContext.consume(this)!.openSelectionLocation(
          this.sessionId,
          location,
          signal,
        ),
      refreshHighlights: () => SessionPresentationContext.consume(this)!.refreshEditorHighlights(),
    });
  }

  private pendingSideChatThreadId: string | undefined;

  constructor(props: CakeChatSessionStore["props"]) {
    super(props);
    // A new side chat is listed before its sidecar conversation is live; it
    // opens once the thread's own conversation Store exists.
    this.reaction(
      () =>
        Boolean(
          this.pendingSideChatThreadId &&
          this.sideChatThreads.some((thread) => thread.id === this.pendingSideChatThreadId) &&
          this.sideChats.chatStore(this.pendingSideChatThreadId),
        ),
      (ready) => {
        if (ready && this.pendingSideChatThreadId) this.openSideChat(this.pendingSideChatThreadId);
      },
    );
    // Unsent text holds interrupt-policy session results back until it is sent or cleared.
    this.reaction(
      () => this.conversationSessionStore.chatStore.draft.trim().length > 0,
      (composing) => {
        void Promise.resolve()
          .then(() =>
            this.client.cakeChats.setComposing(
              { composing, sessionId: this.sessionId },
              { signal: this.signal },
            ),
          )
          .catch(() => undefined);
      },
    );
  }

  get model() {
    return this.props.model;
  }
  get client() {
    return ClientContext.consume(this)!;
  }
  get sessionId() {
    return this.props.sessionId;
  }
  get streaming() {
    return this.model.streaming;
  }
  @child
  get workflowRunStores(): WorkflowRunStore[] {
    return workflowOwnerReferences(this.model.uiParts).map((sessionId) =>
      createStore(WorkflowRunStore, {
        key: sessionId,
        model: this.props.workflowCatalog(sessionId),
      }),
    );
  }

  @child
  get subagentActivityStore(): SubagentActivityStore {
    return createStore(SubagentActivityStore, {
      sessionId: this.sessionId,
      model: this.props.subagentCatalog,
      parts: () => this.model.uiParts,
    });
  }

  @child
  get sessionArtifactsStore(): SessionArtifactsStore {
    return createStore(SessionArtifactsStore, {
      sessionId: this.sessionId,
      model: this.props.artifactModel,
    });
  }

  @child
  get todos(): ProjectTodosStore {
    return createStore(ProjectTodosStore, {
      project: () =>
        this.sessionId.startsWith("project-chat:") ? this.props.project?.() : undefined,
      sidePanel: () => this.conversationSessionStore.sideChatStore,
    });
  }

  @child
  get sideChats(): CakeChatSideChatsStore {
    return createStore(CakeChatSideChatsStore, {
      catalog: this.props.discussionCatalog,
      discussionSessionModel: this.props.discussionSessionModel,
      parent: () => this.model,
      configuration: () => this.conversationSessionStore.configurationStore,
      operations: this.props.operations,
      modelPresets: this.props.modelPresets,
      openModelPresetSettings: this.props.openModelPresetSettings,
      settings: this.props.settings,
    });
  }

  /** Open side chats for the header menu. */
  get sideChatThreads() {
    return this.sideChats.openThreads;
  }

  sideChatStreaming(threadId: string) {
    return this.sideChats.threadStreaming(threadId);
  }

  @child
  get messageCommentsStore(): MessageCommentsStore {
    return createStore(MessageCommentsStore, {
      catalog: () => this.props.discussionCatalog,
      host: () => this.sideChats,
      context: () => ({ sessionId: this.sessionId }),
      onThreadCreated: (threadId) => {
        // The draft in the side chat panel becomes the thread's own chat, which
        // carries the shared queue, stop, and reply behavior.
        const sideChat = this.conversationSessionStore.sideChatStore;
        if (sideChat.target?.chatStore !== this.messageCommentsStore.draftChatStore) return;
        this.pendingSideChatThreadId = threadId;
        this.openSideChat(threadId);
      },
    });
  }

  openSideChat(threadId: string) {
    const thread = this.sideChatThreads.find((candidate) => candidate.id === threadId);
    const chatStore = this.sideChats.chatStore(threadId);
    if (!thread || !chatStore) return false;
    this.pendingSideChatThreadId = undefined;
    this.conversationSessionStore.sideChatStore.open({
      key: `discussion:${thread.id}`,
      title: "Side chat",
      eyebrow: () => (thread.anchor.selectedText ? "Selection" : "Message"),
      chatStore,
    });
    return true;
  }

  @child
  get history(): ConversationHistoryStore {
    return createStore(ConversationHistoryStore, { model: this.model });
  }

  /** Voice mode drives this composer exactly as it does a Project Session's. Spoken input is
   * an ordinary submission, so it reaches Durable's queue with the same dedup as typed text. */
  private get conversationMode() {
    const workflow = ConversationModeContext.consume(this);
    if (!workflow) return undefined;
    return {
      workflow,
      target: conversationModeTarget({
        sessionId: this.sessionId,
        parts: () => this.model.uiParts,
        composer: () => this.conversationSessionStore.chatStore,
        // An unmaterialized Cake Chat starts through its own creation path; voice joins after.
        canEnter: () =>
          workflow.isActiveSession(this.sessionId) &&
          !this.props.pendingSessions.isPending(this.sessionId),
      }),
    };
  }

  @child
  get conversationSessionStore(): ConversationSessionStore {
    return createStore(ConversationSessionStore, {
      sessionId: this.sessionId,
      model: this.model,
      operations: this.props.operations,
      canSubmit: () => true,
      startSession: (input) => this.startSession(input),
      ensureSessionActive: () => true,
      composer: {
        scheduleMessage: async (sessionId, args) => {
          const scheduled = parseScheduledMessage(args);
          await this.client.scheduledMessages.schedule(
            {
              targetSessionId: sessionId,
              text: scheduled.text,
              sendAt: scheduled.sendAt,
              createdBySessionId: sessionId,
            },
            { signal: this.signal },
          );
          return !this.signal.aborted;
        },
        presentationMode: () => this.presentationMode,
        draftSessionPrompt: (sessionId) =>
          this.props.pendingSessions.conversation(sessionId)?.draftPrompt,
        isDeferredSession: (sessionId) => this.props.pendingSessions.isPending(sessionId),
        createDraftSession: (sessionId, text, attachments) => {
          const conversation = this.props.pendingSessions.conversation(sessionId);
          if (!conversation || !this.props.pendingSessions.isPending(sessionId)) return false;
          conversation.createDraft(text, attachments);
          return true;
        },
        updateDraftSession: (sessionId, text, attachments) =>
          this.props.pendingSessions.conversation(sessionId)?.updateDraft(text, attachments) ??
          false,
        activateDraftSession: (sessionId) =>
          this.props.pendingSessions.conversation(sessionId)?.activateDraft(),
        applyGeneratedDraftName: (sessionId, title) =>
          this.props.pendingSessions.conversation(sessionId)?.applyGeneratedDraftName(title),
        editorText: (entryId) =>
          this.model.tree.find((entry) => entry.piId === entryId)?.editorText,
        responseMode: () =>
          ConversationModeContext.consume(this)?.responseModeFor(this.sessionId) ?? "text",
      },
      configuration: {
        deferredNewSession: () => this.props.pendingSessions.isPending(this.sessionId),
        effectiveConfiguration: () => this.props.pendingSessions.configuration(this.sessionId),
        setPendingConfiguration: (configuration) =>
          this.props.pendingSessions.conversation(this.sessionId)?.setConfiguration(configuration),
      },
      chat: {
        contextUsage: true,
        history: this.history,
        commands: () => this.model.commands.filter((command) => command.name !== "sidechat"),
        placeholder: () =>
          this.sessionId.startsWith("project-chat:")
            ? "Talk about this project…"
            : "Ask Cake to find or control a task…",
        inputLabel: () =>
          this.sessionId.startsWith("project-chat:") ? "Message Project Chat" : "Message Cake Chat",
        conversationMode: this.conversationMode,
        scheduledMessages: {
          messages: () => this.props.scheduledMessageCatalog.messages,
          cancel: (id) => this.client.scheduledMessages.cancel(id, { signal: this.signal }),
        },
        isDraftSession: () =>
          this.props.pendingSessions.conversation(this.sessionId)?.isDraft ?? false,
      },
      modelPresets: this.props.modelPresets,
      openModelPresetSettings: this.props.openModelPresetSettings,
      settings: this.props.settings,
    });
  }

  private async startSession(input: ComposerDeliveryInput) {
    const newSession = this.props.pendingSessions.newSessionRequest(this.sessionId);
    if (!newSession) return false;
    await this.client.cakeChats.start(
      {
        sessionId: input.sessionId,
        tools: this.props.target().tools,
        text: input.text,
        renderUserMessageAsMarkdown: input.renderUserMessageAsMarkdown,
        attachments: input.attachments,
        newSession,
      },
      { signal: this.signal },
    );
    this.props.pendingSessions.markMaterialized(this.sessionId);
    return true;
  }
}
