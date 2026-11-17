import { Store, child, createStore } from "r-state-tree";
import type { Annotation } from "../../contracts/conversations/session-contract";
import { ComposerDraftStore } from "./ComposerDraftStore";
import { OptimisticUserMessagesStore } from "./OptimisticUserMessagesStore";

interface SideChatDraftSubmissionStoreProps {
  create(text: string, annotations: readonly Annotation[]): Promise<string | undefined>;
  requestTarget(threadId: string): void;
  target(threadId: string): OptimisticUserMessagesStore | undefined;
}

/** Owns the first side-chat input until its new conversation can take over. */
export class SideChatDraftSubmissionStore extends Store<SideChatDraftSubmissionStoreProps> {
  threadId: string | undefined;
  submitting = false;

  constructor(props: SideChatDraftSubmissionStore["props"]) {
    super(props);
    this.reaction(
      () => (this.threadId ? this.props.target(this.threadId) : undefined),
      (target) => {
        if (target) this.optimisticMessages.transferTo(target);
      },
    );
  }

  @child
  get draft(): ComposerDraftStore {
    return createStore(ComposerDraftStore);
  }

  @child
  get optimisticMessages(): OptimisticUserMessagesStore {
    return createStore(OptimisticUserMessagesStore, { canonicalParts: () => [] });
  }

  get parts() {
    // The draft pane can outlive the start receipt while the sidecar hydrates.
    return (
      (this.threadId ? this.props.target(this.threadId)?.parts : undefined) ??
      this.optimisticMessages.parts
    );
  }

  async submit(onSubmitted?: () => void) {
    if (this.submitting || this.threadId || !this.draft.hasContent) return undefined;
    const text = this.draft.text.trim();
    const attachments = this.draft.submissionAttachments;
    const annotations = this.draft.annotationDraft.annotations.slice();
    const id = crypto.randomUUID();
    this.submitting = true;
    this.draft.clearError();
    this.draft.clearForSubmit();
    if (!text.startsWith("/")) this.optimisticMessages.add(id, text, attachments, "sending", false);
    onSubmitted?.();
    try {
      const threadId = await this.props.create(text, annotations);
      if (this.signal.aborted) return undefined;
      if (!threadId) {
        this.optimisticMessages.remove(id);
        this.draft.restoreAfterFailure(text, attachments);
        return undefined;
      }
      this.props.requestTarget(threadId);
      this.threadId = threadId;
      const target = this.props.target(threadId);
      if (target) this.optimisticMessages.transferTo(target);
      return threadId;
    } catch (error) {
      if (!this.signal.aborted) {
        this.optimisticMessages.remove(id);
        this.draft.reportError(error);
        this.draft.restoreAfterFailure(text, attachments);
      }
      return undefined;
    } finally {
      this.submitting = false;
    }
  }
}
