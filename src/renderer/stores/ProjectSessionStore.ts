import {
  Store,
  child,
  computed,
  createStore,
  effect as reactiveEffect,
  snapshot,
} from "r-state-tree";
import type { StoreEvent } from "../events/StoreEvent";
import type { Session } from "../models/Session";
import type { ChatConfiguration, ModelPreset } from "../../ipc/session-contract";
import type { ProjectPendingSessionsStore } from "./ProjectPendingSessionsStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import type { ReviewsStore } from "./ReviewsStore";
import type { ComposerDeliveryInput } from "./ConversationComposerStore";
import type {
  ProjectSessionPromptInput,
  ProjectSessionStartInput,
} from "../../domain/project-sessions/project-session-data";
import { parseScheduledMessage } from "../../utils/scheduled-message-time";
import type { QueuedPrompt as ChatQueuedPrompt } from "./ChatStore";
import { ConversationSessionStore } from "./ConversationSessionStore";
import type { AppearanceSettingsStore } from "./AppearanceSettingsStore";
import { ArtifactInteractionStore } from "./ArtifactInteractionStore";
import { MessageCommentsStore } from "./MessageCommentsStore";
import { SubagentActivityStore } from "./SubagentActivityStore";
import { WorktreeStore, type WorktreeStoreProps } from "./WorktreeStore";
import { StagedSessionCommandStore } from "./StagedSessionCommandStore";
import { ClientContext } from "./context/ClientContext";
import type { ExistingWorktreeCandidate, WorktreeDraftChoice } from "./WorktreeCreationStore";
import type { SessionActivity } from "../lib/session-activity";

export interface SessionTarget {
  workspacePath: string;
  sessionId: string;
}

export interface ProjectSessionStoreProps extends SessionTarget {
  model: Session;
  pendingSessions: ProjectPendingSessionsStore;
  operations: SessionOperationCoordinatorStore;
  reviews(): ReviewsStore;
  canSubmit(): boolean;
  isActive(): boolean;
  worktreeOperation: WorktreeStoreProps["operation"];
  openCommandPane(pane: "changelog" | "tree" | "resources"): Promise<void>;
  projectName(): string;
  familyId(): string | undefined;
  abort(): Promise<void>;
  renameSession(name: string): Promise<void>;
  toolCompactSession(entryId: string, prompt?: string): Promise<boolean>;
  modelPresets(): readonly ModelPreset[];
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
  @snapshot ideMode = false;
  @snapshot ideChatSidebarVisible = true;
  @snapshot ideChatSidebarWidth = 420;
  private artifactRequestActive = false;
  private readSettledTurnRevision = 0;
  private pendingSideChatThreadId: string | undefined;

  constructor(props: ProjectSessionStore["props"]) {
    super(props);
    this.reaction(
      () =>
        Boolean(
          this.pendingSideChatThreadId &&
          this.sideChatThreads.some((thread) => thread.id === this.pendingSideChatThreadId),
        ),
      (ready) => {
        if (ready && this.pendingSideChatThreadId) this.openSideChat(this.pendingSideChatThreadId);
      },
    );
  }

  enterIde() {
    this.ideMode = true;
  }

  leaveIde() {
    this.ideMode = false;
  }

  toggleIdeChatSidebar() {
    this.ideChatSidebarVisible = !this.ideChatSidebarVisible;
  }

  showIdeChatSidebar() {
    this.ideChatSidebarVisible = true;
  }

  setIdeChatSidebarWidth(width: number) {
    this.ideChatSidebarWidth = width;
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
          (thread.anchor.view === "message" || thread.anchor.view === "session"),
      )
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
  get canonicalParts() {
    return this.model.uiParts;
  }

  @computed
  get runtimeQueuedPrompts(): ChatQueuedPrompt[] {
    return this.model.parts.flatMap((part) =>
      part.kind === "text" &&
      part.role === "user" &&
      (part.deliveryState === "queued" || part.deliveryState === "steering")
        ? [
            {
              id: part.partKey,
              text: part.text ?? "",
              attachments: [],
              renderUserMessageAsMarkdown: part.renderAs === "markdown",
              state: part.deliveryState,
              source: part.crossSession,
              editable: false,
            },
          ]
        : [],
    );
  }

