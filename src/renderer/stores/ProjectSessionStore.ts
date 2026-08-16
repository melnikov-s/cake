import { Store, child, createStore } from "r-state-tree";
import type { DesktopClient } from "../desktop-client";
import { SessionModel } from "../models/session";
import type { SessionRegistryStore } from "./SessionRegistryStore";
import type { SessionOperationCoordinator } from "./SessionOperationCoordinator";
import type { ReviewsStore } from "./ReviewsStore";
import type { PluginCommandStore } from "./PluginCommandStore";
import { MessageComposerStore } from "./MessageComposerStore";
import { ChatConfigurationStore } from "./ChatConfigurationStore";
import { TranscriptViewStore } from "./TranscriptViewStore";
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
}

/** Owns the view and interaction workflow for one project Pi session. */
export class ProjectSessionStore extends Store<ProjectSessionStoreProps> {
  readonly model: SessionModel;
  draft = "";
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
      this.draft.trim()
      || this.composerStore.attachments.length > 0
      || this.props.reviews().pendingThreads.length > 0
    );
  }

  setDraft(value: string) {
    this.draft = value;
    this.props.persist();
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
      draft: () => this.draft,
      setDraft: (value) => this.setDraft(value),
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
  get transcriptViewStore(): TranscriptViewStore {
    return createStore(TranscriptViewStore);
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
      context: () => this.target
    });
  }
}
