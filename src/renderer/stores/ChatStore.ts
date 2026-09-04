import { observable, snapshot, Store, untracked } from "r-state-tree";
import { shouldRenderMarkdown } from "../../utils/markdown";
import type { StateSnapshot } from "react-virtuoso";
import type {
  Annotation,
  Attachment,
  FileSuggestion,
  SessionSnapshot,
  UiPart,
  WorkLogViewMode,
  WorkLogsExpansion,
} from "../../ipc/session-contract";
import { workLogGroupKeys } from "../../utils/work-log-groups";
import type { QueuedPrompt } from "./MessageComposerStore";
import type { ScheduledMessage } from "../models/ScheduledMessage";
import type { ChatConfigurationStore } from "./ChatConfigurationStore";
import type { ExistingWorktreeCandidate, WorktreeDraftChoice } from "./WorktreeCreationStore";

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
  canSubmit(draft: string): boolean;
  submit(
    draft: string,
    options?: { renderUserMessageAsMarkdown?: boolean },
  ): Promise<boolean | void>;
  setUserMessageMarkdown?(entryId: string, renderAsMarkdown: boolean): Promise<void>;
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
  scheduledMessages?(): readonly ScheduledMessage[];
  cancelScheduledMessage?(id: string): Promise<void>;
  composerVisible?(): boolean;
  showComposerContextMenu?(
    selection: string,
    x: number,
    y: number,
  ): Promise<"reword" | "reword-with-prompt" | undefined>;
  rewordComposerSelection?(selection: string, prompt?: string): Promise<string>;
  hideThinking?(): boolean;
  error?(): { message?: string; details?: string; title?: string };
  workLogViewMode?(): WorkLogViewMode | undefined;
  setWorkLogViewMode?(mode: WorkLogViewMode): void;
  workLogsExpansion?(): WorkLogsExpansion | undefined;
  setWorkLogsExpansion?(expansion: WorkLogsExpansion): void;
}

export interface WorkLogTimerState {
  startedAt: number;
  endedAt?: number;
}

export interface MessageNavigationRequest {
  messageId: string;
  revision: number;
}

export type { WorkLogViewMode, WorkLogsExpansion };

/** Common state and behavior contract for every Cake conversation surface. */
export class ChatStore extends Store<ChatStoreProps> {
  @snapshot draft = "";
  private localWorkLogViewMode: WorkLogViewMode = "auto";
  private localWorkLogsExpansion: WorkLogsExpansion = "collapsed";
  readonly workLogItemOverrides = observable(new Map<string, boolean>());
  readonly workLogGroupOverrides = observable(new Map<string, boolean>());
  readonly updatingUserMessagePresentation = observable(new Set<string>());
  private readonly requestedUserMessagePresentation = observable(
    new Map<string, { requested: boolean; projectedAtRequest: boolean }>(),
  );
  submittingLocally = false;
  rewording = false;
  rewordError: string | undefined;
  userMessagePresentationError: string | undefined;
  scheduledMessageError: string | undefined;
  loadingStartedAt: number | undefined;
  readonly workLogTimers = observable(new Map<string, WorkLogTimerState>());
  transcriptScrollState: StateSnapshot | undefined;
  messageNavigationRequest: MessageNavigationRequest | undefined;
  changedFilesOpen = false;
  private messageNavigationRevision = 0;
  private draftRevision = 0;
  private workLogTickNow = 0;
  private workLogTickInterval: ReturnType<typeof setInterval> | undefined;
  private changedFilesChurning: boolean | undefined;
  private scheduledMessageNow = Date.now();
  private scheduledMessageTickInterval: ReturnType<typeof setInterval> | undefined;

