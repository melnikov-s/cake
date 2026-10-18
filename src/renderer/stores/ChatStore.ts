import { child, computed, createStore, snapshot, Store } from "r-state-tree";
import { MessageReferencePreviewStore } from "./MessageReferencePreviewStore";
import { messageReferencesInText } from "../../contracts/conversations/message-reference-forwarding";
import { sessionNotificationMarkdown } from "../../contracts/cake-chats/session-digest-reminder";
import { shouldRenderMarkdown } from "../../utils/markdown";
import type { ConversationModeStore, ConversationModeTarget } from "./ConversationModeStore";
import type {
  Annotation,
  Attachment,
  FileSuggestion,
  ConversationSnapshot,
  UiPart,
} from "../../contracts/conversations/session-contract";
import type { ChatConfigurationStore } from "./ChatConfigurationStore";
import type { ExistingWorktreeCandidate, WorktreeDraftChoice } from "./WorktreeCreationStore";
import {
  ScheduledMessageInteractionStore,
  type ScheduledMessageCapabilities,
} from "./ScheduledMessageInteractionStore";
import { PromptCacheStore } from "./PromptCacheStore";
import type { ContextInspectorStore } from "./ContextInspectorStore";
import {
  TranscriptInteractionStore,
  type TranscriptScrollPosition,
  type UserMessagePresentationCapabilities,
} from "./TranscriptInteractionStore";
import {
  WorkLogPresentationStore,
  type WorkLogPresentationCapabilities,
} from "./WorkLogPresentationStore";

export interface QueuedPrompt {
  id: string;
  itemId?: string;
  turnId?: string;
  command?: string;
  text: string;
  attachments: Attachment[];
  renderUserMessageAsMarkdown: boolean;
  /** Admission previews have no runtime identity yet and cannot be acted on. */
  pending?: boolean;
  state: "queued" | "steering";
  source?: Extract<UiPart, { kind: "text" }>["crossSession"];
  scheduled?: Extract<UiPart, { kind: "text" }>["scheduled"];
  /** Whether the prompt text can be pulled back into the composer; runtime-held prompts cannot. */
  editable?: boolean;
}

interface ComposerRewordCapabilities {
  showContextMenu(
    selection: string,
    x: number,
    y: number,
  ): Promise<"reword" | "reword-with-prompt" | undefined>;
  rewordSelection(selection: string, prompt?: string): Promise<string>;
}

