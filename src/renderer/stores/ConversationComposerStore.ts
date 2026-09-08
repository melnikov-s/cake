import { Store, child, computed, createStore, observable, snapshot } from "r-state-tree";
import type { Annotation, Attachment, FileSuggestion, UiPart } from "../../ipc/session-contract";
import { applyAnnotationUpdate, createAnnotation } from "../../utils/annotations";
import { parsePiBuiltinCommand } from "../../ipc/session-contract";
import type { RendererEvent } from "../RendererEvent";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import { describeError } from "../error-details";
import { pastedImageAttachments } from "../pasted-image-attachments";
import { RendererClientContext } from "../client/RendererClientContext";
import type { WorktreeDraftChoice } from "./WorktreeCreationStore";
import { OptimisticUserMessagesStore } from "./OptimisticUserMessagesStore";
import { shouldRenderMarkdown } from "../../utils/markdown";

/** A prompt held locally while the session streams, shown as a chip above the composer. */
export interface QueuedPrompt {
  id: string;
  text: string;
  attachments: Attachment[];
  renderUserMessageAsMarkdown: boolean;
}

export interface ComposerDeliveryInput {
  sessionId: string;
  text: string;
  attachments: Attachment[];
  delivery: "prompt" | "steer";
  renderUserMessageAsMarkdown: boolean;
}

interface DraftPrompt {
  text: string;
  attachments: Attachment[];
}

export interface ConversationComposerStoreProps {
  projectPath?(): string | undefined;
  sessionId(): string | undefined;
  canonicalParts(): UiPart[];
  draft(): string;
  setDraft(value: string): void;
  canSubmit(): boolean;
  isStreaming(): boolean;
  queueWhileStreaming?(): boolean;
  openCommandPane?(pane: "changelog" | "tree" | "resources"): Promise<void>;
  selectModel(value: string): Promise<boolean | void>;
  renameSession(name: string): Promise<boolean | void>;
  handoffSession(entryId: string, prompt?: string, resolveSource?: boolean): Promise<boolean>;
  deliver(input: ComposerDeliveryInput): Promise<boolean | void>;
  editMessage(input: Omit<ComposerDeliveryInput, "delivery"> & { entryId: string }): Promise<void>;
  compact(sessionId: string, instructions?: string): Promise<void>;
  clearQueue?(): Promise<void>;
  scheduleMessage?(sessionId: string, args: string): Promise<boolean>;
  operations: SessionOperationCoordinatorStore;
  operationOwner: string;
  draftSessionPrompt?(sessionId: string): DraftPrompt | undefined;
  isDeferredSession?(sessionId: string): boolean;
  createDraftSession?(
    sessionId: string,
    text: string,
    attachments: Attachment[],
  ): boolean | Promise<boolean | void>;
  updateDraftSession?(
    sessionId: string,
    text: string,
    attachments: Attachment[],
  ): boolean | Promise<boolean | void>;
  activateDraftSession?(sessionId: string): DraftPrompt | undefined;
  applyGeneratedDraftName?(sessionId: string, title: string): void;
  configureDraftActivation?(choice: WorktreeDraftChoice): void;
  sessionCreationChoice?(): WorktreeDraftChoice;
  editorText?(entryId: string): string | undefined;
}

/** Owns attachments, the local prompt queue, optimistic immediate prompts, and prompt delivery. */
export class ConversationComposerStore extends Store<ConversationComposerStoreProps> {
  @snapshot attachments: Attachment[] = observable([]);
  @snapshot annotations: Annotation[] = observable([]);
  @snapshot editorContextAttachment: Extract<Attachment, { kind: "source" }> | undefined;
  queuedPrompts: QueuedPrompt[] = observable([]);
  focusRequestRevision = 0;
  error: string | undefined;
  errorDetails: string | undefined;
  editingEntryId: string | undefined;
  editingDraftSession = false;
  private drainingQueue = false;

  constructor(props: ConversationComposerStore["props"]) {
    super(props);
    this.reaction(
      () => this.props.isStreaming(),
      (streaming, previousStreaming) => {
        if (previousStreaming && !streaming) this.drainQueue();
      },
    );
  }

