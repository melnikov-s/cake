import { Store, child, computed, createStore, snapshot } from "r-state-tree";
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
} from "../../domain/project-session-data";
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
  handoffSession(entryId: string, prompt?: string, resolveSource?: boolean): Promise<boolean>;
  modelPresets(): readonly ModelPreset[];
  openModelPresetSettings(): void;
  newSessionRequest():
    | { path: string; configuration?: ChatConfiguration; name?: string }
    | undefined;
  prepareNewSession(firstUserMessage: string): Promise<boolean>;
  configureDraftActivation(choice: WorktreeDraftChoice): void;
  sessionCreationChoice(): WorktreeDraftChoice;
  draftActivationCandidates(): ExistingWorktreeCandidate[];
  onWorktreeLanded(record: Parameters<WorktreeStoreProps["onLanded"]>[0]): Promise<void> | void;
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
  get canHandoff() {
    return !this.props.familyId();
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
        renameSession: (name) => this.props.renameSession(name),
        canHandoff: () => this.canHandoff,
        handoffSession: (entryId, prompt, resolveSource) =>
          this.props.handoffSession(entryId, prompt, resolveSource),
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
          this.client.projectSessions.applyConfiguration(
            { sessionId: this.sessionId, configuration },
            { signal: this.signal },
          ),
        setModel: (provider, modelId) =>
          this.client.projectSessions.setModel(
            { sessionId: this.sessionId, provider, modelId },
            { signal: this.signal },
          ),
        setThinkingLevel: (level) =>
          this.client.projectSessions.setThinkingLevel(
            { sessionId: this.sessionId, level },
            { signal: this.signal },
          ),
        setFastMode: (enabled) =>
          this.client.projectSessions.setFastMode(
            { sessionId: this.sessionId, enabled },
            { signal: this.signal },
          ),
      },
      chat: {
        stoppable: () => this.model.backgroundWorkActive,
        commands: () => {
          const commands = this.props.pendingSessions.isTemporary(this.sessionId)
            ? this.stagedCommandStore.commands
            : this.model.commands;
          return this.canHandoff
            ? commands
            : commands.filter(
                (command) => command.name !== "handoff" && command.name !== "handoffandresolve",
              );
        },
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
      const newSession = this.props.newSessionRequest();
      if (newSession) {
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
