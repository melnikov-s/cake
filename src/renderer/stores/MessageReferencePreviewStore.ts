import { Store } from "r-state-tree";
import {
  decodeMessageReadResult,
  messageNavigationTarget,
  messageReference,
  parseSessionLink,
  type MessageReadResult,
} from "../../contracts/conversations/message-reference";
import { ClientContext } from "./context/ClientContext";

/** A transient exact-source preview, never added to the Conversation or a window snapshot. */
export class MessageReferencePreviewStore extends Store<{
  reference?: string;
  partId?: string;
}> {
  expanded = false;

  toggle() {
    this.expanded = !this.expanded;
    if (this.expanded && !this.page && !this.loading) void this.load();
  }

  load() {
    const target = messageNavigationTarget(this.props.reference!);
    return this.open(target.sessionId, target.messageId);
  }

  page: MessageReadResult | undefined;
  loading = false;
  error: string | undefined;
  copyError: string | undefined;
  private revision = 0;

  private async readPage(sessionId: string, entryId: string, offset: number) {
    const value = await ClientContext.consume(this)!.sessionChats.inspect(
      { sessionId, kind: "messages-read", entryId, offset, maxChars: 20_000 },
      { signal: this.signal },
    );
    const page = decodeMessageReadResult(value);
    if (page.message.ref !== messageReference(sessionId, entryId) || page.offset !== offset)
      throw new Error("The source reader returned a different message or page");
    return page;
  }

  /** Resolve against the producer, including sources absent from the viewer's catalog. */
  loadWorkspaceImage = async (path: string, signal: AbortSignal) => {
    const sessionId = this.page?.message.sessionId;
    if (!sessionId) throw new Error("No original message is loaded");
    const client = ClientContext.consume(this)!;
    const source = await client.projectSessions.lookup({ sessionId }, { signal });
    signal.throwIfAborted();
    return client.filesystem.readImage(source.workingDirectory, path, { signal });
  };

  loadAttachmentImage = async (reference: string, signal: AbortSignal) => {
    const target = parseSessionLink(reference);
    const sessionId = this.page?.message.sessionId;
    if (!sessionId || target?.sessionId !== sessionId || !target.attachmentId)
      throw new Error("Image attachment must belong to the original session");
    const content = await ClientContext.consume(this)!.sessionChats.readAttachment(
      { sessionId, reference: target.attachmentId },
      { signal },
    );
    if (content.kind !== "image") throw new Error("Attachment is not a supported image");
    return content;
  };

  /** Read the complete original without moving the reader's current page. */
  async textForCopy() {
    this.copyError = undefined;
    const current = this.page;
    if (!current) throw new Error("No original message is loaded");
    const { sessionId, entryId } = current.message;
    let page = current.offset === 0 ? current : await this.readPage(sessionId, entryId, 0);
    const chunks = [page.text];
    while (page.nextOffset !== null) {
      if (page.nextOffset <= page.offset)
        throw new Error("The source reader returned an invalid next page");
      page = await this.readPage(sessionId, entryId, page.nextOffset);
      chunks.push(page.text);
    }
    this.signal.throwIfAborted();
    return chunks.join("");
  }

  showCopyError(error: unknown) {
    this.copyError = `Could not copy original message: ${error instanceof Error ? error.message : String(error)}`;
  }

  async open(sessionId: string, entryId: string, offset = 0) {
    const revision = ++this.revision;
    this.loading = true;
    this.error = undefined;
    this.copyError = undefined;
    try {
      const page = await this.readPage(sessionId, entryId, offset);
      if (revision !== this.revision || this.signal.aborted) return false;
      this.page = page;
      return true;
    } catch (error) {
      if (revision === this.revision && !this.signal.aborted)
        this.error = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      if (revision === this.revision && !this.signal.aborted) this.loading = false;
    }
  }

  next() {
    const page = this.page;
    if (!page || page.nextOffset === null || this.loading) return;
    void this.open(page.message.sessionId, page.message.entryId, page.nextOffset);
  }

  previous() {
    const page = this.page;
    if (!page || page.offset === 0 || this.loading) return;
    void this.open(page.message.sessionId, page.message.entryId, Math.max(0, page.offset - 20_000));
  }

  close() {
    this.revision++;
    this.page = undefined;
    this.loading = false;
    this.error = undefined;
    this.copyError = undefined;
  }
}
