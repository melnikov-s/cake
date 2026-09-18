import { computed, Store, untracked } from "r-state-tree";
import type { ArtifactRecord } from "../../ipc/artifact-contract";
import {
  decodeArtifactLineageId,
  decodeArtifactRevisionNumber,
  type ArtifactLineageId,
  type ArtifactLink,
  type ArtifactRevisionNumber,
} from "../../domain/artifacts/artifact-lineage";
import type { ArtifactCatalog } from "../models/ArtifactCatalog";
import { ClientContext } from "./context/ClientContext";

/**
 * Owns one session panel's window-local workflow. Mount performs an authoritative
 * current query. Ordered native artifact invalidations and successful mutations
 * trigger another current query; a monotonically increasing request token makes
 * the newest started refresh the only result allowed to commit. Reconnect/remount
 * therefore starts from storage again rather than replaying a renderer event log.
 */
export class SessionArtifactsStore extends Store<{
  sessionId: string;
  model: ArtifactCatalog;
  isActive(): boolean;
  enabled?(): boolean;
}> {
  open = false;
  selectedArtifactId: string | undefined;
  viewedRevision: ArtifactRevisionNumber | undefined;
  width = 416;
  loading = false;
  operationLoading = false;
  historyLoading = false;
  historyOffset = 0;
  historyLimit = 50;
  historyTotal = 0;
  historyHasMore = false;
  error: string | undefined;
  historyError: string | undefined;
  private request = 0;
  private selectionRequest = 0;
  private historyRequest = 0;
  private revisionRequest = 0;

  constructor(props: SessionArtifactsStore["props"]) {
    super(props);
    this.effect(() => {
      if (this.props.enabled?.() === false) return;
      untracked(() => {
        void this.refresh();
      });
    });
  }

  get client() {
    return ClientContext.consume(this)!;
  }

  @computed
  get associations() {
    return this.props.model.associationsFor(this.props.sessionId);
  }

  @computed
  get records(): ArtifactRecord[] {
    return this.associations
      .map((association) => association.lineage?.revision(association.selectedRevision)?.record)
      .filter(
        (record): record is ArtifactRecord =>
          record !== undefined && record.artifact.kind !== "request",
      )
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  @computed
  get selectedAssociation() {
    return this.associations.find(
      (association) => association.lineage?.id === this.selectedArtifactId,
    );
  }
  @computed
  get selectedRecord() {
    const association = this.selectedAssociation;
    if (!association?.lineage) return undefined;
    return association.lineage.revision(this.viewedRevision ?? association.selectedRevision)
      ?.record;
  }
  @computed
  get selectedStableRef() {
    return this.selectedAssociation?.stableRef;
  }
  @computed
  get selectedExactRef() {
    const association = this.selectedAssociation;
    const revision = this.viewedRevision ?? association?.selectedRevision;
    return association && revision ? `${association.stableRef}@r${revision}` : undefined;
  }
  @computed get selectedIndex() {
    return this.records.findIndex((record) => record.artifact.id === this.selectedArtifactId);
  }
  @computed get hasPrevious() {
    return this.selectedIndex > 0;
  }
  @computed get hasNext() {
    return this.selectedIndex >= 0 && this.selectedIndex < this.records.length - 1;
  }

  async refresh(openNew = false) {
    const request = ++this.request;
    const previous = new Set(this.associations.map((association) => association.lineage?.id));
    this.loading = true;
    this.error = undefined;
    try {
      const values = await this.client.artifacts.effective(this.props.sessionId, {
        signal: this.signal,
      });
      if (request !== this.request || this.signal.aborted) return;
      this.props.model.applyEffective(this.props.sessionId, values);
      if (openNew && this.props.isActive()) {
        const added = values.find((value) => !previous.has(value.revision.lineageId));
        if (added) {
          this.selectedArtifactId = added.revision.lineageId;
          this.open = true;
        }
      }
    } catch (error) {
      if (request !== this.request || this.signal.aborted) return;
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (request === this.request && !this.signal.aborted) this.loading = false;
    }
  }

  toggle() {
    if (this.open) this.close();
    else {
      this.selectedArtifactId = undefined;
      this.open = true;
    }
  }
  close() {
    this.open = false;
  }
  showList() {
    this.selectionRequest += 1;
    this.historyRequest += 1;
    this.revisionRequest += 1;
    this.selectedArtifactId = undefined;
    this.viewedRevision = undefined;
    this.operationLoading = false;
    this.historyLoading = false;
    this.historyError = undefined;
  }
  openArtifact(artifactId: string) {
    const association = this.associations.find((value) => value.lineage?.id === artifactId);
    if (!association) return;
    const selectionRequest = ++this.selectionRequest;
    this.historyRequest += 1;
    this.revisionRequest += 1;
    this.selectedArtifactId = artifactId;
    this.viewedRevision = decodeArtifactRevisionNumber(association.selectedRevision);
    this.operationLoading = false;
    this.historyOffset = 0;
    this.historyTotal = 0;
    this.historyHasMore = false;
    this.historyError = undefined;
    this.open = true;
    void this.loadHistoryPage(decodeArtifactLineageId(artifactId), 0, selectionRequest);
  }
  async loadOlderHistory() {
    const lineageId = this.selectedArtifactId;
    if (!lineageId || this.historyLoading || (!this.historyHasMore && !this.historyError))
      return undefined;
    return this.loadHistoryPage(
      decodeArtifactLineageId(lineageId),
      this.historyOffset,
      this.selectionRequest,
    );
  }
  private isCurrentSelection(request: number, lineageId: ArtifactLineageId) {
    return (
      !this.signal.aborted &&
      request === this.selectionRequest &&
      this.selectedArtifactId === lineageId
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
  async viewRevision(lineageId: ArtifactLineageId, revision: ArtifactRevisionNumber) {
    if (this.selectedArtifactId !== lineageId) return undefined;
    const selectionRequest = this.selectionRequest;
    const request = ++this.revisionRequest;
    this.operationLoading = true;
    this.error = undefined;
    try {
      const value = await this.client.artifacts.readExact(lineageId, revision, {
        signal: this.signal,
      });
      if (!this.isCurrentSelection(selectionRequest, lineageId) || request !== this.revisionRequest)
        return undefined;
      this.props.model.upsertRevision(value);
      this.viewedRevision = revision;
      return value;
    } catch (error) {
      if (this.isCurrentSelection(selectionRequest, lineageId) && request === this.revisionRequest)
        this.error = error instanceof Error ? error.message : String(error);
      return undefined;
    } finally {
      if (this.isCurrentSelection(selectionRequest, lineageId) && request === this.revisionRequest)
        this.operationLoading = false;
    }
  }
  async readablePath(lineageId: ArtifactLineageId, revision: ArtifactRevisionNumber) {
    this.operationLoading = true;
    this.error = undefined;
    try {
      const value = await this.client.artifacts.materialize(
        this.props.sessionId,
        lineageId,
        revision,
        { signal: this.signal },
      );
      return value.exactPath;
    } catch (error) {
      if (!this.signal.aborted) this.error = error instanceof Error ? error.message : String(error);
      return undefined;
    } finally {
      if (!this.signal.aborted) this.operationLoading = false;
    }
  }
  showPrevious() {
    const artifactId = this.records[this.selectedIndex - 1]?.artifact.id;
    if (this.hasPrevious && artifactId) this.openArtifact(artifactId);
  }
  showNext() {
    const artifactId = this.records[this.selectedIndex + 1]?.artifact.id;
    if (this.hasNext && artifactId) this.openArtifact(artifactId);
  }
  setWidth(width: number) {
    this.width = Math.max(320, width);
  }

  receive(lineageId: string) {
    const known = this.associations.some((association) => association.lineage?.id === lineageId);
    void this.refresh(!known);
  }

  async setSelection(lineageId: ArtifactLineageId, selection: ArtifactLink["selection"]) {
    const current = this.associations.find((value) => value.lineage?.id === lineageId);
    if (!current?.link) return;
    this.operationLoading = true;
    this.error = undefined;
    try {
      await this.client.artifacts.setSelection(
        { sessionId: this.props.sessionId, lineageId, target: current.link.target, selection },
        { signal: this.signal },
      );
      await this.refresh();
      const updated = this.associations.find((value) => value.lineage?.id === lineageId);
      this.viewedRevision = updated
        ? decodeArtifactRevisionNumber(updated.selectedRevision)
        : undefined;
    } catch (error) {
      if (!this.signal.aborted) this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (!this.signal.aborted) this.operationLoading = false;
    }
  }
  follow(lineageId: ArtifactLineageId) {
    return this.setSelection(lineageId, { mode: "follow-latest" });
  }
  pin(lineageId: ArtifactLineageId, revision: ArtifactRevisionNumber) {
    return this.setSelection(lineageId, { mode: "pinned", revision });
  }
  async unlink(lineageId: ArtifactLineageId) {
    const current = this.associations.find((value) => value.lineage?.id === lineageId);
    if (!current?.link) return;
    this.operationLoading = true;
    this.error = undefined;
    try {
      await this.client.artifacts.unlink(
        { sessionId: this.props.sessionId, lineageId, target: current.link.target },
        { signal: this.signal },
      );
      await this.refresh();
      if (this.selectedArtifactId === lineageId) this.showList();
    } catch (error) {
      if (!this.signal.aborted) this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (!this.signal.aborted) this.operationLoading = false;
    }
  }
}
