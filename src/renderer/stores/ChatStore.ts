import { DraftMoveContext } from "./context/DraftMoveContext";
import type { ComposerDraftStore } from "./ComposerDraftStore";
import type { CaptureDestination } from "../../contracts/desktop/screen-capture-data";
import { CaptureDestinationPickerStore } from "./CaptureDestinationPickerStore";
import { SessionReferenceContext } from "./context/SessionReferenceContext";
import { splitComposerReferences } from "../lib/composer-references";
import { ClientContext } from "./context/ClientContext";
import type { SessionPurpose } from "../../contracts/project-sessions/session-purpose";
import { child, computed, createStore, snapshot, Store } from "r-state-tree";
import { ChatPresentationContext } from "./context/ChatPresentationContext";
import { DictationContext } from "./context/DictationContext";
import type { DictationSubmission } from "./DictationStore";
import { MessageReferencePreviewStore } from "./MessageReferencePreviewStore";
import { incomingMessageReferences } from "../lib/incoming-message-references";
import { messageReferencesInText } from "../../contracts/conversations/message-reference-forwarding";
import { sessionNotificationEntries } from "../../contracts/cake-chats/session-digest-reminder";
import { SessionUpdateEntryStore } from "./SessionUpdateEntryStore";
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
import type { TranscriptAttachmentImagesStore } from "./TranscriptAttachmentImagesStore";
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
  /** Typed authorship for the read-only queue indicator; never inferred from text/editability. */
  provenance?: "agent" | "attention" | "automatic";
  scheduled?: Extract<UiPart, { kind: "text" }>["scheduled"];
  /** Cake admitted it for someone else (a worker report, batched updates, an opened attention
   * item, Workboard entries). */
  automatic?: boolean;
  /** Whether the prompt text can be pulled back into the composer; runtime-held prompts cannot. */
  editable?: boolean;
}

interface ComposerRewordCapabilities {
  rewordSelection(selection: string, prompt?: string): Promise<string>;
}

export interface ChatStoreProps {
  /** Live projection demand owned by the actual transcript consumer. */
  retainTranscript?(): () => void;
  /** Optional disk-history workflow, shared by every chat surface. */
  history?: {
    readonly hasMore: boolean;
    readonly loading: boolean;
    readonly error?: string;
    load(): Promise<void>;
    retain?(): () => void;
  };
  id(): string;
  parts(): UiPart[];
  /** Display pixels for vaulted image inputs; surfaces without it show reference links only. */
  attachmentImages?(): TranscriptAttachmentImagesStore;
  streaming(): boolean;
  submitting(): boolean;
  stoppable?(): boolean;
  configuration(): ChatConfigurationStore | undefined;
  commands(): ConversationSnapshot["commands"];
  placeholder(): string;
  inputLabel(): string;
  composerDraft?(): ComposerDraftStore;
  draft?(): string;
  setDraft?(value: string): void;
  canSubmit(draft: string): boolean;
  submit(
    draft: string,
    options?: { renderUserMessageAsMarkdown?: boolean },
  ): Promise<boolean | void | { turnId: string }>;
  sendQueuedToSideChat?(id: string): Promise<void>;
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
  addReplyContext?(name: string, text: string): void;
  removeAttachment?(index: number): void;
  annotations?(): readonly Annotation[];
  addAnnotation?(annotation: Omit<Annotation, "id">): void | boolean;
  updateAnnotation?(id: string, update: Partial<Omit<Annotation, "id">>): void;
  removeAnnotation?(id: string): void;
  suggestFiles?(prefix: string): Promise<ReadonlyArray<FileSuggestion>>;
  focusRequestRevision?(): number;
  focusRequestIsExplicit?(): boolean;
  usage?(): ConversationSnapshot["usage"];
  contextInspector?: ContextInspectorStore;
  estimatedContextUsage?: boolean;
  promptCacheModel?(): { provider: string; modelId: string } | undefined;
  queuedPrompts?(): readonly QueuedPrompt[];
  steerQueuedPrompt?(id: string): void | Promise<void>;
  stopAndSendQueuedPrompt?(id: string): void | Promise<void>;
  reorderQueuedPrompt?(id: string, position: number): void | Promise<void>;
  editQueuedPrompt?(id: string, text: string): Promise<boolean>;
  removeQueuedPrompt?(id: string): void;
  withdrawQueuedPrompt?(id: string): Promise<void>;
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
  retainTranscript() {
    return this.props.retainTranscript?.();
  }

  private localInputHistoryRevision = 0;
  private enterContinuation: EnterContinuation | undefined;
  private enterContinuationGeneration = 0;
  private advancingEnterContinuation = false;
  private enterContinuationError: string | undefined;
  /** Empty Enter escalates the user's own latest message, never whatever heads the queue. */
  private lastSentTurnId: string | undefined;

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
  private pendingImagePastes = 0;

