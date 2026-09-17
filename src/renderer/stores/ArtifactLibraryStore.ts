import { Store, untracked } from "r-state-tree";
import type {
  ArtifactLineageId,
  ArtifactLink,
  ArtifactLinkTarget,
  ArtifactReferenceMetadata,
  ArtifactRevisionNumber,
  ArtifactStableRef,
  ArtifactTextComparison,
} from "../../domain/artifacts/artifact-lineage";
import type { ArtifactProjectionMetadata } from "../../services/artifacts/ArtifactProjection";
import type { ArtifactCatalog } from "../models/ArtifactCatalog";
import { ClientContext } from "./context/ClientContext";

type ArtifactReferencePreviewState = {
  loading: boolean;
  metadata?: ArtifactReferenceMetadata;
  error?: string;
};

export class ArtifactLibraryStore extends Store<{
  model: ArtifactCatalog;
  artifactsChanged(lineageId: string): void;
}> {
  search = "";
  kind = "all";
  offset = 0;
  limit = 50;
  total = 0;
  loading = false;
  detailLoading = false;
  error: string | undefined;
  operationError: string | undefined;
  activeSessionId: string | undefined;
  selectedLineageId: ArtifactLineageId | undefined;
  selectedRevision: ArtifactRevisionNumber | undefined;
  pendingRestoreRevision: ArtifactRevisionNumber | undefined;
  comparison: ArtifactTextComparison | undefined;
  previewStates: Record<string, ArtifactReferencePreviewState> = {};
  private visibleLineageIds: ReadonlyArray<string> = [];
  private request = 0;
  private controller: AbortController | undefined;

  constructor(props: ArtifactLibraryStore["props"]) {
    super(props);
    this.effect(() => {
      untracked(() => {
        void this.load();
      });
      return () => this.controller?.abort();
    });
  }

  get client() {
    return ClientContext.consume(this)!;
  }
  get lineages() {
    return this.visibleLineageIds
      .map((lineageId) => this.props.model.find(lineageId))
      .filter((lineage) => lineage !== undefined)
      .filter((lineage) => this.kind === "all" || lineage.latest?.kind === this.kind);
  }
  get selectedLineage() {
    return this.selectedLineageId ? this.props.model.find(this.selectedLineageId) : undefined;
  }
  get selectedLinks() {
    return this.selectedLineageId
      ? this.props.model.links.filter((link) => link.lineageId === this.selectedLineageId)
      : [];
  }

  open(sessionId?: string) {
    this.activeSessionId = sessionId;
  }

  setSearch(search: string) {
    this.search = search;
    this.offset = 0;
  }

  setKind(kind: string) {
    this.kind = kind;
  }

  async load() {
    const request = ++this.request;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.loading = true;
    this.error = undefined;
    try {
      const page = await this.client.artifacts.catalog(
        { search: this.search, offset: this.offset, limit: this.limit },
        { signal: AbortSignal.any([this.signal, controller.signal]) },
      );
      if (request !== this.request || this.signal.aborted) return;
      for (const item of page.items) this.props.model.upsertSummary(item);
      this.visibleLineageIds = page.items.map((item) => item.id);
      this.total = page.total;
      this.offset = page.offset;
      this.limit = page.limit;
    } catch (error) {
      if (request !== this.request || controller.signal.aborted || this.signal.aborted) return;
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (request === this.request && !this.signal.aborted) this.loading = false;
    }
  }

  async select(lineageId: ArtifactLineageId) {
    this.selectedLineageId = lineageId;
    this.selectedRevision = undefined;
    this.comparison = undefined;
    this.error = undefined;
    this.detailLoading = true;
    try {
      const [detail, history] = await Promise.all([
        this.client.artifacts.detail(lineageId, { signal: this.signal }),
        this.client.artifacts.history({ lineageId, offset: 0, limit: 50 }, { signal: this.signal }),
      ]);
      if (this.selectedLineageId === lineageId) {
        this.props.model.applyDetail(detail);
        this.props.model.applyHistory(lineageId, history.items);
        this.selectedRevision = detail.lineage.latestRevision;
        await this.readExact(lineageId, detail.lineage.latestRevision);
      }
    } catch (error) {
      if (!this.signal.aborted && this.selectedLineageId === lineageId)
        this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (this.selectedLineageId === lineageId && !this.signal.aborted) this.detailLoading = false;
    }
  }

  async selectRevision(lineageId: ArtifactLineageId, revision: ArtifactRevisionNumber) {
    this.selectedRevision = revision;
    this.comparison = undefined;
    this.operationError = undefined;
    try {
      return await this.readExact(lineageId, revision);
    } catch (error) {
      if (!this.signal.aborted)
        this.operationError = error instanceof Error ? error.message : String(error);
      return undefined;
    }
  }

  async readExact(lineageId: ArtifactLineageId, revision: ArtifactRevisionNumber) {
    const value = await this.client.artifacts.readExact(lineageId, revision, {
      signal: this.signal,
    });
    if (!this.signal.aborted) this.props.model.upsertRevision(value);
    return value;
  }

  async loadHistory(lineageId: ArtifactLineageId, offset = 0, limit = 50) {
    const page = await this.client.artifacts.history(
      { lineageId, offset, limit },
      { signal: this.signal },
    );
    const detail = await this.client.artifacts.detail(lineageId, { signal: this.signal });
    if (!this.signal.aborted) {
      this.props.model.applyDetail(detail);
      this.props.model.applyHistory(lineageId, page.items);
    }
    return page;
  }

  resolveReference(reference: ArtifactStableRef) {
    return this.client.artifacts.referenceMetadata(reference, { signal: this.signal });
  }

  private setPreviewState(reference: ArtifactStableRef, state: ArtifactReferencePreviewState) {
    this.previewStates = {
      ...Object.fromEntries(Object.entries(this.previewStates).slice(-99)),
      [reference]: state,
    };
  }

  async previewReference(reference: ArtifactStableRef) {
    const current = this.previewStates[reference];
    if (current?.loading || current?.metadata) return current?.metadata;
    this.setPreviewState(reference, { loading: true });
    try {
      const metadata = await this.resolveReference(reference);
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

  async materialize(
    sessionId: string,
    lineageId: ArtifactLineageId,
    revision: ArtifactRevisionNumber,
  ): Promise<ArtifactProjectionMetadata | undefined> {
    this.operationError = undefined;
    try {
      return await this.client.artifacts.materialize(sessionId, lineageId, revision, {
        signal: this.signal,
      });
    } catch (error) {
      if (!this.signal.aborted)
        this.operationError = error instanceof Error ? error.message : String(error);
      return undefined;
    }
  }

  async compare(
    lineageId: ArtifactLineageId,
    from: ArtifactRevisionNumber,
    to: ArtifactRevisionNumber,
  ) {
    this.operationError = undefined;
    try {
      const value = await this.client.artifacts.compareText(lineageId, from, to, {
        signal: this.signal,
      });
      if (!this.signal.aborted) this.comparison = value;
      return value;
    } catch (error) {
      if (!this.signal.aborted)
        this.operationError = error instanceof Error ? error.message : String(error);
      return undefined;
    }
  }

  requestRestore(revision: ArtifactRevisionNumber) {
    this.pendingRestoreRevision = revision;
  }

  cancelRestore() {
    this.pendingRestoreRevision = undefined;
  }

  async restore(
    sessionId: string,
    lineageId: ArtifactLineageId,
    sourceRevision: ArtifactRevisionNumber,
    expectedLatestRevision: number,
  ) {
    this.operationError = undefined;
    try {
      const value = await this.client.artifacts.restore(
        { sessionId, lineageId, sourceRevision, expectedLatestRevision },
        { signal: this.signal },
      );
      if (!this.signal.aborted) {
        this.pendingRestoreRevision = undefined;
        this.props.model.upsertRevision(value);
        this.selectedRevision = value.metadata.revision;
        this.props.artifactsChanged(lineageId);
        await this.select(lineageId);
      }
      return value;
    } catch (error) {
      if (!this.signal.aborted)
        this.operationError = error instanceof Error ? error.message : String(error);
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

  async link(
    sessionId: string,
    lineageId: ArtifactLineageId,
    target: ArtifactLinkTarget,
    selection: ArtifactLink["selection"] = { mode: "follow-latest" },
  ) {
    this.operationError = undefined;
    let link: ArtifactLink;
    try {
      link = await this.client.artifacts.link(
        { sessionId, lineageId, target, selection },
        { signal: this.signal },
      );
    } catch (error) {
      if (!this.signal.aborted)
        this.operationError = error instanceof Error ? error.message : String(error);
      return undefined;
    }
    if (!this.signal.aborted) this.props.artifactsChanged(lineageId);
    try {
      const detail = await this.client.artifacts.detail(lineageId, { signal: this.signal });
      if (!this.signal.aborted) {
        this.props.model.applyDetail(detail);
        this.updatePreviewLinks(lineageId, detail.links);
      }
    } catch (error) {
      if (!this.signal.aborted)
        this.operationError = error instanceof Error ? error.message : String(error);
    }
    return link;
  }

  async setSelection(
    sessionId: string,
    lineageId: ArtifactLineageId,
    target: ArtifactLinkTarget,
    selection: ArtifactLink["selection"],
  ) {
    this.operationError = undefined;
    try {
      const link = await this.client.artifacts.setSelection(
        { sessionId, lineageId, target, selection },
        { signal: this.signal },
      );
      const detail = await this.client.artifacts.detail(lineageId, { signal: this.signal });
      if (!this.signal.aborted) {
        this.props.model.applyDetail(detail);
        this.updatePreviewLinks(lineageId, detail.links);
        this.props.artifactsChanged(lineageId);
      }
      return link;
    } catch (error) {
      if (!this.signal.aborted)
        this.operationError = error instanceof Error ? error.message : String(error);
      return undefined;
    }
  }

  async unlink(sessionId: string, lineageId: ArtifactLineageId, target: ArtifactLinkTarget) {
    this.operationError = undefined;
    try {
      await this.client.artifacts.unlink({ sessionId, lineageId, target }, { signal: this.signal });
      const detail = await this.client.artifacts.detail(lineageId, { signal: this.signal });
      if (!this.signal.aborted) {
        this.props.model.applyDetail(detail);
        this.updatePreviewLinks(lineageId, detail.links);
        this.props.artifactsChanged(lineageId);
      }
    } catch (error) {
      if (!this.signal.aborted)
        this.operationError = error instanceof Error ? error.message : String(error);
    }
  }
}
