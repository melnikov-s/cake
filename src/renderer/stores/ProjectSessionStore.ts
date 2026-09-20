import { Store, child, computed, createStore, snapshot } from "r-state-tree";
import { isSessionAssistantThread } from "../../domain/discussion-sessions/discussion-session-data";
import type { StoreEvent } from "../events/StoreEvent";
import type { Conversation } from "../models/Conversation";
import type { ChatConfiguration, ModelPreset } from "../../ipc/session-contract";
import type { CakeControlTool } from "../../domain/cake-chats/cake-chat-data";
import type { ProjectPendingSessionsStore } from "./ProjectPendingSessionsStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import type { ReviewsStore } from "./ReviewsStore";
import type { ComposerDeliveryInput } from "./ConversationComposerStore";
import type { ProjectSessionStartInput } from "../../domain/project-sessions/project-session-data";
import type { EditorLocation } from "../../ipc/editor-location";
import { parseScheduledMessage } from "../../utils/scheduled-message-time";
import { ConversationSessionStore } from "./ConversationSessionStore";
import type { AppearanceSettingsStore } from "./AppearanceSettingsStore";
import { ArtifactInteractionStore } from "./ArtifactInteractionStore";
import { SessionArtifactsStore } from "./SessionArtifactsStore";
import type { ArtifactCatalog } from "../models/ArtifactCatalog";
import { MessageCommentsStore } from "./MessageCommentsStore";
import { SubagentActivityStore } from "./SubagentActivityStore";
import { WorktreeStore, type WorktreeStoreProps } from "./WorktreeStore";
import { StagedSessionCommandStore } from "./StagedSessionCommandStore";
import { SessionAssistantStore } from "./SessionAssistantStore";
import { ClientContext } from "./context/ClientContext";
import { DrawStore } from "./DrawStore";
import type { ExistingWorktreeCandidate, WorktreeDraftChoice } from "./WorktreeCreationStore";
import type { SessionActivity } from "../lib/session-activity";
import type { ProjectSessionPresentationMode } from "../../domain/project-sessions/project-session-presentation";

export type { ProjectSessionPresentationMode } from "../../domain/project-sessions/project-session-presentation";

export interface SessionTarget {
  workspacePath: string;
  sessionId: string;
}

export interface ProjectSessionStoreProps extends SessionTarget {
  model: Conversation;
  artifactModel: ArtifactCatalog;
  pendingSessions: ProjectPendingSessionsStore;
  operations: SessionOperationCoordinatorStore;
  reviews(): ReviewsStore;
  canSubmit(): boolean;
  isActive(): boolean;
  worktreeOperation: WorktreeStoreProps["operation"];
  openCommandPane(pane: "changelog" | "tree" | "resources"): Promise<void>;
  projectName(): string;
  familyId(): string | undefined;
  renameSession(name: string): Promise<void>;
  toolCompactSession(entryId: string, prompt?: string): Promise<boolean>;
  modelPresets(): readonly ModelPreset[];
  assistantTools?(): readonly CakeControlTool[];
  openModelPresetSettings(): void;
  newSessionRequest():
    | { path: string; configuration?: ChatConfiguration; name?: string }
    | undefined;
  prepareNewSession(firstUserMessage: string): Promise<boolean>;
  ensureSessionActive(): boolean | Promise<boolean>;
  configureDraftActivation(choice: WorktreeDraftChoice): void;
  sessionCreationChoice(): WorktreeDraftChoice;
  draftActivationCandidates(): ExistingWorktreeCandidate[];
  onWorktreeLanded: WorktreeStoreProps["onLanded"];
  onWorktreeDiscarded(
    record: Parameters<WorktreeStoreProps["onDiscarded"]>[0],
  ): Promise<void> | void;
  retirement: WorktreeStoreProps["retirement"];
  onResolveWorktree: WorktreeStoreProps["onResolveWorkspace"];
  settings?(): AppearanceSettingsStore | undefined;
}

/** Owns the view and interaction workflow for one project Pi session. */
export class ProjectSessionStore extends Store<ProjectSessionStoreProps> {
  /** Session-local presentation preference restored when this session is selected. */
  @snapshot presentationMode: ProjectSessionPresentationMode = "normal";
  @snapshot workspaceChatSidebarVisible = true;
  @snapshot workspaceChatSidebarWidth = 420;
  private artifactRequestActive = false;
  private readSettledTurnRevision = 0;
  private pendingSideChatThreadId: string | undefined;
  private pendingEditorLocation: EditorLocation | undefined;