  // Source presentation belongs to the transcript, not an assistant's choice to call
  // messages.present. Discover exact identities only; bodies stay lazy in each preview.
  @child
  get messageSources(): MessageReferencePreviewStore[] {
    const incoming = incomingMessageReferences(this.parts);
    return this.parts.flatMap((part) => {
      const references =
        part.kind === "tool" && part.messageReference
          ? [part.messageReference]
          : part.kind === "text" &&
              ((part.role === "assistant" && part.status !== "streaming") ||
                part.subagentReport ||
                part.crossSession ||
                part.agentSource)
            ? [
                ...new Set([
                  ...(part.crossSession?.sourceMessageRef
                    ? [part.crossSession.sourceMessageRef]
                    : []),
                  ...(part.agentSource ? messageReferencesInText(part.agentSource.href) : []),
                  ...messageReferencesInText(part.text),
                ]),
              ]
            : [];
      return references
        .filter(
          (reference) =>
            (part.kind === "text" &&
              (part.crossSession || part.subagentReport || part.agentSource)) ||
            !incoming.has(reference),
        )
        .map((reference) =>
          createStore(MessageReferencePreviewStore, {
            key: part.id + reference,
            partId: part.id,
            reference,
          }),
        );
    });
  }

  @child
  get sessionUpdates(): SessionUpdateEntryStore[] {
    return this.parts.flatMap((part) =>
      part.kind === "context"
        ? sessionNotificationEntries(part.text).map((entry) =>
            createStore(SessionUpdateEntryStore, {
              key: part.id + entry.key,
              partId: part.id,
              entry,
            }),
          )
        : [],
    );
  }

