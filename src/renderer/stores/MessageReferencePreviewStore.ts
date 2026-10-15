import { Store } from "r-state-tree";
import {
  decodeMessageReadResult,
  type MessageReadResult,
} from "../../contracts/conversations/message-reference";
import { ClientContext } from "./context/ClientContext";

/** A transient exact-source preview, never added to the Conversation or a window snapshot. */
export class MessageReferencePreviewStore extends Store {
  page: MessageReadResult | undefined;
  loading = false;
  error: string | undefined;
  private revision = 0;

  async open(sessionId: string, entryId: string, offset = 0) {
    const revision = ++this.revision;
    this.loading = true;
    this.error = undefined;
    try {
      const value = await ClientContext.consume(this)!.sessionChats.inspect(
        { sessionId, kind: "messages-read", entryId, offset, maxChars: 20_000 },
        { signal: this.signal },
      );
      if (revision !== this.revision || this.signal.aborted) return false;
      this.page = decodeMessageReadResult(value);
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
  }
}
