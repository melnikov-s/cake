import { Store, child, createStore } from "r-state-tree";
import type { Session } from "../models/Session";
import type { ModelPreset } from "../../ipc/session-contract";
import { ClientContext } from "./context/ClientContext";
import { ChatConfigurationStore } from "./ChatConfigurationStore";
import { ChatStore } from "./ChatStore";
import type { AppearanceSettingsStore } from "./AppearanceSettingsStore";
import type { CakeChatManagementStore } from "./CakeChatManagementStore";
import type { CakeChatPendingSessionsStore } from "./CakeChatPendingSessionsStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import { ConversationComposerStore } from "./ConversationComposerStore";
import type { CakeChatTarget } from "../../domain/cake-chat-data";

export interface CakeChatSessionStoreProps {
  sessionId: string;
  model: Session;
  target(): CakeChatTarget;
  pendingSessions: CakeChatPendingSessionsStore;
  management: CakeChatManagementStore;
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
      canSubmit: () => this.composerStore.draftStore.hasContent,
      isStreaming: () => this.streaming,
      selectModel: async (value) => {
        await this.configurationStore.selectModel(value);
        return !this.signal.aborted && !this.configurationStore.error;
      },
      renameSession: (name) => this.props.management.renameSession(this.sessionId, name),
      handoffSession: (entryId, prompt, resolveSource) =>
        this.props.management.handoff(this.sessionId, entryId, prompt, resolveSource),
      deliver: async (input) => {
        const newSession = this.props.pendingSessions.newSessionRequest(
          this.sessionId,
          this.props.target().tools,
        );
        const prompt = {
          sessionId: input.sessionId,
          text: input.text,
          renderUserMessageAsMarkdown: input.renderUserMessageAsMarkdown,
          attachments: input.attachments,
        };
        if (newSession !== undefined) Object.assign(prompt, { newSession });
        await this.client.cakeChats.prompt(prompt, { signal: this.signal });
        this.props.pendingSessions.markMaterialized(this.sessionId);
      },
      editMessage: (input) =>
        this.client.cakeChats.editMessage(
          { ...this.props.target(), ...input },
          { signal: this.signal },
        ),
      compact: async (_sessionId, instructions) => {
        if (this.props.pendingSessions.isPending(this.sessionId))
          throw new Error("Compaction requires an existing conversation");
        await this.client.cakeChats.compact(
          { ...this.props.target(), instructions },
          { signal: this.signal },
        );
      },
      operations: this.props.operations,
      operationOwner: this.promptOwner,
      draftSessionPrompt: (sessionId) => this.props.pendingSessions.draftPrompt(sessionId),
      isDeferredSession: (sessionId) => this.props.pendingSessions.isPending(sessionId),
      createDraftSession: (sessionId, text, attachments) =>
        this.props.pendingSessions.createDraft(sessionId, text, attachments),
      updateDraftSession: (sessionId, text, attachments) =>
        this.props.pendingSessions.updateDraft(sessionId, text, attachments),
      activateDraftSession: (sessionId) => this.props.pendingSessions.activateDraft(sessionId),
      applyGeneratedDraftName: (sessionId, title) =>
        this.props.pendingSessions.applyGeneratedDraftName(sessionId, title),
      editorText: (entryId) => this.model.tree.find((entry) => entry.piId === entryId)?.editorText,
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
      deferredNewSession: () => this.props.pendingSessions.isPending(this.sessionId),
      effectiveConfiguration: () => this.props.pendingSessions.configuration(this.sessionId),
      setPendingConfiguration: (configuration) =>
        this.props.pendingSessions.setConfiguration(this.sessionId, configuration),
      setConfiguration: (configuration) =>
        this.client.cakeChats.applyConfiguration(
          { ...this.props.target(), configuration },
          { signal: this.signal },
        ),
      setModel: (provider, modelId) =>
        this.client.cakeChats.setModel(
          { ...this.props.target(), provider, modelId },
          { signal: this.signal },
        ),
      setThinkingLevel: (level) =>
        this.client.cakeChats.setThinkingLevel(
          { ...this.props.target(), level },
          { signal: this.signal },
        ),
      setFastMode: (enabled) =>
        this.client.cakeChats.setFastMode(
          { ...this.props.target(), enabled },
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
      draft: () => this.composerStore.draftStore.text,
      setDraft: (value) => this.composerStore.draftStore.setText(value),
      submitting: () =>
        this.composerStore.deliveryStore.activeOperations.length > 0 ||
        this.model.activeTurnIds.length > 0,
      configuration: () => this.configurationStore,
      commands: () => this.model.commands,
      placeholder: () => "Ask Cake to find or control a task…",
      inputLabel: () => "Message Cake Chat",
      focusRequestRevision: () => this.composerStore.draftStore.focusRequestRevision,
      canSubmit: () => this.composerStore.draftStore.hasContent,
      submit: (_draft, options) =>
        this.composerStore.submit(undefined, options?.renderUserMessageAsMarkdown ?? false),
      userMessagePresentation: {
        setMarkdown: (entryId, renderAsMarkdown) =>
          this.client.cakeChats.setUserMessageMarkdown(
            { ...this.props.target(), entryId, renderAsMarkdown },
            { signal: this.signal },
          ),
      },
      activateDraft: () => this.composerStore.activateDraftSession(),
      editLastUserMessage: (entryId) => this.composerStore.beginEditMessage(entryId),
      isDraftSession: () => this.props.pendingSessions.isDraft(this.sessionId),
      editingMessage: () => this.composerStore.editingMessage,
      abort: () => this.abort(),
      attachments: () => this.composerStore.draftStore.visibleAttachments,
      annotations: () => this.composerStore.draftStore.annotationDraft.annotations,
      addAnnotation: (annotation) => this.composerStore.draftStore.annotationDraft.add(annotation),
      updateAnnotation: (id, update) =>
        this.composerStore.draftStore.annotationDraft.update(id, update),
      removeAnnotation: (id) => this.composerStore.draftStore.annotationDraft.remove(id),
      addPastedImages: (files) => this.composerStore.draftStore.addPastedImages(files),
      removeAttachment: (index) => this.composerStore.draftStore.removeAttachment(index),
      composerReword: {
        showContextMenu: (selection, x, y) =>
          this.client.electron.showComposerContextMenu(
            { selection, x, y },
            { signal: this.signal },
          ),
        rewordSelection: (selection, prompt) =>
          this.client.workspaces.rewordComposerSelection(
            { selection, prompt },
            { signal: this.signal },
          ),
      },
      usage: () => this.model.usage,
      hideThinking: () => Boolean(this.model.piSettings?.hideThinkingBlock),
      error: () => ({
        message: this.configurationStore.error ?? this.composerStore.error,
        details: this.configurationStore.errorDetails ?? this.composerStore.errorDetails,
        title: "Cake Chat failed",
      }),
      workLogPresentation: {
        viewMode: () => this.props.settings?.()?.workLogViewMode,
        setViewMode: (mode) => this.props.settings?.()?.setWorkLogViewMode(mode),
        expansion: () => this.props.settings?.()?.workLogsExpansion,
        setExpansion: (expansion) => this.props.settings?.()?.setWorkLogsExpansion(expansion),
      },
    });
  }

  requestFocus() {
    this.composerStore.draftStore.requestFocus();
  }

  async abort() {
    if (!this.streaming) return;
    const operationId = this.props.operations.start(`cake-chat-abort:${this.sessionId}`);
    try {
      await this.client.cakeChats.abort(this.props.target(), {
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
    this.composerStore.reportError(error, context);
  }
}
