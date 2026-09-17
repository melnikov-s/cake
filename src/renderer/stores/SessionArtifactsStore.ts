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
  error: string | undefined;
  private request = 0;

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
    this.selectedArtifactId = undefined;
    this.viewedRevision = undefined;
  }
  openArtifact(artifactId: string) {
    const association = this.associations.find((value) => value.lineage?.id === artifactId);
    if (!association) return;
    this.selectedArtifactId = artifactId;
    this.viewedRevision = decodeArtifactRevisionNumber(association.selectedRevision);
    this.open = true;
    void this.loadHistory(decodeArtifactLineageId(artifactId));
  }
  async loadHistory(lineageId: ArtifactLineageId) {
    try {
      const page = await this.client.artifacts.history(
        { lineageId, offset: 0, limit: 50 },
        { signal: this.signal },
      );
      if (!this.signal.aborted) this.props.model.applyHistory(lineageId, page.items);
      return page;
    } catch (error) {
      if (!this.signal.aborted) this.error = error instanceof Error ? error.message : String(error);
      return undefined;
    }
  }
  async viewRevision(lineageId: ArtifactLineageId, revision: ArtifactRevisionNumber) {
    this.operationLoading = true;
    this.error = undefined;
    try {
      const value = await this.client.artifacts.readExact(lineageId, revision, {
        signal: this.signal,
      });
      if (!this.signal.aborted) {
        this.props.model.upsertRevision(value);
        this.viewedRevision = revision;
      }
      return value;
    } catch (error) {
      if (!this.signal.aborted) this.error = error instanceof Error ? error.message : String(error);
      return undefined;
    } finally {
      if (!this.signal.aborted) this.operationLoading = false;
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
    if (this.hasPrevious)
      this.selectedArtifactId = this.records[this.selectedIndex - 1]?.artifact.id;
  }
  showNext() {
    if (this.hasNext) this.selectedArtifactId = this.records[this.selectedIndex + 1]?.artifact.id;
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
