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
import { BranchIcon, CheckIcon, ChevronDownIcon, FolderIcon, PullRequestIcon } from "./ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { cn } from "@/lib/utils";

export interface WorktreePillProps {
  creation: WorktreeCreationStore;
  actions: WorktreeStore;
  sessionId: string;
  projectPath: string;
  draft: boolean;
  onConfigured(): void;
}

type ConfirmationKind = "dirty-merge" | "dirty-target-preserve" | "dirty-target-squash" | "discard";

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
      <div className="mx-4 -mb-5 flex min-w-0 items-center gap-2 overflow-x-auto rounded-t-[1.75rem] border border-b-0 border-border/70 bg-card/70 px-5 pt-3.5 pb-8 text-sm">
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
  const dirty = status.dirtyCount > 0;
  const merging = actions.phase !== "idle" && actions.phase !== "discarding";
  const mergeLabel =
    actions.phase === "landing"
      ? "Merging…"
      : actions.phase === "proposing"
        ? "Preparing message…"
        : actions.phase === "resolving"
          ? "Resolving conflicts…"
          : "Merge";

  const squash = () => {
    if (dirty) {
      setConfirmation("dirty-merge");
      return;
    }
    if (status.targetDirty) {
      setConfirmation("dirty-target-squash");
      return;
    }
    run(actions.land({ strategy: "squash" }));
  };
  const targetDirtyStrategy =
    confirmation === "dirty-target-squash"
      ? "squash"
      : confirmation === "dirty-target-preserve"
        ? "preserve"
        : undefined;

  return (
    <>
      <div className="mx-4 -mb-5 flex flex-col gap-1 rounded-t-[1.75rem] border border-b-0 border-border/70 bg-card/70 px-5 pt-3.5 pb-8">
        <div className="flex min-w-0 items-center gap-2 overflow-x-auto text-sm">
          <span className="flex h-8 min-w-0 shrink items-center gap-2 px-2.5 text-foreground">
            <PullRequestIcon />
            <span className="truncate">{branch}</span>
            <span aria-hidden="true">→</span>
            <span className="truncate">{target}</span>
          </span>
          {status.aheadCount > 0 && (
            <Popover
              open={confirmation === "dirty-merge"}
              onOpenChange={(open) => {
                if (!open && confirmation === "dirty-merge") setConfirmation(undefined);
              }}
            >
              <PopoverTrigger
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                className="h-8 shrink-0 rounded-lg px-2.5 text-sm font-normal text-foreground shadow-none"
                onClick={(event) => {
                  event.preventDefault();
                  if (dirty) {
                    setConfirmation("dirty-merge");
                    return;
                  }
                  if (status.targetDirty) {
                    setConfirmation("dirty-target-preserve");
                    return;
                  }
                  run(actions.land());
                }}
              >
                {mergeLabel}
              </PopoverTrigger>
              <PopoverContent align="start" side="top" className="!w-80 !p-0">
                <Confirmation state="requested" className="border-0 shadow-none">
                  <ConfirmationRequest>
                    <ConfirmationTitle>Commit changes before merging</ConfirmationTitle>
                    <ConfirmationDescription>
                      This worktree has uncommitted changes. Ask the agent to commit them, then
                      merge into {target}.
                    </ConfirmationDescription>
                    <ConfirmationActions>
                      <ConfirmationAction onClick={() => setConfirmation(undefined)}>
                        Got it
                      </ConfirmationAction>
                    </ConfirmationActions>
                  </ConfirmationRequest>
                </Confirmation>
              </PopoverContent>
            </Popover>
          )}
          {status.aheadCount > 1 && !merging && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              className="h-8 shrink-0 rounded-lg px-2.5 text-sm font-normal text-foreground shadow-none"
              onClick={squash}
            >
              Squash…
            </Button>
          )}
          {actions.stalled && (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 shrink-0 rounded-lg px-2.5 text-sm font-normal text-foreground shadow-none"
                onClick={() => run(actions.retryLanding())}
              >
                Retry
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 shrink-0 rounded-lg px-2.5 text-sm font-normal text-foreground shadow-none"
                onClick={() => actions.cancelLanding()}
              >
                Dismiss
              </Button>
            </>
          )}
          <Popover
            open={confirmation === "discard"}
            onOpenChange={(open) => setConfirmation(open ? "discard" : undefined)}
          >
            <PopoverTrigger
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              className="h-8 shrink-0 rounded-lg px-2.5 text-sm font-normal text-destructive shadow-none hover:bg-destructive/10 hover:text-destructive"
            >
              {actions.phase === "discarding" ? "Discarding…" : "Discard & resolve"}
            </PopoverTrigger>
            <PopoverContent align="start" side="top" className="!w-80 !p-0">
              <Confirmation state="requested" className="border-0 shadow-none">
                <ConfirmationRequest>
                  <ConfirmationTitle>Discard this worktree?</ConfirmationTitle>
                  <ConfirmationDescription>
                    The worktree and its branch will be deleted, all unmerged work will be lost, and
                    its sessions will be resolved.
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
      {targetDirtyStrategy && (
        <div className="dialog-backdrop">
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
                    run(actions.land({ strategy: targetDirtyStrategy, allowDirtyTarget: true }))
                  }
                >
                  Continue
                </ConfirmationAction>
              </ConfirmationActions>
            </ConfirmationRequest>
          </Confirmation>
        </div>
      )}
    </>
  );
});