  constructor(props: ChatStore["props"]) {
    super(props);
    this.loadingStartedAt = this.loading ? Date.now() : undefined;
    this.reaction(
      () => this.loading,
      (loading) => {
        this.loadingStartedAt = loading ? Date.now() : undefined;
      },
    );
    untracked(() => this.syncWorkLogTimers());
    this.reaction(
      () =>
        this.props
          .parts()
          .flatMap((part) => (part.kind === "tool" ? [{ id: part.id, state: part.state }] : [])),
      () => this.syncWorkLogTimers(),
    );
    this.reaction(
      () => this.scheduledMessages.length > 0,
      (active) => this.updateScheduledMessageTick(active),
    );
    this.reaction(
      () => ({
        requested: [...this.requestedUserMessagePresentation],
        actual: this.props
          .parts()
          .flatMap((part) =>
            part.kind === "text" && part.role === "user" && part.entryId
              ? [[part.entryId, part.renderAs === "markdown"] as const]
              : [],
          ),
      }),
      ({ requested, actual }) => {
        const actualByEntryId = new Map(actual);
        for (const [entryId, presentation] of requested) {
          const projected = actualByEntryId.get(entryId);
          if (projected === presentation.requested && projected !== presentation.projectedAtRequest)
            this.requestedUserMessagePresentation.delete(entryId);
        }
      },
    );
    this.effect(() => {
      untracked(() => this.updateScheduledMessageTick(this.scheduledMessages.length > 0));
      return () => {
        this.stopWorkLogTick();
        this.stopScheduledMessageTick();
      };
    });
  }

  private get workLogTimingActive() {
    for (const timer of this.workLogTimers.values()) if (timer.endedAt === undefined) return true;
    return false;
  }

  private syncWorkLogTimers() {
    const now = Date.now();
    const retainedPartIds = new Set<string>();
    for (const part of this.props.parts()) {
      retainedPartIds.add(part.id);
      if (part.kind !== "tool") continue;
      const timer = this.workLogTimers.get(part.id);
      if (part.state === "running" || part.state === "approval") {
        if (!timer) this.workLogTimers.set(part.id, { startedAt: now });
      } else if (timer && timer.endedAt === undefined) {
        this.workLogTimers.set(part.id, { ...timer, endedAt: now });
      }
    }
    for (const partId of this.workLogTimers.keys()) {
      if (!retainedPartIds.has(partId)) this.workLogTimers.delete(partId);
    }
    for (const partId of this.workLogItemOverrides.keys()) {
      if (!retainedPartIds.has(partId)) this.workLogItemOverrides.delete(partId);
    }
    const retainedGroupIds = new Set(workLogGroupKeys(this.props.parts()));
    for (const groupId of this.workLogGroupOverrides.keys()) {
      if (!retainedGroupIds.has(groupId)) this.workLogGroupOverrides.delete(groupId);
    }
    this.updateWorkLogTick();
  }

  /** Runs exactly one shared tick interval while any work log item is still counting. */
  private updateWorkLogTick() {
    if (this.workLogTimingActive) this.startWorkLogTick();
    else this.stopWorkLogTick();
  }

  private startWorkLogTick() {
    if (this.workLogTickInterval !== undefined) return;
    this.workLogTickNow = Date.now();
    this.workLogTickInterval = setInterval(() => {
      this.workLogTickNow = Date.now();
    }, 100);
  }

  private stopWorkLogTick() {
    if (this.workLogTickInterval === undefined) return;
    clearInterval(this.workLogTickInterval);
    this.workLogTickInterval = undefined;
  }

  /** Elapsed milliseconds for a work log tool item, or undefined when never observed running. */
  workLogElapsedMs(partId: string): number | undefined {
    const timer = this.workLogTimers.get(partId);
    if (!timer) return undefined;
    return Math.max(0, (timer.endedAt ?? this.workLogTickNow) - timer.startedAt);
  }

  /** Elapsed time across a protocol pair that is presented as one work-log item. */
  workLogElapsedMsRange(startPartId: string, endPartId: string): number | undefined {
    const start = this.workLogTimers.get(startPartId);
    const end = this.workLogTimers.get(endPartId);
    if (!start) return this.workLogElapsedMs(endPartId);
    return Math.max(0, (end?.endedAt ?? this.workLogTickNow) - start.startedAt);
  }