  @child
  get transcriptInteraction(): TranscriptInteractionStore {
    return createStore(TranscriptInteractionStore, {
      // Selection must use the same visible projection as the transcript, not queued inputs.
      parts: () => this.parts,
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
  get attachmentImages() {
    return this.props.attachmentImages?.();
  }
  get draft() {
    return this.props.draft?.() ?? this.localDraft;
  }
  @computed
  get parts() {
    const parts = this.props
      .parts()
      .filter(
        (part) =>
          part.kind !== "text" ||
          (part.deliveryState !== "queued" && part.deliveryState !== "steering"),
      );
    const incoming = incomingMessageReferences(parts);
    const deliveries = new Set<string>();
    return parts.filter((part) => {
      // Keep the Pi receipt in history, but do not mount a second source surface.
      if (part.kind === "tool" && part.messageReference && incoming.has(part.messageReference))
        return false;
      if (part.kind !== "text" || !part.crossSession) return true;
      const id = part.crossSession.messageId;
      if (deliveries.has(id)) return false;
      deliveries.add(id);
      return true;
    });
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
    return !this.submittingLocally && this.pendingImagePastes === 0 && this.props.canSubmit(value);
  }
  get canActivateDraft() {
    return (
      Boolean(this.props.activateDraft) && !this.submittingLocally && this.pendingImagePastes === 0
    );
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
        !candidate.originalHistory &&
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

  addReplyContext(name: string, text: string) {
    this.props.addReplyContext?.(name, text);
  }

  replyToMessage(entryId: string) {
    const quoted = this.parts.flatMap((part) =>
      part.kind === "text" && part.entryId === entryId ? [part.text] : [],
    );
    this.addReplyContext(
      "Reply to message",
      `> replying to message: ${entryId}\n\n${quoted.join("\n\n")}`,
    );
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
    return (
      this.props.hideThinking?.() ?? ChatPresentationContext.consume(this)?.hideThinking() ?? false
    );
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
  get focusRequestIsExplicit() {
    return this.props.focusRequestIsExplicit?.() ?? false;
  }
  get contextInspector() {
    return this.props.contextInspector;
  }

  get usage() {
    return this.props.usage?.();
  }

  get estimatedContextUsage() {
    return this.props.estimatedContextUsage ?? false;
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
    return this.canSubmitValue(value);
  }

  get inputHistoryRevision() {
    return (
      (this.props.composerDraft?.().inputHistoryRevision ?? 0) + this.localInputHistoryRevision
    );
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

  get sessionReferencePurposes() {
    const catalog = SessionReferenceContext.consume(this);
    const purposes = new Map<string, SessionPurpose>();
    for (const segment of splitComposerReferences(this.draft)) {
      if (!segment.sessionId) continue;
      const purpose = catalog?.sessionPurpose?.(segment.sessionId);
      if (purpose) purposes.set(segment.sessionId, purpose);
    }
    return purposes;
  }

  get sessionReferenceNames(): ReadonlyMap<string, string> {
    const catalog = SessionReferenceContext.consume(this);
    const names = new Map<string, string>();
    for (const segment of splitComposerReferences(this.draft)) {
      if (!segment.sessionId) continue;
      const title = catalog?.sessionTitle(segment.sessionId);
      if (title) names.set(segment.sessionId, title);
    }
    return names;
  }

  @child get sessionReferencePicker(): CaptureDestinationPickerStore | undefined {
    const catalog = SessionReferenceContext.consume(this);
    return catalog
      ? createStore(CaptureDestinationPickerStore, {
          // Child reconciliation reads prop values on every access; keep catalog work lazy.
          routing: () => catalog.destinations,
        })
      : undefined;
  }

  get canMoveDraft() {
    return Boolean(
      this.props.composerDraft?.().hasContent &&
      !this.props.composerDraft?.().pendingImageImports &&
      !this.editingMessage &&
      !DraftMoveContext.consume(this)?.busy &&
      this.draftMovePicker,
    );
  }

  @child get draftMovePicker(): CaptureDestinationPickerStore | undefined {
    const moves = DraftMoveContext.consume(this);
    const sourceId = this.id;
    return moves
      ? createStore(CaptureDestinationPickerStore, {
          routing: () => moves.destinations(sourceId),
        })
      : undefined;
  }

  canForwardQueuedPrompt(entry: QueuedPrompt) {
    return Boolean(
      this.props.withdrawQueuedPrompt &&
      this.draftMovePicker &&
      !entry.pending &&
      entry.editable !== false &&
      !entry.command &&
      !entry.provenance &&
      !entry.automatic &&
      !entry.scheduled &&
      !entry.source,
    );
  }

  async forwardQueuedPrompt(id: string, text: string, destination: CaptureDestination) {
    const entry = this.queuedPrompts.find((entry) => entry.id === id);
    if (!entry || !this.canForwardQueuedPrompt(entry))
      throw new Error("That queued message is no longer available to forward.");
    if (!text.trim() && !entry.attachments.length) return false;
    return DraftMoveContext.consume(this)!.forwardQueued(
      this.id,
      { text, attachments: entry.attachments.slice() },
      destination,
      async () => {
        const current = this.queuedPrompts.find((item) => item.id === id);
        if (!current || !this.canForwardQueuedPrompt(current))
          throw new Error("That queued message is no longer available to forward.");
        await this.props.withdrawQueuedPrompt!(id);
      },
    );
  }

  moveDraft(destination: CaptureDestination) {
    const source = this.props.composerDraft?.();
    if (source && !this.editingMessage)
      return DraftMoveContext.consume(this)?.move(this.id, source, destination);
  }

  showComposerContextMenu(selection: string, x: number, y: number) {
    return ClientContext.consume(this)!.electron.showComposerContextMenu(
      {
        selection,
        x,
        y,
        canInsertModel: Boolean(this.configuration),
        canInsertSession: Boolean(this.sessionReferencePicker),
        canMoveDraft: this.canMoveDraft,
        canReword: Boolean(selection && this.canRewordComposerSelection && !this.rewording),
      },
      { signal: this.signal },
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

  private divertingQueuedId: string | undefined;

  canSendQueuedToSideChat(entry: QueuedPrompt) {
    return (
      Boolean(this.props.sendQueuedToSideChat) &&
      !entry.pending &&
      entry.editable !== false &&
      !entry.command &&
      !entry.provenance &&
      !entry.automatic &&
      !entry.scheduled
    );
  }

  get sendingQueuedToSideChat() {
    return this.divertingQueuedId !== undefined;
  }

  async sendQueuedToSideChat(id: string) {
    const entry = this.queuedPrompts.find((item) => item.id === id);
    if (!entry || !this.canSendQueuedToSideChat(entry) || this.sendingQueuedToSideChat) return;
    this.divertingQueuedId = id;
    try {
      await this.props.sendQueuedToSideChat?.(id);
    } finally {
      this.divertingQueuedId = undefined;
    }
  }

  async submit(
    value = this.draft,
    options?: {
      renderUserMessageAsMarkdown?: boolean;
      enterContinuation?: number;
      /** Only supplied by the composer's actual keyboard Enter-submit path. */
      composerEnter?: AbortSignal;
    },
  ) {
    // A cleared in-flight draft or an unread image is not an intentional empty
    // submission. Never let it fall through to steering an unrelated queue head.
    if (this.submittingLocally || this.pendingImagePastes > 0) {
      if (this.enterContinuation?.generation === options?.enterContinuation)
        this.cancelEnterContinuation();
      return false;
    }
    if (value !== this.draft) this.setDraft(value);
    const dictation = DictationContext.consume(this)?.();
    const empty = !value.trim() && this.attachments.length === 0 && this.annotations.length === 0;
    const own = empty ? this.ownQueuedPrompt() : undefined;
    if (own?.state === "steering" && this.canStopAndSendQueuedPrompt) {
      await this.stopAndSendQueuedPrompt(own.id);
      return true;
    }
    if (own?.state === "queued" && !own.command) {
      await this.steerQueuedPrompt(own.id);
      return true;
    }
    const conversationId = this.id;
    this.submittingLocally = true;
    let submission: DictationSubmission | undefined;
    let accepted = false;
    try {
      if (!this.editingMessage && !empty) submission = await dictation?.prepareSubmission(this.id);
      if (submission) {
        if (!submission.ready) return false;
        // Final recognition updates the bound draft before admission takes its snapshot.
        value = this.draft;
      }
      if (!this.props.canSubmit(value)) {
        if (this.enterContinuation?.generation === options?.enterContinuation)
          this.cancelEnterContinuation();
        return false;
      }
      // Capture the actual admitted input after final recognition, before delivery
      // can clear the draft/attachments or end an edit. Only Enter carries this signal.
      const enterSubmission =
        options?.composerEnter &&
        (value.trim() || this.attachments.length || this.annotations.length) &&
        !this.editingMessage &&
        !this.submitsAsDraft &&
        // Slash commands can succeed without submitting a user message.
        !value.trimStart().startsWith("/");
      // Record composer sends without changing the reader's transcript position.
      // Editing an earlier message rewrites history in place instead.
      if (!this.editingMessage) this.transcriptInteraction.noteSentMessage();
      const submittedRevision = this.draftRevision;
      const inputHistoryRevision = this.inputHistoryRevision;
      const submitted = await this.props.submit(value, {
        renderUserMessageAsMarkdown:
          options?.renderUserMessageAsMarkdown ?? shouldRenderMarkdown(value),
      });
      accepted = submitted !== false;
      if (accepted && this.inputHistoryRevision === inputHistoryRevision)
        this.localInputHistoryRevision += 1;
      // End ownership before clearing the controlled draft can request an insertion restart.
      dictation?.completeSubmission(submission, accepted);
      if (submitted !== false && this.draft === value && this.draftRevision === submittedRevision)
        this.setDraft("");
      if (submitted && submitted !== true) this.lastSentTurnId = submitted.turnId;
      const continuation = this.enterContinuation;
      if (continuation && continuation.generation === options?.enterContinuation) {
        if (submitted && submitted !== true)
          this.enterContinuation = { ...continuation, turnId: submitted.turnId };
        else this.cancelEnterContinuation();
      }
      if (
        accepted &&
        submitted !== undefined &&
        enterSubmission &&
        !options?.composerEnter?.aborted &&
        !this.signal.aborted &&
        this.id === conversationId
      )
        this.transcriptInteraction.acceptComposerEnterSubmission();
      return submitted !== false;
    } finally {
      dictation?.completeSubmission(submission, accepted);
      if (
        this.enterContinuation?.generation === options?.enterContinuation &&
        !this.enterContinuation?.turnId
      )
        this.cancelEnterContinuation();
      this.submittingLocally = false;
    }
  }

  /**
   * The queued message empty Enter acts on: the one this user sent last, or else their first
   * queued message. Rows from other sessions, schedules or Cake are never escalated.
   */
  private ownQueuedPrompt(): QueuedPrompt | undefined {
    const latest = this.lastSentTurnId
      ? this.queuedPrompts.find((entry) => entry.turnId === this.lastSentTurnId)
      : undefined;
    if (latest) return latest.pending ? undefined : latest;
    // An admission still in flight is the user's latest message; wait for its row.
    if (this.queuedPrompts.some((entry) => entry.pending)) return undefined;
    return this.queuedPrompts.find(
      (entry) =>
        !entry.source &&
        !entry.scheduled &&
        !entry.automatic &&
        (entry.state === "steering" || !entry.command),
    );
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
  editQueuedPrompt(id: string, text: string) {
    return this.props.editQueuedPrompt?.(id, text) ?? Promise.resolve(false);
  }
  removeQueuedPrompt(id: string) {
    const turnId = this.queuedPrompts.find((entry) => entry.id === id)?.turnId;
    if (turnId && this.transcriptInteraction.resultReveal?.responseTurnId === turnId)
      this.transcriptInteraction.cancelResultReveal();
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
  async addPastedImages(files: readonly File[]) {
    this.pendingImagePastes += 1;
    try {
      await this.props.addPastedImages?.(files);
    } finally {
      this.pendingImagePastes -= 1;
    }
  }
  removeAttachment(index: number) {
    this.props.removeAttachment?.(index);
  }
  addAnnotation(annotation: Omit<Annotation, "id">) {
    return this.props.addAnnotation?.(annotation);
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
