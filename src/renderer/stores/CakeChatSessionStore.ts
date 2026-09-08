import { Store, child, createStore } from "r-state-tree";
import type { Session } from "../models/Session";
import type { ModelPreset } from "../../ipc/session-contract";
import { describeError } from "../lib/error-details";
import { ClientContext } from "./context/ClientContext";
import { ChatConfigurationStore } from "./ChatConfigurationStore";
import { ChatStore } from "./ChatStore";
import type { CakeChatCollectionStore } from "./CakeChatCollectionStore";
import type { AppearanceSettingsStore } from "./AppearanceSettingsStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import { ConversationComposerStore } from "./ConversationComposerStore";

export interface CakeChatSessionStoreProps {
  sessionId: string;
  model: Session;
  collection: CakeChatCollectionStore;
  operations: SessionOperationCoordinatorStore;
  modelPresets(): readonly ModelPreset[];
  openModelPresetSettings(): void;
  settings?(): AppearanceSettingsStore | undefined;
}

/** Owns the configuration and shared conversation input workflow for one Cake Chat session. */
export class CakeChatSessionStore extends Store<CakeChatSessionStoreProps> {
  constructor(props: CakeChatSessionStore["props"]) {
    super(props);
    this.effect(() => () => {
      this.props.operations.reset(this.promptOwner);
      this.props.operations.reset(this.configurationOwner);
      this.props.operations.reset(`cake-chat-abort:${this.sessionId}`);
    });
  }

  get model() {
    return this.props.model;
  }
  get client() {
    return ClientContext.consume(this)!;
  }
  get sessionId() {
    return this.props.sessionId;
  }
  get streaming() {
    return this.model.streaming;
  }
  get promptOwner() {
    return `cake-chat-prompt:${this.sessionId}`;
  }
  get configurationOwner() {
    return `cake-chat-configuration:${this.sessionId}`;
  }

  @child
  get composerStore(): ConversationComposerStore {
    return createStore(ConversationComposerStore, {
      sessionId: () => this.sessionId,
      canonicalParts: () => this.model.uiParts,
      draft: () => this.chatStore.draft,
      setDraft: (value) => this.chatStore.setDraft(value),
      canSubmit: () =>
        Boolean(
          this.chatStore.draft.trim() ||
          this.composerStore.attachments.length > 0 ||
          this.composerStore.annotations.length > 0,
        ),
      isStreaming: () => this.streaming,
      selectModel: async (value) => {
        await this.configurationStore.selectModel(value);
        return !this.signal.aborted && !this.configurationStore.error;
      },
      renameSession: (name) => this.props.collection.renameSession(this.sessionId, name),
      handoffSession: (entryId, prompt, resolveSource) =>
        this.props.collection.handoff(this.sessionId, entryId, prompt, resolveSource),
      deliver: async (input) => {
        const newSession = this.props.collection.newSessionRequest(this.sessionId);
        const prompt = {
          sessionId: input.sessionId,
          text: input.text,
          renderUserMessageAsMarkdown: input.renderUserMessageAsMarkdown,
          attachments: input.attachments,
        };
        if (newSession !== undefined) Object.assign(prompt, { newSession });
        await this.client.cakeChats.prompt(prompt, { signal: this.signal });
        this.props.collection.markSessionStarted(this.sessionId);
      },
      editMessage: (input) =>
        this.client.cakeChats.editMessage(
          { ...this.props.collection.target(this.sessionId), ...input },
          { signal: this.signal },
        ),
      compact: async (_sessionId, instructions) => {
        if (this.props.collection.isPendingSession(this.sessionId))
          throw new Error("Compaction requires an existing conversation");
        await this.client.cakeChats.compact(
          { ...this.props.collection.target(this.sessionId), instructions },
          { signal: this.signal },
        );
      },
      operations: this.props.operations,
      operationOwner: this.promptOwner,
      draftSessionPrompt: (sessionId) => this.props.collection.draftSessionPrompt(sessionId),
      isDeferredSession: (sessionId) => this.props.collection.isPendingSession(sessionId),
      createDraftSession: (sessionId, text, attachments) =>
        this.props.collection.createDraftSession(sessionId, text, attachments),
      updateDraftSession: (sessionId, text, attachments) =>
        this.props.collection.updateDraftSession(sessionId, text, attachments),
      activateDraftSession: (sessionId) => this.props.collection.activateDraftSession(sessionId),
      applyGeneratedDraftName: (sessionId, title) =>
        this.props.collection.applyGeneratedDraftName(sessionId, title),
      editorText: (entryId) => this.model.tree.find((entry) => entry.id === entryId)?.editorText,
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
      deferredNewSession: () => this.props.collection.isPendingSession(this.sessionId),
      effectiveConfiguration: () =>
        this.props.collection.pendingSessionConfiguration(this.sessionId),
      setPendingConfiguration: (configuration) =>
        this.props.collection.setPendingSessionConfiguration(this.sessionId, configuration),
      setConfiguration: (configuration) =>
        this.client.cakeChats.applyConfiguration(
          { ...this.props.collection.target(this.sessionId), configuration },
          { signal: this.signal },
        ),
      setModel: (provider, modelId) =>
        this.client.cakeChats.setModel(
          { ...this.props.collection.target(this.sessionId), provider, modelId },
          { signal: this.signal },
        ),
      setThinkingLevel: (level) =>
        this.client.cakeChats.setThinkingLevel(
          { ...this.props.collection.target(this.sessionId), level },
          { signal: this.signal },
        ),
      setFastMode: (enabled) =>
        this.client.cakeChats.setFastMode(
          { ...this.props.collection.target(this.sessionId), enabled },
          { signal: this.signal },
        ),
    });
  }

