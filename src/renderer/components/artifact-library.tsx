import type { ReactNode } from "react";
import type { SourceLocation } from "../../contracts/editor/source-location";
import { observer } from "r-state-tree/react";
import { AnnotationIcon, ArtifactIcon, SearchIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { LoadingState } from "@/components/ui/loading-state";
import { NavItem } from "@/components/ui/nav-item";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { decodeArtifactLineageId } from "../../contracts/artifacts/artifact-lineage";
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
  onOpenSourceLocation,
  wrapArtifact,
}: {
  store: ArtifactLibraryStore;
  referencePreviews: ArtifactReferencePreviewStore;
  sessions: SessionCatalogStore;
  inlineWidgets: InlineWidgetStore;
  onOpenSourceLocation?(location: SourceLocation): void;
  wrapArtifact?(artifactId: string, children: ReactNode): ReactNode;
}) {
  return (
    <div className="grid h-full min-h-0 grid-cols-[17.5rem_minmax(0,1fr)] max-[720px]:grid-cols-1">
      <aside className="flex min-h-0 flex-col border-r border-border/65 bg-sidebar max-[720px]:max-h-72 max-[720px]:border-b max-[720px]:border-r-0">
        <div className="grid shrink-0 gap-2 border-b border-border/55 p-2.5">
          <div className="relative">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground">
              <SearchIcon size={13} />
            </span>
            <Input
              className="h-7 pl-8 text-xs"
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
            size="sm"
            aria-label="Artifact scope"
            value={store.globalOnly ? "global" : "all"}
            onChange={(event) => store.setGlobalOnly(event.target.value === "global")}
          >
            <option value="all">All artifacts</option>
            <option value="global">Global artifacts</option>
          </Select>
          <div className="flex items-center justify-between gap-2">
            <Select
              className="flex-1"
              size="sm"
              aria-label="Filter artifacts by kind"
              value={store.kind}
              onChange={(event) => store.setKind(event.target.value)}
            >
              <option value="all">All kinds</option>
              <option value="message-board">Workboard</option>
              <option value="markdown">Markdown</option>
              <option value="table">Table</option>
              <option value="diagram">Diagram</option>
              <option value="widget">Widget</option>
              <option value="html">HTML</option>
              <option value="file">File</option>
              <option value="media">Media</option>
              <option value="diff">Diff</option>
            </Select>
            <span className="shrink-0 px-1 font-mono text-xs tabular-nums text-muted-foreground">
              {store.total} {store.total === 1 ? "lineage" : "lineages"}
            </span>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {store.loading && store.lineages.length === 0 ? (
            <LoadingState label="Loading artifact library" />
          ) : store.error ? (
            <p className="rounded-lg border border-destructive/25 bg-destructive/8 p-3 text-xs text-destructive">
              {store.error}
            </p>
          ) : store.lineages.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              No artifacts match this view.
            </div>
          ) : (
            <nav className="grid gap-0.5" aria-label="Artifact lineages">
              {store.lineages.map((lineage) => (
                <NavItem
                  key={lineage.id}
                  icon={
                    lineage.latest?.kind === "message-board" ? (
                      <AnnotationIcon size={14} />
                    ) : (
                      <ArtifactIcon />
                    )
                  }
                  label={lineage.title ?? lineage.id}
                  description={
                    lineage.latest?.kind === "message-board"
                      ? (store.boardPreviews[lineage.id] ?? "Shared family coordination")
                      : (lineage.description ??
                        `Updated ${displayDate(lineage.latest?.publishedAt ?? lineage.createdAt)} · r${lineage.latestRevision}`)
                  }
                  badge={
                    <span className="flex items-center gap-1">
                      {lineage.global && <Badge variant="secondary">Global</Badge>}
                      <Badge variant="secondary">
                        {lineage.latest?.kind === "message-board"
                          ? "Workboard"
                          : lineage.latest?.kind}
                      </Badge>
                    </span>
                  }
                  active={store.detailStore.selectedLineageId === lineage.id}
                  aria-current={
                    store.detailStore.selectedLineageId === lineage.id ? "page" : undefined
                  }
                  onClick={() => void store.detailStore.select(decodeArtifactLineageId(lineage.id))}
                />
              ))}
            </nav>
          )}
        </div>
      </aside>
      <section className="min-h-0 overflow-hidden bg-background">
        <ArtifactLineageDetail
          store={store.detailStore}
          referencePreviews={referencePreviews}
          activeSessionId={store.activeSessionId}
          sessions={sessions}
          inlineWidgets={inlineWidgets}
          onOpenSourceLocation={onOpenSourceLocation}
          wrapArtifact={wrapArtifact}
        />
      </section>
    </div>
  );
});
