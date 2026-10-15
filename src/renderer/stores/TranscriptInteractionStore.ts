import { Store, computed, observable } from "r-state-tree";
import type { UiPart } from "../../contracts/conversations/session-contract";

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
 * of any kind; keyboard selection walks assistant messages only. Each new
 * selection gets a fresh revision so the transcript reveals it exactly once.
 */
export interface MessageSelection {
  messageId: string;
  /** Presentation identity that survives a streamed part settling under a new id. */
  renderKey?: string;
  origin: "navigation" | "keyboard";
  revision: number;
}

function isSelectableAssistantMessage(part: UiPart) {
  return (
    part.kind === "text" && part.role === "assistant" && !part.subagentReport && Boolean(part.text)
  );
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
  changedFilesOpen = false;
  userMessagePresentationError: string | undefined;
  private messageSelectionRevision = 0;
  private changedFilesChurning: boolean | undefined;

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

  /** Selects and reveals a linked message, superseding any saved scroll anchor. */
  navigateToMessage(messageId: string) {
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
   * Selects the assistant message before the current selection, or the newest one
   * when nothing is selected. Returns false when there is no assistant message to
   * select; at the oldest message the selection stays and is revealed again.
   */
  selectPreviousAssistantMessage() {
    const parts = this.props.parts();
    const before = this.selectedMessageIndex ?? parts.length;
    const target =
      parts.findLast((part, index) => index < before && isSelectableAssistantMessage(part)) ??
      (this.selectedMessageIndex === undefined ? undefined : parts[this.selectedMessageIndex]);
    if (!target) return false;
    this.selectMessage(target.id, "keyboard");
    return true;
  }

  /**
   * Moves the selection to the next assistant message. Moving past the newest one
   * clears the selection. Returns false when nothing was selected.
   */
  selectNextAssistantMessage() {
    const selected = this.selectedMessageIndex;
    if (selected === undefined) return false;
    const target = this.props
      .parts()
      .find((part, index) => index > selected && isSelectableAssistantMessage(part));
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
      index = parts.findIndex(
        (part) => part.kind === "text" && part.renderKey === selection.renderKey,
      );
    return index < 0 ? undefined : index;
  }

  private selectMessage(messageId: string, origin: MessageSelection["origin"]) {
    const part = this.props.parts().find((candidate) => candidate.id === messageId);
    this.messageSelection = {
      messageId,
      renderKey: part?.kind === "text" ? part.renderKey : undefined,
      origin,
      revision: ++this.messageSelectionRevision,
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
