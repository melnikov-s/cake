import { useState } from "react";
import { observer } from "r-state-tree/react";
import type { WorktreeStore } from "../stores/WorktreeStore";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { cn } from "@/lib/utils";
import { BranchIcon } from "./ui/icons";

export interface WorktreeChipProps {
  store: WorktreeStore;
  /** The project (or plain workspace) path a new worktree would be created from. */
  currentProjectPath: string | undefined;
  /** Creates a new managed worktree session for the given repository. */
  onCreateWorktree(projectPath: string): void;
  /** Navigates back to the project after an explicit discard. */
  onFinished(projectPath: string): void;
  notify(input: { tone: "info" | "warning" | "error"; title: string; message: string }): void;
}

/** Header control for the active session's managed Git worktree. */
export const WorktreeChip = observer(function WorktreeChip({
  store,
  currentProjectPath,
  onCreateWorktree,
  onFinished,
  notify,
}: WorktreeChipProps) {
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [open, setOpen] = useState(false);
  const status = store.status;

  if (!status)
    return (
      <button
        className="header-pane-toggle"
        type="button"
        aria-label="Create a worktree session"
        disabled={!currentProjectPath}
        onClick={() => {
          if (currentProjectPath) onCreateWorktree(currentProjectPath);
        }}
      >
        <BranchIcon />
        <span>Worktree</span>
      </button>
    );

  const record = status.record;
  const unmerged = status.aheadCount > 0 && !status.merged;
  const stateLabel =
    store.phase === "resolving"
      ? "Resolving conflicts…"
      : store.phase === "landing"
        ? "Merging…"
        : store.phase === "discarding"
          ? "Cleaning up…"
          : status.dirtyCount > 0
            ? `${status.dirtyCount} uncommitted`
            : unmerged
              ? `${status.aheadCount} unmerged`
              : status.merged
                ? "Merged"
                : "Clean";

  const handleLand = () => {
    void store.land().catch(() => undefined);
    // A successful landing (direct or after automatic conflict resolution)
    // navigates through the store's onLanded callback.
  };

  const handleDiscard = (keepBranch: boolean) => {
    void store
      .discard(keepBranch)
      .then(() => {
        notify({
          tone: "info",
          title: "Worktree discarded",
          message: keepBranch ? `Branch ${record.branch} was kept.` : "The worktree was deleted.",
        });
        setOpen(false);
        setConfirmingDiscard(false);
        onFinished(record.projectPath);
      })
      .catch(() => undefined);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        variant="ghost"
        size="sm"
        className="header-pane-toggle gap-1.5"
        aria-label="Worktree status"
      >
        <BranchIcon />
        <span>{record.branch.replace(/^agent\//, "")}</span>
        <span
          className={cn(
            "rounded px-1 py-px text-[10px] font-medium",
            store.phase !== "idle" || status.dirtyCount > 0
              ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
              : status.merged
                ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                : "bg-muted text-muted-foreground",
          )}
        >
          {stateLabel}
        </span>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 rounded-lg border bg-background p-3 shadow-md">
        {confirmingDiscard ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm font-semibold">Discard this worktree?</p>
            <p className="text-sm text-muted-foreground">
              {status.dirtyCount > 0
                ? `${status.dirtyCount} uncommitted file${status.dirtyCount === 1 ? "" : "s"} will be lost`
                : unmerged
                  ? `${status.aheadCount} commit${status.aheadCount === 1 ? "" : "s"} will be removed from the worktree`
                  : "The worktree directory will be deleted"}
              . The conversation transcript is kept.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setConfirmingDiscard(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={store.isBusy}
                onClick={() => handleDiscard(unmerged)}
              >
                Discard
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="text-sm font-semibold">{record.branch}</div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <dt>Base</dt>
              <dd className="text-right">{record.baseBranch}</dd>
              <dt>Commits</dt>
              <dd className="text-right">
                {unmerged ? `${status.aheadCount} not yet merged` : "All merged"}
              </dd>
              <dt>Working tree</dt>
              <dd className="text-right">
                {status.merging
                  ? "Merge in progress"
                  : status.dirtyCount > 0
                    ? `${status.dirtyCount} uncommitted`
                    : "Clean"}
              </dd>
            </dl>
            {store.error && <p className="text-xs text-destructive">{store.error}</p>}
            {store.phase === "resolving" && (
              <p className="text-xs text-muted-foreground">
                The agent is resolving merge conflicts. Landing continues automatically once the
                merge is committed.
              </p>
            )}
            {status.canonicalDirty && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                The project checkout has uncommitted changes; commit or stash them before landing.
              </p>
            )}
            {!status.canonicalOnBaseBranch && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Switch the project checkout back to “{status.mainBranch}” to land.
              </p>
            )}
            <div className="flex justify-between gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                disabled={store.isBusy}
                onClick={() => setConfirmingDiscard(true)}
              >
                Discard…
              </Button>
              <Button size="sm" disabled={!store.canLand} onClick={handleLand}>
                Merge to {status.mainBranch}
              </Button>
            </div>
            <button
              className="header-pane-toggle justify-start"
              type="button"
              aria-label="Create another worktree session"
              onClick={() => {
                setOpen(false);
                onCreateWorktree(record.projectPath);
              }}
            >
              <BranchIcon />
              <span>New worktree session</span>
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
});
