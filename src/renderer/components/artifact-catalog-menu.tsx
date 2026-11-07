import { useState } from "react";
import { observer } from "r-state-tree/react";
import { Button } from "@/components/ui/button";
import { AnnotationIcon, ArtifactIcon } from "@/components/ui/icons";
import { NavItem } from "@/components/ui/nav-item";
import {
  Popover,
  PopoverContent,
  PopoverIconTrigger,
  PopoverNumberedIconTrigger,
} from "@/components/ui/popover";
import { LoadingState } from "@/components/ui/loading-state";
import type { ArtifactLibraryStore } from "../stores/ArtifactLibraryStore";
import type { SessionArtifactsStore } from "../stores/SessionArtifactsStore";

/** Shared artifact access for Cake Chat and Project Sessions. */
export const ArtifactCatalogMenu = observer(function ArtifactCatalogMenu({
  store,
  sessionArtifacts,
  ownerLabel,
  railLabel,
  onOpen,
  onOpenArtifact,
  onOpenLibrary,
}: {
  store: ArtifactLibraryStore;
  sessionArtifacts?: SessionArtifactsStore;
  /** Explicit inherited library owner when a secondary conversation is focused. */
  ownerLabel?: string;
  railLabel?: string;
  onOpen?(): void;
  onOpenArtifact(lineageId: string): void;
  onOpenLibrary(): void;
}) {
  const [open, setOpen] = useState(false);
  const source = sessionArtifacts ?? store;
  const title = ownerLabel ? `Artifacts for ${ownerLabel}` : "Artifacts";
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
  const browse = () => {
    setOpen(false);
    onOpenLibrary();
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
        <PopoverNumberedIconTrigger
          count={items.length}
          tooltip={`${items.length} artifacts${ownerLabel ? ` for ${ownerLabel}` : ""}`}
          wrapTooltip={Boolean(ownerLabel)}
          data-cake-hint-key="a"
        >
          <ArtifactIcon />
        </PopoverNumberedIconTrigger>
      ) : (
        <PopoverIconTrigger tooltip="Artifacts" label={railLabel} data-cake-hint-key="a">
          <ArtifactIcon />
        </PopoverIconTrigger>
      )}
      <PopoverContent align="end" className="w-80 p-0" aria-label={title}>
        {ownerLabel && (
          <div className="break-words border-b border-border/65 px-3 py-2 text-xs font-medium">
            {title}
          </div>
        )}
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
                onClick={() => {
                  setOpen(false);
                  onOpenArtifact(item.id);
                }}
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
