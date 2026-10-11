import { computed, Store, untracked } from "r-state-tree";
import type { ArtifactRecord } from "../../ipc/artifact-contract";
import type { ArtifactCatalog } from "../models/ArtifactCatalog";
import { ClientContext } from "./context/ClientContext";

/**
 * Owns one session's effective artifact query. Mount, menu opening, and ordered
 * artifact invalidations refetch the authoritative projection. Only the newest
 * started refresh may commit; the shared library owns selection and mutations.
 */
export class SessionArtifactsStore extends Store<{
  sessionId: string;
  model: ArtifactCatalog;
  enabled?(): boolean;
}> {
  loading = false;
  error: string | undefined;
  private request = 0;

  constructor(props: SessionArtifactsStore["props"]) {
    super(props);
    this.effect(() => {
      if (this.props.enabled?.() === false) return;
      untracked(() => {
        void this.refresh();
      });
    });
  }

  get client() {
    return ClientContext.consume(this)!;
  }

  @computed
  get associations() {
    return this.props.model.associationsFor(this.props.sessionId);
  }

  @computed
  get records(): ArtifactRecord[] {
    return this.associations
      .map((association) => association.lineage?.revision(association.selectedRevision)?.record)
      .filter((record): record is ArtifactRecord => record !== undefined)
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async refresh() {
    if (this.props.enabled?.() === false) return;
    const request = ++this.request;
    this.loading = true;
    this.error = undefined;
    try {
      const values = await this.client.artifacts.effective(this.props.sessionId, {
        signal: this.signal,
      });
      if (request !== this.request || this.signal.aborted) return;
      this.props.model.applyEffective(this.props.sessionId, values);
    } catch (error) {
      if (request !== this.request || this.signal.aborted) return;
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (request === this.request && !this.signal.aborted) this.loading = false;
    }
  }

  receive() {
    void this.refresh();
  }
}
