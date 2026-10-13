import { observable, Store, untracked } from "r-state-tree";
import type { ArtifactStableRef } from "../../contracts/artifacts/artifact-lineage";
import { parseArtifactRef } from "../../contracts/artifacts/artifact-lineage";
import type { ArtifactCatalog } from "../models/ArtifactCatalog";
import { ClientContext } from "./context/ClientContext";

/** Window-local inline disclosures. Payloads remain in the shared artifact Model;
 * stable references follow publication; explicit @rN references stay pinned. Independent mounts have
 * independent expansion state. Reads deduplicate per mount and ignore stale or
 * disposed results; nothing here is persisted or changes session links. */
export class InlineArtifactPreviewStore extends Store<{ model: ArtifactCatalog }> {
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
        const latest = this.props.model.find(parsed.lineageId)?.latestRevision;
        if (!parsed.revision && latest) {
          untracked(() => {
            const reference: ArtifactStableRef = `cake://artifact/${parsed.lineageId}@r${latest}`;
            if (state.targetRef === reference) return;
            state.targetRef = reference;
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
    return this.revision(key)?.record?.artifact.title ?? lineage?.title;
  }

  prepare(key: string, reference: ArtifactStableRef) {
    if (this.states[key]?.reference === reference) return;
    this.states[key] = observable({ reference, expanded: true, loading: false });
    void this.load(key);
  }

  async receive(lineageId?: string) {
    const references = new Set(Object.values(this.states).map((state) => state.reference));
    await Promise.all(
      [...references].map(async (reference) => {
        const parsed = parseArtifactRef(reference);
        if (parsed.revision || (lineageId && parsed.lineageId !== lineageId)) return;
        try {
          const metadata = await this.client.artifacts.referenceMetadata(reference, {
            signal: this.signal,
          });
          if (!this.signal.aborted) {
            this.props.model.upsertSummary(metadata.lineage);
            for (const [key, state] of Object.entries(this.states))
              if (state.reference === reference) void this.load(key);
          }
        } catch (error) {
          if (!this.signal.aborted)
            for (const state of Object.values(this.states))
              if (state.reference === reference)
                state.error = error instanceof Error ? error.message : String(error);
        }
      }),
    );
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
      if (!state.targetRef) {
        const parsed = parseArtifactRef(state.reference);
        const known = parsed.revision ?? this.props.model.find(parsed.lineageId)?.latestRevision;
        if (known) {
          state.targetRef = `cake://artifact/${parsed.lineageId}@r${known}`;
        } else {
          const metadata = await this.client.artifacts.referenceMetadata(state.reference, {
            signal: this.signal,
          });
          if (!current()) return;
          this.props.model.upsertSummary(metadata.lineage);
          this.props.model.applyHistory(metadata.lineage.id, [metadata.revision]);
          state.targetRef = parsed.revision
            ? metadata.exactRef
            : `cake://artifact/${parsed.lineageId}@r${this.props.model.find(parsed.lineageId)!.latestRevision}`;
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
