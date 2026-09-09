import { Store } from "r-state-tree";
import type { Attachment, UiPart } from "../../ipc/session-contract";
import { shouldRenderMarkdown } from "../../utils/markdown";
import type { WorktreeDraftChoice } from "./WorktreeCreationStore";
import { ClientContext } from "./context/ClientContext";

export interface PendingSessionPrompt {
  text: string;
  attachments: Attachment[];
}

export interface PendingSessionDraftStoreProps {
  sessionId(): string | undefined;
  prompt?(sessionId: string): PendingSessionPrompt | undefined;
  isDeferred?(sessionId: string): boolean;
  create?(
    sessionId: string,
    text: string,
    attachments: Attachment[],
  ): boolean | Promise<boolean | void>;
  update?(
    sessionId: string,
    text: string,
    attachments: Attachment[],
  ): boolean | Promise<boolean | void>;
  activate?(sessionId: string): PendingSessionPrompt | undefined;
  applyGeneratedName?(sessionId: string, title: string): void;
  configureActivation?(choice: WorktreeDraftChoice): void;
  creationChoice?(): WorktreeDraftChoice;
}

/** Owns transient composer editing/activation UI for a saved pending-conversation prompt. */
export class PendingSessionDraftStore extends Store<PendingSessionDraftStoreProps> {
  editing = false;

  get client() {
    return ClientContext.consume(this)!;
  }

  get prompt() {
    const sessionId = this.props.sessionId();
    return sessionId ? this.props.prompt?.(sessionId) : undefined;
  }

  get shouldCreate() {
    return this.props.creationChoice?.().kind === "draft";
  }

  async create(text: string, attachments: Attachment[]) {
    const sessionId = this.props.sessionId();
    if (!sessionId || !this.props.isDeferred?.(sessionId) || !this.props.create) return false;
    if (!text && attachments.length === 0) return false;
    if ((await this.props.create(sessionId, text, attachments)) === false) return false;
    this.props.configureActivation?.({ kind: "current" });
    if (text)
      void this.client.workspaces
        .generateSessionTitle(text, { signal: this.signal })
        .then((title) => {
          if (title && !this.signal.aborted) this.props.applyGeneratedName?.(sessionId, title);
        })
        .catch(() => undefined);
    return true;
  }

  async update(text: string, attachments: Attachment[]) {
    const sessionId = this.props.sessionId();
    if (!this.editing || !sessionId || !this.props.update) return false;
    if ((await this.props.update(sessionId, text, attachments)) === false) return false;
    this.editing = false;
    return true;
  }

  takeForActivation(choice?: WorktreeDraftChoice) {
    const sessionId = this.props.sessionId();
    if (!sessionId || choice?.kind === "draft") return undefined;
    if (choice) this.props.configureActivation?.(choice);
    return this.props.activate?.(sessionId);
  }

  beginEdit(entryId: string) {
    const sessionId = this.props.sessionId();
    const prompt = this.prompt;
    if (!sessionId || !prompt || entryId !== `draft:${sessionId}`) return undefined;
    this.editing = true;
    this.props.configureActivation?.({ kind: "draft" });
    return prompt;
  }

  cancelEdit() {
    if (!this.editing) return false;
    this.editing = false;
    this.props.configureActivation?.({ kind: "current" });
    return true;
  }

  parts(): UiPart[] | undefined {
    const sessionId = this.props.sessionId();
    const prompt = this.prompt;
    if (!sessionId || !prompt || this.editing) return undefined;
    const entryId = `draft:${sessionId}`;
    return [
      {
        id: `draft-${sessionId}-text`,
        kind: "text",
        role: "user",
        entryId,
        text: prompt.text,
        status: "complete",
        renderAs: shouldRenderMarkdown(prompt.text) ? "markdown" : undefined,
        draft: true,
      },
      ...prompt.attachments.flatMap((attachment, index): UiPart[] => {
        if (attachment.kind === "annotation")
          return [
            {
              id: `draft-${sessionId}-annotation-${index}`,
              kind: "annotation",
              annotations: attachment.annotations,
            },
          ];
        if (attachment.kind === "image")
          return [
            {
              id: `draft-${sessionId}-attachment-${index}`,
              kind: "attachment",
              name: attachment.name,
              mediaType: attachment.mimeType,
              attachmentKind: "image",
              data: attachment.data,
            },
          ];
        if (attachment.kind === "source")
          return [
            {
              id: `draft-${sessionId}-attachment-${index}`,
              kind: "attachment",
              name: attachment.name,
              mediaType: "text/plain",
              attachmentKind: "source",
              location: attachment.location,
            },
          ];
        return [];
      }),
    ];
  }
}
