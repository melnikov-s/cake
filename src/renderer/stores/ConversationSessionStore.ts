import { Store, child, createStore } from "r-state-tree";
import type { Session } from "../models/Session";
import type { ModelPreset, SessionSnapshot } from "../../ipc/session-contract";
import type { StoreEvent } from "../events/StoreEvent";
import {
  ConversationComposerStore,
  type ConversationComposerStoreProps,
} from "./ConversationComposerStore";
import { ChatConfigurationStore, type ChatConfigurationStoreProps } from "./ChatConfigurationStore";
import { ChatStore, type ChatStoreProps, type QueuedPrompt } from "./ChatStore";
import type { AppearanceSettingsStore } from "./AppearanceSettingsStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import type { ExistingWorktreeCandidate, WorktreeDraftChoice } from "./WorktreeCreationStore";
import type { ScheduledMessageCapabilities } from "./ScheduledMessageInteractionStore";
import type { UserMessagePresentationCapabilities } from "./TranscriptInteractionStore";
import { ClientContext } from "./context/ClientContext";

type ComposerCapabilities = Omit<
  ConversationComposerStoreProps,
  | "sessionId"
  | "canonicalParts"
  | "canSubmit"
  | "isStreaming"
  | "selectModel"
  | "operations"
  | "operationOwner"
>;

type ConfigurationCapabilities = Omit<
  ChatConfigurationStoreProps,
  "session" | "operations" | "operationOwner" | "presets" | "openPresetSettings"
>;

interface ConversationChatCapabilities {
  commands(): SessionSnapshot["commands"];
  placeholder(): string;
  inputLabel(): string;
  userMessagePresentation: UserMessagePresentationCapabilities;
  stoppable?(): boolean;
  abort?(): Promise<void>;
  addAttachments?(): Promise<void>;
  suggestFiles?(prefix: string): ReturnType<NonNullable<ChatStoreProps["suggestFiles"]>>;
  sessionCreationChoice?(): WorktreeDraftChoice;
  draftActivationCandidates?(): ExistingWorktreeCandidate[];
  isDraftSession?(): boolean;
  steeringPrompts?(): readonly QueuedPrompt[];
  scheduledMessages?: ScheduledMessageCapabilities;
  rewordWorkingDirectory?(): string | undefined;
  fallbackError?(): { message?: string; details?: string };
  configurationErrorFirst?: boolean;
  errorTitle?: string;
}

export interface ConversationSessionStoreProps {
  sessionId: string;
  model: Session;
  operations: SessionOperationCoordinatorStore;
  composerOperationOwner: string;
  configurationOperationOwner: string;
  canSubmit(): boolean;
  composer: ComposerCapabilities;
  configuration: ConfigurationCapabilities;
  chat: ConversationChatCapabilities;
  modelPresets(): readonly ModelPreset[];
  openModelPresetSettings(): void;
  settings?(): AppearanceSettingsStore | undefined;
  resetOperationOwnersOnDispose?: boolean;
}

/** Owns the common active-conversation children and wiring for one primary Cake session. */
export class ConversationSessionStore extends Store<ConversationSessionStoreProps> {
  constructor(props: ConversationSessionStore["props"]) {
    super(props);
    if (props.resetOperationOwnersOnDispose)
      this.effect(() => () => {
        props.operations.reset(props.composerOperationOwner);
        props.operations.reset(props.configurationOperationOwner);
      });
  }

  get client() {
    return ClientContext.consume(this)!;
  }

  get sessionId() {
    return this.props.sessionId;
  }

  get model() {
    return this.props.model;
  }

  get streaming() {
    return this.model.streaming;
  }

  get canSubmit() {
    return this.props.canSubmit() && this.composerStore.draftStore.hasContent;
  }

  @child
  get composerStore(): ConversationComposerStore {
    return createStore(ConversationComposerStore, {
      ...this.props.composer,
      sessionId: () => this.sessionId,
      canonicalParts: () => this.model.uiParts,
      canSubmit: () => this.canSubmit,
      isStreaming: () => this.streaming,
      selectModel: async (value) => {
        await this.configurationStore.selectModel(value);
        return !this.signal.aborted && !this.configurationStore.error;
      },
      operations: this.props.operations,
      operationOwner: this.props.composerOperationOwner,
    });
  }

  @child
  get configurationStore(): ChatConfigurationStore {
    return createStore(ChatConfigurationStore, {
      ...this.props.configuration,
      session: () => this.model,
      operations: this.props.operations,
      operationOwner: this.props.configurationOperationOwner,
      presets: this.props.modelPresets,
      openPresetSettings: this.props.openModelPresetSettings,
    });
  }

