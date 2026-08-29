import { Store, applySnapshot, child, createStore, observable } from "r-state-tree";
import { Session } from "../../models/Session";
import type {
  Attachment,
  ModelPreset,
  SessionPreview,
  SessionSnapshot,
} from "../../ipc/session-contract";
import { parsePiBuiltinCommand } from "../../ipc/session-contract";
import { pastedImageAttachments } from "../pasted-image-attachments";
import { describeError } from "../error-details";
import { ChatConfigurationStore } from "./ChatConfigurationStore";
import { ChatStore } from "./ChatStore";
import type { GlobalChatStore } from "./GlobalChatStore";
import type { AppearanceSettingsStore } from "./AppearanceSettingsStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import type { DesktopClientEvent } from "../desktop-client";
import { toSessionPreviewSnapshot, toSessionSnapshot } from "../../utils/session-snapshot";

export interface CakeChatSessionStoreProps {
  sessionId: string;
  collection: GlobalChatStore;
  operations: SessionOperationCoordinatorStore;
  modelPresets(): readonly ModelPreset[];
  openModelPresetSettings(): void;
  settings?(): AppearanceSettingsStore | undefined;
  persist?(): void;
}

/** Owns the independent draft, attachments, configuration, and turn policy for one Cake Chat session. */
export class CakeChatSessionStore extends Store<CakeChatSessionStoreProps> {
  readonly model: Session;
  attachments: Attachment[] = observable([]);
  error: string | undefined;
  errorDetails: string | undefined;
  editingEntryId: string | undefined;
  editingDraftSession = false;
  private readonly pendingSubmissions = new Map<
    string,
    { text: string; attachments: Attachment[]; editingEntryId?: string }
  >();

  constructor(props: CakeChatSessionStore["props"]) {
    super(props);
    this.model = Session.create({ sessionId: props.sessionId });
    this.effect(() => () => {
      this.props.operations.reset(this.promptOwner);
      this.props.operations.reset(this.configurationOwner);
      this.props.operations.reset(`cake-chat-abort:${this.sessionId}`);
      this.model[Symbol.dispose]();
    });
  }

