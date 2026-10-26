import { Store, child, createStore, effect as reactiveEffect } from "r-state-tree";
import type { Conversation } from "../models/Conversation";
import type {
  ModelPreset,
  ConversationSnapshot,
  UiPart,
} from "../../contracts/conversations/session-contract";
import type { ComposerDeliveryInput } from "./ConversationComposerStore";
import {
  cakeChatSideChatConversationId,
  isCakeChatSessionId,
} from "../../contracts/cake-chats/cake-chat-identity";
import type { StoreEvent } from "../events/StoreEvent";
import {
  ConversationComposerStore,
  type ConversationComposerStoreProps,
} from "./ConversationComposerStore";
import { ChatConfigurationStore, type ChatConfigurationStoreProps } from "./ChatConfigurationStore";
import { ChatStore, type ChatStoreProps, type QueuedPrompt } from "./ChatStore";
import { queuedPrompts } from "../lib/queued-prompts";
import { ConversationInterviewStore } from "./ConversationInterviewStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import { SideChatStore } from "./SideChatStore";
import { ContextInspectorStore } from "./ContextInspectorStore";
import type { ExistingWorktreeCandidate, WorktreeDraftChoice } from "./WorktreeCreationStore";
import type { ScheduledMessageCapabilities } from "./ScheduledMessageInteractionStore";
import { ClientContext } from "./context/ClientContext";
import { DeliveryAvailabilityContext } from "./context/DeliveryAvailabilityContext";

type ComposerCapabilities = Omit<
  ConversationComposerStoreProps,
  | "sessionId"
  | "canonicalParts"
  | "canSubmit"
  | "isStreaming"
  | "selectModel"
  | "operations"
  | "operationOwner"
  | "deliver"
  | "editMessage"
  | "compact"
>;

type ConfigurationCapabilities = Omit<
  ChatConfigurationStoreProps,
  | "session"
  | "operations"
  | "operationOwner"
  | "presets"
  | "openPresetSettings"
  | "setConfiguration"
  | "setModel"
  | "setThinkingLevel"
  | "setFastMode"
>;

interface ConversationChatCapabilities {
  contextUsage?: boolean;
  history?: ChatStoreProps["history"];
  commands(): ConversationSnapshot["commands"];
  placeholder(): string;
  inputLabel(): string;
  /** Kind-specific context shown ahead of the transcript, such as a Discussion anchor. */
  leadingParts?(): UiPart[];
  suggestFiles?(prefix: string): ReturnType<NonNullable<ChatStoreProps["suggestFiles"]>>;
  sessionCreationChoice?(): WorktreeDraftChoice;
  draftActivationCandidates?(): ExistingWorktreeCandidate[];
  isDraftSession?(): boolean;
  scheduledMessages?: ScheduledMessageCapabilities;
  conversationMode?: ChatStoreProps["conversationMode"];
  /** Hidden for a conversation whose model is fixed by its kind, such as the session assistant. */
  modelPickerVisible?(): boolean;
  rewordWorkingDirectory?(): string | undefined;
  fallbackError?(): { message?: string; details?: string };
}

export interface ConversationSessionStoreProps {
  sessionId: string;
  model: Conversation;
  operations: SessionOperationCoordinatorStore;
  canSubmit(): boolean;
  /** Creates the kind-specific runtime profile for a not-yet-materialized session. */
  startSession?(input: ComposerDeliveryInput): Promise<boolean>;
  /** Restores and assembles an existing runtime before a shared conversation command. */
  ensureSessionActive(): boolean | Promise<boolean>;
  composer: ComposerCapabilities;
  configuration: ConfigurationCapabilities;
  chat: ConversationChatCapabilities;
  modelPresets(): readonly ModelPreset[];
  openModelPresetSettings(): void;
}

