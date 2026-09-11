import { child, computed, createStore, snapshot, Store } from "r-state-tree";
import { shouldRenderMarkdown } from "../../utils/markdown";
import type {
  Annotation,
  Attachment,
  FileSuggestion,
  SessionSnapshot,
  UiPart,
} from "../../ipc/session-contract";
import type { ChatConfigurationStore } from "./ChatConfigurationStore";
import type { ExistingWorktreeCandidate, WorktreeDraftChoice } from "./WorktreeCreationStore";
import type { QueuedPrompt as ComposerQueuedPrompt } from "./ConversationComposerStore";
import {
  ScheduledMessageInteractionStore,
  type ScheduledMessageCapabilities,
} from "./ScheduledMessageInteractionStore";
import {
  TranscriptInteractionStore,
  type TranscriptScrollPosition,
  type UserMessagePresentationCapabilities,
} from "./TranscriptInteractionStore";
import {
  WorkLogPresentationStore,
  type WorkLogPresentationCapabilities,
} from "./WorkLogPresentationStore";

export interface QueuedPrompt extends ComposerQueuedPrompt {
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
  id(): string;
  parts(): UiPart[];
  streaming(): boolean;
  submitting(): boolean;
  stoppable?(): boolean;
  configuration(): ChatConfigurationStore | undefined;
  commands(): SessionSnapshot["commands"];
  placeholder(): string;
  inputLabel(): string;
  draft?(): string;
  setDraft?(value: string): void;
  canSubmit(draft: string): boolean;
  submit(
    draft: string,
    options?: { renderUserMessageAsMarkdown?: boolean },
  ): Promise<boolean | void>;
  userMessagePresentation?: UserMessagePresentationCapabilities;
  activateDraft?(choice?: WorktreeDraftChoice): Promise<boolean>;
  sessionCreationChoice?(): WorktreeDraftChoice;
  draftActivationCandidates?(): ExistingWorktreeCandidate[];
  editLastUserMessage?(entryId: string): boolean | undefined;
  isDraftSession?(): boolean;
  editingMessage?(): boolean;
  abort?(): Promise<void>;
  attachments?(): Attachment[];
  addAttachments?(): Promise<void>;
  addPastedImages?(files: readonly File[]): Promise<void>;
  removeAttachment?(index: number): void;
  annotations?(): readonly Annotation[];
  addAnnotation?(annotation: Omit<Annotation, "id">): void;
  updateAnnotation?(id: string, update: Partial<Omit<Annotation, "id">>): void;
  removeAnnotation?(id: string): void;
  suggestFiles?(prefix: string): Promise<ReadonlyArray<FileSuggestion>>;
  focusRequestRevision?(): number;
  usage?(): SessionSnapshot["usage"];
  queuedPrompts?(): readonly QueuedPrompt[];
  steerQueuedPrompt?(id: string): void;
  editQueuedPrompt?(id: string): boolean | undefined;
  removeQueuedPrompt?(id: string): void;
  cancelSteering?(): Promise<void>;
  scheduledMessages?: ScheduledMessageCapabilities;
  composerVisible?(): boolean;
  composerReword?: ComposerRewordCapabilities;
  hideThinking?(): boolean;
  error?(): { message?: string; details?: string; title?: string };
  workLogPresentation?: WorkLogPresentationCapabilities;
}

export type { TranscriptScrollPosition };

/** Common state and behavior contract for every Cake conversation surface. */
export class ChatStore extends Store<ChatStoreProps> {
  @snapshot private localDraft = "";
  submittingLocally = false;
  rewording = false;
  rewordError: string | undefined;
  private draftRevision = 0;

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
        ((candidate.kind === "text" && candidate.role === "user") || candidate.kind === "skill") &&
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
  get canAttach() {
    return Boolean(this.props.addAttachments);
  }
  get canPasteImages() {
    return Boolean(this.props.addPastedImages);
  }
  get canSuggestFiles() {
    return Boolean(this.props.suggestFiles);
  }
  @computed
  get queuedPrompts(): readonly QueuedPrompt[] {
    return this.props.queuedPrompts?.() ?? [];
  }
  get canSteerQueuedPrompt() {
    return Boolean(this.props.steerQueuedPrompt);
  }
  get canEditQueuedPrompt() {
    return Boolean(this.props.editQueuedPrompt);
  }
  get canRemoveQueuedPrompt() {
    return Boolean(this.props.removeQueuedPrompt);
  }
  get canCancelSteering() {
    return Boolean(this.props.cancelSteering);
  }
  get composerVisible() {
    return this.props.composerVisible?.() ?? true;
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
  get usage() {
    return this.props.usage?.();
  }
  get error() {
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
    if (this.draft !== value) this.draftRevision += 1;
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

  async submit(value = this.draft, options?: { renderUserMessageAsMarkdown?: boolean }) {
    if (value !== this.draft) this.setDraft(value);
    const queued = this.queuedPrompts.find((entry) => entry.state === "queued");
    if (!value.trim() && this.attachments.length === 0 && this.annotations.length === 0 && queued) {
      this.steerQueuedPrompt(queued.id);
      return true;
    }
    if (!this.props.canSubmit(value) || this.submittingLocally) return false;
    this.submittingLocally = true;
    const submittedRevision = this.draftRevision;
    try {
      const submitted = await this.props.submit(value, {
        renderUserMessageAsMarkdown:
          options?.renderUserMessageAsMarkdown ?? shouldRenderMarkdown(value),
      });
      if (submitted !== false && this.draft === value && this.draftRevision === submittedRevision)
        this.setDraft("");
      return submitted !== false;
    } finally {
      this.submittingLocally = false;
    }
  }

  steerQueuedPrompt(id: string) {
    this.props.steerQueuedPrompt?.(id);
  }
  editQueuedPrompt(id: string) {
    this.props.editQueuedPrompt?.(id);
  }
  removeQueuedPrompt(id: string) {
    this.props.removeQueuedPrompt?.(id);
  }
  cancelSteering() {
    return this.props.cancelSteering?.() ?? Promise.resolve();
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
  addAttachments() {
    return this.props.addAttachments?.() ?? Promise.resolve();
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
