import { Store, computed, observable } from "r-state-tree";
import type { UiPart } from "../../contracts/conversations/session-contract";
import { sessionNotificationEntries } from "../../contracts/cake-chats/session-digest-reminder";

export interface UserMessagePresentationCapabilities {
  setMarkdown(entryId: string, renderAsMarkdown: boolean): Promise<void>;
}

export interface TranscriptInteractionStoreProps {
  parts(): UiPart[];
  loading(): boolean;
  userMessagePresentation?: UserMessagePresentationCapabilities;
}

/**
 * The message a transcript pane has selected. Navigation selects a linked message
 * of any kind; keyboard selection walks visible conversational entries. Each new
 * selection gets a fresh revision so the transcript reveals it exactly once.
 */
export interface MessageSelection {
  messageId: string;
  /** Kind-qualified presentation identity that survives a streamed part settling under a new id. */
  renderKey?: string;
  origin: "navigation" | "keyboard";
  revision: number;
}

/** Only top-level conversation parts are stops, never nested source previews or activity. */
function isSelectableMessage(part: UiPart) {
  if (part.kind === "text")
    // Attachment-only user inputs still have a visible label and stable text anchor.
    return part.role === "user" || Boolean(part.text) || Boolean(part.subagentReport);
  if (part.kind === "skill") return true;
  // Session result notifications are conversational; ordinary injected context is not.
  return part.kind === "context" && sessionNotificationEntries(part.text).length > 0;
}

function messageRenderKey(part: UiPart | undefined) {
  // A skill and its accompanying user text share an input renderKey but are distinct rows.
  return (part?.kind === "text" || part?.kind === "skill") && part.renderKey
    ? `${part.kind}:${part.renderKey}`
    : undefined;
}

export type TranscriptScrollPosition =
  | { kind: "top" }
  | { kind: "bottom" }
  | { kind: "message"; messageId: string; offset: number };

/** Owns transcript restoration, message selection, disclosure, and message presentation edits. */
export class TranscriptInteractionStore extends Store<TranscriptInteractionStoreProps> {
  readonly updatingUserMessagePresentation = observable(new Set<string>());
  private readonly requestedUserMessagePresentation = observable(
    new Map<string, { requested: boolean; projectedAtRequest: boolean }>(),
  );
  loadingStartedAt: number | undefined;
  transcriptScrollPosition: TranscriptScrollPosition | undefined;
  messageSelection: MessageSelection | undefined;
  private readonly openSideChatImports = observable(new Set<string>());
  private readonly collapsedImages = observable(new Set<string>());

  imageExpanded(partId: string) {
    return !this.collapsedImages.has(partId);
  }

  toggleImage(partId: string) {
    if (this.collapsedImages.has(partId)) this.collapsedImages.delete(partId);
    else this.collapsedImages.add(partId);
  }

  sideChatImportOpen(groupId: string) {
    return this.openSideChatImports.has(groupId);
  }

  setSideChatImportOpen(groupId: string, open: boolean) {
    if (open) this.openSideChatImports.add(groupId);
    else this.openSideChatImports.delete(groupId);
  }
  userMessagePresentationError: string | undefined;
  /** Counts the reader's own sends. */
  sentMessageRevision = 0;
  /**
   * Counts the reader's requests for the newest content: sending, the
   * jump-to-bottom control, or arrowing past the newest message. These are the
   * only times the transcript scrolls to the bottom for the reader.
   */
  bottomRequestRevision = 0;
  private messageSelectionRevision = 0;
  /** Explicit attention navigation only; late receipts cannot revive a superseded request. */
  resultReveal:
    | {
        revision: number;
        source?: "incoming" | "history";
        partIds?: readonly string[];
        responseTurnId?: string;
        messageId?: string;
        renderKey?: string;
      }
    | undefined;
  private resultRevealRevision = 0;

  beginResultReveal() {
    this.clearMessageSelection();
    const revision = ++this.resultRevealRevision;
    this.resultReveal = { revision };
    return revision;
  }

  completeResultReveal(
    revision: number,
    partIds: readonly string[],
    responseTurnId?: string,
    source: "incoming" | "history" = "incoming",
  ) {
    if (this.resultReveal?.revision !== revision) return;
    this.resultReveal =
      partIds.length || responseTurnId ? { revision, source, partIds, responseTurnId } : undefined;
  }

  @computed
  get resultMessage() {
    const reveal = this.resultReveal;
    if (!reveal) return undefined;
    const parts = this.props.parts();
    if (reveal.partIds?.length) return parts.find((part) => part.id === reveal.partIds?.[0]);
    if (reveal.messageId)
      return parts.find(
        (part) =>
          part.id === reveal.messageId ||
          (part.kind === "text" &&
            part.renderKey === reveal.renderKey &&
            reveal.renderKey !== undefined),
      );
    const turnId = reveal.responseTurnId;
    return turnId
      ? parts.find(
          (part) =>
            part.kind === "text" &&
            part.role === "assistant" &&
            Boolean(part.text.trim()) &&
            part.responseToTurnIds?.includes(turnId),
        )
      : undefined;
  }

  bindResultMessage(revision: number, part: UiPart) {
    const reveal = this.resultReveal;
    if (!reveal || reveal.revision !== revision || reveal.messageId) return;
    // Once seen, this exact result may legitimately move into persisted history.
    this.resultReveal = {
      ...reveal,
      source: "history",
      messageId: part.id,
      renderKey: part.kind === "text" ? part.renderKey : undefined,
    };
  }