export interface ChatStoreProps {
  /** Optional disk-history workflow, shared by every chat surface. */
  history?: {
    readonly hasMore: boolean;
    readonly loading: boolean;
    readonly error?: string;
    load(): Promise<void>;
  };
  id(): string;
  parts(): UiPart[];
  streaming(): boolean;
  submitting(): boolean;
  stoppable?(): boolean;
  configuration(): ChatConfigurationStore | undefined;
  commands(): ConversationSnapshot["commands"];
  placeholder(): string;
  inputLabel(): string;
  draft?(): string;
  setDraft?(value: string): void;
  canSubmit(draft: string): boolean;
  submit(
    draft: string,
    options?: { renderUserMessageAsMarkdown?: boolean },
  ): Promise<boolean | void | { turnId: string }>;
  userMessagePresentation?: UserMessagePresentationCapabilities;
  activateDraft?(choice?: WorktreeDraftChoice): Promise<boolean>;
  sessionCreationChoice?(): WorktreeDraftChoice;
  draftActivationCandidates?(): ExistingWorktreeCandidate[];
  editLastUserMessage?(entryId: string): boolean | undefined;
  isDraftSession?(): boolean;
  editingMessage?(): boolean;
  abort?(): Promise<void>;
  attachments?(): Attachment[];
  addPastedImages?(files: readonly File[]): Promise<void>;
  addPastedText?(text: string): void;
  removeAttachment?(index: number): void;
  annotations?(): readonly Annotation[];
  addAnnotation?(annotation: Omit<Annotation, "id">): void;
  updateAnnotation?(id: string, update: Partial<Omit<Annotation, "id">>): void;
  removeAnnotation?(id: string): void;
  suggestFiles?(prefix: string): Promise<ReadonlyArray<FileSuggestion>>;
  focusRequestRevision?(): number;
  usage?(): ConversationSnapshot["usage"];
  contextInspector?: ContextInspectorStore;
  promptCacheModel?(): { provider: string; modelId: string } | undefined;
  queuedPrompts?(): readonly QueuedPrompt[];
  steerQueuedPrompt?(id: string): void | Promise<void>;
  stopAndSendQueuedPrompt?(id: string): void | Promise<void>;
  reorderQueuedPrompt?(id: string, position: number): void | Promise<void>;
  editQueuedPrompt?(id: string): void | Promise<void>;
  removeQueuedPrompt?(id: string): void;
  scheduledMessages?: ScheduledMessageCapabilities;
  composerVisible?(): boolean;
  /**
   * Whether the composer toolbar offers the model picker. A surface pinned to
   * one model, such as the session assistant, hides it while keeping the
   * configuration Store for its own commands.
   */
  modelPickerVisible?(): boolean;
  composerReword?: ComposerRewordCapabilities;
  hideThinking?(): boolean;
  error?(): { message?: string; details?: string; title?: string };
  workLogPresentation?: WorkLogPresentationCapabilities;
  /** Project-only capability. Shared Chat renders controls; this Store does not own voice state. */
  conversationMode?: {
    readonly workflow: ConversationModeStore;
    readonly target: ConversationModeTarget;
  };
}

export type { TranscriptScrollPosition };

interface EnterContinuation {
  generation: number;
  turnId?: string;
  requested: number;
  completed: number;
}

/** Common state and behavior contract for every Cake conversation surface. */
export class ChatStore extends Store<ChatStoreProps> {
  private enterContinuation: EnterContinuation | undefined;
  private enterContinuationGeneration = 0;
  private advancingEnterContinuation = false;
  private enterContinuationError: string | undefined;

  constructor(props: ChatStore["props"]) {
    super(props);
    this.effect(() => {
      const continuation = this.enterContinuation;
      if (!continuation?.turnId || this.advancingEnterContinuation) return;
      const queued = this.queuedPrompts.find(
        (entry) => entry.turnId === continuation.turnId && !entry.pending,
      );
      // Admission and lane changes can precede their queue projection. Missing means
      // wait, never select another input. A consumed input therefore cannot be escalated.
      if (!queued) return;
      if (
        continuation.requested > continuation.completed &&
        (continuation.completed === 0 || queued.state === "steering")
      )
        void this.advanceEnterContinuation(continuation, queued);
    });
  }

  get hasEnterContinuation() {
    return this.enterContinuation !== undefined;
  }

  beginEnterContinuation() {
    const generation = ++this.enterContinuationGeneration;
    this.enterContinuationError = undefined;
    this.enterContinuation = { generation, requested: 0, completed: 0 };
    return generation;
  }

  cancelEnterContinuation() {
    if (!this.enterContinuation) return;
    this.enterContinuationGeneration += 1;
    this.enterContinuation = undefined;
  }

  continueSentMessage() {
    const continuation = this.enterContinuation;
    if (continuation)
      this.enterContinuation = {
        ...continuation,
        requested: Math.min(2, continuation.requested + 1),
      };
  }

