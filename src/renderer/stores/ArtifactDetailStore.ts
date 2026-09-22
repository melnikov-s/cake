import { Store } from "r-state-tree";
import type {
  ArtifactLineageId,
  ArtifactRevisionNumber,
  ArtifactTextComparison,
} from "../../domain/artifacts/artifact-lineage";
import type { ArtifactCatalog } from "../models/ArtifactCatalog";
import { ClientContext } from "./context/ClientContext";

export class ArtifactDetailStore extends Store<{
  model: ArtifactCatalog;
  artifactsChanged(lineageId: string): void;
}> {
  detailLoading = false;
  historyLoading = false;
  historyOffset = 0;
  historyLimit = 50;
  historyTotal = 0;
  historyHasMore = false;
  error: string | undefined;
  historyError: string | undefined;
  operationError: string | undefined;
  selectedLineageId: ArtifactLineageId | undefined;
  selectedRevision: ArtifactRevisionNumber | undefined;
  pendingRestoreRevision: ArtifactRevisionNumber | undefined;
  comparison: ArtifactTextComparison | undefined;
  private selectionRequest = 0;
  private historyRequest = 0;
  private revisionRequest = 0;
  private compareRequest = 0;
  private restoreRequest = 0;

  get client() {
    return ClientContext.consume(this)!;
  }

  get selectedLineage() {
    return this.selectedLineageId ? this.props.model.find(this.selectedLineageId) : undefined;
  }

  get selectedLinks() {
    return this.selectedLineageId
      ? this.props.model.links.filter((link) => link.lineageId === this.selectedLineageId)
      : [];
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
}
