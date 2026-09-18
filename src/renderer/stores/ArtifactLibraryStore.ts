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
  historyLoading = false;
  historyOffset = 0;
  historyLimit = 50;
  historyTotal = 0;
  historyHasMore = false;
  error: string | undefined;
  historyError: string | undefined;
  operationError: string | undefined;
  activeSessionId: string | undefined;
  selectedLineageId: ArtifactLineageId | undefined;
  selectedRevision: ArtifactRevisionNumber | undefined;
  pendingRestoreRevision: ArtifactRevisionNumber | undefined;
  comparison: ArtifactTextComparison | undefined;
  previewStates: Record<string, ArtifactReferencePreviewState> = {};
  private visibleLineageIds: ReadonlyArray<string> = [];
  private request = 0;
  private selectionRequest = 0;
  private historyRequest = 0;
  private revisionRequest = 0;
  private compareRequest = 0;
  private restoreRequest = 0;
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
    const selectionRequest = ++this.selectionRequest;
    this.historyRequest += 1;
    this.revisionRequest += 1;
    this.compareRequest += 1;
    this.restoreRequest += 1;
    this.selectedLineageId = lineageId;
    this.selectedRevision = undefined;
    this.pendingRestoreRevision = undefined;
    this.comparison = undefined;
    this.error = undefined;
    this.operationError = undefined;
    this.historyOffset = 0;
    this.historyTotal = 0;
    this.historyHasMore = false;
    this.historyError = undefined;
    this.detailLoading = true;

    const history = this.loadHistoryPage(lineageId, 0, selectionRequest);
    const detail = (async () => {
      let revisionRequest: number | undefined;
      try {
        const value = await this.client.artifacts.detail(lineageId, { signal: this.signal });
        if (!this.isCurrentSelection(selectionRequest, lineageId)) return;
        this.props.model.applyDetail(value);
        this.selectedRevision = value.lineage.latestRevision;
        revisionRequest = ++this.revisionRequest;
        const revision = await this.client.artifacts.readExact(
          lineageId,
          value.lineage.latestRevision,
          { signal: this.signal },
        );
        if (
          this.isCurrentSelection(selectionRequest, lineageId) &&
          revisionRequest === this.revisionRequest &&
          this.selectedRevision === value.lineage.latestRevision
        )
          this.props.model.upsertRevision(revision);
      } catch (error) {
        if (
          this.isCurrentSelection(selectionRequest, lineageId) &&
          (revisionRequest === undefined || revisionRequest === this.revisionRequest)
        )
          this.error = error instanceof Error ? error.message : String(error);
      } finally {
        if (this.isCurrentSelection(selectionRequest, lineageId)) this.detailLoading = false;
      }
    })();
    await Promise.all([detail, history]);
  }

  async selectRevision(lineageId: ArtifactLineageId, revision: ArtifactRevisionNumber) {
    if (this.selectedLineageId !== lineageId) return undefined;
    const selectionRequest = this.selectionRequest;
    const revisionRequest = ++this.revisionRequest;
    this.compareRequest += 1;
    this.restoreRequest += 1;
    this.selectedRevision = revision;
    this.pendingRestoreRevision = undefined;
    this.comparison = undefined;
    this.operationError = undefined;
    try {
      const value = await this.client.artifacts.readExact(lineageId, revision, {
        signal: this.signal,
      });
      if (
        !this.isCurrentSelection(selectionRequest, lineageId) ||
        revisionRequest !== this.revisionRequest ||
        this.selectedRevision !== revision
      )
        return undefined;
      this.props.model.upsertRevision(value);
      return value;
    } catch (error) {
      if (
        this.isCurrentSelection(selectionRequest, lineageId) &&
        revisionRequest === this.revisionRequest
      )
        this.operationError = error instanceof Error ? error.message : String(error);
      return undefined;
    }
  }

  async loadOlderHistory() {
    const lineageId = this.selectedLineageId;
    if (!lineageId || this.historyLoading || (!this.historyHasMore && !this.historyError))
      return undefined;
    return this.loadHistoryPage(lineageId, this.historyOffset, this.selectionRequest);
  }

  private isCurrentSelection(request: number, lineageId: ArtifactLineageId) {
    return (
      !this.signal.aborted &&
      request === this.selectionRequest &&
      this.selectedLineageId === lineageId
    );
  }

  private async loadHistoryPage(
    lineageId: ArtifactLineageId,
    offset: number,
    selectionRequest: number,
  ) {
    const request = ++this.historyRequest;
    this.historyLoading = true;
    this.historyError = undefined;
    try {
      const page = await this.client.artifacts.history(
        { lineageId, offset, limit: this.historyLimit },
        { signal: this.signal },
      );
      if (!this.isCurrentSelection(selectionRequest, lineageId) || request !== this.historyRequest)
        return undefined;
      this.props.model.applyHistory(lineageId, page.items);
      this.historyOffset = page.offset + page.items.length;
      this.historyTotal = page.total;
      this.historyHasMore = page.hasMore;
      return page;
    } catch (error) {
      if (this.isCurrentSelection(selectionRequest, lineageId) && request === this.historyRequest)
        this.historyError = error instanceof Error ? error.message : String(error);
      return undefined;
    } finally {
      if (this.isCurrentSelection(selectionRequest, lineageId) && request === this.historyRequest)
        this.historyLoading = false;
    }
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
    if (this.selectedLineageId !== lineageId || this.selectedRevision !== from) return undefined;
    const selectionRequest = this.selectionRequest;
    const request = ++this.compareRequest;
    this.comparison = undefined;
    this.operationError = undefined;
    try {
      const value = await this.client.artifacts.compareText(lineageId, from, to, {
        signal: this.signal,
      });
      if (
        !this.isCurrentSelection(selectionRequest, lineageId) ||
        request !== this.compareRequest ||
        this.selectedRevision !== from
      )
        return undefined;
      this.comparison = value;
      return value;
    } catch (error) {
      if (
        this.isCurrentSelection(selectionRequest, lineageId) &&
        request === this.compareRequest &&
        this.selectedRevision === from
      )
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
    if (this.selectedLineageId !== lineageId) return undefined;
    const selectionRequest = this.selectionRequest;
    const request = ++this.restoreRequest;
    this.operationError = undefined;
    try {
      const value = await this.client.artifacts.restore(
        { sessionId, lineageId, sourceRevision, expectedLatestRevision },
        { signal: this.signal },
      );
      if (this.signal.aborted) return undefined;
      this.props.model.upsertRevision(value);
      this.props.artifactsChanged(lineageId);
      if (this.isCurrentSelection(selectionRequest, lineageId) && request === this.restoreRequest) {
        this.pendingRestoreRevision = undefined;
        this.selectedRevision = value.metadata.revision;
        await this.select(lineageId);
      }
      return value;
    } catch (error) {
      if (this.isCurrentSelection(selectionRequest, lineageId) && request === this.restoreRequest)
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
