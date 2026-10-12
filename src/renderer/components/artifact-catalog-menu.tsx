import { useState } from "react";
import { observer } from "r-state-tree/react";
import { Button } from "@/components/ui/button";
import { AnnotationIcon, ArtifactIcon } from "@/components/ui/icons";
import { NavItem } from "@/components/ui/nav-item";
import {
  Popover,
  PopoverContent,
  PopoverIconTrigger,
  PopoverTrigger,
} from "@/components/ui/popover";
import { LoadingState } from "@/components/ui/loading-state";
import type { ArtifactLibraryStore } from "../stores/ArtifactLibraryStore";
import type { SessionArtifactsStore } from "../stores/SessionArtifactsStore";

/** Shared artifact access for Cake Chat and Project Sessions. */
export const ArtifactCatalogMenu = observer(function ArtifactCatalogMenu({
  store,
  sessionArtifacts,
  onOpen,
  onOpenLibrary,
}: {
  store: ArtifactLibraryStore;
  sessionArtifacts?: SessionArtifactsStore;
  onOpen?(): void;
  onOpenLibrary(lineageId?: string): void;
}) {
  const [open, setOpen] = useState(false);
  const source = sessionArtifacts ?? store;
  const items = sessionArtifacts
    ? sessionArtifacts.records.map(({ artifact }) => ({
        id: artifact.id,
        title: artifact.title,
        kind: artifact.kind,
      }))
    : store.lineages.map((lineage) => ({
        id: lineage.id,
        title: lineage.title,
        kind: lineage.latest?.kind,
      }));
  const browse = (lineageId?: string) => {
    setOpen(false);
    onOpenLibrary(lineageId);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (value) {
          onOpen?.();
          if (sessionArtifacts) void sessionArtifacts.refresh();
          else void store.load();
        }
      }}
    >
      {sessionArtifacts ? (
        <PopoverTrigger
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 px-2 text-muted-foreground"
          data-cake-hint-key="a"
          aria-label={`${items.length} artifacts`}
        >
          <ArtifactIcon />
          <span className="font-mono text-[11px] tabular-nums">{items.length}</span>
        </PopoverTrigger>
      ) : (
        <PopoverIconTrigger tooltip="Artifacts" data-cake-hint-key="a">
          <ArtifactIcon />
        </PopoverIconTrigger>
      )}
      <PopoverContent align="end" className="w-80 p-0" aria-label="Artifacts">
        <nav className="max-h-80 overflow-auto p-2" aria-label="Artifact list">
          {source.loading ? (
            <LoadingState label="Loading artifacts" />
          ) : source.error ? (
            <p className="p-4 text-xs text-destructive">{source.error}</p>
          ) : items.length === 0 ? (
            <p className="p-4 text-center text-xs text-muted-foreground">No artifacts yet.</p>
          ) : (
            items.map((item) => (
              <NavItem
                key={item.id}
                icon={item.kind === "message-board" ? <AnnotationIcon /> : <ArtifactIcon />}
                label={item.title ?? item.id}
                description={
                  item.kind === "message-board"
                    ? (store.boardPreviews[item.id] ?? "Workboard")
                    : item.kind
                }
                onClick={() => browse(item.id)}
              />
            ))
          )}
        </nav>
        <div className="border-t border-border/65 p-3">
          <Button variant="outline" className="w-full" onClick={() => browse()}>
            Browse all artifacts
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
});
