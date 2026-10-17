import { Store, child, computed, createStore, observable, snapshot } from "r-state-tree";
import type { InterviewRecord, InterviewResult } from "../../contracts/interviews/interview";
import {
  ConversationModeContext,
  conversationModeTarget,
  type ConversationModeTarget,
} from "./ConversationModeStore";
import { isSessionAssistantThread } from "../../contracts/discussion-sessions/discussion-session-data";
import type { StoreEvent } from "../events/StoreEvent";
import type { Conversation } from "../models/Conversation";
import type { DiscussionCatalog } from "../models/DiscussionCatalog";
import type { SubagentCatalog } from "../models/SubagentCatalog";
import type { WorkflowCatalog } from "../models/WorkflowCatalog";
import { WorkflowRunStore } from "./WorkflowRunStore";
import type { ScheduledMessageCatalog } from "../models/ScheduledMessageCatalog";
import type { ModelPreset } from "../../contracts/conversations/session-contract";
import type { CakeControlTool } from "../../contracts/cake-chats/cake-chat-data";
import { ProjectPendingSessionsContext } from "./context/ProjectPendingSessionsContext";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import type { ReviewsStore } from "./ReviewsStore";
import { parseScheduledMessage } from "../../utils/scheduled-message-time";
import { ConversationSessionStore } from "./ConversationSessionStore";
import type { AppearanceSettingsStore } from "./AppearanceSettingsStore";
import { InterviewStore } from "./InterviewStore";
import { SessionArtifactsStore } from "./SessionArtifactsStore";
import type { ArtifactCatalog } from "../models/ArtifactCatalog";
import { MessageCommentsStore } from "./MessageCommentsStore";
import { SubagentActivityStore } from "./SubagentActivityStore";
import { WorktreeStore, type WorktreeStoreProps } from "./WorktreeStore";
import { StagedSessionCommandStore } from "./StagedSessionCommandStore";
import { SessionAssistantStore } from "./SessionAssistantStore";
import { ClientContext } from "./context/ClientContext";
import { EditorSelectionsStore } from "./EditorSelectionsStore";
import { SessionManagementContext } from "./context/SessionManagementContext";
import { ProjectSessionCreationContext } from "./context/ProjectSessionCreationContext";
import { ProjectSessionNavigationContext } from "./context/ProjectSessionNavigationContext";
import { SessionPresentationContext } from "./context/SessionPresentationContext";
import { CommandPaneContext } from "./context/CommandPaneContext";
import { SessionContinuationContext } from "./context/SessionContinuationContext";
import { ToastContext } from "./context/ToastContext";
import { settledSessionActivity, type SessionActivity } from "../lib/session-activity";
import type { ProjectSessionPresentationMode } from "../../contracts/project-sessions/project-session-presentation";

export type { ProjectSessionPresentationMode } from "../../contracts/project-sessions/project-session-presentation";

export interface SessionTarget {
  workspacePath: string;
  sessionId: string;
}

export interface ProjectSessionStoreProps extends SessionTarget {
  model: Conversation;
  discussionCatalog: DiscussionCatalog;
  subagentCatalog: SubagentCatalog;
  workflowCatalog: WorkflowCatalog;
  scheduledMessageCatalog: ScheduledMessageCatalog;
  artifactModel: ArtifactCatalog;
  operations: SessionOperationCoordinatorStore;
  reviews(): ReviewsStore;
  isActive(): boolean;
  worktreeOperation: WorktreeStoreProps["operation"];
  projectName(): string;
  familyId(): string | undefined;
  modelPresets(): readonly ModelPreset[];
  assistantTools?(): readonly CakeControlTool[];
  openModelPresetSettings(): void;
  retirement: WorktreeStoreProps["retirement"];
  settings?(): AppearanceSettingsStore | undefined;
}

/** Owns the view and interaction workflow for one project Pi session. */
export class ProjectSessionStore extends Store<ProjectSessionStoreProps> {
  /** Session-local presentation preference restored when this session is selected. */
  @snapshot presentationMode: ProjectSessionPresentationMode = "normal";
  @snapshot workspaceChatSidebarVisible = true;
  @snapshot workspaceChatSidebarWidth = 420;
  private readonly interviewRequests = observable(
    new Map<string, Extract<StoreEvent, { type: "interview-requested" }>>(),
  );
  private readSettledTurnRevision = 0;
  private pendingSideChatThreadId: string | undefined;

