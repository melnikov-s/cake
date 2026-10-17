import { observable, Store, untracked } from "r-state-tree";
import type {
  ArtifactLineageId,
  ArtifactLink,
  ArtifactLinkTarget,
  ArtifactRevisionNumber,
  ArtifactStableRef,
} from "../../contracts/artifacts/artifact-lineage";
import { parseArtifactRef } from "../../contracts/artifacts/artifact-lineage";
import type { ArtifactProjectionMetadata } from "../../contracts/artifacts/artifact-projection-data";
import type { ArtifactReferencePreviewState } from "../lib/artifact-reference-preview-state";
import type { ArtifactCatalog } from "../models/ArtifactCatalog";
import { ClientContext } from "./context/ClientContext";

export class ArtifactReferencePreviewStore extends Store<{
  model: ArtifactCatalog;
  artifactsChanged(lineageId: string): void;
}> {
  /** Resolution identities/status only. Mutable lineage facts live in ArtifactCatalog. */
  readonly previewStates = observable<Record<string, ArtifactReferencePreviewState>>({});
  private readonly pending = new Map<string, Promise<ArtifactStableRef | undefined>>();
  private readonly mounts = new Map<string, number>();
  operationError: string | undefined;
  private operationErrorLineageId: ArtifactLineageId | undefined;
  private operationRequest = 0;

  constructor(props: ArtifactReferencePreviewStore["props"]) {
    super(props);
    this.effect(() => {
      void this.props.model.invalidationVersion;
      untracked(() => {
        // Reference presentation is mutable even for an exact/history reference:
        // its lineage title and links can change without changing revision bytes.
        for (const reference of Object.keys(this.previewStates))
          void this.previewReference(reference, true);
      });
    });
  }

  get client() {
    return ClientContext.consume(this)!;
  }

  lineage(reference: ArtifactStableRef) {
    return this.props.model.find(parseArtifactRef(reference).lineageId);
  }

  exactReference(reference: ArtifactStableRef): ArtifactStableRef | undefined {
    const state = this.previewStates[reference];
    if (!state?.exactRef) return undefined;
    const parsed = parseArtifactRef(reference);
    // An exact destination never follows publication. A stable destination also follows
    // updates arriving through detail/effective projections, without another cached copy.
    const latest = this.lineage(reference)?.latestRevision;
    return !parsed.revision && latest
      ? `cake://artifact/${parsed.lineageId}@r${latest}`
      : state.exactRef;
  }

  /** Renderer metadata demand only; this does not acquire a widget/backend resource. */
  retainReference(reference: ArtifactStableRef) {
    this.mounts.set(reference, (this.mounts.get(reference) ?? 0) + 1);
    void this.previewReference(reference);
  }

  releaseReference(reference: ArtifactStableRef) {
    const remaining = (this.mounts.get(reference) ?? 0) - 1;
    if (remaining > 0) this.mounts.set(reference, remaining);
    else {
      this.mounts.delete(reference);
      this.pending.delete(reference);
      delete this.previewStates[reference];
    }
  }

  previewReference(reference: ArtifactStableRef, refresh = false) {
    if (this.signal.aborted) return Promise.resolve(undefined);
    const current = this.previewStates[reference];
    if (!refresh) {
      const pending = this.pending.get(reference);
      if (pending) return pending;
      if (current?.exactRef && !current.error)
        return Promise.resolve(this.exactReference(reference));
    }
    const state = observable<ArtifactReferencePreviewState>({
      loading: true,
      exactRef: current?.exactRef,
    });
    this.previewStates[reference] = state;
    const request = this.resolveReference(reference, state);
    this.pending.set(reference, request);
    void request.finally(() => {
      if (this.pending.get(reference) === request) this.pending.delete(reference);
    });
    return request;
  }

  private async resolveReference(
    reference: ArtifactStableRef,
    state: ArtifactReferencePreviewState,
  ) {
    const version = this.props.model.invalidationVersion;
    const isCurrent = () =>
      !this.signal.aborted &&
      this.previewStates[reference] === state &&
      version === this.props.model.invalidationVersion;
    try {
      const metadata = await this.client.artifacts.referenceMetadata(reference, {
        signal: this.signal,
      });
      if (!isCurrent()) return undefined;
      this.props.model.applyReferenceMetadata(metadata);
      state.exactRef = parseArtifactRef(reference).revision ? reference : metadata.exactRef;
      state.loading = false;
      return this.exactReference(reference);
    } catch (error) {
      if (isCurrent()) {
        state.loading = false;
        state.error = error instanceof Error ? error.message : String(error);
      }
      return undefined;
    }
  }

  operationErrorFor(lineageId: ArtifactLineageId) {
    return this.operationErrorLineageId === lineageId ? this.operationError : undefined;
  }

  clearOperationError(lineageId?: ArtifactLineageId) {
    if (lineageId !== undefined && this.operationErrorLineageId !== lineageId) return;
    this.operationRequest += 1;
    this.operationError = undefined;
    this.operationErrorLineageId = undefined;
  }

  private beginOperation(lineageId: ArtifactLineageId) {
    this.operationError = undefined;
    this.operationErrorLineageId = lineageId;
    return ++this.operationRequest;
  }

  private failOperation(lineageId: ArtifactLineageId, request: number, error: unknown) {
    if (this.signal.aborted || request !== this.operationRequest) return;
    this.operationErrorLineageId = lineageId;
    this.operationError = error instanceof Error ? error.message : String(error);
  }

  async materialize(
    sessionId: string,
    lineageId: ArtifactLineageId,
    revision: ArtifactRevisionNumber,
  ): Promise<ArtifactProjectionMetadata | undefined> {
    const operationRequest = this.beginOperation(lineageId);
    try {
      return await this.client.artifacts.materialize(sessionId, lineageId, revision, {
        signal: this.signal,
      });
    } catch (error) {
      this.failOperation(lineageId, operationRequest, error);
      return undefined;
    }
  }

  private async refreshLinks(lineageId: ArtifactLineageId, request: number) {
    const detail = await this.client.artifacts.detail(lineageId, { signal: this.signal });
    if (!this.signal.aborted && request === this.operationRequest)
      this.props.model.applyDetail(detail);
  }

  async link(
    sessionId: string,
    lineageId: ArtifactLineageId,
    target: ArtifactLinkTarget,
    selection: ArtifactLink["selection"] = { mode: "follow-latest" },
  ) {
    const operationRequest = this.beginOperation(lineageId);
    let link: ArtifactLink;
    try {
      link = await this.client.artifacts.link(
        { sessionId, lineageId, target, selection },
        { signal: this.signal },
      );
    } catch (error) {
      this.failOperation(lineageId, operationRequest, error);
      return undefined;
    }
    if (!this.signal.aborted) this.props.artifactsChanged(lineageId);
    try {
      await this.refreshLinks(lineageId, operationRequest);
    } catch (error) {
      this.failOperation(lineageId, operationRequest, error);
    }
    return link;
  }

  async setSelection(
    sessionId: string,
    lineageId: ArtifactLineageId,
    target: ArtifactLinkTarget,
    selection: ArtifactLink["selection"],
  ) {
    const operationRequest = this.beginOperation(lineageId);
    try {
      const link = await this.client.artifacts.setSelection(
        { sessionId, lineageId, target, selection },
        { signal: this.signal },
      );
      try {
        await this.refreshLinks(lineageId, operationRequest);
      } finally {
        if (!this.signal.aborted) this.props.artifactsChanged(lineageId);
      }
      return link;
    } catch (error) {
      this.failOperation(lineageId, operationRequest, error);
      return undefined;
    }
  }

  async unlink(sessionId: string, lineageId: ArtifactLineageId, target: ArtifactLinkTarget) {
    const operationRequest = this.beginOperation(lineageId);
    try {
      await this.client.artifacts.unlink({ sessionId, lineageId, target }, { signal: this.signal });
      try {
        await this.refreshLinks(lineageId, operationRequest);
      } finally {
        if (!this.signal.aborted) this.props.artifactsChanged(lineageId);
      }
    } catch (error) {
      this.failOperation(lineageId, operationRequest, error);
    }
  }
}
