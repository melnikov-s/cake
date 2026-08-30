import { useState } from "react";
import { observer } from "r-state-tree/react";
import type { WorktreeCreationStore } from "../stores/WorktreeCreationStore";
import type { WorktreeStore } from "../stores/WorktreeStore";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationDescription,
  ConfirmationRequest,
  ConfirmationTitle,
} from "./ai-elements/confirmation";
import { Button } from "./ui/button";
import { DialogBackdrop } from "./ui/dialog";
import { BranchIcon, CheckIcon, ChevronDownIcon, FolderIcon, PullRequestIcon } from "./ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { WorktreePillAction } from "./worktree-pill-action";
import { WorktreeStatusIcon } from "./worktree-status-icon";
import { cn } from "@/lib/utils";

export interface WorktreePillProps {
  creation: WorktreeCreationStore;
  actions: WorktreeStore;
  sessionId: string;
  projectPath: string;
  draft: boolean;
  onConfigured(): void;
}

type ConfirmationKind = "dirty-target" | "dirty-target-resolve" | "discard-resolve";

/** Horizontal checkout choices for drafts and deterministic worktree actions for running sessions. */
export const WorktreePill = observer(function WorktreePill({
  creation,
  actions,
  sessionId,
  projectPath,
  draft,
  onConfigured,
}: WorktreePillProps) {
  const [existingOpen, setExistingOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<ConfirmationKind>();
  const choice = creation.choice(sessionId);
  const candidates = creation.candidates(projectPath);
  const status = actions.status;
  const busy = actions.isBusy || creation.preparingSessionId === sessionId;

  const choose = (next: Parameters<WorktreeCreationStore["select"]>[1]) => {
    creation.select(sessionId, next);
    setExistingOpen(false);
    queueMicrotask(onConfigured);
  };
  const run = (operation: Promise<unknown>) => {
    setConfirmation(undefined);
    void operation.catch(() => undefined);
  };

  if (draft) {
    const selectedExisting =
      choice.kind === "reuse"
        ? candidates.find((record) => record.worktreePath === choice.worktreePath)
        : undefined;
    return (
      <div className="mx-4 -mb-5 flex min-w-0 items-center gap-2 overflow-x-auto rounded-t-[1.75rem] border border-b-0 border-border/85 bg-card px-5 pt-3.5 pb-8 text-sm">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          aria-pressed={choice.kind === "current"}
          className={cn(
            "h-8 shrink-0 gap-2 rounded-lg px-2.5 text-sm font-normal text-foreground shadow-none",
            choice.kind === "current" && "bg-muted text-foreground",
          )}
          onClick={() => choose({ kind: "current" })}
        >
          <FolderIcon />
          Current checkout
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          aria-pressed={choice.kind === "new"}
          className={cn(
            "h-8 shrink-0 gap-2 rounded-lg px-2.5 text-sm font-normal text-foreground shadow-none",
            choice.kind === "new" && "bg-muted text-foreground",
          )}
          onClick={() => choose({ kind: "new" })}
        >
          <BranchIcon />
          New worktree
        </Button>
        <Popover open={existingOpen} onOpenChange={setExistingOpen}>
          <PopoverTrigger
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy || candidates.length === 0}
            aria-label="Choose existing worktree"
            aria-haspopup="menu"
            className={cn(
              "h-8 shrink-0 gap-2 rounded-lg px-2.5 text-sm font-normal text-foreground shadow-none",
              choice.kind === "reuse" && "bg-muted text-foreground",
            )}
          >
            <PullRequestIcon />
            <span className="max-w-56 truncate">
              {selectedExisting
                ? `${selectedExisting.sessionTitle} · ${selectedExisting.branch.replace(/^agent\//, "")}`
                : "Existing worktree"}
            </span>
            <ChevronDownIcon size={12} />
          </PopoverTrigger>
          <PopoverContent
            align="start"
            side="top"
            role="menu"
            aria-label="Existing worktrees"
            className="!max-h-72 !w-72 !rounded-lg !border-border !bg-popover !p-1 !shadow-xl"
          >
            {candidates.map((record) => {
              const selected =
                choice.kind === "reuse" && choice.worktreePath === record.worktreePath;
              return (
                <Button
                  key={record.worktreePath}
                  type="button"
                  variant="ghost"
                  role="menuitemradio"
                  aria-checked={selected}
                  className="h-8 w-full justify-start gap-2 rounded-md px-2 text-xs font-normal"
                  onClick={() => choose({ kind: "reuse", worktreePath: record.worktreePath })}
                >
                  <span className="flex w-4 justify-center">{selected && <CheckIcon />}</span>
                  <PullRequestIcon />
                  <span className="flex min-w-0 flex-1 flex-col text-left">
                    <span className="truncate">{record.sessionTitle}</span>
                    <span className="truncate text-[10px] text-muted-foreground">
                      {record.branch.replace(/^agent\//, "")} →{" "}
                      {record.baseBranch.replace(/^agent\//, "")}
                    </span>
                  </span>
                </Button>
              );
            })}
          </PopoverContent>
        </Popover>
      </div>
    );
  }

  if (!status) return null;

  const target = status.targetBranch.replace(/^agent\//, "");
  const branch = status.record.branch.replace(/^agent\//, "");
  const landed = status.record.state === "landed";
  const hasUncommittedChanges = status.dirtyCount > 0;
  const hasCommits = status.aheadCount > 0;
  const hasWorkToMerge = hasUncommittedChanges || hasCommits;
  const sessionDisabledReason = actions.isSessionRunning
    ? "Wait for the session to finish before using worktree actions."
    : undefined;
  const operationDisabledReason =
    sessionDisabledReason ?? (busy ? "A worktree operation is already in progress." : undefined);
  const mergeDisabledReason =
    operationDisabledReason ??
    (!hasWorkToMerge ? "There are no changes or commits to merge." : undefined);
  const mergeLabel =
    actions.phase === "committing"
      ? "Committing…"
      : actions.phase === "landing"
        ? "Merging…"
        : actions.phase === "resolving"
          ? "Resolving conflicts…"
          : hasUncommittedChanges
            ? "Commit & merge"
            : "Merge";
  const mergeAndResolveLabel = hasUncommittedChanges
    ? "Commit & merge & resolve"
    : "Merge & resolve";

  return (
    <>
      <div className="mx-4 -mb-5 flex flex-col gap-1 rounded-t-[1.75rem] border border-b-0 border-border/85 bg-card px-5 pt-3.5 pb-8">
        <div className="flex min-w-0 items-center gap-2 overflow-x-auto text-sm">
          <span className="flex h-8 min-w-0 shrink items-center gap-2 px-2.5 text-foreground">
            <WorktreeStatusIcon state={status.record.state} className="shrink-0" />
            <span className="truncate">{branch}</span>
            <span aria-hidden="true">→</span>
            <span className="truncate">{target}</span>
          </span>
          {!landed && (
            <>
              <WorktreePillAction
                disabledReason={mergeDisabledReason}
                onClick={() => {
                  if (status.targetDirty) {
                    setConfirmation("dirty-target");
                    return;
                  }
                  run(actions.commitAndMerge());
                }}
              >
                {mergeLabel}
              </WorktreePillAction>
              <WorktreePillAction
                disabledReason={mergeDisabledReason}
                onClick={() => {
                  if (status.targetDirty) {
                    setConfirmation("dirty-target-resolve");
                    return;
                  }
                  run(actions.commitAndMerge(false, true));
                }}
              >
                {mergeAndResolveLabel}
              </WorktreePillAction>
            </>
          )}
          {landed && (
            <WorktreePillAction
              disabledReason={operationDisabledReason}
              onClick={() => run(actions.resolve())}
            >
              {actions.phase === "resolving-session" ? "Resolving…" : "Resolve"}
            </WorktreePillAction>
          )}
          {actions.stalled && (
            <>
              <WorktreePillAction
                disabledReason={sessionDisabledReason}
                onClick={() => run(actions.retryLanding())}
              >
                Retry
              </WorktreePillAction>
              <WorktreePillAction
                disabledReason={sessionDisabledReason}
                onClick={() => actions.cancelLanding()}
              >
                Dismiss
              </WorktreePillAction>
            </>
          )}
          {!landed && (
            <Popover
              open={confirmation === "discard-resolve"}
              onOpenChange={(open) => setConfirmation(open ? "discard-resolve" : undefined)}
            >
              <WorktreePillAction
                popoverTrigger
                tone="destructive"
                disabledReason={operationDisabledReason}
              >
                {actions.phase === "discarding" ? "Discarding…" : "Discard & resolve"}
              </WorktreePillAction>
              <PopoverContent align="start" side="top" className="!w-80 !p-0">
                <Confirmation state="requested" className="border-0 shadow-none">
                  <ConfirmationRequest>
                    <ConfirmationTitle>Discard this worktree?</ConfirmationTitle>
                    <ConfirmationDescription>
                      The worktree and its branch will be deleted, all unmerged work will be lost,
                      and its sessions will be resolved.
                    </ConfirmationDescription>
                    <ConfirmationActions>
                      <ConfirmationAction
                        variant="outline"
                        onClick={() => setConfirmation(undefined)}
                      >
                        Cancel
                      </ConfirmationAction>
                      <ConfirmationAction
                        variant="destructive"
                        onClick={() => run(actions.discard(false, true))}
                      >
                        Discard & resolve
                      </ConfirmationAction>
                    </ConfirmationActions>
                  </ConfirmationRequest>
                </Confirmation>
              </PopoverContent>
            </Popover>
          )}
        </div>
        {actions.error && <p className="px-2 text-xs text-destructive">{actions.error}</p>}
        {(status.targetDirty || !status.targetOnBranch) && (
          <p className="px-2 text-xs text-amber-600 dark:text-amber-400">
            {status.targetDirty
              ? "The merge target has uncommitted changes."
              : `Switch the merge target to ${status.targetBranch} first.`}
          </p>
        )}
      </div>
      {(confirmation === "dirty-target" || confirmation === "dirty-target-resolve") && (
        <DialogBackdrop>
          <Confirmation
            state="requested"
            role="alertdialog"
            aria-labelledby="dirty-target-title"
            aria-describedby="dirty-target-description"
          >
            <ConfirmationRequest>
              <ConfirmationTitle id="dirty-target-title">
                Merge with uncommitted target changes?
              </ConfirmationTitle>
              <ConfirmationDescription id="dirty-target-description">
                The merge target has uncommitted or untracked changes. Git will preserve them when
                possible, but may refuse the merge if they overlap this worktree.
              </ConfirmationDescription>
              <ConfirmationActions>
                <ConfirmationAction variant="outline" onClick={() => setConfirmation(undefined)}>
                  Cancel
                </ConfirmationAction>
                <ConfirmationAction
                  onClick={() =>
                    run(actions.commitAndMerge(true, confirmation === "dirty-target-resolve"))
                  }
                >
                  Continue
                </ConfirmationAction>
              </ConfirmationActions>
            </ConfirmationRequest>
          </Confirmation>
        </DialogBackdrop>
      )}
    </>
  );
});
