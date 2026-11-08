import { batch, Store } from "r-state-tree";
import type { Conversation } from "../models/Conversation";
import { ClientContext } from "./context/ClientContext";
import { describeError } from "../lib/error-details";

/** Window-local paging workflow. Pi owns disk originals; Conversation owns their
 * transient projection. One request at a time; disposal cancels reads, never model runs. */
export class ConversationHistoryStore extends Store<{ model: Conversation }> {
  loading = false;
  error: string | undefined;
  private loaded = false;
  private cursor: string | undefined;

  constructor(props: ConversationHistoryStore["props"]) {
    super(props);
    this.effect(() => () => {
      props.model.earlierParts.splice(0);
    });
  }

  get hasMore() {
    return (this.loaded ? this.cursor : this.props.model.historyCursor) !== undefined;
  }

  async load(beforePrepend?: () => void) {
    const cursor = this.loaded ? this.cursor : this.props.model.historyCursor;
    if (this.loading || cursor === undefined || this.signal.aborted) return;
    this.loading = true;
    this.error = undefined;
    const model = this.props.model;
    try {
      const page = await ClientContext.consume(this)!.sessionChats.history(
        { sessionId: model.sessionId, cursor },
        { signal: this.signal },
      );
      if (this.signal.aborted || model !== this.props.model) return;
      const known = new Set([...model.earlierParts, ...model.uiParts].map((part) => part.id));
      const older = page.parts.filter((part) => !known.has(part.id));
      // Capture the current reader, not their position when the read started.
      if (older.length) beforePrepend?.();
      batch(() => {
        model.earlierParts.unshift(...older);
        this.cursor = page.cursor;
        this.loaded = true;
      });
    } catch (error) {
      if (!this.signal.aborted) this.error = describeError(error).message;
    } finally {
      if (!this.signal.aborted) this.loading = false;
    }
  }
}
