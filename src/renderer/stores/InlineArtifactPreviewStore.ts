import { observable, Store } from "r-state-tree";
import type { ArtifactStableRef } from "../../contracts/artifacts/artifact-lineage";
import { parseArtifactRef } from "../../contracts/artifacts/artifact-lineage";
import type { ArtifactCatalog } from "../models/ArtifactCatalog";
import { ClientContext } from "./context/ClientContext";

/** Window-local inline disclosures. Payloads remain in the shared artifact Model;
 * references freeze to an exact revision on resolution. Independent mounts have
 * independent expansion state. Reads deduplicate per mount and ignore stale or
 * disposed results; nothing here is persisted or changes session links. */
export class InlineArtifactPreviewStore extends Store<{ model: ArtifactCatalog }> {
  readonly states = observable<
    Record<
      string,
      {
        reference: ArtifactStableRef;
        exactRef?: ArtifactStableRef;
        expanded: boolean;
        loading: boolean;
        error?: string;
      }
    >
  >({});

  get client() {
    return ClientContext.consume(this)!;
  }

  revision(key: string) {
    const reference = this.states[key]?.exactRef;
    if (!reference) return undefined;
    const parsed = parseArtifactRef(reference);
    return this.props.model.find(parsed.lineageId)?.revision(parsed.revision!);
  }

  title(key: string) {
    const state = this.states[key];
    if (!state) return undefined;
    const lineage = this.props.model.find(parseArtifactRef(state.reference).lineageId);
    return this.revision(key)?.record?.artifact.title ?? lineage?.title;
  }

  prepare(key: string, reference: ArtifactStableRef) {
    if (this.states[key]?.reference === reference) return;
    this.states[key] = observable({ reference, expanded: true, loading: false });
    void this.load(key);
  }

  release(key: string) {
    delete this.states[key];
  }

  toggle(key: string) {
    const state = this.states[key];
    if (!state) return;
    state.expanded = !state.expanded;
    if (state.expanded) void this.load(key);
  }

  async load(key: string) {
    const state = this.states[key];
    if (!state || state.loading) return;
    state.loading = true;
    state.error = undefined;
    const current = () => !this.signal.aborted && this.states[key] === state;
    try {
      if (!state.exactRef) {
        const parsed = parseArtifactRef(state.reference);
        if (parsed.revision && this.props.model.find(parsed.lineageId)?.revision(parsed.revision)) {
          state.exactRef = state.reference;
        } else {
          const metadata = await this.client.artifacts.referenceMetadata(state.reference, {
            signal: this.signal,
          });
          if (!current()) return;
          this.props.model.upsertSummary(metadata.lineage);
          this.props.model.applyHistory(metadata.lineage.id, [metadata.revision]);
          state.exactRef = metadata.exactRef;
        }
      }
      if (!state.expanded || this.revision(key)?.record) return;
      const parsed = parseArtifactRef(state.exactRef);
      const revision = await this.client.artifacts.readExact(parsed.lineageId, parsed.revision!, {
        signal: this.signal,
      });
      if (current()) this.props.model.upsertRevision(revision);
    } catch (error) {
      if (current()) state.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (current()) state.loading = false;
    }
  }
}