  constructor(props: ProjectSessionStore["props"]) {
    super(props);
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

  showPresentation(mode: ProjectSessionPresentationMode) {
    this.presentationMode = mode;
    if (mode !== "vscode") this.pendingEditorLocation = undefined;
  }

  requestEditorLocation(location: EditorLocation) {
    this.pendingEditorLocation = location;
  }

  takePendingEditorLocation() {
    const location = this.pendingEditorLocation;
    this.pendingEditorLocation = undefined;
    return location;
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
  get drawStore(): DrawStore {
    return createStore(DrawStore, { sessionId: this.sessionId });
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
    return this.model.reviewThreads
      .filter(
        (thread) =>
          thread.status === "open" &&
          (thread.anchor.view === "message" || thread.anchor.view === "session") &&
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
      staged: () => this.props.pendingSessions.isTemporary(this.sessionId),
      thread: () => this.model.reviewThreads.find(isSessionAssistantThread),
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
    if (event.type === "artifact-requested") {
      if (event.record.artifact.sessionId !== this.sessionId) return;
      this.artifactRequestActive = true;
      this.artifactInteractionStore.receive(event);
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
      if (this.artifactRequestActive) this.artifactInteractionStore.receive(event);
    }
  }

  get hydrated() {
    return (
      this.props.pendingSessions.isTemporary(this.sessionId) || Boolean(this.model.sessionFile)
    );
  }

  @computed
  get activity(): SessionActivity | undefined {
    if (this.artifactRequestActive) return "waiting";
    if (this.isStreaming) return "running";
    if (this.props.isActive() || this.model.settledTurnRevision <= this.readSettledTurnRevision)
      return undefined;
    return this.latestTurnErrored ? "error" : "unread";
  }

  markRead() {
    this.readSettledTurnRevision = this.model.settledTurnRevision;
  }

  depart() {
    this.markRead();
    this.conversationSessionStore.composerStore.cancelDraftEdit();
  }

  private get latestTurnErrored() {
    for (let index = this.model.parts.length - 1; index >= 0; index -= 1) {
      const part = this.model.parts[index]!;
      if ((part.kind === "text" && part.role === "user") || part.kind === "skill") return false;
      if (part.kind === "text" && part.role === "assistant" && part.status === "error") return true;
      if (part.kind === "notice" && part.tone === "error" && part.title === "Model request failed")
        return true;
    }
    return false;
  }

  @child
  get worktreeStore(): WorktreeStore {
    return createStore(WorktreeStore, {
      workspacePath: () => this.workspacePath,
      sessionId: () => this.sessionId,
      enabled: () => this.props.isActive(),
      isStreaming: () => this.isStreaming,
      operation: this.props.worktreeOperation,
      onLanded: this.props.onWorktreeLanded,
      onDiscarded: this.props.onWorktreeDiscarded,
      retirement: this.props.retirement,
      onResolveWorkspace: this.props.onResolveWorktree,
    });
  }

  @child
  get subagentActivityStore(): SubagentActivityStore {
    return createStore(SubagentActivityStore, {
      sessionId: this.sessionId,
      model: this.model,
      parts: () => this.canonicalParts,
    });
  }

  openSideChat(threadId: string) {
    const thread = this.sideChatThreads.find((candidate) => candidate.id === threadId);
    const chatStore = this.props.reviews().chatStore(threadId);
    if (!thread || !chatStore) return false;
    this.pendingSideChatThreadId = undefined;
    this.conversationSessionStore.sideChatStore.open({
      key: `discussion:${thread.id}`,
      title: "Side chat",
      eyebrow: () => (thread.anchor.view === "message" ? "Selection" : "Session"),
      chatStore,
    });
    return true;
  }

  private async createSideChat(prompt: string) {
    if (this.props.pendingSessions.isTemporary(this.sessionId)) return false;
    const threadId = await this.props
      .reviews()
      .createSideChat({ sessionId: this.sessionId, workingDirectory: this.workspacePath }, prompt);
    if (!threadId) return false;
    this.pendingSideChatThreadId = threadId;
    this.openSideChat(threadId);
    return true;
  }

  @child
  get stagedCommandStore(): StagedSessionCommandStore {
    return createStore(StagedSessionCommandStore);
  }

  @child
  get conversationSessionStore(): ConversationSessionStore {
    return createStore(ConversationSessionStore, {
      sessionId: this.sessionId,
      model: this.model,
      operations: this.props.operations,
      canSubmit: this.props.canSubmit,
      startSession: (input) => this.startSession(input),
      ensureSessionActive: this.props.ensureSessionActive,
      composer: {
        projectPath: () => this.workspacePath,
        presentationMode: () => this.presentationMode,
        openCommandPane: (pane) => this.props.openCommandPane(pane),
        createSideChat: (prompt) => this.createSideChat(prompt),
        renameSession: (name) => this.props.renameSession(name),
        toolCompactSession: (entryId, prompt) => this.props.toolCompactSession(entryId, prompt),
        scheduleMessage: (sessionId, args) => this.scheduleMessage(sessionId, args),
        draftSessionPrompt: (sessionId) =>
          this.props.pendingSessions.conversation(sessionId)?.draftPrompt,
        isDeferredSession: (sessionId) => this.props.pendingSessions.isTemporary(sessionId),
        createDraftSession: async (sessionId, text, attachments) => {
          await this.props.pendingSessions.createDraft(sessionId, text, attachments);
          return true;
        },
        updateDraftSession: async (sessionId, text, attachments) => {
          await this.props.pendingSessions.updateDraft(sessionId, text, attachments);
          return true;
        },
        activateDraftSession: (sessionId) =>
          this.props.pendingSessions.conversation(sessionId)?.activateDraft(),
        applyGeneratedDraftName: (sessionId, title) =>
          this.props.pendingSessions.conversation(sessionId)?.applyGeneratedDraftName(title),
        configureDraftActivation: (choice) => this.props.configureDraftActivation(choice),
        sessionCreationChoice: this.props.sessionCreationChoice,
        editorText: (entryId) =>
          this.model.tree.find((entry) => entry.piId === entryId)?.editorText,
      },
      configuration: {
        deferredNewSession: () => this.props.pendingSessions.isTemporary(this.sessionId),
        effectiveConfiguration: () => this.props.newSessionRequest()?.configuration,
        setPendingConfiguration: (configuration) =>
          this.props.pendingSessions.conversation(this.sessionId)?.setConfiguration(configuration),
      },
      chat: {
        commands: () =>
          this.props.pendingSessions.isTemporary(this.sessionId)
            ? this.stagedCommandStore.commands
            : this.model.commands,
        placeholder: () =>
          this.isStreaming
            ? "Add the next instruction…"
            : `Ask Cake to work in ${this.props.projectName()}…`,
        inputLabel: () => "Message",
        sessionCreationChoice: this.props.sessionCreationChoice,
        draftActivationCandidates: this.props.draftActivationCandidates,
        isDraftSession: () => this.props.pendingSessions.isDraft(this.sessionId),
        addAttachments: () =>
          this.conversationSessionStore.composerStore.draftStore.addAttachments(),
        suggestFiles: (prefix) =>
          this.conversationSessionStore.composerStore.draftStore.suggestFiles(prefix),
        rewordWorkingDirectory: () => this.workspacePath,
        scheduledMessages: {
          messages: () => this.model.scheduledMessages,
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

  private async startSession(input: ComposerDeliveryInput) {
    const pending = this.props.newSessionRequest();
    if (!pending) return false;
    this.props.pendingSessions.projectSubmission(input.sessionId, input.text);
    try {
      if (!(await this.props.prepareNewSession(input.text))) {
        this.props.pendingSessions.cancelSubmission(input.sessionId);
        return false;
      }
      const newSession = this.props.newSessionRequest();
      if (!newSession) {
        this.props.pendingSessions.cancelSubmission(input.sessionId);
        return false;
      }
      const pendingLabelIds =
        this.props.pendingSessions.conversation(input.sessionId)?.labelIds ?? [];
      const startInput: ProjectSessionStartInput = {
        sessionId: input.sessionId,
        workingDirectory: newSession.path,
        text: input.text,
        renderUserMessageAsMarkdown: input.renderUserMessageAsMarkdown,
        attachments: input.attachments,
      };
      if (input.presentationMode !== undefined)
        Object.assign(startInput, { presentationMode: input.presentationMode });
      if (newSession.configuration !== undefined)
        Object.assign(startInput, { configuration: newSession.configuration });
      if (newSession.name !== undefined) Object.assign(startInput, { name: newSession.name });
      if (pendingLabelIds.length > 0) Object.assign(startInput, { labelIds: pendingLabelIds });
      await this.client.projectSessions.start(startInput, { signal: this.signal });
      this.props.pendingSessions.materialize(input.sessionId, newSession.path);
      return true;
    } catch (error) {
      this.props.pendingSessions.cancelSubmission(input.sessionId);
      throw error;
    }
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
      isActive: this.props.isActive,
      enabled: () => !this.props.pendingSessions.isTemporary(this.sessionId),
    });
  }

  @child
  get artifactInteractionStore(): ArtifactInteractionStore {
    return createStore(ArtifactInteractionStore, {
      sessionContext: () => ({ sessionId: this.sessionId }),
      operations: this.props.operations,
      operationOwner: `artifact-answer:${this.sessionId}`,
      isStreaming: () => this.isStreaming,
      onRequestChanged: (active) => {
        this.artifactRequestActive = active;
      },
    });
  }

  @child
  get messageCommentsStore(): MessageCommentsStore {
    return createStore(MessageCommentsStore, {
      sessionModel: () => this.model,
      reviews: this.props.reviews,
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
