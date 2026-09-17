import { Store, untracked } from "r-state-tree";
import type {
  ArtifactLineageId,
  ArtifactLink,
  ArtifactLinkTarget,
  ArtifactRevisionNumber,
  ArtifactStableRef,
  ArtifactTextComparison,
} from "../../domain/artifacts/artifact-lineage";
import type { ArtifactCatalog } from "../models/ArtifactCatalog";
import { ClientContext } from "./context/ClientContext";

export class ArtifactLibraryStore extends Store<{
  model: ArtifactCatalog;
  artifactsChanged(lineageId: string): void;
}> {
  search = "";
  offset = 0;
  limit = 50;
  total = 0;
  loading = false;
  error: string | undefined;
  selectedLineageId: ArtifactLineageId | undefined;
  comparison: ArtifactTextComparison | undefined;
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
      .filter((lineage) => lineage !== undefined);
  }
  get selectedLineage() {
    return this.selectedLineageId ? this.props.model.find(this.selectedLineageId) : undefined;
  }

  setSearch(search: string) {
    this.search = search;
    this.offset = 0;
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
    this.error = undefined;
    try {
      const detail = await this.client.artifacts.detail(lineageId, { signal: this.signal });
      if (this.selectedLineageId === lineageId) this.props.model.applyDetail(detail);
    } catch (error) {
      if (!this.signal.aborted) this.error = error instanceof Error ? error.message : String(error);
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

  async compare(
    lineageId: ArtifactLineageId,
    from: ArtifactRevisionNumber,
    to: ArtifactRevisionNumber,
  ) {
    const value = await this.client.artifacts.compareText(lineageId, from, to, {
      signal: this.signal,
    });
    if (!this.signal.aborted) this.comparison = value;
    return value;
  }

  async restore(
    sessionId: string,
    lineageId: ArtifactLineageId,
    sourceRevision: ArtifactRevisionNumber,
    expectedLatestRevision: number,
  ) {
    const value = await this.client.artifacts.restore(
      { sessionId, lineageId, sourceRevision, expectedLatestRevision },
      { signal: this.signal },
    );
    if (!this.signal.aborted) {
      this.props.model.upsertRevision(value);
      this.props.artifactsChanged(lineageId);
    }
    return value;
  }

  async link(
    sessionId: string,
    lineageId: ArtifactLineageId,
    target: ArtifactLinkTarget,
    selection: ArtifactLink["selection"] = { mode: "follow-latest" },
  ) {
    const link = await this.client.artifacts.link(
      { sessionId, lineageId, target, selection },
      { signal: this.signal },
    );
    const detail = await this.client.artifacts.detail(lineageId, { signal: this.signal });
    if (!this.signal.aborted) {
      this.props.model.applyDetail(detail);
      this.props.artifactsChanged(lineageId);
    }
    return link;
  }

  async setSelection(
    sessionId: string,
    lineageId: ArtifactLineageId,
    target: ArtifactLinkTarget,
    selection: ArtifactLink["selection"],
  ) {
    const link = await this.client.artifacts.setSelection(
      { sessionId, lineageId, target, selection },
      { signal: this.signal },
    );
    const detail = await this.client.artifacts.detail(lineageId, { signal: this.signal });
    if (!this.signal.aborted) {
      this.props.model.applyDetail(detail);
      this.props.artifactsChanged(lineageId);
    }
    return link;
  }

  async unlink(sessionId: string, lineageId: ArtifactLineageId, target: ArtifactLinkTarget) {
    await this.client.artifacts.unlink({ sessionId, lineageId, target }, { signal: this.signal });
    const detail = await this.client.artifacts.detail(lineageId, { signal: this.signal });
    if (!this.signal.aborted) {
      this.props.model.applyDetail(detail);
      this.props.artifactsChanged(lineageId);
    }
  }
}
