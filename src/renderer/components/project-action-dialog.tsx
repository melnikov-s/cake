import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationDescription,
  ConfirmationRequest,
  ConfirmationTitle,
} from "./ai-elements/confirmation";
import { DialogBackdrop } from "./ui/dialog";

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
  return (
    <DialogBackdrop
      onClose={() => {
        if (!busy) onCancel();
      }}
    >
      <Confirmation
        state="requested"
        role="alertdialog"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="w-full max-w-lg"
      >
        <ConfirmationRequest>
          <ConfirmationTitle id={titleId}>
            {removing ? `Remove ${projectName}?` : "Delete resolved worktrees?"}
          </ConfirmationTitle>
          <ConfirmationDescription id={descriptionId}>
            {removing
              ? `Removing this project hides it and its ${sessionCount} session${sessionCount === 1 ? "" : "s"} from Cake. Adding the folder again restores them. You can instead permanently delete every session now.`
              : `${resolvedWorktreeCount} landed worktree${resolvedWorktreeCount === 1 ? "" : "s"} with only resolved sessions will be deleted. Their sessions will remain in project history.`}
          </ConfirmationDescription>
          <ConfirmationActions className="flex-wrap">
            <ConfirmationAction variant="outline" disabled={busy} onClick={onCancel}>
              Cancel
            </ConfirmationAction>
            {removing ? (
              <>
                <ConfirmationAction
                  variant="outline"
                  disabled={busy}
                  onClick={() => onRemove(false)}
                >
                  Remove only
                </ConfirmationAction>
                <ConfirmationAction
                  variant="destructive"
                  disabled={busy}
                  onClick={() => onRemove(true)}
                >
                  Remove and delete sessions
                </ConfirmationAction>
              </>
            ) : (
              <ConfirmationAction
                variant="destructive"
                disabled={busy}
                onClick={onDeleteResolvedWorktrees}
              >
                Delete worktrees
              </ConfirmationAction>
            )}
          </ConfirmationActions>
        </ConfirmationRequest>
      </Confirmation>
    </DialogBackdrop>
  );
}
