import { useState } from "react";
import { observer } from "r-state-tree/react";
import { Button } from "@/components/ui/button";
import { AnnotationIcon, ArtifactIcon } from "@/components/ui/icons";
import { NavItem } from "@/components/ui/nav-item";
import { Popover, PopoverContent, PopoverNumberedIconTrigger } from "@/components/ui/popover";
import { LoadingState } from "@/components/ui/loading-state";
import type { ArtifactLibraryStore } from "../stores/ArtifactLibraryStore";
import type { SessionArtifactsStore } from "../stores/SessionArtifactsStore";

/** Session artifact access for Cake Chat and Project Sessions. */
export const ArtifactCatalogMenu = observer(function ArtifactCatalogMenu({
  store,
  sessionArtifacts,
  ownerLabel,
  onOpen,
  onOpenArtifact,
  onOpenLibrary,
}: {
  store: ArtifactLibraryStore;
  sessionArtifacts: SessionArtifactsStore;
  /** Explicit inherited library owner when a secondary conversation is focused. */
  ownerLabel?: string;
  onOpen?(): void;
  onOpenArtifact(lineageId: string): void;
  onOpenLibrary(): void;
}) {
  const [open, setOpen] = useState(false);
  const title = ownerLabel ? `Artifacts for ${ownerLabel}` : "Artifacts";
  const items = sessionArtifacts.records.map(({ artifact }) => ({
    id: artifact.id,
    title: artifact.title,
    kind: artifact.kind,
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
          void sessionArtifacts.refresh();
        }
      }}
    >
      <PopoverNumberedIconTrigger
        count={items.length}
        tooltip={`${items.length} artifacts${ownerLabel ? ` for ${ownerLabel}` : ""}`}
        wrapTooltip={Boolean(ownerLabel)}
        data-cake-hint-key="a"
      >
        <ArtifactIcon size={24} />
      </PopoverNumberedIconTrigger>
      <PopoverContent align="end" className="w-80 p-0" aria-label={title}>
        {ownerLabel && (
          <div className="break-words border-b border-border/65 px-3 py-2 text-xs font-medium">
            {title}
          </div>
        )}
        <nav className="max-h-80 overflow-auto p-2" aria-label="Artifact list">
          {sessionArtifacts.loading ? (
            <LoadingState label="Loading artifacts" />
          ) : sessionArtifacts.error ? (
            <p className="p-4 text-xs text-destructive">{sessionArtifacts.error}</p>
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