  constructor(props: ProjectSessionStore["props"]) {
    super(props);
    this.reaction(
      () =>
        this.canonicalParts.flatMap((part) =>
          part.kind === "tool" && part.interview && part.state !== "running"
            ? [part.interview.id]
            : [],
        ),
      (settled) => {
        for (const id of settled) this.interviewRequests.delete(id);
      },
    );
    // A new thread is listed before its sidecar conversation is live; the side
    // chat opens once the thread's own conversation Store exists.
    this.reaction(
      () =>
        Boolean(
          this.pendingSideChatThreadId &&
          this.sideChatThreads.some((thread) => thread.id === this.pendingSideChatThreadId) &&
          this.props.reviews().chatStore(this.pendingSideChatThreadId),
        ),
      (ready) => {
        if (ready && this.pendingSideChatThreadId) this.openSideChat(this.pendingSideChatThreadId);
      },
    );
  }

  private get pending() {
    return ProjectPendingSessionsContext.consume(this)!;
  }

  private get navigation() {
    return ProjectSessionNavigationContext.consume(this)!;
  }

  private canSubmit() {
    return !this.signal.aborted && this.navigation.canSubmitSession(this.sessionId);
  }

  showPresentation(mode: ProjectSessionPresentationMode) {
    this.presentationMode = mode;
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

  toggleWorkspaceChatSidebar() {
    this.workspaceChatSidebarVisible = !this.workspaceChatSidebarVisible;
  }

  showWorkspaceChatSidebar() {
    this.workspaceChatSidebarVisible = true;
  }

  setWorkspaceChatSidebarWidth(width: number) {
    this.workspaceChatSidebarWidth = width;
  }

  get model() {
    return this.props.model;
  }
  get client() {
    return ClientContext.consume(this)!;
  }
  get workspacePath() {
    return this.props.workspacePath;
  }
  get sessionId() {
    return this.props.sessionId;
  }
  @computed
  get sideChatThreads() {
    return this.props.discussionCatalog.threads
      .filter(
        (thread) =>
          thread.status === "open" &&
          (thread.anchor.view === "message" ||
            thread.anchor.view === "artifact" ||
            thread.anchor.view === "session") &&
          !isSessionAssistantThread(thread),
      )
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
  get canonicalParts() {
    return this.model.uiParts;
  }
  sideChatStreaming(threadId: string) {
    return this.props.reviews().threadStreaming(threadId);
  }

  @child
  get sessionAssistantStore(): SessionAssistantStore {
    return createStore(SessionAssistantStore, {
      sessionId: this.sessionId,
      workspacePath: this.workspacePath,
      staged: () => this.pending.isTemporary(this.sessionId),
      thread: () => this.props.discussionCatalog.threads.find(isSessionAssistantThread),
      stagedMessages: () =>
        this.canonicalParts.flatMap((part) => {
          if (part.kind === "text" && !part.draft) return [{ role: part.role, text: part.text }];
          if (part.kind === "skill") return [{ role: "user" as const, text: part.content }];
          return [];
        }),
      tools: () => this.props.assistantTools?.() ?? [],
      discussionSession: (threadId) => this.props.reviews().discussionSession(threadId),
    });
  }

  get isStreaming() {
    return this.model.streaming;
  }
  private get composerOwner() {
    return `session-chat-composer:${this.sessionId}`;
  }

  /** Routes an event only to the session subsystem that authoritatively owns it. */
  receive(event: StoreEvent) {
    if (event.type === "interview-requested") {
      if (event.record.sessionId !== this.sessionId) return;
      this.interviewRequests.set(event.record.id, event);
      return;
    }
    if (event.type === "operation-completed" || event.type === "operation-failed") {
      if (
        event.operationId &&
        this.props.operations.includes(event.operationId, this.composerOwner)
      )
        this.conversationSessionStore.receive(event);
      return;
    }
    if (event.type === "agent-availability-changed" && event.availability.state === "unavailable") {
      if (this.props.operations.active(this.composerOwner).length > 0)
        this.conversationSessionStore.receive(event);
      this.interviewRequests.clear();
    }
  }

  get hydrated() {
    return this.pending.isTemporary(this.sessionId) || Boolean(this.model.sessionFile);
  }

  @computed
  get activity(): SessionActivity | undefined {
    if (this.interviewRequests.size > 0) return "waiting";
    // Accepted turns include preparation before Pi emits its first streaming event.
    if (this.isStreaming || this.model.activeTurnIds.length > 0) return "running";
    if (this.props.isActive() || this.model.settledTurnRevision <= this.readSettledTurnRevision)
      return undefined;
    return settledSessionActivity(this.model.settledTurns.at(-1)?.outcome, this.model.parts);
  }

  markRead() {
    this.readSettledTurnRevision = this.model.settledTurnRevision;
  }

  depart() {
    this.markRead();
    this.conversationSessionStore.composerStore.cancelDraftEdit();
  }

  @child
  get worktreeStore(): WorktreeStore {
    return createStore(WorktreeStore, {
      workspacePath: () => this.workspacePath,
      sessionId: () => this.sessionId,
      enabled: () => this.props.isActive(),
      isStreaming: () => this.isStreaming,
      operation: this.props.worktreeOperation,
      onLanded: (_record, result) => {
        // Sibling sessions sharing this Working Directory observe the same operation; keying
        // the toast by operation keeps one landing (and its family resolution) to one toast.
        const coalesceKey = `worktree-landed:${result.operationId}`;
        const resolvedCount = result.resolvedSessionIds?.length ?? 0;
        ToastContext.consume(this)!.show(
          !result.resolved
            ? {
                tone: "info",
                title: "Worktree merged",
                message: "Your work was merged back into the project.",
                coalesceKey,
              }
            : resolvedCount > 1
              ? {
                  tone: "info",
                  title: "Sessions merged and resolved",
                  message: `The worktree was merged into the project and ${resolvedCount} sessions were resolved.`,
                  coalesceKey,
                }
              : {
                  tone: "info",
                  title: "Session merged and resolved",
                  message: "This session was merged into the project and resolved.",
                  coalesceKey,
                },
        );
      },
      onDiscarded: () => undefined,
      retirement: this.props.retirement,
      onResolveWorkspace: (workspacePath, options) =>
        this.navigation.resolveWorktreeWorkspace(workspacePath, options),
    });
  }

  @child
  get subagentActivityStore(): SubagentActivityStore {
    return createStore(SubagentActivityStore, {
      sessionId: this.sessionId,
      model: this.props.subagentCatalog,
      parts: () => this.canonicalParts,
    });
  }

  @child
  get workflowRunStore(): WorkflowRunStore {
    return createStore(WorkflowRunStore, { model: this.props.workflowCatalog });
  }

  get workflowRunStores() {
    return [this.workflowRunStore];
  }

  openSideChat(threadId: string) {
    const thread = this.sideChatThreads.find((candidate) => candidate.id === threadId);
    const chatStore = this.props.reviews().chatStore(threadId);
    if (!thread || !chatStore) return false;
    this.pendingSideChatThreadId = undefined;
    this.conversationSessionStore.sideChatStore.open({
      key: `discussion:${thread.id}`,
      title: "Side chat",
      eyebrow: () =>
        thread.anchor.view === "artifact"
          ? "Artifact selection"
          : thread.anchor.view === "message"
            ? "Selection"
            : "Session",
      chatStore,
    });
    return true;
  }

  private async createSideChat(prompt: string) {
    if (this.pending.isTemporary(this.sessionId)) return false;
    const threadId = await this.props
      .reviews()
      .createSideChat({ sessionId: this.sessionId, workingDirectory: this.workspacePath }, prompt);
    if (!threadId) return false;
    this.pendingSideChatThreadId = threadId;
    this.openSideChat(threadId);
    return true;
  }

  get conversationTarget(): ConversationModeTarget {
    return conversationModeTarget({
      sessionId: this.sessionId,
      parts: () => this.model.uiParts,
      composer: () => this.conversationSessionStore.chatStore,
      canEnter: () =>
        this.props.isActive() && this.canSubmit() && !this.pending.isTemporary(this.sessionId),
    });
  }

  @child
  get stagedCommandStore(): StagedSessionCommandStore {
    return createStore(StagedSessionCommandStore);
  }

  @child
  get conversationSessionStore(): ConversationSessionStore {
    // Bind Project Session policy here; shared conversations/composers remain
    // reusable without depending on Project-only ambient capabilities.
    const creation = ProjectSessionCreationContext.consume(this)!;
    const management = SessionManagementContext.consume(this)!;
    const pending = ProjectPendingSessionsContext.consume(this)!;
    return createStore(ConversationSessionStore, {
      sessionId: this.sessionId,
      model: this.model,
      operations: this.props.operations,
      canSubmit: () => this.canSubmit(),
      startSession: (input) => creation.start(this.sessionId, input),
      ensureSessionActive: () => management.ensureSessionActive(this.sessionId),
      composer: {
        projectPath: () => this.workspacePath,
        presentationMode: () => this.presentationMode,
        responseMode: () =>
          ConversationModeContext.consume(this)?.responseModeFor(this.sessionId) ?? "text",
        openCommandPane: (pane) => CommandPaneContext.consume(this)!.open(pane),
        createSideChat: (prompt) => this.createSideChat(prompt),
        renameSession: (name) => management.renameSession(this.sessionId, name),
        toolCompactSession: (entryId, prompt) =>
          SessionContinuationContext.consume(this)!.toolCompactAt(entryId, prompt),
        scheduleMessage: (sessionId, args) => this.scheduleMessage(sessionId, args),
        draftSessionPrompt: (sessionId) => pending.conversation(sessionId)?.draftPrompt,
        isDeferredSession: (sessionId) => pending.isTemporary(sessionId),
        createDraftSession: async (sessionId, text, attachments) => {
          await pending.createDraft(sessionId, text, attachments);
          return true;
        },
        updateDraftSession: async (sessionId, text, attachments) => {
          await pending.updateDraft(sessionId, text, attachments);
          return true;
        },
        activateSavedDraftSession: (choice) => creation.activateSavedDraft(this.sessionId, choice),
        activateDraftSession: (sessionId) => {
          const record = pending.savedRecord(sessionId);
          return record?.status === "saved"
            ? { text: record.text, attachments: [...record.attachments], resolved: record.resolved }
            : undefined;
        },
        configureDraftActivation: (choice) =>
          creation.configureDraftActivation(this.sessionId, choice),
        sessionCreationChoice: () => creation.choice(this.sessionId),
        editorText: (entryId) =>
          this.model.tree.find((entry) => entry.piId === entryId)?.editorText,
      },
      configuration: {
        deferredNewSession: () => pending.isTemporary(this.sessionId),
        effectiveConfiguration: () => creation.request(this.sessionId)?.configuration,
        setPendingConfiguration: (configuration) =>
          pending.conversation(this.sessionId)?.setConfiguration(configuration),
      },
      chat: {
        conversationMode: ConversationModeContext.consume(this)
          ? { workflow: ConversationModeContext.consume(this)!, target: this.conversationTarget }
          : undefined,
        commands: () =>
          pending.isTemporary(this.sessionId)
            ? this.stagedCommandStore.commands
            : this.model.commands,
        placeholder: () =>
          this.isStreaming
            ? "Add the next instruction…"
            : `Ask Cake to work in ${this.props.projectName()}…`,
        inputLabel: () => "Message",
        sessionCreationChoice: () => creation.choice(this.sessionId),
        draftActivationCandidates: () => creation.candidates(this.sessionId),
        isDraftSession: () => pending.isDraft(this.sessionId),
        suggestFiles: (prefix) =>
          this.conversationSessionStore.composerStore.draftStore.suggestFiles(prefix),
        rewordWorkingDirectory: () => this.workspacePath,
        scheduledMessages: {
          messages: () => this.props.scheduledMessageCatalog.messages,
          cancel: (id) => this.client.scheduledMessages.cancel(id, { signal: this.signal }),
        },
        fallbackError: () => ({
          message: this.stagedCommandStore.error,
          details: this.stagedCommandStore.errorDetails,
        }),
      },
      modelPresets: this.props.modelPresets,
      openModelPresetSettings: this.props.openModelPresetSettings,
      settings: this.props.settings,
    });
  }

  private async scheduleMessage(sessionId: string, args: string) {
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
  }

  @child
  get sessionArtifactsStore(): SessionArtifactsStore {
    return createStore(SessionArtifactsStore, {
      sessionId: this.sessionId,
      model: this.props.artifactModel,
      enabled: () => Boolean(this.model.sessionFile) && !this.pending.isTemporary(this.sessionId),
    });
  }

  @child
  get interviews(): InterviewStore[] {
    const records = new Map<string, { record: InterviewRecord; result?: InterviewResult }>();
    for (const part of this.canonicalParts)
      if (part.kind === "tool" && part.interview?.sessionId === this.sessionId)
        records.set(part.interview.id, { record: part.interview, result: part.interviewResult });
    // Requests can arrive before their Pi metadata reaches the projection.
    for (const [id, request] of this.interviewRequests)
      if (!records.has(id)) records.set(id, { record: request.record });
    return [...records.values()].map(({ record, result }) =>
      createStore(InterviewStore, {
        key: record.id,
        record,
        result,
        request: this.interviewRequests.get(record.id),
        operations: this.props.operations,
        isStreaming: () => this.isStreaming,
        onResponded: () => {
          this.interviewRequests.delete(record.id);
        },
      }),
    );
  }

  interview(id: string) {
    return this.interviews.find((interview) => interview.record.id === id);
  }
  get waitingForInterview() {
    return this.interviewRequests.size > 0;
  }
  get interviewError() {
    return this.interviews.find((interview) => interview.error);
  }

  @child
  get messageCommentsStore(): MessageCommentsStore {
    return createStore(MessageCommentsStore, {
      catalog: () => this.props.discussionCatalog,
      host: this.props.reviews,
      context: () => ({ sessionId: this.sessionId }),
      onThreadCreated: (threadId) => {
        // The selection draft in the side chat becomes the thread's own chat,
        // which carries the shared queue, stop, and reply behavior.
        const sideChat = this.conversationSessionStore.sideChatStore;
        if (sideChat.target?.chatStore !== this.messageCommentsStore.draftChatStore) return;
        this.pendingSideChatThreadId = threadId;
        this.openSideChat(threadId);
      },
    });
  }
}
