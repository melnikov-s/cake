import { observable, Store, untracked } from "r-state-tree";
import type { ArtifactStableRef } from "../../contracts/artifacts/artifact-lineage";
import { parseArtifactRef } from "../../contracts/artifacts/artifact-lineage";
import type { ArtifactCatalog } from "../models/ArtifactCatalog";
import type { ArtifactReferencePreviewStore } from "./ArtifactReferencePreviewStore";
import { ClientContext } from "./context/ClientContext";
import type { UiPart } from "../../contracts/conversations/session-contract";
import { inlineArtifactReferences } from "../lib/inline-artifact-references";

/** Window-local inline disclosures. Payloads remain in the shared artifact Model;
 * stable references follow publication; explicit @rN references stay pinned. Each transcript
 * occurrence has independent expansion state. Disclosure choices survive virtualization,
 * while payload reads and reference demand remain mount-owned. Nothing is persisted. */
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
        presentationId: string;
        loading: boolean;
        error?: string;
      }
    >
  >({});

  private readonly conversations = observable<
    Record<string, { conversationId: string; parts(): UiPart[] }>
  >({});
  private nextObservation = 0;
  private readonly newest = new Map<string, number>();
  private readonly disclosures = observable<
    Record<
      string,
      {
        conversationId: string;
        reference: ArtifactStableRef;
        expanded: boolean;
      }
    >
  >({});

  constructor(props: InlineArtifactPreviewStore["props"]) {
    super(props);
    this.effect(() => {
      for (const { conversationId, parts } of Object.values(this.conversations)) {
        const references = inlineArtifactReferences(parts());
        const exact = references.map((reference) => this.resolvedReference(reference));
        untracked(() => {
          for (const reference of exact)
            if (reference) this.presentRevision(conversationId, reference);
        });
      }
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

  /** Observe full history so restored/offscreen newer revisions count, not render order. */
  observeConversation(conversationId: string, parts: () => UiPart[]) {
    const key = String(++this.nextObservation);
    this.conversations[key] = { conversationId, parts };
    return () => {
      delete this.conversations[key];
    };
  }

  private resolvedReference(reference: ArtifactStableRef): ArtifactStableRef | undefined {
    const parsed = parseArtifactRef(reference);
    const revision = parsed.revision ?? this.props.model.find(parsed.lineageId)?.latestRevision;
    return revision ? `cake://artifact/${parsed.lineageId}@r${revision}` : undefined;
  }

  private lineageKey(conversationId: string, reference: ArtifactStableRef) {
    return JSON.stringify([conversationId, parseArtifactRef(reference).lineageId]);
  }

  private presentRevision(conversationId: string, reference: ArtifactStableRef) {
    const parsed = parseArtifactRef(reference);
    if (!parsed.revision) return;
    const key = this.lineageKey(conversationId, reference);
    if (parsed.revision <= (this.newest.get(key) ?? 0)) return;
    this.newest.set(key, parsed.revision);
    for (const disclosure of Object.values(this.disclosures)) {
      if (this.lineageKey(disclosure.conversationId, disclosure.reference) !== key) continue;
      const resolved = this.resolvedReference(disclosure.reference);
      if (resolved && parseArtifactRef(resolved).revision! < parsed.revision)
        disclosure.expanded = false;
    }
  }

  expanded(key: string) {
    const state = this.states[key];
    return state ? (this.disclosures[state.presentationId]?.expanded ?? true) : true;
  }

  prepare(key: string, reference: ArtifactStableRef, conversationId = key, surfaceId = key) {
    const previous = this.states[key];
    if (previous?.reference === reference) return;
    if (previous) this.props.references.releaseReference(previous.reference);
    const presentationId = JSON.stringify([conversationId, surfaceId, reference]);
    const resolved = this.resolvedReference(reference);
    if (resolved) this.presentRevision(conversationId, resolved);
    if (!this.disclosures[presentationId]) {
      const revision = resolved && parseArtifactRef(resolved).revision;
      this.disclosures[presentationId] = observable({
        conversationId,
        reference,
        expanded:
          !revision ||
          revision >= (this.newest.get(this.lineageKey(conversationId, reference)) ?? 0),
      });
    }
    this.states[key] = observable({ reference, presentationId, loading: false });
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
    const disclosure = this.disclosures[state.presentationId]!;
    disclosure.expanded = !disclosure.expanded;
    if (disclosure.expanded) void this.load(key);
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
      const disclosure = this.disclosures[state.presentationId]!;
      this.presentRevision(disclosure.conversationId, state.targetRef);
      if (!this.expanded(key)) return;
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
        if (!state.error && this.expanded(key) && state.targetRef !== state.exactRef)
          void this.load(key);
      }
    }
  }
}