/** Owns the common active-conversation children and wiring for one primary Cake session. */
export class ConversationSessionStore extends Store<ConversationSessionStoreProps> {
  constructor(props: ConversationSessionStore["props"]) {
    super(props);
    this.effect(() => () => {
      props.operations.reset(this.composerOperationOwner);
      props.operations.reset(this.configurationOperationOwner);
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

  private get composerOperationOwner() {
    return `session-chat-composer:${this.sessionId}`;
  }

  private get configurationOperationOwner() {
    return `session-chat-configuration:${this.sessionId}`;
  }

  get canSubmit() {
    return (
      (DeliveryAvailabilityContext.consume(this)?.() ?? true) &&
      this.props.canSubmit() &&
      this.composerStore.draftStore.hasContent
    );
  }

  @child
  get composerStore(): ConversationComposerStore {
    return createStore(ConversationComposerStore, {
      ...this.props.composer,
      sessionId: () => this.sessionId,
      deliver: (input) => this.deliver(input),
      editMessage: (input) =>
        this.withActiveSession(async () => {
          await this.client.sessionChats.editMessage(input, { signal: this.signal });
        }),
      compact: (sessionId, instructions) =>
        this.withActiveSession(async () => {
          await this.client.sessionChats.compact(
            { sessionId, instructions },
            { signal: this.signal },
          );
        }),
      canonicalParts: () => this.model.uiParts,
      canSubmit: () => this.canSubmit,
      isStreaming: () => this.streaming,
      selectModel: async (value) => {
        await this.configurationStore.selectModel(value);
        return !this.signal.aborted && !this.configurationStore.error;
      },
      operations: this.props.operations,
      operationOwner: this.composerOperationOwner,
    });
  }

  @child
  get configurationStore(): ChatConfigurationStore {
    return createStore(ChatConfigurationStore, {
      ...this.props.configuration,
      session: () => this.model,
      setConfiguration: (configuration) =>
        this.configureActiveSession(() =>
          this.client.sessionChats.applyConfiguration(
            { sessionId: this.sessionId, configuration },
            { signal: this.signal },
          ),
        ),
      setModel: (provider, modelId) =>
        this.configureActiveSession(() =>
          this.client.sessionChats.setModel(
            { sessionId: this.sessionId, provider, modelId },
            { signal: this.signal },
          ),
        ),
      setThinkingLevel: (level) =>
        this.configureActiveSession(() =>
          this.client.sessionChats.setThinkingLevel(
            { sessionId: this.sessionId, level },
            { signal: this.signal },
          ),
        ),
      setFastMode: (enabled) =>
        this.configureActiveSession(() =>
          this.client.sessionChats.setFastMode(
            { sessionId: this.sessionId, enabled },
            { signal: this.signal },
          ),
        ),
      operations: this.props.operations,
      operationOwner: this.configurationOperationOwner,
      presets: this.props.modelPresets,
      openPresetSettings: this.props.openModelPresetSettings,
    });
  }

  @child
  get contextInspectorStore(): ContextInspectorStore {
    return createStore(ContextInspectorStore, {
      sessionId: this.sessionId,
      status: () => this.model.usage?.cakeChatContext,
      isPending: () => this.props.configuration.deferredNewSession?.() ?? false,
    });
  }

  @child
  get interviewStore(): ConversationInterviewStore {
    return createStore(ConversationInterviewStore, {
      sessionId: this.sessionId,
      parts: () => this.model.uiParts,
      isStreaming: () => this.streaming,
      operations: this.props.operations,
    });
  }

  @child
  get sideChatStore(): SideChatStore {
    return createStore(SideChatStore, {
      onClose: () => this.composerStore.draftStore.requestFocus(),
    });
  }

  @child
  get chatStore(): ChatStore {
    const capabilities = this.props.chat;
    const durable =
      isCakeChatSessionId(this.sessionId) ||
      cakeChatSideChatConversationId(this.sessionId) !== undefined;
    return createStore(ChatStore, {
      id: () => this.sessionId,
      parts: () =>
        capabilities.leadingParts
          ? [...capabilities.leadingParts(), ...this.composerStore.parts]
          : this.composerStore.parts,
      attachmentImages: () => this.composerStore.deliveryStore.attachmentImages,
      streaming: () => this.streaming,
      draft: () => this.composerStore.draftStore.text,
      setDraft: (value) => this.composerStore.draftStore.setText(value),
      submitting: () =>
        this.composerStore.deliveryStore.activeOperations.length > 0 ||
        this.model.activeTurnIds.length > 0,
      configuration: () => this.configurationStore,
      commands: capabilities.commands,
      placeholder: capabilities.placeholder,
      inputLabel: capabilities.inputLabel,
      canSubmit: () => this.canSubmit,
      submit: (_draft, options) =>
        this.composerStore.submit(undefined, options?.renderUserMessageAsMarkdown ?? false),
      userMessagePresentation: {
        setMarkdown: (entryId, renderAsMarkdown) =>
          this.client.sessionChats.setUserMessageMarkdown(
            { sessionId: this.sessionId, entryId, renderAsMarkdown },
            { signal: this.signal },
          ),
      },
      activateDraft: (choice) => this.composerStore.activateDraftSession(choice),
      sessionCreationChoice: capabilities.sessionCreationChoice,
      draftActivationCandidates: capabilities.draftActivationCandidates,
      // Durable supports saved display preferences, not transcript rewriting.
      // Unsent Cake Chat drafts still use the shared draft editor.
      editLastUserMessage:
        !durable || this.props.configuration.deferredNewSession?.()
          ? (entryId) => this.composerStore.beginEditMessage(entryId)
          : undefined,
      isDraftSession: capabilities.isDraftSession,
      editingMessage: () => this.composerStore.editingMessage,
      abort: () => this.abort(),
      attachments: () => this.composerStore.draftStore.visibleAttachments,
      addPastedImages: (files) => this.composerStore.draftStore.addPastedImages(files),
      addPastedText: (text) => this.composerStore.draftStore.addPastedText(text),
      removeAttachment: (index) => this.composerStore.draftStore.removeAttachment(index),
      annotations: () => this.composerStore.draftStore.annotationDraft.annotations,
      addAnnotation: (annotation) => this.composerStore.draftStore.annotationDraft.add(annotation),
      updateAnnotation: (id, update) =>
        this.composerStore.draftStore.annotationDraft.update(id, update),
      removeAnnotation: (id) => this.composerStore.draftStore.annotationDraft.remove(id),
      suggestFiles: capabilities.suggestFiles,
      focusRequestRevision: () => this.composerStore.draftStore.focusRequestRevision,
      history: capabilities.history,
      usage: () => this.model.usage,
      contextInspector: capabilities.contextUsage ? this.contextInspectorStore : undefined,
      promptCacheModel: () =>
        this.model.model
          ? { provider: this.model.model.provider, modelId: this.model.model.modelId }
          : undefined,
      queuedPrompts: () => [
        ...this.runtimeQueuedPrompts,
        ...this.composerStore.deliveryStore.optimisticUserMessages.queuedMessages.map((entry) => ({
          ...entry,
          pending: true,
        })),
      ],
      steerQueuedPrompt: async (id) => {
        await this.editRuntimeQueuedPrompt(id, "steer");
      },
      stopAndSendQueuedPrompt: (id) => this.stopAndSendQueuedPrompt(id),
      reorderQueuedPrompt: (id, position) => this.reorderQueuedPrompt(id, position),
      editQueuedPrompt: (id) => this.editQueuedPrompt(id),
      removeQueuedPrompt: (id) => {
        void this.editRuntimeQueuedPrompt(id, "remove");
      },
      scheduledMessages: capabilities.scheduledMessages,
      conversationMode: capabilities.conversationMode,
      modelPickerVisible: capabilities.modelPickerVisible,
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
    });
  }

  get error() {
    const fallback = this.props.chat.fallbackError?.();
    const message = this.composerStore.error ?? this.configurationStore.error ?? fallback?.message;
    const details =
      this.composerStore.errorDetails ?? this.configurationStore.errorDetails ?? fallback?.details;
    return { message, details };
  }

  receive(event: StoreEvent) {
    if (event.type === "interview-requested") this.interviewStore.receive(event);
    else this.composerStore.receive(event);
  }

  private get runtimeQueuedPrompts(): QueuedPrompt[] {
    return queuedPrompts(this.model.parts.map((part) => part.value));
  }

  private async deliver(input: ComposerDeliveryInput) {
    if (this.props.configuration.deferredNewSession?.() && this.props.startSession)
      return this.props.startSession(input);
    const active = await this.activeSession();
    if (!active) return false;
    const command =
      input.delivery === "steer" ? this.client.sessionChats.steer : this.client.sessionChats.prompt;
    const turnId = await command(
      {
        sessionId: input.sessionId,
        text: input.text,
        attachments: input.attachments,
        renderUserMessageAsMarkdown: input.renderUserMessageAsMarkdown,
        responseMode: input.responseMode ?? "text",
        ...(input.presentationMode === undefined
          ? null
          : { presentationMode: input.presentationMode }),
      },
      { signal: this.signal },
    );
    return { turnId };
  }

  private async configureActiveSession(command: () => Promise<void>) {
    if (await this.activeSession()) await command();
  }

  private async withActiveSession(command: () => Promise<void>) {
    if (!(await this.activeSession())) throw new Error("That conversation is unavailable");
    await command();
  }

  /** Restores the session when needed and waits for its assembled live projection. */
  async prepareForCommand() {
    const revision = this.model.observedSnapshotRevision;
    if (!(await this.activeSession())) return false;
    if (this.model.observedSnapshotRevision > 0) return true;
    return this.waitForActiveProjection(revision);
  }

  private async activeSession() {
    const observedSnapshotRevision = this.model.observedSnapshotRevision;
    const active = this.props.ensureSessionActive();
    if (active === false) return false;
    if (active === true)
      return this.model.historyOnly ? this.waitForActiveProjection(observedSnapshotRevision) : true;
    const restored = await active;
    return restored ? this.waitForActiveProjection(observedSnapshotRevision) : false;
  }

  /** Keeps pending interaction state visible until restored live observation is attached. */
  private waitForActiveProjection(afterRevision: number): Promise<boolean> {
    if (!this.model.historyOnly && this.model.observedSnapshotRevision > afterRevision)
      return Promise.resolve(true);
    if (this.signal.aborted) return Promise.resolve(false);
    if (this.model.observationError) return Promise.reject(new Error(this.model.observationError));
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (ready: boolean, error?: string) => {
        if (settled) return;
        settled = true;
        this.signal.removeEventListener("abort", abort);
        dispose();
        if (error) reject(new Error(error));
        else resolve(ready);
      };
      const abort = () => finish(false);
      this.signal.addEventListener("abort", abort, { once: true });
      const dispose = reactiveEffect(() => {
        if (this.model.observationError) {
          const error = this.model.observationError;
          queueMicrotask(() => finish(false, error));
        } else if (!this.model.historyOnly && this.model.observedSnapshotRevision > afterRevision)
          queueMicrotask(() => finish(true));
      });
    });
  }

  private async abort() {
    if (!this.streaming) return;
    try {
      await this.client.sessionChats.abort(
        { sessionId: this.sessionId, stop: { by: "user" } },
        { signal: this.signal },
      );
    } catch (error) {
      if (!this.signal.aborted) this.composerStore.reportError(error);
    }
  }

  private async stopAndSendQueuedPrompt(partId: string) {
    try {
      await this.client.sessionChats.sendQueuedMessageNow(
        {
          sessionId: this.sessionId,
          partId,
        },
        { signal: this.signal },
      );
    } catch (error) {
      if (!this.signal.aborted) this.composerStore.reportError(error, "Queued prompt");
    }
  }

  private async reorderQueuedPrompt(id: string, position: number) {
    const entry = this.runtimeQueuedPrompts.find((item) => item.id === id);
    if (!entry?.itemId) return;
    try {
      await this.client.sessionChats.reorderQueuedMessage(
        { sessionId: this.sessionId, itemId: entry.itemId, position },
        { signal: this.signal },
      );
    } catch (error) {
      if (!this.signal.aborted) this.composerStore.reportError(error, "Queued prompt");
    }
  }

  private async editQueuedPrompt(id: string) {
    const part = this.model.parts.find((item) => item.partKey === id);
    if (
      !part?.queuedInput ||
      part.queuedInput.command ||
      part.queuedInput.internal ||
      part.crossSession ||
      part.scheduled ||
      part.subagentReport
    )
      return;
    const input = part.queuedInput;
    if (!(await this.editRuntimeQueuedPrompt(id, "remove")) || this.signal.aborted) return;
    this.composerStore.draftStore.restore(input.text, input.attachments);
    this.composerStore.draftStore.requestFocus();
  }

  private async editRuntimeQueuedPrompt(partId: string, operation: "remove" | "steer") {
    const command =
      operation === "remove"
        ? this.client.sessionChats.removeQueuedMessage
        : this.client.sessionChats.steerQueuedMessage;
    try {
      await command({ sessionId: this.sessionId, partId }, { signal: this.signal });
      return true;
    } catch (error) {
      if (!this.signal.aborted) this.composerStore.reportError(error, "Queued prompt");
      return false;
    }
  }
}
