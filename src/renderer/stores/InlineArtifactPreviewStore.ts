import { observable, Store, untracked } from "r-state-tree";
import type { ArtifactStableRef } from "../../contracts/artifacts/artifact-lineage";
import { parseArtifactRef } from "../../contracts/artifacts/artifact-lineage";
import type { ArtifactCatalog } from "../models/ArtifactCatalog";
import type { ArtifactReferencePreviewStore } from "./ArtifactReferencePreviewStore";
import { ClientContext } from "./context/ClientContext";

/** Window-local inline disclosures. Payloads remain in the shared artifact Model;
 * stable references follow publication; explicit @rN references stay pinned. Independent mounts have
 * independent expansion state. Reads deduplicate per mount and ignore stale or
 * disposed results; nothing here is persisted or changes session links. */
export class InlineArtifactPreviewStore extends Store<{
  model: ArtifactCatalog;
  references: ArtifactReferencePreviewStore;
}> {
  readonly states = observable<
    Record<
      string,
      {
        reference: ArtifactStableRef;
        exactRef?: ArtifactStableRef;
        targetRef?: ArtifactStableRef;
        expanded: boolean;
        loading: boolean;
        error?: string;
      }
    >
  >({});

  constructor(props: InlineArtifactPreviewStore["props"]) {
    super(props);
    this.effect(() => {
      for (const [key, state] of Object.entries(this.states)) {
        const parsed = parseArtifactRef(state.reference);
        const resolution = this.props.references.previewStates[state.reference];
        const resolved = resolution && !resolution.loading && !resolution.error;
        const latest = this.props.model.find(parsed.lineageId)?.latestRevision;
        const reference: ArtifactStableRef | undefined =
          !parsed.revision && latest
            ? `cake://artifact/${parsed.lineageId}@r${latest}`
            : this.props.references.exactReference(state.reference);
        if (reference) {
          untracked(() => {
            if (state.targetRef !== reference) state.targetRef = reference;
            else if (!resolved) return;
            void this.load(key);
          });
        }
      }
    });
  }

  get client() {
    return ClientContext.consume(this)!;
  }

  publicationReference(lineageId: string, sessionId: string): ArtifactStableRef {
    const association = this.props.model
      .associationsFor(sessionId)
      .find((item) => item.lineage?.id === lineageId);
    return association?.link?.mode === "pinned"
      ? `cake://artifact/${lineageId}@r${association.selectedRevision}`
      : `cake://artifact/${lineageId}`;
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
    return lineage?.title;
  }

  prepare(key: string, reference: ArtifactStableRef) {
    const previous = this.states[key];
    if (previous?.reference === reference) return;
    if (previous) this.props.references.releaseReference(previous.reference);
    this.states[key] = observable({ reference, expanded: true, loading: false });
    this.props.references.retainReference(reference);
    void this.load(key);
  }

  release(key: string) {
    const state = this.states[key];
    if (state) this.props.references.releaseReference(state.reference);
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
      if (!state.targetRef) {
        const parsed = parseArtifactRef(state.reference);
        const known = parsed.revision ?? this.props.model.find(parsed.lineageId)?.latestRevision;
        if (known) {
          state.targetRef = `cake://artifact/${parsed.lineageId}@r${known}`;
        } else {
          const reference = await this.props.references.previewReference(state.reference);
          if (!current()) return;
          if (!reference) {
            const error = this.props.references.previewStates[state.reference]?.error;
            if (error) state.error = error;
            return;
          }
          state.targetRef = reference;
        }
      }
      if (!state.expanded) return;
      const target = state.targetRef;
      const parsed = parseArtifactRef(target);
      if (!this.props.model.find(parsed.lineageId)?.revision(parsed.revision!)?.record) {
        const revision = await this.client.artifacts.readExact(parsed.lineageId, parsed.revision!, {
          signal: this.signal,
        });
        if (current()) this.props.model.upsertRevision(revision);
      }
      // Keep the existing host (including fullscreen) mounted until its replacement is ready.
      if (current() && state.targetRef === target) state.exactRef = target;
    } catch (error) {
      if (current()) state.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (current()) {
        state.loading = false;
        // A publication may have advanced the target while this exact read was pending.
        if (!state.error && state.expanded && state.targetRef !== state.exactRef)
          void this.load(key);
      }
    }
  }
}