  get isStreaming() {
    return this.model.streaming;
  }
  private get composerOwner() {
    return `message-composer:${this.sessionId}`;
  }
  private get configurationOwner() {
    return `chat-configuration:${this.sessionId}`;
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
      composerOperationOwner: this.composerOwner,
      configurationOperationOwner: this.configurationOwner,
      canSubmit: this.props.canSubmit,
      composer: {
        projectPath: () => this.workspacePath,
        queueWhileStreaming: () => true,
        openCommandPane: (pane) => this.props.openCommandPane(pane),
        createSideChat: (prompt) => this.createSideChat(prompt),
        renameSession: (name) => this.props.renameSession(name),
        toolCompactSession: (entryId, prompt) => this.props.toolCompactSession(entryId, prompt),
        deliver: (input) => this.deliverComposerMessage(input),
        editMessage: (input) =>
          this.client.projectSessions.editMessage(input, { signal: this.signal }),
        compact: (sessionId, instructions) =>
          this.client.projectSessions.compact({ sessionId, instructions }, { signal: this.signal }),
        clearQueue: async () => {
          await this.client.projectSessions.clearQueue(
            { sessionId: this.sessionId },
            { signal: this.signal },
          );
        },
        cancelSteering: async () => {
          await this.client.projectSessions.cancelSteering(
            { sessionId: this.sessionId },
            { signal: this.signal },
          );
        },
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
        setConfiguration: (configuration) =>
          this.configureActiveSession(() =>
            this.client.projectSessions.applyConfiguration(
              { sessionId: this.sessionId, configuration },
              { signal: this.signal },
            ),
          ),
        setModel: (provider, modelId) =>
          this.configureActiveSession(() =>
            this.client.projectSessions.setModel(
              { sessionId: this.sessionId, provider, modelId },
              { signal: this.signal },
            ),
          ),
        setThinkingLevel: (level) =>
          this.configureActiveSession(() =>
            this.client.projectSessions.setThinkingLevel(
              { sessionId: this.sessionId, level },
              { signal: this.signal },
            ),
          ),
        setFastMode: (enabled) =>
          this.configureActiveSession(() =>
            this.client.projectSessions.setFastMode(
              { sessionId: this.sessionId, enabled },
              { signal: this.signal },
            ),
          ),
      },
      chat: {
        stoppable: () => this.model.backgroundWorkActive,
        commands: () =>
          this.props.pendingSessions.isTemporary(this.sessionId)
            ? this.stagedCommandStore.commands
            : this.model.commands,
        placeholder: () =>
          this.isStreaming
            ? "Add the next instruction…"
            : `Ask Cake to work in ${this.props.projectName()}…`,
        inputLabel: () => "Message",
        userMessagePresentation: {
          setMarkdown: (entryId, renderAsMarkdown) =>
            this.client.projectSessions.setUserMessageMarkdown(
              { sessionId: this.sessionId, entryId, renderAsMarkdown },
              { signal: this.signal },
            ),
        },
        sessionCreationChoice: this.props.sessionCreationChoice,
        draftActivationCandidates: this.props.draftActivationCandidates,
        isDraftSession: () => this.props.pendingSessions.isDraft(this.sessionId),
        abort: () => this.props.abort(),
        addAttachments: () =>
          this.conversationSessionStore.composerStore.draftStore.addAttachments(),
        suggestFiles: (prefix) =>
          this.conversationSessionStore.composerStore.draftStore.suggestFiles(prefix),
        rewordWorkingDirectory: () => this.workspacePath,
        steeringPrompts: () => this.runtimeQueuedPrompts,
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

  private async deliverComposerMessage(input: ComposerDeliveryInput) {
    const pendingNewSession = this.props.newSessionRequest();
    if (pendingNewSession)
      this.props.pendingSessions.projectSubmission(input.sessionId, input.text);
    try {
      if (pendingNewSession && !(await this.props.prepareNewSession(input.text))) return false;
      if (!pendingNewSession) {
        const active = this.ensureActiveProjection();
        if (active !== true && !(await active)) return false;
      }
      const newSession = this.props.newSessionRequest();
      if (newSession) {
        const pendingStatusId = this.props.pendingSessions.conversation(
          input.sessionId,
        )?.workflowStatusId;
        const startInput: ProjectSessionStartInput = {
          sessionId: input.sessionId,
          workingDirectory: newSession.path,
          text: input.text,
          renderUserMessageAsMarkdown: input.renderUserMessageAsMarkdown,
          attachments: input.attachments,
        };
        if (newSession.configuration !== undefined)
          Object.assign(startInput, { configuration: newSession.configuration });
        if (newSession.name !== undefined) Object.assign(startInput, { name: newSession.name });
        if (pendingStatusId) Object.assign(startInput, { workflowStatusId: pendingStatusId });
        await this.client.projectSessions.start(startInput, { signal: this.signal });
        this.props.pendingSessions.materialize(input.sessionId, newSession.path);
      } else {
        const command =
          input.delivery === "steer"
            ? this.client.projectSessions.steer
            : this.client.projectSessions.prompt;
        const promptInput: ProjectSessionPromptInput = {
          sessionId: input.sessionId,
          text: input.text,
          renderUserMessageAsMarkdown: input.renderUserMessageAsMarkdown,
          attachments: input.attachments,
        };
        await command(promptInput, { signal: this.signal });
      }
      return true;
    } catch (error) {
      this.props.pendingSessions.cancelSubmission(input.sessionId);
      throw error;
    }
  }

  private async configureActiveSession(command: () => Promise<void>) {
    const active = this.ensureActiveProjection();
    if (active !== true && !(await active)) return;
    await command();
  }

  private ensureActiveProjection(): boolean | Promise<boolean> {
    const observedSnapshotRevision = this.model.observedSnapshotRevision;
    const active = this.props.ensureSessionActive();
    if (active === true) return true;
    if (active === false) return false;
    return active.then((restored) =>
      restored ? this.waitForActiveProjection(observedSnapshotRevision) : false,
    );
  }

  /** Keeps pending interaction state visible until live observation is attached. */
  private waitForActiveProjection(afterRevision: number): Promise<boolean> {
    if (!this.model.resolved && this.model.observedSnapshotRevision > afterRevision)
      return Promise.resolve(true);
    if (this.signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ready: boolean) => {
        if (settled) return;
        settled = true;
        this.signal.removeEventListener("abort", abort);
        dispose();
        resolve(ready);
      };
      const abort = () => finish(false);
      this.signal.addEventListener("abort", abort, { once: true });
      const dispose = reactiveEffect(() => {
        if (!this.model.resolved && this.model.observedSnapshotRevision > afterRevision)
          queueMicrotask(() => finish(true));
      });
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
    });
  }
}
