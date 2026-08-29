import { Store, observable } from "r-state-tree";
import type {
  Annotation,
  Attachment,
  ChatConfiguration,
  FileSuggestion,
  UiPart,
} from "../../ipc/session-contract";
import { parsePiBuiltinCommand } from "../../ipc/session-contract";
import type { DesktopClient, DesktopClientEvent } from "../desktop-client";
import type { SessionRegistryStore } from "./SessionRegistryStore";
import type { ReviewsStore } from "./ReviewsStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import { describeError } from "../error-details";
import { pastedImageAttachments } from "../pasted-image-attachments";

interface PendingUserMessage {
  operationId: string;
  sessionId: string;
  canonicalPartCount: number;
  expectedOccurrence: number;
  text: string;
  parts: UiPart[];
}

/** A prompt held locally while the session streams, shown as a chip above the composer. */
export interface QueuedPrompt {
  id: string;
  text: string;
  attachments: Attachment[];
}

export interface MessageComposerStoreProps {
  client: Pick<
    DesktopClient,
    "chooseAttachments" | "suggestFiles" | "submit" | "compactSession" | "setModel"
  >;
  sessionRegistry: SessionRegistryStore;
  reviews(): ReviewsStore;
  projectPath(): string | undefined;
  sessionId(): string | undefined;
  canonicalParts(): UiPart[];
  draft(): string;
  setDraft(value: string): void;
  canSubmit(): boolean;
  isStreaming(): boolean;
  openCommandPane(pane: "changelog" | "tree" | "resources"): Promise<void>;
  matchesPluginCommand(input: string): boolean;
  runPluginCommand(input: string): Promise<boolean>;
  renameSession(name: string): Promise<void>;
  handoffSession(entryId: string, prompt?: string, resolveSource?: boolean): Promise<boolean>;
  operations: SessionOperationCoordinatorStore;
  operationOwner: string;
  newSessionRequest?(): { path: string; configuration?: ChatConfiguration } | undefined;
}

/** Owns attachments, the local prompt queue, optimistic immediate prompts, and prompt delivery. */
export class MessageComposerStore extends Store<MessageComposerStoreProps> {
  attachments: Attachment[] = observable([]);
  annotations: Annotation[] = observable([]);
  editorContextAttachment: Extract<Attachment, { kind: "source" }> | undefined;
  pendingUserMessages: PendingUserMessage[] = observable([]);
  queuedPrompts: QueuedPrompt[] = observable([]);
  focusRequestRevision = 0;
  error: string | undefined;
  errorDetails: string | undefined;
  private drainingQueue = false;

