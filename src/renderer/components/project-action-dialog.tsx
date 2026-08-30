import { Button } from "./ui/button";
import {
  DialogBackdrop,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { LoadingState } from "./ui/loading-state";

export type ProjectAction = "remove-project" | "delete-resolved-worktrees";

export function ProjectActionDialog({
  action,
  projectName,
  sessionCount,
  resolvedWorktreeCount,
  busy,
  onCancel,
  onRemove,
  onDeleteResolvedWorktrees,
}: {
  action: ProjectAction;
  projectName: string;
  sessionCount: number;
  resolvedWorktreeCount: number;
  busy: boolean;
  onCancel(): void;
  onRemove(deleteSessions: boolean): void;
  onDeleteResolvedWorktrees(): void;
}) {
  const removing = action === "remove-project";
  const titleId = "project-action-title";
  const descriptionId = "project-action-description";
  const progressLabel = removing ? "Removing project" : "Deleting worktrees";

  return (
    <DialogBackdrop
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onClose={() => {
        if (!busy) onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle id={titleId}>
            {removing ? `Remove ${projectName}?` : "Delete resolved worktrees?"}
          </DialogTitle>
          <DialogDescription id={descriptionId}>
            {removing
              ? `Removing this project hides it and its ${sessionCount} session${sessionCount === 1 ? "" : "s"} from Cake. Adding the folder again restores them. You can instead permanently delete every session now.`
              : `${resolvedWorktreeCount} landed worktree${resolvedWorktreeCount === 1 ? "" : "s"} with only resolved sessions will be deleted. Their sessions will remain in project history.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-wrap">
          {busy && <LoadingState label={progressLabel} variant="Dots" />}
          <Button variant="outline" size="sm" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          {removing ? (
            <>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => onRemove(false)}>
                Remove only
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={() => onRemove(true)}
              >
                Remove and delete sessions
              </Button>
            </>
          ) : (
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={onDeleteResolvedWorktrees}
            >
              Delete worktrees
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </DialogBackdrop>
  );
}
