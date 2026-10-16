import { Store, untracked } from "r-state-tree";
import type {
  ArtifactLineageId,
  ArtifactLink,
  ArtifactLinkTarget,
  ArtifactRevisionNumber,
  ArtifactStableRef,
} from "../../contracts/artifacts/artifact-lineage";
import type { ArtifactProjectionMetadata } from "../../contracts/artifacts/artifact-projection-data";
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

  async previewReference(reference: ArtifactStableRef, refresh = false) {
    const current = this.previewStates[reference];
    if (!refresh && (current?.loading || current?.metadata)) return current?.metadata;
    this.setPreviewState(reference, { loading: true, metadata: current?.metadata });
    const state = this.previewStates[reference];
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
      this.setPreviewState(reference, { loading: false, metadata });
      return metadata;
    } catch (error) {
      if (isCurrent())
        this.setPreviewState(reference, {
          loading: false,
          metadata: current?.metadata,
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
