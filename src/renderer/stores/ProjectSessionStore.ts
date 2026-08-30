import { Store, child, createStore } from "r-state-tree";
import type { DesktopClient, DesktopClientEvent } from "../desktop-client";
import { Session } from "../../models/Session";
import type { ChatConfiguration, ModelPreset } from "../../ipc/session-contract";
import type { SessionRegistryStore } from "./SessionRegistryStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import type { ReviewsStore } from "./ReviewsStore";
import type { PluginCommandStore } from "./PluginCommandStore";
import { MessageComposerStore } from "./MessageComposerStore";
import { ChatConfigurationStore } from "./ChatConfigurationStore";
import { ChatStore } from "./ChatStore";
import type { AppearanceSettingsStore } from "./AppearanceSettingsStore";
import { ArtifactInteractionStore } from "./ArtifactInteractionStore";
import { MessageCommentsStore } from "./MessageCommentsStore";
import { SubagentActivityStore } from "./SubagentActivityStore";
import { WorktreeStore, type WorktreeStoreProps } from "./WorktreeStore";
import type { ExistingWorktreeCandidate, WorktreeDraftChoice } from "./WorktreeCreationStore";

export interface SessionTarget {
  workspacePath: string;
  sessionId: string;
}

export interface ProjectSessionStoreProps extends SessionTarget {
  client: DesktopClient;
  registry: SessionRegistryStore;
  operations: SessionOperationCoordinatorStore;
  reviews(): ReviewsStore;
  pluginCommands(): PluginCommandStore;
  canSubmit(): boolean;
  isActive(): boolean;
  openCommandPane(pane: "changelog" | "tree" | "resources"): Promise<void>;
  persist(): void;
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
  draftActivationCandidates(): ExistingWorktreeCandidate[];
  worktreeClient: WorktreeStoreProps["client"];
  onWorktreeLanded(record: Parameters<WorktreeStoreProps["onLanded"]>[0]): Promise<void> | void;
  onWorktreeDiscarded(
    record: Parameters<WorktreeStoreProps["onDiscarded"]>[0],
  ): Promise<void> | void;
  onResolveWorktree(workspacePath: string): Promise<void> | void;
  settings?(): AppearanceSettingsStore | undefined;
}

/** Owns the view and interaction workflow for one project Pi session. */
export class ProjectSessionStore extends Store<ProjectSessionStoreProps> {
  readonly model: Session;
  activity: "running" | "unread" | "error" | undefined;
  backgroundWorkActive = false;
  private artifactRequestActive = false;
  // Drafts and review threads can create this Store before its transcript is loaded.
  hydrated = false;

