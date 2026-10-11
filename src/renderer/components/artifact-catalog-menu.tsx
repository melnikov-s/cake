import { useState } from "react";
import { observer } from "r-state-tree/react";
import { Button } from "@/components/ui/button";
import { ArtifactIcon } from "@/components/ui/icons";
import { NavItem } from "@/components/ui/nav-item";
import { Popover, PopoverContent, PopoverIconTrigger } from "@/components/ui/popover";
import { LoadingState } from "@/components/ui/loading-state";
import type { ArtifactLibraryStore } from "../stores/ArtifactLibraryStore";

/** Artifact access when no Project Session panel is available. */
export const ArtifactCatalogMenu = observer(function ArtifactCatalogMenu({
  store,
  onOpenLibrary,
}: {
  store: ArtifactLibraryStore;
  onOpenLibrary(lineageId?: string): void;
}) {
  const [open, setOpen] = useState(false);
  const browse = (lineageId?: string) => {
    setOpen(false);
    onOpenLibrary(lineageId);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (value) void store.load();
      }}
    >
      <PopoverIconTrigger tooltip="Artifacts" data-cake-hint-key="a">
        <ArtifactIcon />
      </PopoverIconTrigger>
      <PopoverContent align="end" className="w-80 p-0" aria-label="Artifacts">
        <nav className="max-h-80 overflow-auto p-2" aria-label="Artifact list">
          {store.loading ? (
            <LoadingState label="Loading artifacts" />
          ) : store.error ? (
            <p className="p-4 text-xs text-destructive">{store.error}</p>
          ) : store.lineages.length === 0 ? (
            <p className="p-4 text-center text-xs text-muted-foreground">No artifacts yet.</p>
          ) : (
            store.lineages.map((lineage) => (
              <NavItem
                key={lineage.id}
                icon={<ArtifactIcon />}
                label={lineage.title ?? lineage.id}
                description={lineage.latest?.kind}
                onClick={() => browse(lineage.id)}
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