  @child
  get chatStore(): ChatStore {
    return createStore(ChatStore, {
      id: () => this.sessionId,
      parts: () => this.composerStore.parts,
      streaming: () => this.streaming,
      submitting: () =>
        this.composerStore.activeOperations.length > 0 || this.model.activeTurnIds.length > 0,
      configuration: () => this.configurationStore,
      commands: () => this.model.commands,
      placeholder: () => "Ask Cake to find or control a task…",
      inputLabel: () => "Message Cake Chat",
      focusRequestRevision: () => this.composerStore.focusRequestRevision,
      canSubmit: () =>
        Boolean(
          this.chatStore.draft.trim() ||
          this.composerStore.attachments.length > 0 ||
          this.composerStore.annotations.length > 0,
        ),
      submit: (_draft, options) =>
        this.composerStore.submit(undefined, options?.renderUserMessageAsMarkdown ?? false),
      setUserMessageMarkdown: (entryId, renderAsMarkdown) =>
        this.client.cakeChats.setUserMessageMarkdown(
          { ...this.props.collection.target(this.sessionId), entryId, renderAsMarkdown },
          { signal: this.signal },
        ),
      activateDraft: () => this.composerStore.activateDraftSession(),
      editLastUserMessage: (entryId) => this.composerStore.beginEditMessage(entryId),
      isDraftSession: () => this.props.collection.isDraftSession(this.sessionId),
      editingMessage: () =>
        Boolean(this.composerStore.editingEntryId || this.composerStore.editingDraftSession),
      abort: () => this.abort(),
      attachments: () => this.composerStore.attachments,
      annotations: () => this.composerStore.annotations,
      addAnnotation: (annotation) => this.composerStore.addAnnotation(annotation),
      updateAnnotation: (id, update) => this.composerStore.updateAnnotation(id, update),
      removeAnnotation: (id) => this.composerStore.removeAnnotation(id),
      addPastedImages: (files) => this.composerStore.addPastedImages(files),
      removeAttachment: (index) => this.composerStore.removeAttachment(index),
      showComposerContextMenu: (selection, x, y) =>
        this.client.electron.showComposerContextMenu({ selection, x, y }, { signal: this.signal }),
      rewordComposerSelection: (selection, prompt) =>
        this.client.workspaces.rewordComposerSelection(
          { selection, prompt },
          { signal: this.signal },
        ),
      usage: () => this.model.usage,
      hideThinking: () => Boolean(this.model.piSettings?.hideThinkingBlock),
      error: () => ({
        message: this.configurationStore.error ?? this.composerStore.error,
        details: this.configurationStore.errorDetails ?? this.composerStore.errorDetails,
        title: "Cake Chat failed",
      }),
      workLogViewMode: () => this.props.settings?.()?.workLogViewMode,
      setWorkLogViewMode: (mode) => this.props.settings?.()?.setWorkLogViewMode(mode),
      workLogsExpansion: () => this.props.settings?.()?.workLogsExpansion,
      setWorkLogsExpansion: (expansion) => this.props.settings?.()?.setWorkLogsExpansion(expansion),
    });
  }

  requestFocus() {
    this.composerStore.requestFocus();
  }

  async abort() {
    if (!this.streaming) return;
    const operationId = this.props.operations.start(`cake-chat-abort:${this.sessionId}`);
    try {
      await this.client.cakeChats.abort(this.props.collection.target(this.sessionId), {
        signal: this.signal,
      });
      this.props.operations.finish(operationId);
    } catch (error) {
      if (this.signal.aborted) return;
      this.props.operations.finish(operationId);
      this.reportError(error);
    }
  }

  reportError(error: unknown, context?: string) {
    const described = describeError(error, context);
    this.composerStore.error = described.message;
    this.composerStore.errorDetails = described.details;
  }
}
