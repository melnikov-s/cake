import { Store } from "r-state-tree";
import type {
  ArtifactLineageId,
  ArtifactLink,
  ArtifactLinkTarget,
  ArtifactRevisionNumber,
  ArtifactStableRef,
} from "../../domain/artifacts/artifact-lineage";
import type { ArtifactProjectionMetadata } from "../../services/artifacts/ArtifactProjection";
import type { ArtifactReferencePreviewState } from "../lib/artifact-reference-preview-state";
import type { ArtifactCatalog } from "../models/ArtifactCatalog";
import { ClientContext } from "./context/ClientContext";

export class ArtifactReferencePreviewStore extends Store<{
  model: ArtifactCatalog;
  artifactsChanged(lineageId: string): void;
}> {
  previewStates: Record<string, ArtifactReferencePreviewState> = {};
  operationError: string | undefined;
  private operationErrorLineageId: ArtifactLineageId | undefined;
  private operationRequest = 0;

  get client() {
    return ClientContext.consume(this)!;
  }

  private setPreviewState(reference: ArtifactStableRef, state: ArtifactReferencePreviewState) {
    this.previewStates = {
      ...Object.fromEntries(
        Object.entries(this.previewStates)
          .filter(([cachedReference]) => cachedReference !== reference)
          .slice(-99),
      ),
      [reference]: state,
    };
  }

  async previewReference(reference: ArtifactStableRef) {
    const current = this.previewStates[reference];
    if (current?.loading || current?.metadata) return current?.metadata;
    this.setPreviewState(reference, { loading: true });
    try {
      const metadata = await this.client.artifacts.referenceMetadata(reference, {
        signal: this.signal,
      });
      if (!this.signal.aborted) this.setPreviewState(reference, { loading: false, metadata });
      return metadata;
    } catch (error) {
      if (!this.signal.aborted)
        this.setPreviewState(reference, {
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        });
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

  private updatePreviewLinks(lineageId: ArtifactLineageId, links: ReadonlyArray<ArtifactLink>) {
    this.previewStates = Object.fromEntries(
      Object.entries(this.previewStates).map(([reference, state]) => [
        reference,
        state.metadata?.lineage.id === lineageId
          ? { ...state, metadata: { ...state.metadata, links } }
          : state,
      ]),
    );
  }

  private async refreshLinks(lineageId: ArtifactLineageId) {
    const detail = await this.client.artifacts.detail(lineageId, { signal: this.signal });
    if (!this.signal.aborted) {
      this.props.model.applyDetail(detail);
      this.updatePreviewLinks(lineageId, detail.links);
    }
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
      await this.refreshLinks(lineageId);
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
      await this.refreshLinks(lineageId);
      if (!this.signal.aborted) this.props.artifactsChanged(lineageId);
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
      await this.refreshLinks(lineageId);
      if (!this.signal.aborted) this.props.artifactsChanged(lineageId);
    } catch (error) {
      this.failOperation(lineageId, operationRequest, error);
    }
  }
}
