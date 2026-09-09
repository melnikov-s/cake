import { Store, computed, observable } from "r-state-tree";
import type { UiPart } from "../../ipc/session-contract";

export interface UserMessagePresentationCapabilities {
  setMarkdown(entryId: string, renderAsMarkdown: boolean): Promise<void>;
}

export interface TranscriptInteractionStoreProps {
  parts(): UiPart[];
  loading(): boolean;
  userMessagePresentation?: UserMessagePresentationCapabilities;
}

export interface MessageNavigationRequest {
  messageId: string;
  revision: number;
}

export type TranscriptScrollPosition =
  | { kind: "top" }
  | { kind: "bottom" }
  | { kind: "message"; messageId: string; offset: number };

/** Owns transcript restoration, message navigation, disclosure, and message presentation edits. */
export class TranscriptInteractionStore extends Store<TranscriptInteractionStoreProps> {
  readonly updatingUserMessagePresentation = observable(new Set<string>());
  private readonly requestedUserMessagePresentation = observable(
    new Map<string, { requested: boolean; projectedAtRequest: boolean }>(),
  );
  loadingStartedAt: number | undefined;
  transcriptScrollPosition: TranscriptScrollPosition | undefined;
  messageNavigationRequest: MessageNavigationRequest | undefined;
  changedFilesOpen = false;
  userMessagePresentationError: string | undefined;
  private messageNavigationRevision = 0;
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

  navigateToMessage(messageId: string) {
    this.transcriptScrollPosition = undefined;
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
