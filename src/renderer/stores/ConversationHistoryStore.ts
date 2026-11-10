import { batch, Store } from "r-state-tree";
import type { Conversation } from "../models/Conversation";
import { ClientContext } from "./context/ClientContext";
import { describeError } from "../lib/error-details";

/** Window-local paging workflow. Pi owns disk originals; Conversation owns their
 * transient projection. One request at a time; disposal cancels reads, never model runs. */
export class ConversationHistoryStore extends Store<{
  model: Conversation;
  retainTranscript?(): () => void;
}> {
  loading = false;
  error: string | undefined;
  private loaded = false;
  private cursor: string | undefined;
  private generation = 0;

  constructor(props: ConversationHistoryStore["props"]) {
    super(props);
    this.reaction(
      () => props.model.observedSnapshotRevision,
      (revision) => {
        if (revision !== 0) return;
        this.generation += 1;
        this.loaded = false;
        this.cursor = undefined;
        this.loading = false;
        this.error = undefined;
      },
    );
    this.effect(() => () => {
      props.model.earlierParts.splice(0);
    });
  }

  get hasMore() {
    return (this.loaded ? this.cursor : this.props.model.historyCursor) !== undefined;
  }

  async load() {
    const cursor = this.loaded ? this.cursor : this.props.model.historyCursor;
    if (this.loading || cursor === undefined || this.signal.aborted) return;
    this.loading = true;
    this.error = undefined;
    const model = this.props.model;
    const generation = this.generation;
    const release = this.props.retainTranscript?.();
    try {
      const page = await ClientContext.consume(this)!.sessionChats.history(
        { sessionId: model.sessionId, cursor },
        { signal: this.signal },
      );
      if (this.signal.aborted || model !== this.props.model || generation !== this.generation)
        return;
      const known = new Set([...model.earlierParts, ...model.uiParts].map((part) => part.id));
      const older = page.parts.filter((part) => !known.has(part.id));
      batch(() => {
        model.earlierParts.unshift(...older);
        this.cursor = page.cursor;
        this.loaded = true;
      });
    } catch (error) {
      if (!this.signal.aborted && generation === this.generation)
        this.error = describeError(error).message;
    } finally {
      if (!this.signal.aborted && generation === this.generation) this.loading = false;
      release?.();
    }
  }
}