  cancelResultReveal(revision = this.resultReveal?.revision) {
    if (this.resultReveal?.revision === revision) this.resultReveal = undefined;
  }

  constructor(props: TranscriptInteractionStore["props"]) {
    super(props);
    this.loadingStartedAt = this.props.loading() ? Date.now() : undefined;
    this.reaction(
      () => this.props.loading(),
      (loading) => {
        this.loadingStartedAt = loading ? Date.now() : undefined;
      },
    );
    this.reaction(
      () => {
        const requested = [...this.requestedUserMessagePresentation];
        return {
          requested,
          actual:
            requested.length === 0
              ? []
              : this.props
                  .parts()
                  .flatMap((part) =>
                    part.kind === "text" && part.role === "user" && part.entryId
                      ? [[part.entryId, part.renderAs === "markdown"] as const]
                      : [],
                  ),
        };
      },
      ({ requested, actual }) => {
        const actualByEntryId = new Map(actual);
        for (const [entryId, presentation] of requested) {
          const projected = actualByEntryId.get(entryId);
          if (projected === presentation.requested && projected !== presentation.projectedAtRequest)
            this.requestedUserMessagePresentation.delete(entryId);
        }
      },
    );
  }

  get canToggleUserMessageMarkdown() {
    return Boolean(this.props.userMessagePresentation);
  }

  userMessageRendersAsMarkdown(entryId: string, projectedRenderAsMarkdown: boolean) {
    return (
      this.requestedUserMessagePresentation.get(entryId)?.requested ?? projectedRenderAsMarkdown
    );
  }

  async setUserMessageMarkdown(entryId: string, renderAsMarkdown: boolean) {
    const capability = this.props.userMessagePresentation;
    if (!capability || this.updatingUserMessagePresentation.has(entryId)) return;
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
      await capability.setMarkdown(entryId, renderAsMarkdown);
    } catch (error) {
      this.requestedUserMessagePresentation.delete(entryId);
      if (!this.signal.aborted)
        this.userMessagePresentationError = error instanceof Error ? error.message : String(error);
    } finally {
      this.updatingUserMessagePresentation.delete(entryId);
    }
  }

  setTranscriptScrollPosition(position: TranscriptScrollPosition | undefined) {
    this.transcriptScrollPosition = position;
  }

  /** The reader sent a message from the composer (typed or voice conversation mode). */
  noteSentMessage() {
    this.sentMessageRevision++;
    this.returnToBottom();
  }

  /** The reader asked for the newest content; the transcript follows it again. */
  returnToBottom() {
    this.cancelResultReveal();
    this.clearMessageSelection();
    this.bottomRequestRevision++;
    // A transcript mounted later opens at the bottom too.
    this.transcriptScrollPosition = { kind: "bottom" };
  }

  /** Selects and reveals a linked message, superseding any saved scroll anchor. */
  navigateToMessage(messageId: string) {
    this.cancelResultReveal();
    this.transcriptScrollPosition = undefined;
    this.selectMessage(messageId, "navigation");
  }

  /** The selected message's current part id, or undefined when it left the transcript. */
  @computed
  get selectedMessageId() {
    return this.selectedMessageIndex === undefined
      ? undefined
      : this.props.parts()[this.selectedMessageIndex]?.id;
  }

  /**
   * Selects the conversational entry before the current selection, or the newest one
   * when nothing is selected. Returns false when there is no message to
   * select; at the oldest message the selection stays and is revealed again.
   */
  selectPreviousMessage() {
    const parts = this.props.parts();
    const before = this.selectedMessageIndex ?? parts.length;
    const target =
      parts.findLast((part, index) => index < before && isSelectableMessage(part)) ??
      (this.selectedMessageIndex === undefined ? undefined : parts[this.selectedMessageIndex]);
    if (!target) return false;
    this.selectMessage(target.id, "keyboard");
    return true;
  }

  /**
   * Moves the selection to the next conversational entry. Moving past the newest one
   * clears the selection. Returns false when nothing was selected.
   */
  selectNextMessage() {
    const selected = this.selectedMessageIndex;
    if (selected === undefined) return false;
    const target = this.props
      .parts()
      .find((part, index) => index > selected && isSelectableMessage(part));
    if (target) this.selectMessage(target.id, "keyboard");
    else this.clearMessageSelection();
    return true;
  }

  clearMessageSelection() {
    this.messageSelection = undefined;
  }

  @computed
  private get selectedMessageIndex() {
    const selection = this.messageSelection;
    if (!selection) return undefined;
    const parts = this.props.parts();
    let index = parts.findIndex((part) => part.id === selection.messageId);
    if (index < 0 && selection.renderKey)
      index = parts.findIndex((part) => messageRenderKey(part) === selection.renderKey);
    return index < 0 ? undefined : index;
  }

  private selectMessage(messageId: string, origin: MessageSelection["origin"]) {
    this.cancelResultReveal();
    const part = this.props.parts().find((candidate) => candidate.id === messageId);
    if (part?.sideChatImport) this.setSideChatImportOpen(part.sideChatImport.groupId, true);
    this.messageSelection = {
      messageId,
      renderKey: messageRenderKey(part),
      origin,
      revision: ++this.messageSelectionRevision,
    };
  }

  @computed
  get error() {
    return this.userMessagePresentationError
      ? {
          message: this.userMessagePresentationError,
          title: "Could not change message formatting",
        }
      : undefined;
  }
}
