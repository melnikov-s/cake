import { Store, child, createStore } from "r-state-tree";
import type { Attachment, UiPart } from "../../ipc/session-contract";
import { parsePiBuiltinCommand } from "../../ipc/session-contract";
import type { StoreEvent } from "../events/StoreEvent";
import { describeError } from "../lib/error-details";
import { OptimisticUserMessagesStore } from "./OptimisticUserMessagesStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";

export interface ConversationDeliveryInput {
  sessionId: string;
  text: string;
  attachments: Attachment[];
  delivery: "prompt" | "steer";
  renderUserMessageAsMarkdown: boolean;
}

export interface ConversationDeliveryStoreProps {
  sessionId(): string | undefined;
  canonicalParts(): UiPart[];
  isStreaming(): boolean;
  deliver(input: ConversationDeliveryInput): Promise<boolean | void>;
  editMessage(
    input: Omit<ConversationDeliveryInput, "delivery"> & { entryId: string },
  ): Promise<void>;
  compact(sessionId: string, instructions?: string): Promise<void>;
  operations: SessionOperationCoordinatorStore;
  operationOwner: string;
  restoreDraft(text: string, attachments: readonly Attachment[]): void;
  replaceDraft(text: string, attachments: readonly Attachment[]): void;
  requestFocus(): void;
  editorText?(entryId: string): string | undefined;
}

/** Owns optimistic projection, operation correlation, editing, and delivery failure recovery. */
export class ConversationDeliveryStore extends Store<ConversationDeliveryStoreProps> {
  editingEntryId: string | undefined;
  error: string | undefined;
  errorDetails: string | undefined;

  @child
  get optimisticUserMessages(): OptimisticUserMessagesStore {
    return createStore(OptimisticUserMessagesStore, {
      canonicalParts: this.props.canonicalParts,
    });
  }

  get activeOperations() {
    return this.props.operations.active(this.props.operationOwner);
  }

  get parts() {
    return this.optimisticUserMessages.parts;
  }

  async send(
    text: string,
    attachments: Attachment[],
    delivery: "prompt" | "steer",
    restoreOnError: boolean,
    renderUserMessageAsMarkdown: boolean,
  ): Promise<boolean> {
    const sessionId = this.props.sessionId();
    if (!sessionId || (!text && attachments.length === 0)) return false;
    this.clearError();
    const builtin = parsePiBuiltinCommand(text);
    if (builtin?.name === "compact")
      return this.compact(sessionId, builtin.args || undefined, text, attachments, restoreOnError);

    const operationId = this.props.operations.start(this.props.operationOwner);
    this.addPending(operationId, text, attachments, delivery, renderUserMessageAsMarkdown);
    try {
      const delivered = await this.props.deliver({
        sessionId,
        text,
        attachments,
        delivery,
        renderUserMessageAsMarkdown,
      });
      if (delivered === false) {
        this.optimisticUserMessages.remove(operationId);
        this.finish(operationId);
        if (restoreOnError) this.props.restoreDraft(text, attachments);
        return false;
      }
      this.finish(operationId);
      return !this.signal.aborted;
    } catch (error) {
      if (this.signal.aborted) {
        this.finish(operationId);
        return false;
      }
      this.optimisticUserMessages.remove(operationId);
      this.reportError(error);
      this.finish(operationId);
      if (restoreOnError) this.props.restoreDraft(text, attachments);
      return false;
    }
  }

  async sendEdit(
    entryId: string,
    text: string,
    attachments: Attachment[],
    renderUserMessageAsMarkdown: boolean,
  ) {
    const sessionId = this.props.sessionId();
    if (!sessionId) return false;
    const operationId = this.props.operations.start(this.props.operationOwner);
    this.addPending(operationId, text, attachments, "prompt", renderUserMessageAsMarkdown);
    try {
      await this.props.editMessage({
        sessionId,
        entryId,
        text,
        attachments,
        renderUserMessageAsMarkdown,
      });
      this.finish(operationId);
      return true;
    } catch (error) {
      if (this.signal.aborted) {
        this.finish(operationId);
        return false;
      }
      this.optimisticUserMessages.remove(operationId);
      this.reportError(error);
      this.finish(operationId);
      this.props.replaceDraft(text, attachments);
      this.editingEntryId = entryId;
      return false;
    }
  }

