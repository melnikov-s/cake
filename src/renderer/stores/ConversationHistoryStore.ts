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
  private request: AbortController | undefined;
  private readers = 0;
  private readonly completedCursors = new Set<string>();

  constructor(props: ConversationHistoryStore["props"]) {
    super(props);
    this.reaction(
      () => props.model.observedSnapshotRevision,
      (revision) => {
        if (revision !== 0) return;
        this.cancel();
        this.loaded = false;
        this.cursor = undefined;
        this.completedCursors.clear();
      },
    );
    this.effect(() => () => {
      this.cancel();
      props.model.earlierParts.splice(0);
    });
  }

  get hasMore() {
    return (this.loaded ? this.cursor : this.props.model.historyCursor) !== undefined;
  }

  /** A hidden/switched transcript must not keep a stalled read (or its runtime lease) alive. */
  retain() {
    this.readers += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.readers === 0) this.cancel();
    };
  }

  private cancel() {
    this.generation += 1;
    this.request?.abort();
    this.request = undefined;
    this.loading = false;
    this.error = undefined;
  }

  async load() {
    const cursor = this.loaded ? this.cursor : this.props.model.historyCursor;
    if (this.loading || cursor === undefined || this.signal.aborted) return;
    this.loading = true;
    this.error = undefined;
    const model = this.props.model;
    const generation = this.generation;
    const request = new AbortController();
    this.request = request;
    const signal = AbortSignal.any([this.signal, request.signal]);
    let releaseTranscript: (() => void) | undefined;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseTranscript?.();
    };
    signal.addEventListener("abort", release, { once: true });
    try {
      releaseTranscript = this.props.retainTranscript?.();
      const page = await ClientContext.consume(this)!.sessionChats.history(
        { sessionId: model.sessionId, cursor },
        { signal },
      );
      if (signal.aborted || model !== this.props.model || generation !== this.generation) return;
      if (page.cursor === cursor || (page.cursor && this.completedCursors.has(page.cursor)))
        throw new Error("Earlier history did not advance. Retry loading earlier messages.");
      const known = new Set(model.uiParts.map((part) => part.id));
      const older = page.parts.filter((part) => {
        if (known.has(part.id)) return false;
        known.add(part.id);
        return true;
      });
      batch(() => {
        model.earlierParts.unshift(...older);
        this.completedCursors.add(cursor);
        this.cursor = page.cursor;
        this.loaded = true;
      });
    } catch (error) {
      if (!signal.aborted && generation === this.generation)
        this.error = describeError(error).message;
    } finally {
      if (!signal.aborted && generation === this.generation) {
        this.loading = false;
        this.request = undefined;
      }
      signal.removeEventListener("abort", release);
      release();
    }
  }
}