  @child
  get chatStore(): ChatStore {
    const capabilities = this.props.chat;
    return createStore(ChatStore, {
      id: () => this.sessionId,
      parts: () => this.composerStore.parts,
      streaming: () => this.streaming,
      draft: () => this.composerStore.draftStore.text,
      setDraft: (value) => this.composerStore.draftStore.setText(value),
      submitting: () =>
        this.composerStore.deliveryStore.activeOperations.length > 0 ||
        this.model.activeTurnIds.length > 0,
      stoppable: capabilities.stoppable,
      configuration: () => this.configurationStore,
      commands: capabilities.commands,
      placeholder: capabilities.placeholder,
      inputLabel: capabilities.inputLabel,
      canSubmit: () => this.canSubmit,
      submit: (_draft, options) =>
        this.composerStore.submit(undefined, options?.renderUserMessageAsMarkdown ?? false),
      userMessagePresentation: capabilities.userMessagePresentation,
      activateDraft: (choice) => this.composerStore.activateDraftSession(choice),
      sessionCreationChoice: capabilities.sessionCreationChoice,
      draftActivationCandidates: capabilities.draftActivationCandidates,
      editLastUserMessage: (entryId) => this.composerStore.beginEditMessage(entryId),
      isDraftSession: capabilities.isDraftSession,
      editingMessage: () => this.composerStore.editingMessage,
      abort: capabilities.abort,
      attachments: () => this.composerStore.draftStore.visibleAttachments,
      addAttachments: capabilities.addAttachments,
      addPastedImages: (files) => this.composerStore.draftStore.addPastedImages(files),
      removeAttachment: (index) => this.composerStore.draftStore.removeAttachment(index),
      annotations: () => this.composerStore.draftStore.annotationDraft.annotations,
      addAnnotation: (annotation) => this.composerStore.draftStore.annotationDraft.add(annotation),
      updateAnnotation: (id, update) =>
        this.composerStore.draftStore.annotationDraft.update(id, update),
      removeAnnotation: (id) => this.composerStore.draftStore.annotationDraft.remove(id),
      suggestFiles: capabilities.suggestFiles,
      focusRequestRevision: () => this.composerStore.draftStore.focusRequestRevision,
      usage: () => this.model.usage,
      queuedPrompts: this.props.composer.queueWhileStreaming
        ? () => [
            ...this.composerStore.promptQueueStore.prompts.map((entry) => ({
              ...entry,
              state: "queued" as const,
            })),
            ...(capabilities.steeringPrompts?.() ?? []),
          ]
        : undefined,
      steerQueuedPrompt: this.props.composer.queueWhileStreaming
        ? (id) => this.composerStore.promptQueueStore.steer(id)
        : undefined,
      editQueuedPrompt: this.props.composer.queueWhileStreaming
        ? (id) => this.composerStore.promptQueueStore.edit(id)
        : undefined,
      removeQueuedPrompt: this.props.composer.queueWhileStreaming
        ? (id) => this.composerStore.promptQueueStore.remove(id)
        : undefined,
      cancelSteering: this.props.composer.queueWhileStreaming
        ? () => this.composerStore.promptQueueStore.cancelSteering()
        : undefined,
      scheduledMessages: capabilities.scheduledMessages,
      composerReword: {
        showContextMenu: (selection, x, y) =>
          this.client.electron.showComposerContextMenu(
            { selection, x, y },
            { signal: this.signal },
          ),
        rewordSelection: (selection, prompt) =>
          this.client.workspaces.rewordComposerSelection(
            {
              selection,
              prompt,
              ...(capabilities.rewordWorkingDirectory?.() === undefined
                ? null
                : { workingDirectory: capabilities.rewordWorkingDirectory() }),
            },
            { signal: this.signal },
          ),
      },
      hideThinking: () => Boolean(this.model.piSettings?.hideThinkingBlock),
      error: () => this.error,
      workLogPresentation: {
        viewMode: () => this.props.settings?.()?.workLogViewMode,
        setViewMode: (mode) => this.props.settings?.()?.setWorkLogViewMode(mode),
        expansion: () => this.props.settings?.()?.workLogsExpansion,
        setExpansion: (expansion) => this.props.settings?.()?.setWorkLogsExpansion(expansion),
      },
    });
  }

  get error() {
    const fallback = this.props.chat.fallbackError?.();
    const message = this.props.chat.configurationErrorFirst
      ? (this.configurationStore.error ?? this.composerStore.error ?? fallback?.message)
      : (this.composerStore.error ?? this.configurationStore.error ?? fallback?.message);
    const details = this.props.chat.configurationErrorFirst
      ? (this.configurationStore.errorDetails ??
        this.composerStore.errorDetails ??
        fallback?.details)
      : (this.composerStore.errorDetails ??
        this.configurationStore.errorDetails ??
        fallback?.details);
    return { message, details, title: this.props.chat.errorTitle };
  }

  receive(event: StoreEvent) {
    this.composerStore.receive(event);
  }
}