  private async advanceEnterContinuation(continuation: EnterContinuation, queued: QueuedPrompt) {
    this.advancingEnterContinuation = true;
    try {
      if (continuation.completed === 0) {
        if (!this.canSteerQueuedPrompt || queued.command) {
          this.cancelEnterContinuation();
          return;
        }
        if (queued.state === "queued") await this.steerQueuedPrompt(queued.id);
        const current = this.enterContinuation;
        if (current?.generation === continuation.generation)
          this.enterContinuation = { ...current, completed: 1 };
      } else {
        if (this.canStopAndSendQueuedPrompt) await this.stopAndSendQueuedPrompt(queued.id);
        if (this.enterContinuation?.generation === continuation.generation)
          this.cancelEnterContinuation();
      }
    } catch (error) {
      this.enterContinuationError = error instanceof Error ? error.message : String(error);
      if (this.enterContinuation?.generation === continuation.generation)
        this.cancelEnterContinuation();
    } finally {
      this.advancingEnterContinuation = false;
    }
  }
  get history() {
    return this.props.history;
  }
  get conversationMode() {
    return this.props.conversationMode;
  }
  @snapshot private localDraft = "";
  submittingLocally = false;
  rewording = false;
  rewordError: string | undefined;
  private draftRevision = 0;

  @child
  get messageSources(): MessageReferencePreviewStore[] {
    return this.parts.flatMap((part) => {
      const references =
        part.kind === "tool" && part.messageReference
          ? [part.messageReference]
          : (part.kind === "context" && sessionNotificationMarkdown(part.text)) ||
              (part.kind === "text" && part.crossSession?.replyToMessageId)
            ? messageReferencesInText(part.text)
            : [];
      return references.map((reference) =>
        createStore(MessageReferencePreviewStore, {
          key: part.id + reference,
          sourceKey: part.id + reference,
          reference,
        }),
      );
    });
  }

  @child
  get transcriptInteraction(): TranscriptInteractionStore {
    return createStore(TranscriptInteractionStore, {
      parts: this.props.parts,
      loading: () => this.loading,
      userMessagePresentation: this.props.userMessagePresentation,
    });
  }

  @child
  get workLogPresentation(): WorkLogPresentationStore {
    return createStore(WorkLogPresentationStore, {
      parts: this.props.parts,
      presentation: this.props.workLogPresentation,
    });
  }

  @child
  get scheduledMessageInteraction(): ScheduledMessageInteractionStore {
    return createStore(ScheduledMessageInteractionStore, {
      capabilities: this.props.scheduledMessages,
    });
  }

  @child
  get promptCache(): PromptCacheStore {
    return createStore(PromptCacheStore, {
      parts: this.props.parts,
      model: () => this.props.promptCacheModel?.(),
    });
  }

  get id() {
    return this.props.id();
  }
  get draft() {
    return this.props.draft?.() ?? this.localDraft;
  }
  @computed
  get parts() {
    return this.props
      .parts()
      .filter(
        (part) =>
          part.kind !== "text" ||
          Boolean(part.subagentReport) ||
          (part.deliveryState !== "queued" && part.deliveryState !== "steering"),
      );
  }
  get streaming() {
    return this.props.streaming();
  }
  get submitting() {
    return this.submittingLocally || this.props.submitting();
  }
  get loading() {
    return this.streaming || this.submitting;
  }
  get liveWorkPossible() {
    return this.loading || (this.props.stoppable?.() ?? false);
  }
  get configuration() {
    return this.props.configuration();
  }
  get commands() {
    return this.props.commands();
  }
  get placeholder() {
    return this.props.placeholder();
  }
  get inputLabel() {
    return this.props.inputLabel();
  }
  get canSubmit() {
    return this.canSubmitValue();
  }
  canSubmitValue(value = this.draft) {
    return !this.submittingLocally && this.props.canSubmit(value);
  }
  get canActivateDraft() {
    return Boolean(this.props.activateDraft) && !this.submittingLocally;
  }
  get submitsAsDraft() {
    return this.props.sessionCreationChoice?.().kind === "draft";
  }
  get isDraftSession() {
    return this.props.isDraftSession?.() ?? false;
  }
  get editingMessage() {
    return this.props.editingMessage?.() ?? false;
  }
  get canEditLastUserMessage() {
    return Boolean(this.props.editLastUserMessage) && !this.liveWorkPossible;
  }
  @computed
  get lastEditableUserEntryId() {
    const part = this.parts.findLast(
      (candidate) =>
        ((candidate.kind === "text" && candidate.role === "user" && !candidate.subagentReport) ||
          candidate.kind === "skill") &&
        Boolean(candidate.entryId),
    );
    return part?.kind === "text" || part?.kind === "skill" ? part.entryId : undefined;
  }
  get canAbort() {
    return Boolean(this.props.abort);
  }
  get canStop() {
    return this.canAbort && (this.loading || (this.props.stoppable?.() ?? false));
  }
  get canPasteText() {
    return Boolean(this.props.addPastedText);
  }
  addPastedText(text: string) {
    this.props.addPastedText?.(text);
  }

