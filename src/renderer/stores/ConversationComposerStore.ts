import { Store, child, computed, createStore } from "r-state-tree";
import type { Attachment, UiPart } from "../../ipc/session-contract";
import { parsePiBuiltinCommand } from "../../ipc/session-contract";
import { shouldRenderMarkdown } from "../../utils/markdown";
import type { StoreEvent } from "../events/StoreEvent";
import { describeError } from "../lib/error-details";
import { ComposerDraftStore } from "./ComposerDraftStore";
import {
  ConversationDeliveryStore,
  type ConversationDeliveryInput,
} from "./ConversationDeliveryStore";
import { PendingSessionDraftStore, type PendingSessionPrompt } from "./PendingSessionDraftStore";
import { PromptQueueStore } from "./PromptQueueStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import type { WorktreeDraftChoice } from "./WorktreeCreationStore";

export type ComposerDeliveryInput = ConversationDeliveryInput;
export type { QueuedPrompt } from "./PromptQueueStore";

export interface ConversationComposerStoreProps {
  projectPath?(): string | undefined;
  sessionId(): string | undefined;
  canonicalParts(): UiPart[];
  canSubmit(): boolean;
  isStreaming(): boolean;
  queueWhileStreaming?(): boolean;
  openCommandPane?(pane: "changelog" | "tree" | "resources"): Promise<void>;
  selectModel(value: string): Promise<boolean | void>;
  renameSession(name: string): Promise<boolean | void>;
  canHandoff?(): boolean;
  handoffSession(entryId: string, prompt?: string, resolveSource?: boolean): Promise<boolean>;
  deliver(input: ConversationDeliveryInput): Promise<boolean | void>;
  editMessage(
    input: Omit<ConversationDeliveryInput, "delivery"> & { entryId: string },
  ): Promise<void>;
  compact(sessionId: string, instructions?: string): Promise<void>;
  clearQueue?(): Promise<void>;
  scheduleMessage?(sessionId: string, args: string): Promise<boolean>;
  operations: SessionOperationCoordinatorStore;
  operationOwner: string;
  draftSessionPrompt?(sessionId: string): PendingSessionPrompt | undefined;
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
  activateDraftSession?(sessionId: string): PendingSessionPrompt | undefined;
  applyGeneratedDraftName?(sessionId: string, title: string): void;
  configureDraftActivation?(choice: WorktreeDraftChoice): void;
  sessionCreationChoice?(): WorktreeDraftChoice;
  editorText?(entryId: string): string | undefined;
}

/** Coordinates draft, queue, pending-session, command, and delivery composer capabilities. */
export class ConversationComposerStore extends Store<ConversationComposerStoreProps> {
  private commandError: string | undefined;
  private commandErrorDetails: string | undefined;

  @child
  get draftStore(): ComposerDraftStore {
    return createStore(ComposerDraftStore, { projectPath: this.props.projectPath });
  }

  @child
  get deliveryStore(): ConversationDeliveryStore {
    return createStore(ConversationDeliveryStore, {
      sessionId: this.props.sessionId,
      canonicalParts: this.props.canonicalParts,
      isStreaming: this.props.isStreaming,
      deliver: this.props.deliver,
      editMessage: this.props.editMessage,
      compact: this.props.compact,
      operations: this.props.operations,
      operationOwner: this.props.operationOwner,
      restoreDraft: (text, attachments) => this.draftStore.restoreAfterFailure(text, attachments),
      replaceDraft: (text, attachments) => this.draftStore.restore(text, attachments),
      requestFocus: () => this.draftStore.requestFocus(),
      editorText: this.props.editorText,
    });
  }

  @child
  get promptQueueStore(): PromptQueueStore {
    return createStore(PromptQueueStore, {
      isStreaming: this.props.isStreaming,
      deliver: (entry, delivery) =>
        this.deliveryStore.send(
          entry.text,
          entry.attachments.slice(),
          delivery,
          false,
          entry.renderUserMessageAsMarkdown,
        ),
      restoreForEditing: (entry) => {
        this.draftStore.setText(entry.text);
        this.draftStore.appendAttachments(entry.attachments);
        this.draftStore.requestFocus();
      },
      clearRemoteQueue: this.props.clearQueue,
      clearOptimisticSteering: () => this.deliveryStore.clearOptimisticSteering(),
    });
  }

