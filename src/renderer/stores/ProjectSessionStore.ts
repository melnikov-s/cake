import { Store, child, createStore } from "r-state-tree";
import type { DesktopClient } from "../desktop-client";
import { Session } from "../../models/Session";
import type { ChatConfiguration, ModelPreset } from "../../ipc/session-contract";
import type { SessionRegistryStore } from "./SessionRegistryStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import type { ReviewsStore } from "./ReviewsStore";
import type { PluginCommandStore } from "./PluginCommandStore";
import { MessageComposerStore } from "./MessageComposerStore";
import { ChatConfigurationStore } from "./ChatConfigurationStore";
import { ChatStore } from "./ChatStore";
import { ArtifactInteractionStore } from "./ArtifactInteractionStore";
import { MessageCommentsStore } from "./MessageCommentsStore";

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
  modelPresets(): readonly ModelPreset[];
  openModelPresetSettings(): void;
  newSessionRequest(): { path: string; configuration?: ChatConfiguration } | undefined;
}

/** Owns the view and interaction workflow for one project Pi session. */
export class ProjectSessionStore extends Store<ProjectSessionStoreProps> {
  readonly model: Session;
  activity: "running" | "unread" | undefined;
  backgroundWorkActive = false;
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

  markHydrated() {
    this.hydrated = true;
  }

  get canSubmit() {
    return (
      this.props.canSubmit() &&
      Boolean(this.chatStore.draft.trim() || this.composerStore.attachments.length > 0)
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
    this.activity = this.props.isActive() ? undefined : "unread";
  }

  setBackgroundWorkActive(active: boolean) {
    this.backgroundWorkActive = active;
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
      canSubmit: () => this.canSubmit,
      isStreaming: () => this.isStreaming,
      openCommandPane: (pane) => this.props.openCommandPane(pane),
      matchesPluginCommand: (input) => this.props.pluginCommands().matches(input),
      runPluginCommand: (input) => this.props.pluginCommands().run(input),
      renameSession: (name) => this.props.renameSession(name),
      operations: this.props.operations,
      operationOwner: `message-composer:${this.sessionId}`,
      newSessionRequest: this.props.newSessionRequest,
    });
  }

  @child
  get configurationStore(): ChatConfigurationStore {
    return createStore(ChatConfigurationStore, {
      session: () => this.model,
      operations: this.props.operations,
      operationOwner: `chat-configuration:${this.sessionId}`,
      presets: this.props.modelPresets,
      openPresetSettings: this.props.openModelPresetSettings,
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
      submit: () => this.composerStore.submit(),
      abort: () => this.props.abort(),
      attachments: () => this.composerStore.attachments,
      addAttachments: () => this.composerStore.addAttachments(),
      addPastedImages: (files) => this.composerStore.addPastedImages(files),
      removeAttachment: (index) => this.composerStore.removeAttachment(index),
      suggestFiles: (prefix) => this.composerStore.suggestFiles(prefix),
      focusRequestRevision: () => this.composerStore.focusRequestRevision,
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
    });
  }

  @child
  get messageCommentsStore(): MessageCommentsStore {
    return createStore(MessageCommentsStore, {
      sessionRegistry: this.props.registry,
      reviews: this.props.reviews,
      draftChatStore: () => this.messageCommentChatStore,
      context: () => ({ sessionId: this.sessionId }),
    });
  }

  @child
  get messageCommentChatStore(): ChatStore {
    return this.messageCommentsStore.draftChatStoreElement;
  }
}