  get canPasteImages() {
    return Boolean(this.props.addPastedImages);
  }
  get canSuggestFiles() {
    return Boolean(this.props.suggestFiles);
  }
  @computed
  get queuedPrompts(): readonly QueuedPrompt[] {
    const prompts = this.props.queuedPrompts?.() ?? [];
    return [
      ...prompts.filter((entry) => entry.state === "steering"),
      ...prompts.filter((entry) => entry.state === "queued"),
    ];
  }
  get canSteerQueuedPrompt() {
    return Boolean(this.props.steerQueuedPrompt);
  }
  get canStopAndSendQueuedPrompt() {
    return Boolean(this.props.stopAndSendQueuedPrompt);
  }
  get canReorderQueuedPrompt() {
    return Boolean(this.props.reorderQueuedPrompt);
  }
  get canEditQueuedPrompt() {
    return Boolean(this.props.editQueuedPrompt);
  }
  get canRemoveQueuedPrompt() {
    return Boolean(this.props.removeQueuedPrompt);
  }
  get composerVisible() {
    return this.props.composerVisible?.() ?? true;
  }
  get modelPickerVisible() {
    return this.props.modelPickerVisible?.() ?? true;
  }
  get hideThinking() {
    return this.props.hideThinking?.() ?? false;
  }
  get attachments() {
    return this.props.attachments?.() ?? [];
  }
  get annotations(): readonly Annotation[] {
    return this.props.annotations?.() ?? [];
  }
  get canAnnotate() {
    return Boolean(this.props.addAnnotation);
  }
  get focusRequestRevision() {
    return this.props.focusRequestRevision?.();
  }
  get contextInspector() {
    return this.props.contextInspector;
  }

  get usage() {
    return this.props.usage?.();
  }
  get error() {
    if (this.enterContinuationError)
      return { message: this.enterContinuationError, title: "Queued prompt" };
    if (this.rewordError) return { message: this.rewordError, title: "Reword failed" };
    if (this.transcriptInteraction.error) return this.transcriptInteraction.error;
    if (this.scheduledMessageInteraction.error)
      return {
        message: this.scheduledMessageInteraction.error,
        title: "Could not cancel scheduled message",
      };
    return this.props.error?.();
  }
  get canRewordComposerSelection() {
    return Boolean(this.props.composerReword);
  }
  canSubmitDraft(value: string) {
    return !this.submittingLocally && this.props.canSubmit(value);
  }

  setDraft(value: string) {
    if (this.draft !== value) {
      this.draftRevision += 1;
      // Writing a new message ends transcript message selection.
      this.transcriptInteraction.clearMessageSelection();
    }
    if (this.props.setDraft) this.props.setDraft(value);
    else this.localDraft = value;
    this.rewordError = undefined;
  }

  showComposerContextMenu(selection: string, x: number, y: number) {
    if (!selection) return Promise.resolve(undefined);
    return (
      this.props.composerReword?.showContextMenu(selection, x, y) ?? Promise.resolve(undefined)
    );
  }