  constructor(props: ProjectSessionStore["props"]) {
    super(props);
    this.model = Session.create({
      sessionId: props.sessionId,
      workspacePath: props.workspacePath,
    });
    this.effect(() => () => this.model[Symbol.dispose]());
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
  receive(event: DesktopClientEvent) {
    if (event.type === "subagent-activity-received" || event.type === "subagent-activity-removed") {
      this.subagentActivityStore.receive(event);
      return;
    }
    if (event.type === "artifact-requested") {
      if (event.record.artifact.sessionId !== this.sessionId) return;
      this.artifactRequestActive = true;
      this.artifactInteractionStore.receive(event);
      return;
    }
    if (event.type === "session-snapshot-received") {
      if (
        event.snapshot.sessionId === this.sessionId &&
        this.props.operations.active(this.configurationOwner).length > 0
      )
        this.configurationStore.receive(event);
      return;
    }
    if (event.type === "operation-completed" || event.type === "operation-failed") {
      if (
        event.operationId &&
        this.props.operations.includes(event.operationId, this.composerOwner)
      )
        this.composerStore.receive(event);
      if (
        event.operationId &&
        this.props.operations.includes(event.operationId, this.configurationOwner)
      )
        this.configurationStore.receive(event);
      return;
    }
    if (
      event.type === "pi-state-changed" &&
      (event.state === "failed" || event.state === "stopped")
    ) {
      if (this.props.operations.active(this.composerOwner).length > 0)
        this.composerStore.receive(event);
      if (this.props.operations.active(this.configurationOwner).length > 0)
        this.configurationStore.receive(event);
      if (this.artifactRequestActive) this.artifactInteractionStore.receive(event);
    }
  }

  markHydrated() {
    this.hydrated = true;
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

  markRead() {
    if (this.activity === "unread") this.activity = undefined;
  }

  updateActivity(streaming: boolean, wasStreaming = false) {
    if (streaming) {
      this.activity = "running";
      return;
    }
    if (this.activity !== "running" && !wasStreaming) return;
    if (this.latestTurnErrored) {
      this.activity = "error";
      return;
    }
    this.activity = this.props.isActive() ? undefined : "unread";
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

  setBackgroundWorkActive(active: boolean) {
    this.backgroundWorkActive = active;
  }

  @child
  get worktreeStore(): WorktreeStore {
    return createStore(WorktreeStore, {
      client: this.props.worktreeClient,
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
      client: this.props.client,
      parts: () => this.canonicalParts,
    });
  }

  @child
  get composerStore(): MessageComposerStore {
    return createStore(MessageComposerStore, {
      client: this.props.client,
      sessionRegistry: this.props.registry,
      reviews: this.props.reviews,
      projectPath: () => this.workspacePath,
      sessionId: () => this.sessionId,
      canonicalParts: () => this.canonicalParts,
      draft: () => this.chatStore.draft,
      setDraft: (value) => this.chatStore.setDraft(value),
      persist: () => this.props.persist(),
      canSubmit: () => this.canSubmit,
      isStreaming: () => this.isStreaming,
      openCommandPane: (pane) => this.props.openCommandPane(pane),
      matchesPluginCommand: (input) => this.props.pluginCommands().matches(input),
      runPluginCommand: (input) => this.props.pluginCommands().run(input),
      renameSession: (name) => this.props.renameSession(name),
      handoffSession: (entryId, prompt, resolveSource) =>
        this.props.handoffSession(entryId, prompt, resolveSource),
      operations: this.props.operations,
      operationOwner: this.composerOwner,
      newSessionRequest: this.props.newSessionRequest,
      prepareNewSession: (firstUserMessage) => this.props.prepareNewSession(firstUserMessage),
      configureDraftActivation: (choice) => this.props.configureDraftActivation(choice),
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
      listModels: () => this.props.client.listModels(),
      setConfiguration: (operationId, configuration) =>
        this.props.client.setChatConfiguration({
          operationId,
          sessionId: this.sessionId,
          configuration,
        }),
      setModel: (operationId, provider, modelId) =>
        this.props.client.setModel({ operationId, sessionId: this.sessionId, provider, modelId }),
      setThinkingLevel: (operationId, level) =>
        this.props.client.setThinkingLevel({ operationId, sessionId: this.sessionId, level }),
      setFastMode: (operationId, enabled) =>
        this.props.client.setFastMode({ operationId, sessionId: this.sessionId, enabled }),
    });
  }

  @child
  get chatStore(): ChatStore {
    return createStore(ChatStore, {
      id: () => this.sessionId,
      parts: () => this.composerStore.parts,
      streaming: () => this.isStreaming,
      submitting: () => this.composerStore.activeOperations.length > 0,
      stoppable: () => this.backgroundWorkActive,
      configuration: () => this.configurationStore,
      commands: () => [...this.model.commands, ...this.props.pluginCommands().commands],
      placeholder: () =>
        this.isStreaming
          ? "Add the next instruction…"
          : `Ask Cake to work in ${this.props.projectName()}…`,
      inputLabel: () => "Message",
      canSubmit: () => this.canSubmit,
      submit: (_draft, options) =>
        this.composerStore.submit(undefined, options?.renderUserMessageAsMarkdown ?? false),
      supportsUserMessageMarkdown: () => true,
      createDraft: () => this.composerStore.createDraftSession(),
      canCreateDraft: () =>
        this.props.registry.isTemporarySession(this.sessionId) &&
        !this.props.registry.isDraftSession(this.sessionId),
      activateDraft: (choice) => this.composerStore.activateDraftSession(choice),
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
        this.props.client.showComposerContextMenu({ selection, x, y }),
      rewordComposerSelection: (selection, prompt) =>
        this.props.client.rewordComposerSelection({
          selection,
          prompt,
          workspacePath: this.props.workspacePath,
        }),
      usage: () => this.model.usage,
      queuedPrompts: () => this.composerStore.queuedPrompts,
      steerQueuedPrompt: (id) => this.composerStore.steerQueuedPrompt(id),
      editQueuedPrompt: (id) => this.composerStore.editQueuedPrompt(id),
      removeQueuedPrompt: (id) => this.composerStore.removeQueuedPrompt(id),
      hideThinking: () => Boolean(this.model.piSettings?.hideThinkingBlock),
      error: () => ({
        message: this.composerStore.error ?? this.configurationStore.error,
        details: this.composerStore.errorDetails ?? this.configurationStore.errorDetails,
      }),
      persist: () => this.props.persist(),
      workLogViewMode: () => this.props.settings?.()?.workLogViewMode,
      setWorkLogViewMode: (mode) => {
        this.props.settings?.()?.setWorkLogViewMode(mode);
        this.props.persist();
      },
      workLogsExpansion: () => this.props.settings?.()?.workLogsExpansion,
      setWorkLogsExpansion: (expansion) => {
        this.props.settings?.()?.setWorkLogsExpansion(expansion);
        this.props.persist();
      },
    });
  }

  @child
  get artifactInteractionStore(): ArtifactInteractionStore {
    return createStore(ArtifactInteractionStore, {
      client: this.props.client,
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
