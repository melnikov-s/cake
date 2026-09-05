import { Store, child, createStore, observable, snapshot } from "r-state-tree";
import type { Session } from "../models/Session";
import type {
  Annotation,
  Attachment,
  ModelPreset,
  SessionSnapshot,
} from "../../ipc/session-contract";
import { parsePiBuiltinCommand } from "../../ipc/session-contract";
import { pastedImageAttachments } from "../pasted-image-attachments";
import { describeError } from "../error-details";
import { RendererClientContext } from "../client/RendererClientContext";
import { ChatConfigurationStore } from "./ChatConfigurationStore";
import { ChatStore } from "./ChatStore";
import type { CakeChatCollectionStore } from "./CakeChatCollectionStore";
import type { AppearanceSettingsStore } from "./AppearanceSettingsStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import { OptimisticUserMessagesStore } from "./OptimisticUserMessagesStore";
import { shouldRenderMarkdown } from "../../utils/markdown";

export interface CakeChatSessionStoreProps {
  sessionId: string;
  model: Session;
  collection: CakeChatCollectionStore;
  operations: SessionOperationCoordinatorStore;
  modelPresets(): readonly ModelPreset[];
  openModelPresetSettings(): void;
  settings?(): AppearanceSettingsStore | undefined;
}

/** Owns the independent draft, attachments, configuration, and turn policy for one Cake Chat session. */
export class CakeChatSessionStore extends Store<CakeChatSessionStoreProps> {
  @snapshot attachments: Attachment[] = observable([]);
  @snapshot annotations: Annotation[] = observable([]);
  error: string | undefined;
  errorDetails: string | undefined;
  editingEntryId: string | undefined;
  editingDraftSession = false;
  focusRequestRevision = 0;
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
    return RendererClientContext.consume(this)!;
  }
  get sessionId() {
    return this.props.sessionId;
  }
  get parts() {
    const staged = this.props.collection.draftSessionPrompt(this.sessionId);
    if (!staged || this.editingDraftSession) return this.optimisticUserMessages.parts;
    return [
      {
        id: `draft-${this.sessionId}-text`,
        kind: "text" as const,
        role: "user" as const,
        entryId: `draft:${this.sessionId}`,
        text: staged.text,
        status: "complete" as const,
        renderAs: shouldRenderMarkdown(staged.text) ? ("markdown" as const) : undefined,
        draft: true,
      },
      ...staged.attachments.flatMap((attachment, index): SessionSnapshot["parts"] => {
        if (attachment.kind === "image")
          return [
            {
              id: `draft-${this.sessionId}-attachment-${index}`,
              kind: "attachment",
              name: attachment.name,
              mediaType: attachment.mimeType,
              attachmentKind: "image",
              data: attachment.data,
            },
          ];
        if (attachment.kind === "annotation")
          return [
            {
              id: `draft-${this.sessionId}-annotation-${index}`,
              kind: "annotation",
              annotations: attachment.annotations,
            },
          ];
        return [];
      }),
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

  @child
  get optimisticUserMessages(): OptimisticUserMessagesStore {
    return createStore(OptimisticUserMessagesStore, {
      canonicalParts: () => this.model.uiParts,
    });
  }

  requestFocus() {
    this.focusRequestRevision += 1;
  }

  async submit(text: string, renderUserMessageAsMarkdown = false) {
    text = text.trim();
    const annotations = this.annotations.slice();
    const attachments: Attachment[] = [
      ...this.attachments.filter((attachment) => attachment.kind !== "annotation"),
      ...(annotations.length > 0 ? [{ kind: "annotation" as const, annotations }] : []),
    ];
    if (!text && attachments.length === 0) return false;
    if (this.editingDraftSession) {
      this.props.collection.updateDraftSession(this.sessionId, text, attachments);
      this.attachments.splice(0);
      this.annotations.splice(0);
      this.editingDraftSession = false;
      return true;
    }
    if (this.editingEntryId) {
      const entryId = this.editingEntryId;
      this.editingEntryId = undefined;
      const operationId = this.props.operations.start(this.promptOwner);
      this.attachments.splice(0);
      this.annotations.splice(0);
      try {
        await this.client.cakeChats.editMessage(
          {
            ...this.props.collection.target(this.sessionId),
            entryId,
            text,
            attachments,
            renderUserMessageAsMarkdown,
          },
          { signal: this.signal },
        );
        this.props.operations.finish(operationId);
        return true;
      } catch (error) {
        if (!this.signal.aborted) {
          this.editingEntryId = entryId;
          this.restoreAttachments(attachments);
          this.props.operations.finish(operationId);
          this.reportError(error);
        }
        return false;
      }
    }
    const builtin = parsePiBuiltinCommand(text);
    if (builtin?.name === "handoff" || builtin?.name === "handoffandresolve") {
      if (this.attachments.length > 0 || this.annotations.length > 0) {
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
        await this.client.cakeChats.compact(
          {
            ...this.props.collection.target(this.sessionId),
            instructions: builtin.args || undefined,
          },
          { signal: this.signal },
        );
        if (this.signal.aborted) return false;
        this.props.operations.finish(operationId);
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
    this.optimisticUserMessages.add(
      operationId,
      text,
      attachments,
      "sending",
      renderUserMessageAsMarkdown,
    );
    this.attachments.splice(0);
    this.annotations.splice(0);
    try {
      const newSession = this.props.collection.newSessionRequest(this.sessionId);
      const input = {
        sessionId: this.sessionId,
        text,
        renderUserMessageAsMarkdown,
        attachments,
      };
      if (newSession !== undefined) Object.assign(input, { newSession });
      await this.client.cakeChats.prompt(input, { signal: this.signal });
      this.props.collection.markSessionStarted(this.sessionId);
      this.props.operations.finish(operationId);
      return true;
    } catch (error) {
      this.optimisticUserMessages.remove(operationId);
      if (this.signal.aborted) return false;
      this.restoreAttachments(attachments);
      this.props.operations.finish(operationId);
      this.reportError(error);
      return false;
    }
  }

  async createDraftSession() {
    const text = this.chatStore.draft.trim();
    const attachments: Attachment[] = [
      ...this.attachments.filter((attachment) => attachment.kind !== "annotation"),
      ...(this.annotations.length > 0
        ? [{ kind: "annotation" as const, annotations: this.annotations.slice() }]
        : []),
    ];
    if (!text && attachments.length === 0) return false;
    if (!this.props.collection.createDraftSession(this.sessionId, text, attachments)) return false;
    this.chatStore.setDraft("");
    this.attachments.splice(0);
    this.annotations.splice(0);
    if (text)
      void this.client.workspaces
        .generateSessionTitle(text, { signal: this.signal })
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
    this.restoreAttachments(staged.attachments);
    return this.chatStore.submit();
  }

  beginEditMessage(entryId: string) {
    if (this.streaming) return;
    const staged = this.props.collection.draftSessionPrompt(this.sessionId);
    if (staged && entryId === `draft:${this.sessionId}`) {
      this.chatStore.setDraft(staged.text);
      this.restoreAttachments(staged.attachments);
      this.editingDraftSession = true;
      return false;
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
    const messageAttachments = this.model.uiParts
      .slice(textIndex + 1, end)
      .flatMap((part): Attachment[] => {
        if (part.kind === "attachment" && part.attachmentKind === "image" && part.data)
          return [
            {
              kind: "image",
              name: part.name,
              mimeType: part.mediaType,
              data: part.data,
            },
          ];
        if (part.kind === "annotation")
          return [{ kind: "annotation", annotations: part.annotations }];
        return [];
      });
    this.chatStore.setDraft(
      this.model.tree.find((entry) => entry.id === entryId)?.editorText ??
        (userPart.kind === "text" ? userPart.text : userPart.content),
    );
    this.restoreAttachments(messageAttachments);
    this.editingEntryId = entryId;
    return userPart.kind === "text" && userPart.renderAs === "markdown";
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

  addAnnotation(annotation: Omit<Annotation, "id">) {
    if (this.annotations.length >= 100) {
      this.reportError(new Error("A message can include at most 100 annotations"));
      return;
    }
    this.annotations.push({ id: crypto.randomUUID(), ...annotation });
  }

  updateAnnotation(id: string, update: Partial<Omit<Annotation, "id">>) {
    const index = this.annotations.findIndex((annotation) => annotation.id === id);
    const annotation = this.annotations[index];
    if (index >= 0 && annotation) this.annotations.splice(index, 1, { ...annotation, ...update });
  }

  removeAnnotation(id: string) {
    const index = this.annotations.findIndex((annotation) => annotation.id === id);
    if (index >= 0) this.annotations.splice(index, 1);
  }

  private restoreAttachments(attachments: readonly Attachment[]) {
    this.attachments.splice(
      0,
      this.attachments.length,
      ...attachments.filter((attachment) => attachment.kind !== "annotation"),
    );
    this.annotations.splice(
      0,
      this.annotations.length,
      ...attachments.flatMap((attachment) =>
        attachment.kind === "annotation" ? attachment.annotations : [],
      ),
    );
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
      parts: () => this.parts,
      streaming: () => this.streaming,
      submitting: () =>
        this.props.operations.active(this.promptOwner).length > 0 ||
        this.model.activeTurnIds.length > 0,
      configuration: () => this.configurationStore,
      commands: () => this.model.commands,
      placeholder: () => "Ask Cake to find or control a task…",
      inputLabel: () => "Message Cake Chat",
      focusRequestRevision: () => this.focusRequestRevision,
      canSubmit: (draft) =>
        Boolean(draft.trim() || this.attachments.length > 0 || this.annotations.length > 0),
      submit: (draft, options) => this.submit(draft, options?.renderUserMessageAsMarkdown ?? false),
      setUserMessageMarkdown: (entryId, renderAsMarkdown) =>
        this.client.cakeChats.setUserMessageMarkdown(
          { ...this.props.collection.target(this.sessionId), entryId, renderAsMarkdown },
          { signal: this.signal },
        ),
      createDraft: () => this.createDraftSession(),
      canCreateDraft: () =>
        this.props.collection.isPendingSession(this.sessionId) &&
        !this.props.collection.isDraftSession(this.sessionId),
      activateDraft: () => this.activateDraftSession(),
      editLastUserMessage: (entryId) => this.beginEditMessage(entryId),
      isDraftSession: () => this.props.collection.isDraftSession(this.sessionId),
      editingMessage: () => Boolean(this.editingEntryId || this.editingDraftSession),
      abort: () => this.abort(),
      attachments: () => this.attachments,
      annotations: () => this.annotations,
      addAnnotation: (annotation) => this.addAnnotation(annotation),
      updateAnnotation: (id, update) => this.updateAnnotation(id, update),
      removeAnnotation: (id) => this.removeAnnotation(id),
      addPastedImages: (files) => this.addPastedImages(files),
      removeAttachment: (index) => this.removeAttachment(index),
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
        message: this.configurationStore.error ?? this.error,
        details: this.configurationStore.errorDetails ?? this.errorDetails,
        title: "Cake Chat failed",
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
    this.error = described.message;
    this.errorDetails = described.details;
  }

  private clearError() {
    this.error = undefined;
    this.errorDetails = undefined;
  }
}