  @child
  get optimisticUserMessages(): OptimisticUserMessagesStore {
    return createStore(OptimisticUserMessagesStore, {
      canonicalParts: this.props.canonicalParts,
    });
  }

  get client() {
    return RendererClientContext.consume(this)!;
  }

  get activeOperations() {
    return this.props.operations.active(this.props.operationOwner);
  }

  private reportError(error: unknown) {
    const described = describeError(error);
    this.error = described.message;
    this.errorDetails = described.details;
  }

  requestFocus() {
    this.focusRequestRevision += 1;
  }

  @computed
  get parts() {
    const canonical = this.props.canonicalParts();
    const sessionId = this.props.sessionId();
    if (!sessionId) return canonical;
    const staged = this.props.draftSessionPrompt?.(sessionId);
    if (staged && !this.editingDraftSession) return this.draftParts(sessionId, staged);
    return this.optimisticUserMessages.parts;
  }

  async addAttachments() {
    this.error = undefined;
    this.errorDetails = undefined;
    try {
      const selected = await this.client.filesystem.chooseAttachments({ signal: this.signal });
      if (this.signal.aborted) return;
      const draft = this.props.draft();
      const fileMentions = selected
        .filter((item): item is Extract<Attachment, { kind: "file" }> => item.kind === "file")
        .map((item) =>
          /[\s"]/.test(item.path)
            ? `@"${item.path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
            : `@${item.path}`,
        );
      if (fileMentions.length > 0)
        this.props.setDraft(
          `${draft}${draft.length > 0 && !/\s$/.test(draft) ? " " : ""}${fileMentions.join(" ")}`,
        );
      const images = selected.filter(
        (item): item is Extract<Attachment, { kind: "image" }> => item.kind === "image",
      );
      this.attachments.push(
        ...images.filter(
          (item) =>
            !this.attachments.some(
              (current) => current.kind === "image" && current.name === item.name,
            ),
        ),
      );
    } catch (error) {
      if (this.signal.aborted) return;
      this.reportError(error);
    }
  }

  get visibleAttachments() {
    const explicit = this.attachments.filter((attachment) => attachment.kind !== "annotation");
    const context = this.editorContextAttachment;
    if (!context) return explicit;
    return [
      context,
      ...explicit.filter(
        (attachment) =>
          attachment.kind !== "source" ||
          attachment.location.path !== context.location.path ||
          JSON.stringify(attachment.location.range) !== JSON.stringify(context.location.range),
      ),
    ];
  }

  addAnnotation(annotation: Omit<Annotation, "id">) {
    if (this.annotations.length >= 100) {
      this.reportError(new Error("A message can include at most 100 annotations"));
      return;
    }
    this.annotations.push(createAnnotation(crypto.randomUUID(), annotation));
    this.requestFocus();
  }

  updateAnnotation(id: string, update: Partial<Omit<Annotation, "id">>) {
    const index = this.annotations.findIndex((annotation) => annotation.id === id);
    if (index >= 0) {
      const annotation = this.annotations[index];
      if (!annotation) return;
      this.annotations.splice(index, 1, applyAnnotationUpdate(annotation, update));
    }
  }

  removeAnnotation(id: string) {
    const index = this.annotations.findIndex((annotation) => annotation.id === id);
    if (index >= 0) {
      this.annotations.splice(index, 1);
    }
  }

  setEditorContextAttachment(attachment: Extract<Attachment, { kind: "source" }> | undefined) {
    this.editorContextAttachment = attachment;
  }

  addSourceAttachment(attachment: Extract<Attachment, { kind: "source" }>) {
    const duplicate = this.attachments.some(
      (current) =>
        current.kind === "source" &&
        current.location.path === attachment.location.path &&
        JSON.stringify(current.location.range) === JSON.stringify(attachment.location.range),
    );
    if (!duplicate) {
      this.attachments.push(attachment);
    }
    this.requestFocus();
  }

  async addPastedImages(files: readonly File[]) {
    this.error = undefined;
    this.errorDetails = undefined;
    try {
      const attachments = await pastedImageAttachments(files, 20 - this.attachments.length);
      if (this.signal.aborted) return;
      this.attachments.push(...attachments);
    } catch (error) {
      if (this.signal.aborted) return;
      this.reportError(error);
    }
  }

  suggestFiles(prefix: string): Promise<ReadonlyArray<FileSuggestion>> {
    const projectPath = this.props.projectPath?.();
    return projectPath
      ? this.client.filesystem.suggestFiles(projectPath, prefix, { signal: this.signal })
      : Promise.resolve([]);
  }

  removeAttachment(index: number) {
    if (this.editorContextAttachment) {
      if (index === 0) {
        this.editorContextAttachment = undefined;
        return;
      }
      index -= 1;
    }
    this.attachments.splice(index, 1);
  }

  async submit(deliveryOverride?: "steer", renderUserMessageAsMarkdown = false) {
    if (!this.props.canSubmit()) return;
    this.error = undefined;
    this.errorDetails = undefined;
    const text = this.props.draft().trim();
    if (this.editingDraftSession) {
      const attachments = this.submissionAttachments();
      const sessionId = this.props.sessionId();
      if (!sessionId) return;
      await this.props.updateDraftSession?.(sessionId, text, attachments);
      this.editingDraftSession = false;
      const choice = this.props.sessionCreationChoice?.() ?? { kind: "draft" };
      if (choice.kind !== "draft") {
        await this.activateDraftSession(choice);
        return;
      }
      this.clearComposer();
      this.props.configureDraftActivation?.({ kind: "current" });
      return;
    }
    if (this.props.sessionCreationChoice?.().kind === "draft") {
      await this.createDraftSession();
      return;
    }
    const command = text.toLocaleLowerCase();
    if (
      this.props.openCommandPane &&
      (command === "/tree" || command === "/resources" || command === "/changelog")
    ) {
      this.props.setDraft("");
      await this.props.openCommandPane(
        command === "/tree" ? "tree" : command === "/changelog" ? "changelog" : "resources",
      );
      return true;
    }
    const builtin = parsePiBuiltinCommand(text);
    if (builtin?.name === "handoff" || builtin?.name === "handoffandresolve") {
      if (this.attachments.length > 0 || this.annotations.length > 0) {
        this.reportError(new Error("Remove attachments before using /handoff"));
        return false;
      }
      const assistantPart = this.props
        .canonicalParts()
        .findLast(
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
      const handedOff = await this.props.handoffSession(
        entryId,
        builtin.args || undefined,
        builtin.name === "handoffandresolve",
      );
      if (handedOff && this.props.draft().trim() === text) this.props.setDraft("");
      return handedOff;
    }
    if (builtin?.name === "model") {
      if (builtin.args.indexOf("/") < 1) {
        this.reportError(new Error("Usage: /model <provider/model>"));
        return false;
      }
      const selected = (await this.props.selectModel(builtin.args)) !== false;
      if (selected && this.props.draft().trim() === text) this.props.setDraft("");
      return selected;
    }
    if (builtin?.name === "name") {
      const renamed = await this.renameSession(builtin.args);
      if (renamed && this.props.draft().trim() === text) this.props.setDraft("");
      return renamed;
    }
    if (builtin?.name === "schedule" && this.props.scheduleMessage) {
      if (
        this.attachments.length > 0 ||
        this.annotations.length > 0 ||
        this.editorContextAttachment
      ) {
        this.reportError(new Error("Remove attachments before using /schedule"));
        return false;
      }
      const sessionId = this.props.sessionId();
      if (!sessionId || this.props.isDeferredSession?.(sessionId)) {
        this.reportError(new Error("Scheduling requires an existing conversation"));
        return false;
      }
      try {
        const scheduled = await this.props.scheduleMessage(sessionId, builtin.args);
        if (scheduled && !this.signal.aborted) this.props.setDraft("");
        return scheduled && !this.signal.aborted;
      } catch (error) {
        if (!this.signal.aborted) this.reportError(error);
        return false;
      }
    }
    const sessionId = this.props.sessionId();
    if (!sessionId) return;
    const explicitAttachments = this.attachments.filter(
      (attachment) => attachment.kind !== "annotation",
    );
    const contextAttachments = this.editorContextAttachment
      ? [
          this.editorContextAttachment,
          ...explicitAttachments.filter(
            (attachment) =>
              attachment.kind !== "source" ||
              attachment.location.path !== this.editorContextAttachment?.location.path ||
              JSON.stringify(attachment.location.range) !==
                JSON.stringify(this.editorContextAttachment?.location.range),
          ),
        ]
      : explicitAttachments;
    const annotations = this.annotations.slice();
    const attachments: Attachment[] = [
      ...contextAttachments,
      ...(annotations.length > 0 ? [{ kind: "annotation" as const, annotations }] : []),
    ];
    if (this.editingEntryId) {
      const entryId = this.editingEntryId;
      this.editingEntryId = undefined;
      this.clearComposer();
      return this.deliverEdit(entryId, text, attachments, sessionId, renderUserMessageAsMarkdown);
    }
    if (
      deliveryOverride === undefined &&
      this.props.isStreaming() &&
      (this.props.queueWhileStreaming?.() ?? false)
    ) {
      // While streaming, submissions queue locally and stay editable above the composer.
      if (text || explicitAttachments.length > 0 || annotations.length > 0) {
        this.props.setDraft("");
        this.attachments.splice(0);
        this.annotations.splice(0);
        this.queuedPrompts.push({
          id: crypto.randomUUID(),
          text,
          attachments,
          renderUserMessageAsMarkdown,
        });
      }
      return;
    }
    if (text || explicitAttachments.length > 0 || annotations.length > 0) {
      this.props.setDraft("");
      this.attachments.splice(0);
      this.annotations.splice(0);
      return this.deliver(
        text,
        attachments,
        deliveryOverride ?? "prompt",
        sessionId,
        true,
        renderUserMessageAsMarkdown,
      );
    }
  }

  async createDraftSession() {
    const sessionId = this.props.sessionId();
    if (!sessionId || !this.props.isDeferredSession?.(sessionId) || !this.props.createDraftSession)
      return false;
    const text = this.props.draft().trim();
    const attachments = this.submissionAttachments();
    if (!text && attachments.length === 0) return false;
    if ((await this.props.createDraftSession(sessionId, text, attachments)) === false) return false;
    this.clearComposer();
    this.props.configureDraftActivation?.({ kind: "current" });
    if (text)
      void this.client.workspaces
        .generateSessionTitle(text, { signal: this.signal })
        .then((title) => {
          if (title && !this.signal.aborted) this.props.applyGeneratedDraftName?.(sessionId, title);
        })
        .catch(() => undefined);
    return true;
  }

  async activateDraftSession(choice?: WorktreeDraftChoice): Promise<boolean> {
    const sessionId = this.props.sessionId();
    if (!sessionId || choice?.kind === "draft") return false;
    if (choice) this.props.configureDraftActivation?.(choice);
    const staged = this.props.activateDraftSession?.(sessionId);
    if (!staged) return false;
    this.props.setDraft(staged.text);
    this.restoreAttachments(staged.attachments);
    return (await this.submit(undefined, shouldRenderMarkdown(staged.text))) !== false;
  }

  cancelDraftEdit() {
    if (!this.editingDraftSession) return;
    this.editingDraftSession = false;
    this.clearComposer();
    this.props.configureDraftActivation?.({ kind: "current" });
  }

  beginEditMessage(entryId: string) {
    const sessionId = this.props.sessionId();
    if (!sessionId || this.props.isStreaming()) return;
    const staged = this.props.draftSessionPrompt?.(sessionId);
    if (staged && entryId === `draft:${sessionId}`) {
      this.props.setDraft(staged.text);
      this.restoreAttachments(staged.attachments);
      this.editingDraftSession = true;
      this.props.configureDraftActivation?.({ kind: "draft" });
      this.requestFocus();
      return false;
    }
    const parts = this.props.canonicalParts();
    const userPart = parts.find(
      (part) =>
        ((part.kind === "text" && part.role === "user") || part.kind === "skill") &&
        part.entryId === entryId,
    );
    if (
      !userPart ||
      (userPart.kind !== "skill" && !(userPart.kind === "text" && userPart.role === "user"))
    )
      return;
    const userPartIndex = parts.indexOf(userPart);
    const lastAssistantIndex = parts.findLastIndex(
      (part, index) => index < userPartIndex && part.kind === "text" && part.role === "assistant",
    );
    const nextAssistantOffset = parts
      .slice(userPartIndex + 1)
      .findIndex((part) => part.kind === "text" && part.role === "assistant");
    const end = nextAssistantOffset < 0 ? parts.length : userPartIndex + 1 + nextAssistantOffset;
    const turnParts = parts.slice(lastAssistantIndex + 1, end);
    this.props.setDraft(
      this.props.editorText?.(entryId) ??
        (userPart.kind === "text" ? userPart.text : userPart.content),
    );
    this.restoreAttachments(this.attachmentsFromParts(turnParts));
    this.editingEntryId = entryId;
    this.requestFocus();
    return userPart.kind === "text" && userPart.renderAs === "markdown";
  }

  removeQueuedPrompt(id: string) {
    const index = this.queuedPrompts.findIndex((entry) => entry.id === id);
    if (index >= 0) this.queuedPrompts.splice(index, 1);
  }

  async cancelSteering() {
    if (!this.props.clearQueue) return;
    await this.props.clearQueue();
    if (!this.signal.aborted) this.optimisticUserMessages.removeByDeliveryState("steering");
  }

  private async renameSession(name: string) {
    if (!name.trim()) {
      this.reportError(new Error("Usage: /name <title>"));
      return false;
    }
    this.error = undefined;
    this.errorDetails = undefined;
    try {
      return (await this.props.renameSession(name.trim())) !== false;
    } catch (error) {
      if (!this.signal.aborted) this.reportError(error);
      return false;
    }
  }

  editQueuedPrompt(id: string) {
    const entry = this.takeQueuedPrompt(id);
    if (!entry) return;
    this.props.setDraft(entry.text);
    for (const attachment of entry.attachments) {
      if (attachment.kind === "annotation") this.annotations.push(...attachment.annotations);
      else this.attachments.push(attachment);
    }
    this.requestFocus();
    return entry.renderUserMessageAsMarkdown;
  }

  steerQueuedPrompt(id: string) {
    const entry = this.takeQueuedPrompt(id);
    if (!entry) return;
    void this.deliverQueued(entry, this.props.isStreaming() ? "steer" : "prompt");
  }

  private takeQueuedPrompt(id: string) {
    const index = this.queuedPrompts.findIndex((entry) => entry.id === id);
    return index >= 0 ? this.queuedPrompts.splice(index, 1)[0] : undefined;
  }

  private drainQueue() {
    if (this.drainingQueue || this.props.isStreaming()) return;
    const entry = this.queuedPrompts[0];
    if (!entry) return;
    this.drainingQueue = true;
    this.queuedPrompts.splice(0, 1);
    void this.deliverQueued(entry, "prompt").finally(() => {
      if (!this.signal.aborted) this.drainingQueue = false;
    });
  }

  private async deliverQueued(entry: QueuedPrompt, delivery: "prompt" | "steer") {
    const sessionId = this.props.sessionId();
    const delivered =
      sessionId !== undefined && (entry.text || entry.attachments.length > 0)
        ? await this.deliver(
            entry.text,
            entry.attachments.slice(),
            delivery,
            sessionId,
            false,
            entry.renderUserMessageAsMarkdown,
          )
        : false;
    if (!delivered && !this.signal.aborted) this.queuedPrompts.unshift(entry);
  }

  private async deliverEdit(
    entryId: string,
    text: string,
    attachments: Attachment[],
    sessionId: string,
    renderUserMessageAsMarkdown: boolean,
  ) {
    const operationId = this.props.operations.start(this.props.operationOwner);
    this.addPendingUserMessage(
      operationId,
      text,
      attachments,
      "prompt",
      renderUserMessageAsMarkdown,
    );
    try {
      await this.props.editMessage({
        sessionId,
        entryId,
        text,
        attachments,
        renderUserMessageAsMarkdown,
      });
      this.finishOperation(operationId);
      return true;
    } catch (error) {
      if (this.signal.aborted) {
        this.finishOperation(operationId);
        return false;
      }
      this.removePendingUserMessage(operationId);
      this.reportError(error);
      this.finishOperation(operationId);
      this.props.setDraft(text);
      this.restoreAttachments(attachments);
      this.editingEntryId = entryId;
      return false;
    }
  }

  get stagedAttachments(): Attachment[] {
    return this.submissionAttachments().map((attachment) => ({ ...attachment }));
  }

  private submissionAttachments() {
    const explicit = this.attachments.filter((attachment) => attachment.kind !== "annotation");
    const context = this.editorContextAttachment;
    const attachments = context
      ? [
          context,
          ...explicit.filter(
            (attachment) =>
              attachment.kind !== "source" ||
              attachment.location.path !== context.location.path ||
              JSON.stringify(attachment.location.range) !== JSON.stringify(context.location.range),
          ),
        ]
      : explicit;
    return [
      ...attachments,
      ...(this.annotations.length > 0
        ? [{ kind: "annotation" as const, annotations: this.annotations.slice() }]
        : []),
    ];
  }

  private clearComposer() {
    this.props.setDraft("");
    this.attachments.splice(0);
    this.annotations.splice(0);
    this.editorContextAttachment = undefined;
  }

  private restoreAttachments(attachments: readonly Attachment[]) {
    this.attachments.splice(0);
    this.annotations.splice(0);
    this.editorContextAttachment = undefined;
    for (const attachment of attachments) {
      if (attachment.kind === "annotation") this.annotations.push(...attachment.annotations);
      else this.attachments.push({ ...attachment });
    }
  }

  private attachmentsFromParts(parts: readonly UiPart[]): Attachment[] {
    return parts.flatMap((part): Attachment[] => {
      if (part.kind === "annotation")
        return [{ kind: "annotation", annotations: part.annotations }];
      if (part.kind !== "attachment") return [];
      if (part.attachmentKind === "image" && part.data)
        return [
          {
            kind: "image",
            name: part.name,
            mimeType: part.mediaType,
            data: part.data,
          },
        ];
      if (part.attachmentKind === "source" && part.location?.range?.end && part.location.path)
        return [
          {
            kind: "source",
            name: part.name,
            location: {
              path: part.location.path,
              range: {
                start: { line: part.location.range.start.line },
                end: { line: part.location.range.end.line },
              },
            },
          },
        ];
      return [];
    });
  }

  private draftParts(
    sessionId: string,
    staged: { text: string; attachments: Attachment[] },
  ): UiPart[] {
    const entryId = `draft:${sessionId}`;
    return [
      {
        id: `draft-${sessionId}-text`,
        kind: "text" as const,
        role: "user" as const,
        entryId,
        text: staged.text,
        status: "complete" as const,
        renderAs: shouldRenderMarkdown(staged.text) ? ("markdown" as const) : undefined,
        draft: true,
      },
      ...staged.attachments.flatMap((attachment, index): UiPart[] => {
        if (attachment.kind === "annotation")
          return [
            {
              id: `draft-${sessionId}-annotation-${index}`,
              kind: "annotation",
              annotations: attachment.annotations,
            },
          ];
        if (attachment.kind === "image")
          return [
            {
              id: `draft-${sessionId}-attachment-${index}`,
              kind: "attachment",
              name: attachment.name,
              mediaType: attachment.mimeType,
              attachmentKind: "image",
              data: attachment.data,
            },
          ];
        if (attachment.kind === "source")
          return [
            {
              id: `draft-${sessionId}-attachment-${index}`,
              kind: "attachment",
              name: attachment.name,
              mediaType: "text/plain",
              attachmentKind: "source",
              location: attachment.location,
            },
          ];
        return [];
      }),
    ];
  }

  private async deliver(
    text: string,
    attachments: Attachment[],
    delivery: "prompt" | "steer",
    sessionId: string,
    restoreOnError: boolean,
    renderUserMessageAsMarkdown: boolean,
  ): Promise<boolean> {
    this.error = undefined;
    this.errorDetails = undefined;
    const builtin = parsePiBuiltinCommand(text);
    if (builtin?.name === "compact") {
      // Compaction is a session operation, not a prompt: no optimistic user message.
      const operationId = this.props.operations.start(this.props.operationOwner);
      try {
        await this.props.compact(sessionId, builtin.args || undefined);
        this.finishOperation(operationId);
        if (this.signal.aborted) {
          this.finishOperation(operationId);
          return false;
        }
        return true;
      } catch (error) {
        if (this.signal.aborted) {
          this.finishOperation(operationId);
          return false;
        }
        this.reportError(error);
        this.finishOperation(operationId);
        if (restoreOnError) this.restoreSubmission(text, attachments);
        return false;
      }
    }
    const operationId = this.props.operations.start(this.props.operationOwner);
    this.addPendingUserMessage(
      operationId,
      text,
      attachments,
      delivery,
      renderUserMessageAsMarkdown,
    );
    try {
      const delivered = await this.props.deliver({
        sessionId,
        text,
        attachments,
        delivery,
        renderUserMessageAsMarkdown,
      });
      if (delivered === false) {
        this.removePendingUserMessage(operationId);
        this.finishOperation(operationId);
        if (restoreOnError) this.restoreSubmission(text, attachments);
        return false;
      }
      this.finishOperation(operationId);
      return !this.signal.aborted;
    } catch (error) {
      if (this.signal.aborted) {
        this.finishOperation(operationId);
        return false;
      }
      this.removePendingUserMessage(operationId);
      this.reportError(error);
      this.finishOperation(operationId);
      if (restoreOnError) this.restoreSubmission(text, attachments);
      return false;
    }
  }

  private restoreSubmission(text: string, attachments: readonly Attachment[]) {
    if (!this.props.draft().trim()) this.props.setDraft(text);
    // A failed send must not discard context added for the next message while awaiting delivery.
    for (const attachment of attachments) {
      if (attachment.kind === "annotation") this.annotations.push(...attachment.annotations);
      else if (attachment !== this.editorContextAttachment) this.attachments.push(attachment);
    }
  }

  receive(event: RendererEvent) {
    if (event.type === "agent-availability-changed" && event.availability.state === "unavailable") {
      for (const operationId of this.activeOperations.slice()) this.finishOperation(operationId);
      this.optimisticUserMessages.clear();
      return;
    }
    if (
      (event.type === "operation-completed" || event.type === "operation-failed") &&
      event.operationId &&
      this.activeOperations.includes(event.operationId)
    ) {
      if (event.type === "operation-failed") {
        const pending = this.optimisticUserMessages.remove(event.operationId);
        if (pending && !this.props.draft().trim()) {
          this.props.setDraft(pending.text);
          this.restoreAttachments(pending.attachments);
        }
        this.error = event.message;
        this.errorDetails = event.details ?? event.message;
      }
      this.finishOperation(event.operationId);
    }
  }

  private finishOperation(operationId: string) {
    this.props.operations.finish(operationId);
  }

  private addPendingUserMessage(
    operationId: string,
    text: string,
    attachments: Attachment[],
    delivery: "prompt" | "steer" | "follow-up",
    renderUserMessageAsMarkdown: boolean,
  ) {
    const deliveryState =
      delivery === "steer"
        ? ("steering" as const)
        : delivery === "follow-up"
          ? ("queued" as const)
          : ("sending" as const);
    const pendingId = this.optimisticUserMessages.add(
      operationId,
      text,
      attachments,
      deliveryState,
      renderUserMessageAsMarkdown,
    );
    return pendingId;
  }

  private removePendingUserMessage(operationId: string) {
    this.optimisticUserMessages.remove(operationId);
  }
}
