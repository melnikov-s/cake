import { Store, child, computed, createStore, snapshot } from "r-state-tree";
import type { RendererEvent } from "../RendererEvent";
import type { Session } from "../models/Session";
import type { ChatConfiguration, ModelPreset } from "../../ipc/session-contract";
import type { SessionRegistryStore } from "./SessionRegistryStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import type { ReviewsStore } from "./ReviewsStore";
import { MessageComposerStore } from "./MessageComposerStore";
import { ChatConfigurationStore } from "./ChatConfigurationStore";
import { ChatStore } from "./ChatStore";
import type { AppearanceSettingsStore } from "./AppearanceSettingsStore";
import { ArtifactInteractionStore } from "./ArtifactInteractionStore";
import { MessageCommentsStore } from "./MessageCommentsStore";
import { SubagentActivityStore } from "./SubagentActivityStore";
import { WorktreeStore, type WorktreeStoreProps } from "./WorktreeStore";
import { StagedSessionCommandStore } from "./StagedSessionCommandStore";
import { RendererClientContext } from "../client/RendererClientContext";
import type { ExistingWorktreeCandidate, WorktreeDraftChoice } from "./WorktreeCreationStore";

export interface SessionTarget {
  workspacePath: string;
  sessionId: string;
}

export interface ProjectSessionStoreProps extends SessionTarget {
  model: Session;
  registry: SessionRegistryStore;
  operations: SessionOperationCoordinatorStore;
  reviews(): ReviewsStore;
  canSubmit(): boolean;
  isActive(): boolean;
  openCommandPane(pane: "changelog" | "tree" | "resources"): Promise<void>;
  projectName(): string;
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
  onResolveWorktree(workspacePath: string): Promise<void> | void;
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
    return RendererClientContext.consume(this)!;
  }
  get workspacePath() {
    return this.props.workspacePath;
  }
  get sessionId() {
    return this.props.sessionId;
  }
  get canonicalParts() {
    return this.model.uiParts;
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
  receive(event: RendererEvent) {
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
        this.composerStore.receive(event);
      return;
    }
    if (event.type === "agent-availability-changed" && event.availability.state === "unavailable") {
      if (this.props.operations.active(this.composerOwner).length > 0)
        this.composerStore.receive(event);
      if (this.artifactRequestActive) this.artifactInteractionStore.receive(event);
    }
  }

  get hydrated() {
    return (
      this.props.registry.isTemporarySession(this.sessionId) || Boolean(this.model.sessionFile)
    );
  }

  get canSubmit() {
    return (
      this.props.canSubmit() &&
      Boolean(
        this.chatStore.draft.trim() ||
        this.composerStore.attachments.length > 0 ||
        this.composerStore.annotations.length > 0,
      )
    );
  }

  @computed
  get activity(): "running" | "unread" | "error" | undefined {
    if (this.isStreaming) return "running";
    if (this.props.isActive() || this.model.settledTurnRevision <= this.readSettledTurnRevision)
      return undefined;
    return this.latestTurnErrored ? "error" : "unread";
  }

  markRead() {
    this.readSettledTurnRevision = this.model.settledTurnRevision;
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
      onLanded: this.props.onWorktreeLanded,
      onDiscarded: this.props.onWorktreeDiscarded,
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
  get composerStore(): MessageComposerStore {
    return createStore(MessageComposerStore, {
      sessionRegistry: this.props.registry,
      reviews: this.props.reviews,
      projectPath: () => this.workspacePath,
      sessionId: () => this.sessionId,
      canonicalParts: () => this.canonicalParts,
      draft: () => this.chatStore.draft,
      setDraft: (value) => this.chatStore.setDraft(value),
      canSubmit: () => this.canSubmit,
      isStreaming: () => this.isStreaming,
      openCommandPane: (pane) => this.props.openCommandPane(pane),
      selectModel: (value) => this.configurationStore.selectModel(value),
      renameSession: (name) => this.props.renameSession(name),
      handoffSession: (entryId, prompt, resolveSource) =>
        this.props.handoffSession(entryId, prompt, resolveSource),
      operations: this.props.operations,
      operationOwner: this.composerOwner,
      newSessionRequest: this.props.newSessionRequest,
      prepareNewSession: (firstUserMessage) => this.props.prepareNewSession(firstUserMessage),
      configureDraftActivation: (choice) => this.props.configureDraftActivation(choice),
      sessionCreationChoice: this.props.sessionCreationChoice,
    });
  }

  @child
  get configurationStore(): ChatConfigurationStore {
    return createStore(ChatConfigurationStore, {
      session: () => this.model,
      operations: this.props.operations,
      operationOwner: this.configurationOwner,
      presets: this.props.modelPresets,
      openPresetSettings: this.props.openModelPresetSettings,
      deferredNewSession: () => this.props.registry.isTemporarySession(this.sessionId),
      effectiveConfiguration: () => this.props.newSessionRequest()?.configuration,
      setPendingConfiguration: (configuration) =>
        this.props.registry.setPendingConfiguration(this.sessionId, configuration),
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
    });
  }

  @child
  get stagedCommandStore(): StagedSessionCommandStore {
    return createStore(StagedSessionCommandStore);
  }

  @child
  get chatStore(): ChatStore {
    return createStore(ChatStore, {
      id: () => this.sessionId,
      parts: () => this.composerStore.parts,
      streaming: () => this.isStreaming,
      submitting: () =>
        this.composerStore.activeOperations.length > 0 || this.model.activeTurnIds.length > 0,
      stoppable: () => this.model.backgroundWorkActive,
      configuration: () => this.configurationStore,
      commands: () =>
        this.props.registry.isTemporarySession(this.sessionId)
          ? this.stagedCommandStore.commands
          : this.model.commands,
      placeholder: () =>
        this.isStreaming
          ? "Add the next instruction…"
          : `Ask Cake to work in ${this.props.projectName()}…`,
      inputLabel: () => "Message",
      canSubmit: () => this.canSubmit,
      submit: (_draft, options) =>
        this.composerStore.submit(undefined, options?.renderUserMessageAsMarkdown ?? false),
      setUserMessageMarkdown: (entryId, renderAsMarkdown) =>
        this.client.projectSessions.setUserMessageMarkdown(
          { sessionId: this.sessionId, entryId, renderAsMarkdown },
          { signal: this.signal },
        ),
      activateDraft: (choice) => this.composerStore.activateDraftSession(choice),
      sessionCreationChoice: this.props.sessionCreationChoice,
      draftActivationCandidates: this.props.draftActivationCandidates,
      editLastUserMessage: (entryId) =>
        this.composerStore.beginEditMessage(
          entryId,
          this.model.tree.find((entry) => entry.id === entryId)?.editorText,
        ),
      isDraftSession: () => this.props.registry.isDraftSession(this.sessionId),
      editingMessage: () =>
        Boolean(this.composerStore.editingEntryId || this.composerStore.editingDraftSession),
      abort: () => this.props.abort(),
      attachments: () => this.composerStore.visibleAttachments,
      addAttachments: () => this.composerStore.addAttachments(),
      addPastedImages: (files) => this.composerStore.addPastedImages(files),
      removeAttachment: (index) => this.composerStore.removeAttachment(index),
      annotations: () => this.composerStore.annotations,
      addAnnotation: (annotation) => this.composerStore.addAnnotation(annotation),
      updateAnnotation: (id, update) => this.composerStore.updateAnnotation(id, update),
      removeAnnotation: (id) => this.composerStore.removeAnnotation(id),
      suggestFiles: (prefix) => this.composerStore.suggestFiles(prefix),
      focusRequestRevision: () => this.composerStore.focusRequestRevision,
      showComposerContextMenu: (selection, x, y) =>
        this.client.electron.showComposerContextMenu({ selection, x, y }, { signal: this.signal }),
      rewordComposerSelection: (selection, prompt) =>
        this.client.workspaces.rewordComposerSelection(
          {
            selection,
            prompt,
            workingDirectory: this.props.workspacePath,
          },
          { signal: this.signal },
        ),
      usage: () => this.model.usage,
      queuedPrompts: () => this.composerStore.queuedPrompts,
      steerQueuedPrompt: (id) => this.composerStore.steerQueuedPrompt(id),
      editQueuedPrompt: (id) => this.composerStore.editQueuedPrompt(id),
      removeQueuedPrompt: (id) => this.composerStore.removeQueuedPrompt(id),
      hideThinking: () => Boolean(this.model.piSettings?.hideThinkingBlock),
      error: () => ({
        message:
          this.composerStore.error ??
          this.configurationStore.error ??
          this.stagedCommandStore.error,
        details:
          this.composerStore.errorDetails ??
          this.configurationStore.errorDetails ??
          this.stagedCommandStore.errorDetails,
      }),
      workLogViewMode: () => this.props.settings?.()?.workLogViewMode,
      setWorkLogViewMode: (mode) => {
        this.props.settings?.()?.setWorkLogViewMode(mode);
      },
      workLogsExpansion: () => this.props.settings?.()?.workLogsExpansion,
      setWorkLogsExpansion: (expansion) => {
        this.props.settings?.()?.setWorkLogsExpansion(expansion);
      },
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
      sessionRegistry: this.props.registry,
      reviews: this.props.reviews,
      context: () => ({ sessionId: this.sessionId }),
    });
  }
}
