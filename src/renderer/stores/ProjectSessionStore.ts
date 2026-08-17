import { Store, child, createStore } from "r-state-tree";
import type { DesktopClient } from "../desktop-client";
import { SessionModel } from "../models/session";
import type { SessionRegistryStore } from "./SessionRegistryStore";
import type { SessionOperationCoordinator } from "./SessionOperationCoordinator";
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

export function sessionTargetKey(target: SessionTarget) {
  return `${target.workspacePath}\u0000${target.sessionId}`;
}

export interface ProjectSessionStoreProps extends SessionTarget {
  client: DesktopClient;
  registry: SessionRegistryStore;
  operations: SessionOperationCoordinator;
  reviews(): ReviewsStore;
  pluginCommands(): PluginCommandStore;
  canSubmit(): boolean;
  isActive(): boolean;
  openCommandPane(pane: "changelog" | "tree" | "resources"): Promise<void>;
  persist(): void;
  projectName(): string;
  abort(): Promise<void>;
}

/** Owns the view and interaction workflow for one project Pi session. */
export class ProjectSessionStore extends Store<ProjectSessionStoreProps> {
  readonly model: SessionModel;
  activity: "running" | "unread" | undefined;

  constructor(props: ProjectSessionStore["props"]) {
    super(props);
    this.model = SessionModel.create({ sessionId: props.sessionId, workspacePath: props.workspacePath });
    this.effect(() => () => this.model[Symbol.dispose]());
  }

  get target(): SessionTarget {
    return { workspacePath: this.props.workspacePath, sessionId: this.props.sessionId };
  }

  get workspacePath() { return this.props.workspacePath; }
  get sessionId() { return this.props.sessionId; }
  get canonicalParts() { return this.model.uiParts; }
  get isStreaming() { return this.model.streaming; }
  get canSubmit() {
    return this.props.canSubmit() && Boolean(
      this.chatStore.draft.trim()
      || this.composerStore.attachments.length > 0
      || this.props.reviews().pendingThreads.length > 0
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
      operations: this.props.operations,
      operationOwner: `message-composer:${sessionTargetKey(this.target)}`
    });
  }

  @child
  get configurationStore(): ChatConfigurationStore {
    return createStore(ChatConfigurationStore, {
      session: () => this.model,
      operations: this.props.operations,
      operationOwner: `chat-configuration:${sessionTargetKey(this.target)}`,
      setModel: (operationId, provider, modelId) => this.props.client.setModel({ operationId, ...this.target, provider, modelId }),
      setThinkingLevel: (operationId, level) => this.props.client.setThinkingLevel({ operationId, ...this.target, level })
    });
  }

  @child
  get chatStore(): ChatStore {
    return createStore(ChatStore, {
      id: () => this.sessionId,
      parts: () => this.composerStore.parts,
      streaming: () => this.isStreaming,
      submitting: () => this.composerStore.activeOperations.length > 0,
      configuration: () => this.configurationStore,
      commands: () => [...this.model.commands, ...this.props.pluginCommands().commands],
      placeholder: () => this.isStreaming ? "Add the next instruction…" : `Ask Cake to work in ${this.props.projectName()}…`,
      inputLabel: () => "Message",
      canSubmit: () => this.canSubmit,
      submit: async (_draft, mode) => { await this.composerStore.submit(mode === "steer" ? "steer" : undefined); },
      abort: () => this.props.abort(),
      attachments: () => this.composerStore.attachments,
      addAttachments: () => this.composerStore.addAttachments(),
      addPastedImages: (files) => this.composerStore.addPastedImages(files),
      removeAttachment: (index) => this.composerStore.removeAttachment(index),
      suggestFiles: (prefix) => this.composerStore.suggestFiles(prefix),
      focusRequestRevision: () => this.composerStore.focusRequestRevision,
      usage: () => this.model.usage,
      allowSteer: true,
      hideThinking: () => Boolean(this.model.piSettings?.hideThinkingBlock),
      error: () => ({ message: this.composerStore.error ?? this.configurationStore.error, details: this.composerStore.errorDetails ?? this.configurationStore.errorDetails }),
      persist: () => this.props.persist()
    });
  }

  @child
  get artifactInteractionStore(): ArtifactInteractionStore {
    return createStore(ArtifactInteractionStore, {
      client: this.props.client,
      sessionContext: () => this.target,
      isActiveSession: (workspacePath, sessionId) => this.props.isActive() && workspacePath === this.workspacePath && sessionId === this.sessionId,
      operationActive: (operationId) => this.props.operations.includes(operationId)
    });
  }

  @child
  get messageCommentsStore(): MessageCommentsStore {
    return createStore(MessageCommentsStore, {
      client: this.props.client,
      sessionRegistry: this.props.registry,
      reviews: this.props.reviews,
      draftChatStore: () => this.messageCommentChatStore,
      context: () => this.target
    });
  }

  @child
  get messageCommentChatStore(): ChatStore {
    return this.messageCommentsStore.draftChatStoreElement;
  }
}