  get id() {
    return this.props.id();
  }
  get parts() {
    return this.props.parts();
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
  /** True when the runtime may still produce work, including background subagents. */
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
    return !this.submittingLocally && this.props.canSubmit(this.draft);
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
  get canToggleUserMessageMarkdown() {
    return Boolean(this.props.setUserMessageMarkdown);
  }
  userMessageRendersAsMarkdown(entryId: string, projectedRenderAsMarkdown: boolean) {
    return (
      this.requestedUserMessagePresentation.get(entryId)?.requested ?? projectedRenderAsMarkdown
    );
  }
  async setUserMessageMarkdown(entryId: string, renderAsMarkdown: boolean) {
    if (!this.props.setUserMessageMarkdown || this.updatingUserMessagePresentation.has(entryId))
      return;
    const projectedRenderAsMarkdown = this.props
      .parts()
      .some(
        (part) =>
          part.kind === "text" &&
          part.role === "user" &&
          part.entryId === entryId &&
          part.renderAs === "markdown",
      );
    this.requestedUserMessagePresentation.set(entryId, {
      requested: renderAsMarkdown,
      projectedAtRequest: projectedRenderAsMarkdown,
    });
    this.updatingUserMessagePresentation.add(entryId);
    this.userMessagePresentationError = undefined;
    try {
      await this.props.setUserMessageMarkdown(entryId, renderAsMarkdown);
    } catch (error) {
      this.requestedUserMessagePresentation.delete(entryId);
      if (!this.signal.aborted)
        this.userMessagePresentationError = error instanceof Error ? error.message : String(error);
    } finally {
      this.updatingUserMessagePresentation.delete(entryId);
    }
  }
  get canPasteImages() {
    return Boolean(this.props.addPastedImages);
  }
  get canSuggestFiles() {
    return Boolean(this.props.suggestFiles);
  }
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
  get scheduledMessages(): readonly ScheduledMessage[] {
    return this.props.scheduledMessages?.() ?? [];
  }
  get canCancelScheduledMessage() {
    return Boolean(this.props.cancelScheduledMessage);
  }
  scheduledMessageRemainingMs(sendAt: string) {
    return Math.max(0, Date.parse(sendAt) - this.scheduledMessageNow);
  }
  async cancelScheduledMessage(id: string) {
    if (!this.props.cancelScheduledMessage) return;
    this.scheduledMessageError = undefined;
    try {
      await this.props.cancelScheduledMessage(id);
    } catch (error) {
      if (!this.signal.aborted)
        this.scheduledMessageError = error instanceof Error ? error.message : String(error);
    }
  }
  private updateScheduledMessageTick(active: boolean) {
    if (!active) {
      this.stopScheduledMessageTick();
      return;
    }
    if (this.scheduledMessageTickInterval !== undefined) return;
    this.scheduledMessageNow = Date.now();
    this.scheduledMessageTickInterval = setInterval(() => {
      this.scheduledMessageNow = Date.now();
    }, 1_000);
  }
  private stopScheduledMessageTick() {
    if (this.scheduledMessageTickInterval === undefined) return;
    clearInterval(this.scheduledMessageTickInterval);
    this.scheduledMessageTickInterval = undefined;
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
    if (this.userMessagePresentationError)
      return {
        message: this.userMessagePresentationError,
        title: "Could not change message formatting",
      };
    if (this.scheduledMessageError)
      return {
        message: this.scheduledMessageError,
        title: "Could not cancel scheduled message",
      };
    return this.props.error?.();
  }
  get canRewordComposerSelection() {
    return Boolean(this.props.showComposerContextMenu && this.props.rewordComposerSelection);
  }
  canSubmitDraft(value: string) {
    return !this.submittingLocally && this.props.canSubmit(value);
  }

  setDraft(value: string) {
    if (this.draft !== value) this.draftRevision += 1;
    this.draft = value;
    this.rewordError = undefined;
  }

  showComposerContextMenu(selection: string, x: number, y: number) {
    if (!selection) return Promise.resolve(undefined);
    return this.props.showComposerContextMenu?.(selection, x, y) ?? Promise.resolve(undefined);
  }

  async rewordComposerSelection(selection: string, prompt?: string) {
    if (!this.props.rewordComposerSelection || this.rewording) return undefined;
    this.rewording = true;
    this.rewordError = undefined;
    try {
      return await this.props.rewordComposerSelection(selection, prompt);
    } catch (error) {
      this.rewordError = error instanceof Error ? error.message : String(error);
      return undefined;
    } finally {
      this.rewording = false;
    }
  }

  setTranscriptScrollState(state: StateSnapshot | undefined) {
    this.transcriptScrollState = state;
  }

  navigateToMessage(messageId: string) {
    this.transcriptScrollState = undefined;
    this.messageNavigationRequest = {
      messageId,
      revision: ++this.messageNavigationRevision,
    };
  }

  setChangedFilesOpen(open: boolean) {
    this.changedFilesOpen = open;
  }

  /** Collapses changed files when a new period of file-change churn begins. */
  syncChangedFilesOpen(churning: boolean) {
    if (this.changedFilesChurning === churning) return;
    this.changedFilesChurning = churning;
    if (churning) this.changedFilesOpen = false;
  }

  get workLogViewMode(): WorkLogViewMode {
    return this.props.workLogViewMode?.() ?? this.localWorkLogViewMode;
  }

  setWorkLogViewMode(mode: WorkLogViewMode) {
    if (this.props.setWorkLogViewMode) {
      this.props.setWorkLogViewMode(mode);
    } else {
      this.localWorkLogViewMode = mode;
    }
  }

  /** Ctrl+Shift+O cycles: auto → diff → log → auto. */
  cycleWorkLogViewMode() {
    const next: WorkLogViewMode =
      this.workLogViewMode === "auto" ? "diff" : this.workLogViewMode === "diff" ? "log" : "auto";
    this.setWorkLogViewMode(next);
  }

  get workLogsExpansion(): WorkLogsExpansion {
    return this.props.workLogsExpansion?.() ?? this.localWorkLogsExpansion;
  }

  setWorkLogsExpansion(expansion: WorkLogsExpansion) {
    if (this.props.setWorkLogsExpansion) {
      this.props.setWorkLogsExpansion(expansion);
    } else {
      this.localWorkLogsExpansion = expansion;
    }
    this.workLogItemOverrides.clear();
    this.workLogGroupOverrides.clear();
  }

  /** Ctrl+O cycles: collapsed → expanded (items collapsed) → fully expanded → collapsed. */
  cycleWorkLogsExpansion() {
    const next: WorkLogsExpansion =
      this.workLogsExpansion === "collapsed"
        ? "expanded"
        : this.workLogsExpansion === "expanded"
          ? "fully-expanded"
          : "collapsed";
    this.setWorkLogsExpansion(next);
  }

  /** Effective open state of a work log group (turn). */
  workLogGroupOpen(groupId: string, hasDiff: boolean): boolean {
    const override = this.workLogGroupOverrides.get(groupId);
    if (override !== undefined) return override;
    if (this.workLogsExpansion === "collapsed") return false;
    // In diff mode, non-diff work logs stay collapsed by default
    if (this.workLogViewMode === "diff" && !hasDiff) return false;
    return true;
  }

  setWorkLogGroupOpen(groupId: string, open: boolean) {
    this.workLogGroupOverrides.set(groupId, open);
  }

  /** Effective open state of one item inside a work log; per-item clicks override the global mode. */
  workLogItemOpen(partId: string): boolean {
    return this.workLogItemOverrides.get(partId) ?? this.workLogsExpansion === "fully-expanded";
  }

  setWorkLogItemOpen(partId: string, open: boolean) {
    this.workLogItemOverrides.set(partId, open);
  }

  async submit(value = this.draft, options?: { renderUserMessageAsMarkdown?: boolean }) {
    if (value !== this.draft) this.setDraft(value);
    // Submitting an empty composer while prompts are queued steers the head of
    // the queue immediately, so "type + Enter, Enter" is a keyboard-only way to
    // steer while streaming.
    if (
      !value.trim() &&
      this.attachments.length === 0 &&
      this.annotations.length === 0 &&
      this.queuedPrompts.length > 0
    ) {
      this.steerQueuedPrompt(this.queuedPrompts[0]!.id);
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