  get sessionId() {
    return this.props.sessionId;
  }
  get parts() {
    const staged = this.props.collection.draftSessionPrompt(this.sessionId);
    if (!staged || this.editingDraftSession) return this.model.uiParts;
    return [
      {
        id: `draft-${this.sessionId}-text`,
        kind: "text" as const,
        role: "user" as const,
        entryId: `draft:${this.sessionId}`,
        text: staged.text,
        status: "complete" as const,
        draft: true,
      },
      ...staged.attachments.flatMap((attachment, index): SessionSnapshot["parts"] =>
        attachment.kind === "image"
          ? [
              {
                id: `draft-${this.sessionId}-attachment-${index}`,
                kind: "attachment",
                name: attachment.name,
                mediaType: attachment.mimeType,
                attachmentKind: "image",
                data: attachment.data,
              },
            ]
          : [],
      ),
    ];
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

  applySnapshot(snapshot: SessionSnapshot) {
    applySnapshot(this.model, toSessionSnapshot(snapshot));
  }

  applyPreview(preview: SessionPreview) {
    applySnapshot(this.model, toSessionPreviewSnapshot(preview));
  }

  upsertPart(part: SessionSnapshot["parts"][number]) {
    this.model.upsertPart(part);
  }

  removePart(partId: string) {
    this.model.removePart(partId);
  }

  setStreaming(streaming: boolean) {
    this.model.setStreaming(streaming);
  }

  receive(event: DesktopClientEvent) {
    if (event.type === "global-chat-snapshot-received") {
      if (
        event.snapshot.sessionId === this.sessionId &&
        this.props.operations.active(this.configurationOwner).length > 0
      )
        this.configurationStore.receive(event);
      return;
    }
    if (
      (event.type === "global-chat-operation-completed" ||
        event.type === "global-chat-operation-failed") &&
      this.props.operations.includes(event.operationId, this.configurationOwner)
    )
      this.configurationStore.receive(event);
    if (
      (event.type === "global-chat-operation-completed" ||
        event.type === "global-chat-operation-failed") &&
      this.props.operations.includes(event.operationId, this.promptOwner)
    ) {
      const pending = this.pendingSubmissions.get(event.operationId);
      this.pendingSubmissions.delete(event.operationId);
      if (event.type === "global-chat-operation-failed" && pending) {
        if (!this.chatStore.draft.trim()) this.chatStore.setDraft(pending.text);
        if (this.attachments.length === 0) this.attachments.push(...pending.attachments);
        this.editingEntryId = pending.editingEntryId;
      }
    }
  }

  async submit(text: string, renderUserMessageAsMarkdown = false) {
    text = text.trim();
    const attachments = this.attachments.slice();
    if (!text && attachments.length === 0) return false;
    if (this.editingDraftSession) {
      this.props.collection.updateDraftSession(this.sessionId, text, attachments);
      this.attachments.splice(0);
      this.editingDraftSession = false;
      return true;
    }
    if (this.editingEntryId) {
      const entryId = this.editingEntryId;
      this.editingEntryId = undefined;
      const operationId = this.props.operations.start(this.promptOwner);
      this.pendingSubmissions.set(operationId, { text, attachments, editingEntryId: entryId });
      this.attachments.splice(0);
      try {
        if (!this.props.collection.port.editMessage)
          throw new Error("This Cake Chat client does not support message editing");
        await this.props.collection.port.editMessage({
          operationId,
          sessionId: this.sessionId,
          entryId,
          text,
          attachments,
        });
        return true;
      } catch (error) {
        if (!this.signal.aborted) {
          this.pendingSubmissions.delete(operationId);
          this.editingEntryId = entryId;
          this.attachments.push(...attachments);
          this.props.operations.finish(operationId);
          this.reportError(error);
        }
        return false;
      }
    }
    const builtin = parsePiBuiltinCommand(text);
    if (builtin?.name === "handoff" || builtin?.name === "handoffandresolve") {
      if (this.attachments.length > 0) {
        this.reportError(new Error("Remove attachments before using /handoff"));
        return false;
      }
      const assistantPart = this.parts.findLast(
        (part) =>
          part.kind === "text" &&
          part.role === "assistant" &&
          part.status !== "streaming" &&
          Boolean(part.entryId),
      );
      const entryId = assistantPart?.kind === "text" ? assistantPart.entryId : undefined;
      if (!entryId) {
        this.reportError(new Error("Handoff requires a completed assistant response"));
        return false;
      }
      return this.props.collection.handoff(
        this.sessionId,
        entryId,
        builtin.args || undefined,
        builtin.name === "handoffandresolve",
      );
    }
    if (builtin?.name === "model") {
      const separator = builtin.args.indexOf("/");
      if (!builtin.args || separator < 1) {
        this.reportError(new Error("Usage: /model <provider/model>"));
        return false;
      }
      await this.configurationStore.selectModel(builtin.args);
      return !this.configurationStore.error;
    }
    if (builtin?.name === "compact") {
      if (this.props.collection.isPendingSession(this.sessionId)) {
        this.reportError(new Error("Compaction requires an existing conversation"));
        return false;
      }
      // Compaction is a session operation, not a prompt: nothing enters the transcript.
      const operationId = this.props.operations.start(this.promptOwner);
      try {
        await this.props.collection.port.compact({
          operationId,
          sessionId: this.sessionId,
          instructions: builtin.args || undefined,
        });
        if (this.signal.aborted) return false;
        this.attachments.splice(0);
        return true;
      } catch (error) {
        if (this.signal.aborted) return false;
        this.props.operations.finish(operationId);
        this.reportError(error);
        return false;
      }
    }
    const operationId = this.props.operations.start(this.promptOwner);
    this.pendingSubmissions.set(operationId, { text, attachments });
    this.attachments.splice(0);
    try {
      await this.props.collection.port.prompt({
        operationId,
        sessionId: this.sessionId,
        text,
        renderUserMessageAsMarkdown,
        attachments,
        newSession: this.props.collection.newSessionRequest(this.sessionId),
      });
      return true;
    } catch (error) {
      if (this.signal.aborted) return false;
      this.pendingSubmissions.delete(operationId);
      this.attachments.push(...attachments);
      this.props.operations.finish(operationId);
      this.reportError(error);
      return false;
    }
  }

  async createDraftSession() {
    const text = this.chatStore.draft.trim();
    const attachments = this.attachments.slice();
    if (!text && attachments.length === 0) return false;
    if (!this.props.collection.createDraftSession(this.sessionId, text, attachments)) return false;
    this.chatStore.setDraft("");
    this.attachments.splice(0);
    if (text && this.props.collection.port.generateSessionTitle)
      void this.props.collection.port
        .generateSessionTitle(text)
        .then((title) => {
          if (title && !this.signal.aborted)
            this.props.collection.applyGeneratedDraftName(this.sessionId, title);
        })
        .catch(() => undefined);
    return true;
  }

  async activateDraftSession() {
    const staged = this.props.collection.activateDraftSession(this.sessionId);
    if (!staged) return false;
    this.chatStore.setDraft(staged.text);
    this.attachments.splice(0, this.attachments.length, ...staged.attachments);
    return this.chatStore.submit();
  }

  beginEditMessage(entryId: string) {
    if (this.streaming) return;
    const staged = this.props.collection.draftSessionPrompt(this.sessionId);
    if (staged && entryId === `draft:${this.sessionId}`) {
      this.chatStore.setDraft(staged.text);
      this.attachments.splice(0, this.attachments.length, ...staged.attachments);
      this.editingDraftSession = true;
      return;
    }
    const userPart = this.model.uiParts.find(
      (part) =>
        ((part.kind === "text" && part.role === "user") || part.kind === "skill") &&
        part.entryId === entryId,
    );
    if (
      !userPart ||
      (userPart.kind !== "skill" && !(userPart.kind === "text" && userPart.role === "user"))
    )
      return;
    const textIndex = this.model.uiParts.indexOf(userPart);
    const nextAssistantOffset = this.model.uiParts
      .slice(textIndex + 1)
      .findIndex((part) => part.kind === "text" && part.role === "assistant");
    const end =
      nextAssistantOffset < 0 ? this.model.uiParts.length : textIndex + 1 + nextAssistantOffset;
    const images = this.model.uiParts.slice(textIndex + 1, end).flatMap((part): Attachment[] =>
      part.kind === "attachment" && part.attachmentKind === "image" && part.data
        ? [
            {
              kind: "image",
              name: part.name,
              mimeType: part.mediaType,
              data: part.data,
            },
          ]
        : [],
    );
    this.chatStore.setDraft(
      this.model.tree.find((entry) => entry.id === entryId)?.editorText ??
        (userPart.kind === "text" ? userPart.text : userPart.content),
    );
    this.attachments.splice(0, this.attachments.length, ...images);
    this.editingEntryId = entryId;
  }

  async addPastedImages(files: readonly File[]) {
    this.clearError();
    try {
      const attachments = await pastedImageAttachments(files, 20 - this.attachments.length);
      if (!this.signal.aborted) this.attachments.push(...attachments);
    } catch (error) {
      if (this.signal.aborted) return;
      this.reportError(error);
    }
  }

  removeAttachment(index: number) {
    this.attachments.splice(index, 1);
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
      listModels: () => this.props.collection.port.listModels(),
      setConfiguration: (operationId, configuration) =>
        this.props.collection.port.setConfiguration({
          operationId,
          sessionId: this.sessionId,
          configuration,
        }),
      setModel: (operationId, provider, modelId) =>
        this.props.collection.port.setModel({
          operationId,
          sessionId: this.sessionId,
          provider,
          modelId,
        }),
      setThinkingLevel: (operationId, level) =>
        this.props.collection.port.setThinkingLevel({
          operationId,
          sessionId: this.sessionId,
          level,
        }),
      setFastMode: (operationId, enabled) =>
        this.props.collection.port.setFastMode({
          operationId,
          sessionId: this.sessionId,
          enabled,
        }),
    });
  }

  @child
  get chatStore(): ChatStore {
    return createStore(ChatStore, {
      id: () => this.sessionId,
      parts: () => this.parts,
      streaming: () => this.streaming,
      submitting: () => this.props.operations.active(this.promptOwner).length > 0,
      configuration: () => this.configurationStore,
      commands: () => this.model.commands,
      placeholder: () => "Ask Cake to find or control a task…",
      inputLabel: () => "Message Cake Chat",
      canSubmit: (draft) => Boolean(draft.trim() || this.attachments.length > 0),
      submit: (draft, options) => this.submit(draft, options?.renderUserMessageAsMarkdown ?? false),
      supportsUserMessageMarkdown: () => true,
      createDraft: () => this.createDraftSession(),
      showDraftMenu: (x, y) =>
        this.props.collection.port.showSendContextMenu?.({ x, y }) ?? Promise.resolve(undefined),
      canCreateDraft: () =>
        this.props.collection.isPendingSession(this.sessionId) &&
        !this.props.collection.isDraftSession(this.sessionId),
      activateDraft: () => this.activateDraftSession(),
      editLastUserMessage: (entryId) => this.beginEditMessage(entryId),
      isDraftSession: () => this.props.collection.isDraftSession(this.sessionId),
      editingMessage: () => Boolean(this.editingEntryId || this.editingDraftSession),
      abort: () => this.abort(),
      attachments: () => this.attachments,
      addPastedImages: (files) => this.addPastedImages(files),
      removeAttachment: (index) => this.removeAttachment(index),
      showComposerContextMenu: (selection, x, y) =>
        this.props.collection.port.showComposerContextMenu({ selection, x, y }),
      rewordComposerSelection: (selection, prompt) =>
        this.props.collection.port.rewordComposerSelection({ selection, prompt }),
      usage: () => this.model.usage,
      hideThinking: () => Boolean(this.model.piSettings?.hideThinkingBlock),
      error: () => ({
        message: this.configurationStore.error ?? this.error,
        details: this.configurationStore.errorDetails ?? this.errorDetails,
        title: "Cake Chat failed",
      }),
      persist: () => this.props.persist?.(),
      workLogViewMode: () => this.props.settings?.()?.workLogViewMode,
      setWorkLogViewMode: (mode) => {
        this.props.settings?.()?.setWorkLogViewMode(mode);
        this.props.persist?.();
      },
      workLogsExpansion: () => this.props.settings?.()?.workLogsExpansion,
      setWorkLogsExpansion: (expansion) => {
        this.props.settings?.()?.setWorkLogsExpansion(expansion);
        this.props.persist?.();
      },
    });
  }

  async abort() {
    if (!this.streaming) return;
    const operationId = this.props.operations.start(`cake-chat-abort:${this.sessionId}`);
    try {
      await this.props.collection.port.abort({ operationId, sessionId: this.sessionId });
    } catch (error) {
      if (this.signal.aborted) return;
      this.props.operations.finish(operationId);
      this.reportError(error);
    }
  }

  receiveOperationFailure(operationId: string, error: unknown, details?: string) {
    if (
      this.props.operations.includes(operationId, this.promptOwner) ||
      this.props.operations.includes(operationId, `cake-chat-abort:${this.sessionId}`)
    ) {
      if (details !== undefined) {
        const described = describeError(error);
        this.error = described.message;
        this.errorDetails = details;
      } else {
        this.reportError(error);
      }
    }
  }

  reportError(error: unknown, context?: string) {
    const described = describeError(error, context);
    this.error = described.message;
    this.errorDetails = described.details;
  }

  private clearError() {
    this.error = undefined;
    this.errorDetails = undefined;
  }
}
