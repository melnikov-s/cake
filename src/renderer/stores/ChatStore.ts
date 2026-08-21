import { Store } from "r-state-tree";
import type {
  Attachment,
  FileSuggestion,
  SessionSnapshot,
  UiPart,
} from "../../ipc/session-contract";
import type { QueuedPrompt } from "./MessageComposerStore";
import type { ChatConfigurationStore } from "./ChatConfigurationStore";

export interface ChatStoreProps {
  id(): string;
  parts(): UiPart[];
  streaming(): boolean;
  submitting(): boolean;
  configuration(): ChatConfigurationStore | undefined;
  commands(): SessionSnapshot["commands"];
  placeholder(): string;
  inputLabel(): string;
  canSubmit(draft: string): boolean;
  submit(draft: string): Promise<boolean | void>;
  abort?(): Promise<void>;
  attachments?(): Attachment[];
  addAttachments?(): Promise<void>;
  addPastedImages?(files: readonly File[]): Promise<void>;
  removeAttachment?(index: number): void;
  suggestFiles?(prefix: string): Promise<FileSuggestion[]>;
  focusRequestRevision?(): number;
  usage?(): SessionSnapshot["usage"];
  queuedPrompts?(): readonly QueuedPrompt[];
  steerQueuedPrompt?(id: string): void;
  editQueuedPrompt?(id: string): void;
  removeQueuedPrompt?(id: string): void;
  composerVisible?(): boolean;
  hideThinking?(): boolean;
  error?(): { message?: string; details?: string; title?: string };
  persist?(): void;
}

/** Common state and behavior contract for every Cake conversation surface. */
export class ChatStore extends Store<ChatStoreProps> {
  draft = "";
  thinkingExpanded = false;
  workLogDiff = false;
  submittingLocally = false;
  loadingStartedAt: number | undefined;

  constructor(props: ChatStore["props"]) {
    super(props);
    this.loadingStartedAt = this.loading ? Date.now() : undefined;
    this.reaction(
      () => this.loading,
      (loading) => {
        this.loadingStartedAt = loading ? Date.now() : undefined;
      },
    );
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
  get canAbort() {
    return Boolean(this.props.abort);
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
  get composerVisible() {
    return this.props.composerVisible?.() ?? true;
  }
  get hideThinking() {
    return this.props.hideThinking?.() ?? false;
  }
  get attachments() {
    return this.props.attachments?.() ?? [];
  }
  get focusRequestRevision() {
    return this.props.focusRequestRevision?.();
  }
  get usage() {
    return this.props.usage?.();
  }
  get error() {
    return this.props.error?.();
  }
  canSubmitDraft(value: string) {
    return !this.submittingLocally && this.props.canSubmit(value);
  }

  setDraft(value: string) {
    this.draft = value;
    this.props.persist?.();
  }

  setThinkingExpanded(expanded: boolean) {
    this.thinkingExpanded = expanded;
    this.props.persist?.();
  }

  toggleThinking() {
    this.setThinkingExpanded(!this.thinkingExpanded);
  }

  setWorkLogDiff(showDiff: boolean) {
    this.workLogDiff = showDiff;
  }

  toggleWorkLogDiff() {
    this.setWorkLogDiff(!this.workLogDiff);
  }

  async submit(value = this.draft) {
    if (value !== this.draft) this.setDraft(value);
    if (!this.props.canSubmit(value) || this.submittingLocally) return false;
    this.submittingLocally = true;
    try {
      const submitted = await this.props.submit(value);
      if (submitted !== false && this.draft === value) this.setDraft("");
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
  suggestFiles(prefix: string) {
    return this.props.suggestFiles?.(prefix) ?? Promise.resolve([]);
  }
}
