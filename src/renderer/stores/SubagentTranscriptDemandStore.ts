import { observable, Store } from "r-state-tree";

/** Tracks mounted worker readers separately from a parent's selection and background activity. */
export class SubagentTranscriptDemandStore extends Store {
  private readonly readers = observable(new Map<string, number>());

  get parentSessionIds(): readonly string[] {
    return [...this.readers.keys()];
  }

  retain(parentSessionId: string) {
    this.readers.set(parentSessionId, (this.readers.get(parentSessionId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released || this.signal.aborted) return;
      released = true;
      const count = this.readers.get(parentSessionId) ?? 0;
      if (count <= 1) this.readers.delete(parentSessionId);
      else this.readers.set(parentSessionId, count - 1);
    };
  }
}
