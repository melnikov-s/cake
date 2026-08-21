import { Store, observable } from "r-state-tree";
import type { Attachment, FileSuggestion, UiPart } from "../../ipc/session-contract";
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
  client: Pick<DesktopClient, "chooseAttachments" | "suggestFiles" | "submit">;
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
  operations: SessionOperationCoordinatorStore;
  operationOwner: string;
}

/** Owns attachments, the local prompt queue, optimistic immediate prompts, and prompt delivery. */
export class MessageComposerStore extends Store<MessageComposerStoreProps> {
  attachments: Attachment[] = observable([]);
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
      this.reportError(error);
    }
  }

  async addPastedImages(files: readonly File[]) {
    this.error = undefined;
    this.errorDetails = undefined;
    try {
      const attachments = await pastedImageAttachments(files, 20 - this.attachments.length);
      this.attachments.push(...attachments);
    } catch (error) {
      this.reportError(error);
    }
  }

  suggestFiles(prefix: string): Promise<FileSuggestion[]> {
    const projectPath = this.props.projectPath();
    return projectPath ? this.props.client.suggestFiles(projectPath, prefix) : Promise.resolve([]);
  }

  removeAttachment(index: number) {
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
      this.props.setDraft("");
      return;
    }
    const sessionId = this.props.sessionId();
    if (!sessionId) return;
    const attachments = this.attachments.slice();
    if (deliveryOverride === undefined && this.props.isStreaming()) {
      // While streaming, submissions queue locally and stay editable above the composer.
      if (text || attachments.length > 0) {
        this.props.setDraft("");
        this.attachments.splice(0);
        this.queuedPrompts.push({ id: crypto.randomUUID(), text, attachments });
      }
      return;
    }
    if (text || attachments.length > 0) {
      this.props.setDraft("");
      this.attachments.splice(0);
      await this.deliver(text, attachments, deliveryOverride ?? "prompt", sessionId, true);
    }
  }

  removeQueuedPrompt(id: string) {
    const index = this.queuedPrompts.findIndex((entry) => entry.id === id);
    if (index >= 0) this.queuedPrompts.splice(index, 1);
  }

  editQueuedPrompt(id: string) {
    const entry = this.takeQueuedPrompt(id);
    if (!entry) return;
    this.props.setDraft(entry.text);
    this.attachments.push(...entry.attachments);
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
      this.drainingQueue = false;
    });
  }

  private async deliverQueued(entry: QueuedPrompt, delivery: "prompt" | "steer") {
    const sessionId = this.props.sessionId();
    const delivered =
      sessionId !== undefined && (entry.text || entry.attachments.length > 0)
        ? await this.deliver(entry.text, entry.attachments.slice(), delivery, sessionId, false)
        : false;
    if (!delivered) this.queuedPrompts.unshift(entry);
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
    const operationId = this.props.operations.start(this.props.operationOwner);
    this.addPendingUserMessage(operationId, sessionId, text, attachments, delivery);
    try {
      await this.props.client.submit({ operationId, sessionId, text, delivery, attachments });
      return true;
    } catch (error) {
      this.removePendingUserMessage(operationId);
      this.reportError(error);
      this.finishOperation(operationId);
      if (restoreOnError) {
        if (!this.props.draft().trim()) this.props.setDraft(text);
        this.attachments.push(...attachments);
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
        this.reportError(event.message);
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
    const imageParts: UiPart[] = attachments.flatMap((attachment, index) =>
      attachment.kind === "image"
        ? [
            {
              id: `optimistic-user-${operationId}-attachment-${index}`,
              kind: "attachment" as const,
              name: attachment.name,
              mediaType: attachment.mimeType,
              attachmentKind: "image" as const,
              data: attachment.data,
            },
          ]
        : [],
    );
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
      ...imageParts,
    ];
    const firstImageData = imageParts[0]?.kind === "attachment" ? imageParts[0].data : undefined;
    const earlierPendingCount = this.pendingUserMessages.filter(
      (pending) =>
        pending.sessionId === sessionId &&
        pending.text === text &&
        (Boolean(text) ||
          pending.parts.some((part) => part.kind === "attachment" && part.data === firstImageData)),
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
    const image = parts.find(
      (part): part is Extract<UiPart, { kind: "attachment" }> =>
        part.kind === "attachment" && part.attachmentKind === "image",
    );
    return image?.data
      ? canonical.filter((part) => part.kind === "attachment" && part.data === image.data).length
      : 0;
  }
}