  beginEditMessage(entryId: string) {
    if (!this.props.sessionId() || this.props.isStreaming()) return undefined;
    const parts = this.props.canonicalParts();
    const userPart = parts.find(
      (part) =>
        ((part.kind === "text" && part.role === "user") || part.kind === "skill") &&
        part.entryId === entryId,
    );
    if (!userPart || (userPart.kind !== "text" && userPart.kind !== "skill")) return undefined;
    if (userPart.kind === "text" && userPart.role !== "user") return undefined;
    const userPartIndex = parts.indexOf(userPart);
    const lastAssistantIndex = parts.findLastIndex(
      (part, index) => index < userPartIndex && part.kind === "text" && part.role === "assistant",
    );
    const nextAssistantOffset = parts
      .slice(userPartIndex + 1)
      .findIndex((part) => part.kind === "text" && part.role === "assistant");
    const end = nextAssistantOffset < 0 ? parts.length : userPartIndex + 1 + nextAssistantOffset;
    this.props.replaceDraft(
      this.props.editorText?.(entryId) ??
        (userPart.kind === "text" ? userPart.text : userPart.content),
      attachmentsFromParts(parts.slice(lastAssistantIndex + 1, end)),
    );
    this.editingEntryId = entryId;
    this.props.requestFocus();
    return userPart.kind === "text" && userPart.renderAs === "markdown";
  }

  cancelEdit() {
    this.editingEntryId = undefined;
  }

  clearOptimisticSteering() {
    this.optimisticUserMessages.removeByDeliveryState("steering");
  }

  receive(event: StoreEvent) {
    if (event.type === "agent-availability-changed" && event.availability.state === "unavailable") {
      for (const operationId of this.activeOperations.slice()) this.finish(operationId);
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
        if (pending) this.props.restoreDraft(pending.text, pending.attachments);
        this.error = event.message;
        this.errorDetails = event.details ?? event.message;
      }
      this.finish(event.operationId);
    }
  }

  reportError(error: unknown) {
    const described = describeError(error);
    this.error = described.message;
    this.errorDetails = described.details;
  }

  clearError() {
    this.error = undefined;
    this.errorDetails = undefined;
  }

  private async compact(
    sessionId: string,
    instructions: string | undefined,
    text: string,
    attachments: Attachment[],
    restoreOnError: boolean,
  ) {
    const operationId = this.props.operations.start(this.props.operationOwner);
    try {
      await this.props.compact(sessionId, instructions);
      this.finish(operationId);
      return !this.signal.aborted;
    } catch (error) {
      if (this.signal.aborted) {
        this.finish(operationId);
        return false;
      }
      this.reportError(error);
      this.finish(operationId);
      if (restoreOnError) this.props.restoreDraft(text, attachments);
      return false;
    }
  }

  private addPending(
    operationId: string,
    text: string,
    attachments: Attachment[],
    delivery: "prompt" | "steer",
    renderUserMessageAsMarkdown: boolean,
  ) {
    this.optimisticUserMessages.add(
      operationId,
      text,
      attachments,
      delivery === "steer" ? "steering" : "sending",
      renderUserMessageAsMarkdown,
    );
  }

  private finish(operationId: string) {
    this.props.operations.finish(operationId);
  }
}

const attachmentsFromParts = (parts: readonly UiPart[]): Attachment[] =>
  parts.flatMap((part): Attachment[] => {
    if (part.kind === "annotation") return [{ kind: "annotation", annotations: part.annotations }];
    if (part.kind !== "attachment") return [];
    if (part.attachmentKind === "image" && part.data)
      return [{ kind: "image", name: part.name, mimeType: part.mediaType, data: part.data }];
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
