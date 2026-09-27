import { Store, child, createStore, observable, snapshot } from "r-state-tree";
import type { Annotation, Attachment, FileSuggestion } from "../../ipc/session-contract";
import { describeError } from "../lib/error-details";
import { pastedImageAttachments } from "../lib/pasted-image-attachments";
import { AnnotationDraftStore } from "./AnnotationDraftStore";
import { ClientContext } from "./context/ClientContext";

export interface ComposerDraftStoreProps {
  projectPath?(): string | undefined;
}

/** Owns one coherent unsent composer draft, including text, context, and focus requests. */
export class ComposerDraftStore extends Store<ComposerDraftStoreProps> {
  @snapshot text = "";
  @snapshot readonly attachments: Attachment[] = observable([]);
  @snapshot private readonly annotations: Annotation[] = observable([]);
  @snapshot editorContextAttachment: Extract<Attachment, { kind: "source" }> | undefined;
  focusRequestRevision = 0;
  error: string | undefined;
  errorDetails: string | undefined;

  @child
  get annotationDraft(): AnnotationDraftStore {
    return createStore(AnnotationDraftStore, {
      annotations: this.annotations,
      onAdded: () => this.requestFocus(),
      onLimitReached: () =>
        this.reportError(new Error("A message can include at most 100 annotations")),
    });
  }

  get client() {
    return ClientContext.consume(this)!;
  }

  get hasContent() {
    return Boolean(this.text.trim() || this.attachments.length || this.annotations.length);
  }

  /** The implicit editor context yields to an explicit attachment covering the same location. */
  private get editorContextVisible() {
    const context = this.editorContextAttachment;
    return (
      context !== undefined &&
      !this.attachments.some((attachment) => sameSourceAttachment(attachment, context))
    );
  }

  get visibleAttachments(): Attachment[] {
    const explicit = this.attachments.filter((attachment) => attachment.kind !== "annotation");
    return this.editorContextVisible ? [this.editorContextAttachment!, ...explicit] : explicit;
  }

  get submissionAttachments(): Attachment[] {
    return [
      ...this.visibleAttachments,
      ...(this.annotations.length
        ? [{ kind: "annotation" as const, annotations: this.annotations.slice() }]
        : []),
    ];
  }

  setText(value: string) {
    this.text = value;
  }

  requestFocus() {
    this.focusRequestRevision += 1;
  }

  setEditorContextAttachment(attachment: Extract<Attachment, { kind: "source" }> | undefined) {
    this.editorContextAttachment = attachment;
  }

  /** Adds an explicit source attachment; annotating the same range again replaces its note. */
  addSourceAttachment(attachment: Extract<Attachment, { kind: "source" }>) {
    const existing = this.attachments.findIndex((current) =>
      sameSourceAttachment(current, attachment),
    );
    if (existing >= 0) this.attachments.splice(existing, 1, attachment);
    else this.attachments.push(attachment);
    this.requestFocus();
  }

  async addAttachments() {
    this.clearError();
    try {
      const selected = await this.client.filesystem.chooseAttachments({ signal: this.signal });
      if (this.signal.aborted) return;
      this.attachments.push(
        ...selected.filter(
          (item) =>
            "name" in item &&
            !this.attachments.some(
              (current) =>
                current.kind === item.kind &&
                "name" in current &&
                current.name === item.name &&
                (current.kind !== "file" || (item.kind === "file" && current.path === item.path)),
            ),
        ),
      );
    } catch (error) {
      if (!this.signal.aborted) this.reportError(error);
    }
  }

  async addPastedImages(files: readonly File[]) {
    this.clearError();
    try {
      const attachments = await pastedImageAttachments(files, 20 - this.attachments.length);
      if (!this.signal.aborted) this.attachments.push(...attachments);
    } catch (error) {
      if (!this.signal.aborted) this.reportError(error);
    }
  }

  suggestFiles(prefix: string): Promise<ReadonlyArray<FileSuggestion>> {
    const projectPath = this.props.projectPath?.();
    return projectPath
      ? this.client.filesystem.suggestFiles(projectPath, prefix, { signal: this.signal })
      : Promise.resolve([]);
  }

  removeAttachment(index: number) {
    if (this.editorContextVisible) {
      if (index === 0) {
        this.editorContextAttachment = undefined;
        return;
      }
      index -= 1;
    }
    this.attachments.splice(index, 1);
  }

  /** Consume the draft's editor context without changing the selection in VS Code. */
  clearForSubmit() {
    this.text = "";
    this.attachments.splice(0);
    this.annotationDraft.clear();
    this.editorContextAttachment = undefined;
  }

  clear() {
    this.clearForSubmit();
    this.editorContextAttachment = undefined;
  }

  restore(text: string, attachments: readonly Attachment[]) {
    this.text = text;
    this.attachments.splice(0);
    this.annotationDraft.clear();
    this.editorContextAttachment = undefined;
    this.appendAttachments(attachments);
  }

  restoreAfterFailure(text: string, attachments: readonly Attachment[]) {
    if (!this.text.trim()) this.text = text;
    for (const attachment of attachments) {
      if (attachment.kind === "annotation") this.annotationDraft.append(attachment.annotations);
      else if (!sameSourceAttachment(attachment, this.editorContextAttachment))
        this.attachments.push({ ...attachment });
    }
  }

  appendAttachments(attachments: readonly Attachment[]) {
    for (const attachment of attachments) {
      if (attachment.kind === "annotation") this.annotationDraft.append(attachment.annotations);
      else this.attachments.push({ ...attachment });
    }
  }

  clearError() {
    this.error = undefined;
    this.errorDetails = undefined;
  }

  reportError(error: unknown) {
    const described = describeError(error);
    this.error = described.message;
    this.errorDetails = described.details;
  }
}

const sameSourceAttachment = (
  left: Attachment | undefined,
  right: Extract<Attachment, { kind: "source" }> | undefined,
) =>
  left?.kind === "source" &&
  right?.kind === "source" &&
  left.location.path === right.location.path &&
  JSON.stringify(left.location.range) === JSON.stringify(right.location.range);