  constructor(props: MessageComposerStore["props"]) {
    super(props);
    this.reaction(
      () => this.props.isStreaming(),
      (streaming, previousStreaming) => {
        if (previousStreaming && !streaming) this.drainQueue();
      },
    );
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

  get parts() {
    const canonical = this.props.canonicalParts();
    const sessionId = this.props.sessionId();
    if (!sessionId) return canonical;
    const pendingParts = this.pendingUserMessages
      .filter((pending) => pending.sessionId === sessionId)
      .filter(
        (pending) =>
          this.userMessageOccurrenceCount(pending.sessionId, pending.text, pending.parts) <
          pending.expectedOccurrence,
      );
    if (pendingParts.length === 0) return canonical;
    const parts = [...canonical];
    let offset = 0;
    for (const pending of pendingParts) {
      parts.splice(
        Math.min(pending.canonicalPartCount + offset, parts.length),
        0,
        ...pending.parts,
      );
      offset += pending.parts.length;
    }
    return parts;
  }

  async addAttachments() {
    this.error = undefined;
    this.errorDetails = undefined;
    try {
      const selected = await this.props.client.chooseAttachments();
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
    this.annotations.push({ id: crypto.randomUUID(), ...annotation });
    this.requestFocus();
  }

  removeAnnotation(id: string) {
    const index = this.annotations.findIndex((annotation) => annotation.id === id);
    if (index >= 0) this.annotations.splice(index, 1);
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
    if (!duplicate) this.attachments.push(attachment);
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

  suggestFiles(prefix: string): Promise<FileSuggestion[]> {
    const projectPath = this.props.projectPath();
    return projectPath ? this.props.client.suggestFiles(projectPath, prefix) : Promise.resolve([]);
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

  async submit(deliveryOverride?: "steer") {
    if (!this.props.canSubmit()) return;
    this.error = undefined;
    this.errorDetails = undefined;
    const text = this.props.draft().trim();
    const command = text.toLocaleLowerCase();
    if (command === "/tree" || command === "/resources" || command === "/changelog") {
      this.props.setDraft("");
      await this.props.openCommandPane(
        command === "/tree" ? "tree" : command === "/changelog" ? "changelog" : "resources",
      );
      return;
    }
    if (this.props.matchesPluginCommand(text)) {
      await this.props.runPluginCommand(text);
      if (this.signal.aborted) return;
      this.props.setDraft("");
      return;
    }
    const builtin = parsePiBuiltinCommand(text);
    if (builtin?.name === "handoff" || builtin?.name === "handoffandresolve") {
      if (this.attachments.length > 0 || this.editorContextAttachment) {
        this.reportError(new Error("Remove attachments before using /handoff"));
        return;
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
        return;
      }
      if (
        await this.props.handoffSession(
          entryId,
          builtin.args || undefined,
          builtin.name === "handoffandresolve",
        )
      )
        this.props.setDraft("");
      return;
    }
    if (builtin?.name === "model") {
      this.props.setDraft("");
      await this.switchModel(builtin.args);
      return;
    }
    if (builtin?.name === "name") {
      this.props.setDraft("");
      await this.renameSession(builtin.args);
      return;
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
    if (deliveryOverride === undefined && this.props.isStreaming()) {
      // While streaming, submissions queue locally and stay editable above the composer.
      if (text || explicitAttachments.length > 0 || annotations.length > 0) {
        this.props.setDraft("");
        this.attachments.splice(0);
        this.annotations.splice(0);
        this.queuedPrompts.push({ id: crypto.randomUUID(), text, attachments });
      }
      return;
    }
    if (text || explicitAttachments.length > 0 || annotations.length > 0) {
      this.props.setDraft("");
      this.attachments.splice(0);
      this.annotations.splice(0);
      await this.deliver(text, attachments, deliveryOverride ?? "prompt", sessionId, true);
    }
  }

  removeQueuedPrompt(id: string) {
    const index = this.queuedPrompts.findIndex((entry) => entry.id === id);
    if (index >= 0) this.queuedPrompts.splice(index, 1);
  }

  private async switchModel(value: string) {
    const separator = value.indexOf("/");
    if (!value || separator < 1) {
      this.reportError(new Error("Usage: /model <provider/model>"));
      return;
    }
    const sessionId = this.props.sessionId();
    if (!sessionId) return;
    this.error = undefined;
    this.errorDetails = undefined;
    const operationId = this.props.operations.start(this.props.operationOwner);
    try {
      await this.props.client.setModel({
        operationId,
        sessionId,
        provider: value.slice(0, separator),
        modelId: value.slice(separator + 1),
      });
      if (this.signal.aborted) this.finishOperation(operationId);
    } catch (error) {
      if (this.signal.aborted) {
        this.finishOperation(operationId);
        return;
      }
      this.reportError(error);
      this.finishOperation(operationId);
    }
  }

  private async renameSession(name: string) {
    if (!name.trim()) {
      this.reportError(new Error("Usage: /name <title>"));
      return;
    }
    this.error = undefined;
    this.errorDetails = undefined;
    try {
      await this.props.renameSession(name.trim());
    } catch (error) {
      if (this.signal.aborted) return;
      this.reportError(error);
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
        ? await this.deliver(entry.text, entry.attachments.slice(), delivery, sessionId, false)
        : false;
    if (!delivered && !this.signal.aborted) this.queuedPrompts.unshift(entry);
  }

  private async deliver(
    text: string,
    attachments: Attachment[],
    delivery: "prompt" | "steer",
    sessionId: string,
    restoreOnError: boolean,
  ): Promise<boolean> {
    this.error = undefined;
    this.errorDetails = undefined;
    const builtin = parsePiBuiltinCommand(text);
    if (builtin?.name === "compact") {
      // Compaction is a session operation, not a prompt: no optimistic user message.
      const operationId = this.props.operations.start(this.props.operationOwner);
      try {
        await this.props.client.compactSession({
          operationId,
          sessionId,
          instructions: builtin.args || undefined,
        });
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
        if (restoreOnError && !this.props.draft().trim()) this.props.setDraft(text);
        return false;
      }
    }
    const operationId = this.props.operations.start(this.props.operationOwner);
    this.addPendingUserMessage(operationId, sessionId, text, attachments, delivery);
    try {
      const newSession = this.props.newSessionRequest?.();
      await this.props.client.submit({
        operationId,
        sessionId,
        text,
        delivery,
        attachments,
        newSession,
      });
      if (this.signal.aborted) {
        this.finishOperation(operationId);
        return false;
      }
      if (newSession) this.props.sessionRegistry.markNewSessionStarted(newSession.path, sessionId);
      return true;
    } catch (error) {
      if (this.signal.aborted) {
        this.finishOperation(operationId);
        return false;
      }
      this.removePendingUserMessage(operationId);
      this.reportError(error);
      this.finishOperation(operationId);
      if (restoreOnError) {
        if (!this.props.draft().trim()) this.props.setDraft(text);
        for (const attachment of attachments) {
          if (attachment.kind === "annotation") this.annotations.push(...attachment.annotations);
          else this.attachments.push(attachment);
        }
      }
      return false;
    }
  }

  reconcile(sessionId: string) {
    for (let index = this.pendingUserMessages.length - 1; index >= 0; index -= 1) {
      const pending = this.pendingUserMessages[index]!;
      if (
        pending.sessionId === sessionId &&
        this.userMessageOccurrenceCount(sessionId, pending.text, pending.parts) >=
          pending.expectedOccurrence
      )
        this.pendingUserMessages.splice(index, 1);
    }
  }

  receive(event: DesktopClientEvent) {
    if (
      event.type === "pi-state-changed" &&
      (event.state === "failed" || event.state === "stopped")
    ) {
      for (const operationId of this.activeOperations.slice()) this.finishOperation(operationId);
      this.pendingUserMessages.splice(0);
      return;
    }
    if (
      (event.type === "operation-completed" || event.type === "operation-failed") &&
      event.operationId &&
      this.activeOperations.includes(event.operationId)
    ) {
      if (event.type === "operation-failed") {
        this.removePendingUserMessage(event.operationId);
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
    sessionId: string,
    text: string,
    attachments: Attachment[],
    delivery: "prompt" | "steer" | "follow-up",
  ) {
    const attachmentParts = attachments.flatMap((attachment, index): UiPart[] => {
      if (attachment.kind === "image")
        return [
          {
            id: `optimistic-user-${operationId}-attachment-${index}`,
            kind: "attachment" as const,
            name: attachment.name,
            mediaType: attachment.mimeType,
            attachmentKind: "image" as const,
            data: attachment.data,
          },
        ];
      if (attachment.kind === "source")
        return [
          {
            id: `optimistic-user-${operationId}-attachment-${index}`,
            kind: "attachment" as const,
            name: attachment.name,
            mediaType: "text/plain",
            attachmentKind: "source" as const,
            location: attachment.location,
          },
        ];
      if (attachment.kind === "annotation")
        return [
          {
            id: `optimistic-user-${operationId}-annotation-${index}`,
            kind: "annotation" as const,
            annotations: attachment.annotations,
          },
        ];
      return [];
    });
    const deliveryState =
      delivery === "steer"
        ? ("steering" as const)
        : delivery === "follow-up"
          ? ("queued" as const)
          : ("sending" as const);
    const parts: UiPart[] = [
      ...(text
        ? [
            {
              id: `optimistic-user-${operationId}`,
              kind: "text" as const,
              role: "user" as const,
              text,
              status: "complete" as const,
              deliveryState,
            },
          ]
        : []),
      ...attachmentParts,
    ];
    const firstAttachment =
      attachmentParts[0]?.kind === "attachment" ? attachmentParts[0] : undefined;
    const earlierPendingCount = this.pendingUserMessages.filter(
      (pending) =>
        pending.sessionId === sessionId &&
        pending.text === text &&
        (Boolean(text) ||
          pending.parts.some(
            (part) =>
              part.kind === "attachment" &&
              firstAttachment !== undefined &&
              part.attachmentKind === firstAttachment.attachmentKind &&
              part.data === firstAttachment.data,
          )),
    ).length;
    this.pendingUserMessages.push({
      operationId,
      sessionId,
      canonicalPartCount: this.props.sessionRegistry.findModel(sessionId)?.uiParts.length ?? 0,
      expectedOccurrence:
        this.userMessageOccurrenceCount(sessionId, text, parts) + earlierPendingCount + 1,
      text,
      parts,
    });
  }

  private removePendingUserMessage(operationId: string) {
    const index = this.pendingUserMessages.findIndex(
      (pending) => pending.operationId === operationId,
    );
    if (index >= 0) this.pendingUserMessages.splice(index, 1);
  }

  private userMessageOccurrenceCount(sessionId: string, text: string, parts: UiPart[] = []) {
    const canonical = this.props.sessionRegistry.findModel(sessionId)?.uiParts ?? [];
    if (text)
      return canonical.filter(
        (part) =>
          part.kind === "text" &&
          part.role === "user" &&
          part.status === "complete" &&
          part.text === text,
      ).length;
    const annotation = parts.find(
      (part): part is Extract<UiPart, { kind: "annotation" }> => part.kind === "annotation",
    );
    if (annotation) {
      const ids = annotation.annotations.map((item) => item.id).join("\u0000");
      return canonical.filter(
        (part) =>
          part.kind === "annotation" &&
          part.annotations.map((item) => item.id).join("\u0000") === ids,
      ).length;
    }
    const attachment = parts.find(
      (part): part is Extract<UiPart, { kind: "attachment" }> => part.kind === "attachment",
    );
    return attachment?.data
      ? canonical.filter(
          (part) =>
            part.kind === "attachment" &&
            part.attachmentKind === attachment.attachmentKind &&
            part.data === attachment.data,
        ).length
      : 0;
  }
}
