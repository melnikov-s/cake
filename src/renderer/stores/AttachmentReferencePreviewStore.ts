import { Store } from "r-state-tree";
import type { AttachmentContent } from "../../contracts/conversations/attachment-reference-control";
import { ClientContext } from "./context/ClientContext";

/** User-requested vault previews. Bytes are transient and never sent to an agent or window snapshot. */
export class AttachmentReferencePreviewStore extends Store {
  content: AttachmentContent | undefined;
  sessionId: string | undefined;
  loading = false;
  error: string | undefined;
  private revision = 0;

  async open(sessionId: string, reference: string, offset = 0) {
    const revision = ++this.revision;
    this.loading = true;
    this.error = undefined;
    try {
      const content = await ClientContext.consume(this)!.sessionChats.readAttachment(
        { sessionId, reference, offset, limit: 20_000 },
        { signal: this.signal },
      );
      if (revision !== this.revision || this.signal.aborted) return false;
      this.sessionId = sessionId;
      this.content = content;
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
    const page = this.content;
    if (!this.sessionId || page?.kind !== "text" || page.nextOffset === null || this.loading)
      return;
    void this.open(this.sessionId, page.reference.id, page.nextOffset);
  }

  previous() {
    const page = this.content;
    if (!this.sessionId || page?.kind !== "text" || page.offset === 0 || this.loading) return;
    void this.open(this.sessionId, page.reference.id, Math.max(0, page.offset - 20_000));
  }

  close() {
    this.revision++;
    this.content = undefined;
    this.sessionId = undefined;
    this.loading = false;
    this.error = undefined;
  }
}