  @child
  get pendingSessionDraftStore(): PendingSessionDraftStore {
    return createStore(PendingSessionDraftStore, {
      sessionId: this.props.sessionId,
      prompt: this.props.draftSessionPrompt,
      isDeferred: this.props.isDeferredSession,
      create: this.props.createDraftSession,
      update: this.props.updateDraftSession,
      activate: this.props.activateDraftSession,
      applyGeneratedName: this.props.applyGeneratedDraftName,
      configureActivation: this.props.configureDraftActivation,
      creationChoice: this.props.sessionCreationChoice,
    });
  }

  @computed
  get parts() {
    return this.pendingSessionDraftStore.parts() ?? this.deliveryStore.parts;
  }

  get error() {
    return this.commandError ?? this.deliveryStore.error ?? this.draftStore.error;
  }

  get errorDetails() {
    return (
      this.commandErrorDetails ?? this.deliveryStore.errorDetails ?? this.draftStore.errorDetails
    );
  }

  get editingMessage() {
    return Boolean(this.deliveryStore.editingEntryId || this.pendingSessionDraftStore.editing);
  }

  async submit(deliveryOverride?: "steer", renderUserMessageAsMarkdown = false) {
    if (!this.props.canSubmit()) return;
    this.clearError();
    const text = this.draftStore.text.trim();
    const attachments = this.draftStore.submissionAttachments;

    if (this.pendingSessionDraftStore.editing) {
      if (!(await this.pendingSessionDraftStore.update(text, attachments))) return false;
      const choice = this.props.sessionCreationChoice?.() ?? { kind: "draft" as const };
      if (choice.kind !== "draft") return this.activateDraftSession(choice);
      this.draftStore.clear();
      this.props.configureDraftActivation?.({ kind: "current" });
      return true;
    }
    if (this.pendingSessionDraftStore.shouldCreate) {
      const created = await this.pendingSessionDraftStore.create(text, attachments);
      if (created) this.draftStore.clear();
      return created;
    }
    if (this.isApplicationCommand(text)) {
      const commandResult = await this.dispatchApplicationCommand(text);
      if (commandResult.handled) return commandResult.result;
    }

    const sessionId = this.props.sessionId();
    if (!sessionId) return;
    const editingEntryId = this.deliveryStore.editingEntryId;
    if (editingEntryId) {
      this.deliveryStore.cancelEdit();
      this.draftStore.clear();
      return this.deliveryStore.sendEdit(
        editingEntryId,
        text,
        attachments,
        renderUserMessageAsMarkdown,
      );
    }
    if (
      deliveryOverride === undefined &&
      this.props.isStreaming() &&
      (this.props.queueWhileStreaming?.() ?? false)
    ) {
      if (text || attachments.length) {
        this.draftStore.clearForSubmit();
        this.promptQueueStore.enqueue(text, attachments, renderUserMessageAsMarkdown);
      }
      return;
    }
    if (text || attachments.length) {
      this.draftStore.clearForSubmit();
      return this.deliveryStore.send(
        text,
        attachments,
        deliveryOverride ?? "prompt",
        true,
        renderUserMessageAsMarkdown,
      );
    }
  }

  async activateDraftSession(choice?: WorktreeDraftChoice): Promise<boolean> {
    const staged = this.pendingSessionDraftStore.takeForActivation(choice);
    if (!staged) return false;
    this.draftStore.restore(staged.text, staged.attachments);
    return (await this.submit(undefined, shouldRenderMarkdown(staged.text))) !== false;
  }

  cancelDraftEdit() {
    if (!this.pendingSessionDraftStore.cancelEdit()) return;
    this.draftStore.clear();
  }

  beginEditMessage(entryId: string) {
    const staged = this.pendingSessionDraftStore.beginEdit(entryId);
    if (staged) {
      this.draftStore.restore(staged.text, staged.attachments);
      this.draftStore.requestFocus();
      return false;
    }
    return this.deliveryStore.beginEditMessage(entryId);
  }

