import { observer } from "r-state-tree/react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  DialogBackdrop,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ArtifactDetailStore } from "../stores/ArtifactDetailStore";

export const ArtifactManagement = observer(function ArtifactManagement({
  store,
}: {
  store: ArtifactDetailStore;
}) {
  const lineage = store.selectedLineage;
  if (!lineage) return null;
  return (
    <section className="grid gap-3 border-b border-border/65 pb-4" aria-label="Artifact management">
      <label className="flex items-center justify-between gap-2 text-xs font-medium">
        Global
        <Switch
          aria-label="Keep artifact globally"
          checked={lineage.global}
          disabled={store.metadataPending}
          onCheckedChange={(global) => void store.setGlobal(global)}
        />
      </label>
      <Button
        size="sm"
        variant="ghost"
        className="text-destructive"
        disabled={store.deletePending}
        onClick={() => store.requestDelete()}
      >
        Delete artifact
      </Button>
      {store.confirmingDelete && (
        <DialogBackdrop onClose={() => store.cancelDelete()}>
          <DialogContent role="alertdialog" aria-labelledby="delete-artifact-title">
            <DialogHeader>
              <DialogTitle id="delete-artifact-title">
                Delete {lineage.title ?? lineage.id}?
              </DialogTitle>
              <DialogDescription>
                This deletes the artifact, its revision history and saved state, and stops its
                runtime.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                disabled={store.deletePending}
                onClick={() => store.cancelDelete()}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={store.deletePending}
                onClick={() => void store.deleteArtifact()}
              >
                Delete artifact
              </Button>
            </DialogFooter>
          </DialogContent>
        </DialogBackdrop>
      )}
    </section>
  );
});
