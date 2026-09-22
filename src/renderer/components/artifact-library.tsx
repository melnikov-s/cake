import { observer } from "r-state-tree/react";
import { ActionCard } from "@/components/ui/action-card";
import { ArtifactIcon, SearchIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { LoadingState } from "@/components/ui/loading-state";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { decodeArtifactLineageId } from "../../domain/artifacts/artifact-lineage";
import type { ArtifactLibraryStore } from "../stores/ArtifactLibraryStore";
import type { ArtifactReferencePreviewStore } from "../stores/ArtifactReferencePreviewStore";
import type { SessionCatalogStore } from "../stores/SessionCatalogStore";
import type { InlineWidgetStore } from "../stores/InlineWidgetStore";
import { ArtifactLineageDetail } from "./artifact-lineage-detail";

const displayDate = (value: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));

export const ArtifactLibrary = observer(function ArtifactLibrary({
  store,
  referencePreviews,
  sessions,
  inlineWidgets,
}: {
  store: ArtifactLibraryStore;
  referencePreviews: ArtifactReferencePreviewStore;
  sessions: SessionCatalogStore;
  inlineWidgets: InlineWidgetStore;
}) {
  return (
    <div className="grid h-full min-h-0 grid-cols-[20rem_minmax(0,1fr)] max-[720px]:grid-cols-1">
      <aside className="min-h-0 overflow-auto border-r border-border/65 bg-sidebar/45 p-3 max-[720px]:max-h-72 max-[720px]:border-b max-[720px]:border-r-0">
        <div className="relative">
          <span className="pointer-events-none absolute left-2.5 top-2.5 text-muted-foreground">
            <SearchIcon />
          </span>
          <Input
            className="pl-8"
            aria-label="Search artifact library"
            placeholder="Search artifacts"
            value={store.search}
            onChange={(event) => store.setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void store.load();
            }}
          />
        </div>
        <Select
          className="mt-2"
          size="sm"
          aria-label="Filter artifacts by kind"
          value={store.kind}
          onChange={(event) => store.setKind(event.target.value)}
        >
          <option value="all">All kinds</option>
          <option value="markdown">Markdown</option>
          <option value="table">Table</option>
          <option value="diagram">Diagram</option>
          <option value="widget">Widget</option>
          <option value="html">HTML</option>
          <option value="file">File</option>
          <option value="media">Media</option>
          <option value="diff">Diff</option>
          <option value="form">Form</option>
        </Select>
        <p className="px-1 pb-2 pt-3 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {store.total} {store.total === 1 ? "lineage" : "lineages"}
        </p>
        {store.loading && store.lineages.length === 0 ? (
          <LoadingState label="Loading artifact library" />
        ) : store.error ? (
          <p className="rounded-lg border border-destructive/25 bg-destructive/8 p-3 text-xs text-destructive">
            {store.error}
          </p>
        ) : store.lineages.length === 0 ? (
          <div className="p-5 text-center text-xs text-muted-foreground">
            No artifacts match this view.
          </div>
        ) : (
          <nav className="grid gap-2" aria-label="Artifact lineages">
            {store.lineages.map((lineage) => (
              <ActionCard
                key={lineage.id}
                icon={<ArtifactIcon />}
                title={lineage.title ?? lineage.id}
                description={`Updated ${displayDate(lineage.latest?.publishedAt ?? lineage.createdAt)} · r${lineage.latestRevision}`}
                badge={<Badge>{lineage.latest?.kind}</Badge>}
                aria-current={
                  store.detailStore.selectedLineageId === lineage.id ? "page" : undefined
                }
                className={
                  store.detailStore.selectedLineageId === lineage.id
                    ? "border-primary/35 bg-accent/35"
                    : undefined
                }
                onClick={() => {
                  referencePreviews.clearOperationError();
                  void store.detailStore.select(decodeArtifactLineageId(lineage.id));
                }}
              />
            ))}
          </nav>
        )}
      </aside>
      <section className="min-h-0 overflow-hidden">
        <ArtifactLineageDetail
          store={store.detailStore}
          referencePreviews={referencePreviews}
          activeSessionId={store.activeSessionId}
          sessions={sessions}
          inlineWidgets={inlineWidgets}
        />
      </section>
    </div>
  );
});