  receive(event: StoreEvent) {
    this.deliveryStore.receive(event);
  }

  reportError(error: unknown, context?: string) {
    const described = describeError(error, context);
    this.commandError = described.message;
    this.commandErrorDetails = described.details;
  }

  private clearError() {
    this.commandError = undefined;
    this.commandErrorDetails = undefined;
    this.deliveryStore.clearError();
    this.draftStore.clearError();
  }

  private isApplicationCommand(text: string) {
    const command = text.toLocaleLowerCase();
    if (command === "/tree" || command === "/resources" || command === "/changelog") return true;
    const name = parsePiBuiltinCommand(text)?.name;
    return (
      name === "handoff" ||
      name === "handoffandresolve" ||
      name === "model" ||
      name === "name" ||
      (name === "schedule" && Boolean(this.props.scheduleMessage))
    );
  }

  private async dispatchApplicationCommand(
    text: string,
  ): Promise<{ handled: false } | { handled: true; result: boolean | void }> {
    const command = text.toLocaleLowerCase();
    if (
      this.props.openCommandPane &&
      (command === "/tree" || command === "/resources" || command === "/changelog")
    ) {
      this.draftStore.setText("");
      await this.props.openCommandPane(
        command === "/tree" ? "tree" : command === "/changelog" ? "changelog" : "resources",
      );
      return { handled: true, result: true };
    }
    const builtin = parsePiBuiltinCommand(text);
    if (builtin?.name === "handoff" || builtin?.name === "handoffandresolve") {
      if (this.props.canHandoff?.() === false) {
        this.reportError(new Error("Session Family members cannot be handed off"));
        return { handled: true, result: false };
      }
      if (
        this.draftStore.attachments.length ||
        this.draftStore.annotationDraft.annotations.length
      ) {
        this.reportError(new Error("Remove attachments before using /handoff"));
        return { handled: true, result: false };
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
        return { handled: true, result: false };
      }
      const handedOff = await this.props.handoffSession(
        entryId,
        builtin.args || undefined,
        builtin.name === "handoffandresolve",
      );
      if (handedOff && this.draftStore.text.trim() === text) this.draftStore.setText("");
      return { handled: true, result: handedOff };
    }
    if (builtin?.name === "model") {
      if (builtin.args.indexOf("/") < 1) {
        this.reportError(new Error("Usage: /model <provider/model>"));
        return { handled: true, result: false };
      }
      const selected = (await this.props.selectModel(builtin.args)) !== false;
      if (selected && this.draftStore.text.trim() === text) this.draftStore.setText("");
      return { handled: true, result: selected };
    }
    if (builtin?.name === "name") {
      if (!builtin.args.trim()) {
        this.reportError(new Error("Usage: /name <title>"));
        return { handled: true, result: false };
      }
      try {
        const renamed = (await this.props.renameSession(builtin.args.trim())) !== false;
        if (renamed && this.draftStore.text.trim() === text) this.draftStore.setText("");
        return { handled: true, result: renamed };
      } catch (error) {
        if (!this.signal.aborted) this.reportError(error);
        return { handled: true, result: false };
      }
    }
    if (builtin?.name === "schedule" && this.props.scheduleMessage) {
      if (this.draftStore.submissionAttachments.length) {
        this.reportError(new Error("Remove attachments before using /schedule"));
        return { handled: true, result: false };
      }
      const sessionId = this.props.sessionId();
      if (!sessionId || this.props.isDeferredSession?.(sessionId)) {
        this.reportError(new Error("Scheduling requires an existing conversation"));
        return { handled: true, result: false };
      }
      try {
        const scheduled = await this.props.scheduleMessage(sessionId, builtin.args);
        if (scheduled && !this.signal.aborted) this.draftStore.setText("");
        return { handled: true, result: scheduled && !this.signal.aborted };
      } catch (error) {
        if (!this.signal.aborted) this.reportError(error);
        return { handled: true, result: false };
      }
    }
    return { handled: false };
  }
}