  async rewordComposerSelection(selection: string, prompt?: string) {
    if (!this.props.composerReword || this.rewording) return undefined;
    this.rewording = true;
    this.rewordError = undefined;
    try {
      return await this.props.composerReword.rewordSelection(selection, prompt);
    } catch (error) {
      this.rewordError = error instanceof Error ? error.message : String(error);
      return undefined;
    } finally {
      this.rewording = false;
    }
  }

  async submit(
    value = this.draft,
    options?: {
      renderUserMessageAsMarkdown?: boolean;
      enterContinuation?: number;
    },
  ) {
    if (value !== this.draft) this.setDraft(value);
    const empty = !value.trim() && this.attachments.length === 0 && this.annotations.length === 0;
    const steering = this.queuedPrompts.find(
      (entry) => entry.state === "steering" && !entry.pending,
    );
    if (empty && steering && this.canStopAndSendQueuedPrompt) {
      await this.stopAndSendQueuedPrompt(steering.id);
      return true;
    }
    const queued = this.queuedPrompts.find(
      (entry) => entry.state === "queued" && !entry.pending && !entry.command,
    );
    if (empty && queued) {
      await this.steerQueuedPrompt(queued.id);
      return true;
    }
    if (!this.props.canSubmit(value) || this.submittingLocally) {
      if (this.enterContinuation?.generation === options?.enterContinuation)
        this.cancelEnterContinuation();
      return false;
    }
    this.submittingLocally = true;
    const submittedRevision = this.draftRevision;
    try {
      const submitted = await this.props.submit(value, {
        renderUserMessageAsMarkdown:
          options?.renderUserMessageAsMarkdown ?? shouldRenderMarkdown(value),
      });
      if (submitted !== false && this.draft === value && this.draftRevision === submittedRevision)
        this.setDraft("");
      const continuation = this.enterContinuation;
      if (continuation && continuation.generation === options?.enterContinuation) {
        if (submitted && submitted !== true)
          this.enterContinuation = { ...continuation, turnId: submitted.turnId };
        else this.cancelEnterContinuation();
      }
      return submitted !== false;
    } finally {
      if (
        this.enterContinuation?.generation === options?.enterContinuation &&
        !this.enterContinuation?.turnId
      )
        this.cancelEnterContinuation();
      this.submittingLocally = false;
    }
  }

  steerQueuedPrompt(id: string) {
    return this.props.steerQueuedPrompt?.(id);
  }
  stopAndSendQueuedPrompt(id: string) {
    return this.props.stopAndSendQueuedPrompt?.(id);
  }
  reorderQueuedPrompt(id: string, position: number) {
    return this.props.reorderQueuedPrompt?.(id, position);
  }
  editQueuedPrompt(id: string) {
    return this.props.editQueuedPrompt?.(id);
  }
  removeQueuedPrompt(id: string) {
    this.props.removeQueuedPrompt?.(id);
  }
  get draftActivationCandidates() {
    return this.props.draftActivationCandidates?.();
  }
  activateDraft(choice?: WorktreeDraftChoice) {
    return this.props.activateDraft?.(choice) ?? Promise.resolve(false);
  }
  editLastUserMessage(entryId: string) {
    this.props.editLastUserMessage?.(entryId);
  }
  abort() {
    return this.props.abort?.() ?? Promise.resolve();
  }
  addPastedImages(files: readonly File[]) {
    return this.props.addPastedImages?.(files) ?? Promise.resolve();
  }
  removeAttachment(index: number) {
    this.props.removeAttachment?.(index);
  }
  addAnnotation(annotation: Omit<Annotation, "id">) {
    this.props.addAnnotation?.(annotation);
  }
  updateAnnotation(id: string, update: Partial<Omit<Annotation, "id">>) {
    this.props.updateAnnotation?.(id, update);
  }
  removeAnnotation(id: string) {
    this.props.removeAnnotation?.(id);
  }
  suggestFiles(prefix: string) {
    return this.props.suggestFiles?.(prefix) ?? Promise.resolve([]);
  }
}
