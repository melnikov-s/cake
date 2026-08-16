import { Store } from "r-state-tree";
import type { Attachment, FileSuggestion, SessionSnapshot, UiPart } from "../../ipc/session-contract";
import type { ChatConfigurationStore } from "./ChatConfigurationStore";

type ChatSubmitMode = "send" | "steer";

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
  submit(draft: string, mode: ChatSubmitMode): Promise<boolean | void>;
  abort?(): Promise<void>;
  attachments?(): Attachment[];
  addAttachments?(): Promise<void>;
  addPastedImages?(files: readonly File[]): Promise<void>;
  removeAttachment?(index: number): void;
  suggestFiles?(prefix: string): Promise<FileSuggestion[]>;
  focusRequestRevision?(): number;
  usage?(): SessionSnapshot["usage"];
  allowSteer?: boolean;
  composerVisible?(): boolean;
  hideThinking?(): boolean;
  error?(): { message?: string; details?: string; title?: string };
  persist?(): void;
}

/** Common state and behavior contract for every Cake conversation surface. */
export class ChatStore extends Store<ChatStoreProps> {
  draft = "";
  thinkingExpanded = false;
  submittingLocally = false;

  get id() { return this.props.id(); }
  get parts() { return this.props.parts(); }
  get streaming() { return this.props.streaming(); }
  get submitting() { return this.submittingLocally || this.props.submitting(); }
  get configuration() { return this.props.configuration(); }
  get commands() { return this.props.commands(); }
  get placeholder() { return this.props.placeholder(); }
  get inputLabel() { return this.props.inputLabel(); }
  get canSubmit() { return !this.submittingLocally && this.props.canSubmit(this.draft); }
  get canAbort() { return Boolean(this.props.abort); }
  get canAttach() { return Boolean(this.props.addAttachments); }
  get canPasteImages() { return Boolean(this.props.addPastedImages); }
  get canSuggestFiles() { return Boolean(this.props.suggestFiles); }
  get allowSteer() { return Boolean(this.props.allowSteer); }
  get composerVisible() { return this.props.composerVisible?.() ?? true; }
  get hideThinking() { return this.props.hideThinking?.() ?? false; }
  get attachments() { return this.props.attachments?.() ?? []; }
  get focusRequestRevision() { return this.props.focusRequestRevision?.(); }
  get usage() { return this.props.usage?.(); }
  get error() { return this.props.error?.(); }

  setDraft(value: string) {
    this.draft = value;
    this.props.persist?.();
  }

  setThinkingExpanded(expanded: boolean) {
    this.thinkingExpanded = expanded;
    this.props.persist?.();
  }

  toggleThinking() { this.setThinkingExpanded(!this.thinkingExpanded); }

  async submit(value = this.draft, mode: ChatSubmitMode = "send") {
    if (value !== this.draft) this.setDraft(value);
    if (!this.props.canSubmit(value) || this.submittingLocally) return false;
    this.submittingLocally = true;
    try {
      const submitted = await this.props.submit(value, mode);
      if (submitted !== false && this.draft === value) this.setDraft("");
      return submitted !== false;
    } finally {
      this.submittingLocally = false;
    }
  }

  abort() { return this.props.abort?.() ?? Promise.resolve(); }
  addAttachments() { return this.props.addAttachments?.() ?? Promise.resolve(); }
  addPastedImages(files: readonly File[]) { return this.props.addPastedImages?.(files) ?? Promise.resolve(); }
  removeAttachment(index: number) { this.props.removeAttachment?.(index); }
  suggestFiles(prefix: string) { return this.props.suggestFiles?.(prefix) ?? Promise.resolve([]); }
}
