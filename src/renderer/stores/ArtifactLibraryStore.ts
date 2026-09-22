import { Store, child, createStore, untracked } from "r-state-tree";
import type { ArtifactLineageId } from "../../domain/artifacts/artifact-lineage";
import type { ArtifactCatalog } from "../models/ArtifactCatalog";
import { ArtifactDetailStore } from "./ArtifactDetailStore";
import { ClientContext } from "./context/ClientContext";

export class ArtifactLibraryStore extends Store<{
  model: ArtifactCatalog;
  artifactsChanged(lineageId: string): void;
  clearReferenceOperationError(lineageId?: ArtifactLineageId): void;
}> {
  search = "";
  kind = "all";
  offset = 0;
  limit = 50;
  total = 0;
  loading = false;
  error: string | undefined;
  activeSessionId: string | undefined;
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

  @child
  get detailStore(): ArtifactDetailStore {
    return createStore(ArtifactDetailStore, {
      model: this.props.model,
      artifactsChanged: this.props.artifactsChanged,
      clearReferenceOperationError: this.props.clearReferenceOperationError,
    });
  }

  get lineages() {
    return this.visibleLineageIds
      .map((lineageId) => this.props.model.find(lineageId))
      .filter((lineage) => lineage !== undefined)
      .filter((lineage) => this.kind === "all" || lineage.latest?.kind === this.kind);
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
}
