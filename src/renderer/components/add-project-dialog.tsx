import { observer } from "r-state-tree/react";
import type { ProjectSetupStore } from "../stores/ProjectSetupStore";
import {
  DialogBackdrop,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { ProjectIdentityFields } from "./project-identity-fields";
import { ProjectMergeWorkflowField } from "./project-merge-workflow-field";

export const AddProjectDialog = observer(function AddProjectDialog({
  store,
}: {
  store: ProjectSetupStore;
}) {
  if (!store.path) return null;
  return (
    <DialogBackdrop
      onClose={() => store.close()}
      aria-labelledby="add-project-title"
      aria-describedby="add-project-description"
    >
      <DialogContent className="flex max-h-[86vh] max-w-[35rem] flex-col overflow-hidden p-0 phone:p-0">
        <form
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
          onSubmit={(event) => {
            event.preventDefault();
            void store.save();
          }}
        >
          <DialogHeader className="shrink-0 border-b border-border/65 bg-sidebar/30 px-5 py-3.5">
            <DialogTitle id="add-project-title">Add project</DialogTitle>
            <DialogDescription id="add-project-description">
              Make this project yours. Everything is ready to add.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 space-y-5 overflow-y-auto px-5 py-4">
            <section className="grid gap-1.5">
              <h3 className="px-0.5 text-xs font-semibold">General</h3>
              <ProjectIdentityFields
                store={store.identity}
                path={store.path}
                disabled={store.saving}
              />
            </section>
            <ProjectMergeWorkflowField
              value={store.worktreeLanding}
              onChange={(value) => store.setWorktreeLanding(value)}
              disabled={store.saving}
            />
            {store.error && (
              <p role="alert" className="text-xs text-destructive">
                {store.error}
              </p>
            )}
          </div>
          <DialogFooter className="mt-0 shrink-0 border-t border-border/65 bg-sidebar/30 px-5 py-3">
            <Button variant="ghost" onClick={() => store.close()} disabled={store.saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={!store.canSave}>
              {store.saving ? "Adding…" : "Add project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </DialogBackdrop>
  );
});
