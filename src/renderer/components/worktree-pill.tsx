import { useState } from "react";
import { observer } from "r-state-tree/react";
import type { WorktreeCreationStore } from "../stores/WorktreeCreationStore";
import type { WorktreeStore } from "../stores/WorktreeStore";
import { Button } from "./ui/button";
import { BranchIcon, CheckIcon, ChevronDownIcon } from "./ui/icons";
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

/** Draft location selector that becomes the locked session's contextual Git action pill. */
export const WorktreePill = observer(function WorktreePill({
  creation,
  actions,
  sessionId,
  projectPath,
  draft,
  onConfigured,
}: WorktreePillProps) {
  const [open, setOpen] = useState(false);
  const [discardRequest, setDiscardRequest] = useState<
    { keepBranch: boolean; resolve: boolean } | undefined
  >();
  const choice = creation.choice(sessionId);
  const candidates = creation.candidates(projectPath);
  const status = actions.status;
  const busy = actions.isBusy;

  if (!draft && !status && actions.workspaceDirtyCount === 0) return null;

  const selectedRecord =
    choice.kind === "reuse"
      ? candidates.find((record) => record.worktreePath === choice.worktreePath)
      : choice.kind === "new" && choice.baseWorktreePath
        ? candidates.find((record) => record.worktreePath === choice.baseWorktreePath)
        : undefined;
  const draftLabel =
    choice.kind === "current"
      ? "Current checkout"
      : choice.kind === "reuse"
        ? `Reuse ${selectedRecord?.branch.replace(/^agent\//, "") ?? "worktree"}`
        : choice.baseWorktreePath
          ? `New from ${selectedRecord?.branch.replace(/^agent\//, "") ?? "worktree"}`
          : "New worktree from main";
  const actionLabel =
    actions.phase === "committing"
      ? "Committing…"
      : actions.phase === "landing"
        ? "Merging…"
        : actions.phase === "resolving"
          ? "Resolving conflicts…"
          : actions.phase === "discarding"
            ? "Deleting worktree…"
            : actions.workspaceDirtyCount > 0
              ? "Commit"
              : status && status.aheadCount > 0
                ? `Merge into ${status.targetBranch.replace(/^agent\//, "")}`
                : "Empty worktree";

  const choose = (next: Parameters<WorktreeCreationStore["select"]>[1]) => {
    creation.select(sessionId, next);
    setOpen(false);
    queueMicrotask(onConfigured);
  };
  const run = (operation: Promise<unknown>) => {
    setOpen(false);
    setDiscardRequest(undefined);
    void operation.catch(() => undefined);
  };

  return (
    <div className="flex px-3 pt-2">
      <Popover
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) setDiscardRequest(undefined);
        }}
      >
        <PopoverTrigger
          variant="ghost"
          size="sm"
          disabled={busy || creation.preparingSessionId === sessionId}
          className={cn(
            "h-7 gap-1.5 rounded-full border border-border/70 bg-muted/40 px-2.5 text-xs font-medium text-muted-foreground shadow-none hover:bg-muted hover:text-foreground",
            actions.phase === "resolving" &&
              "border-amber-500/40 text-amber-600 dark:text-amber-400",
          )}
          aria-label={draft ? "Choose worktree" : "Git actions"}
        >
          <BranchIcon />
          <span>{draft ? draftLabel : actionLabel}</span>
          {!busy && <ChevronDownIcon size={12} />}
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="top"
          className="w-80 rounded-xl border bg-background p-2 shadow-lg"
        >
          {draft ? (
            <div className="flex flex-col gap-1">
              <p className="px-2 py-1 text-xs font-semibold text-muted-foreground">Work in</p>
              <Button
                variant="ghost"
                className="h-auto justify-start gap-3 px-2 py-2 text-left"
                onClick={() => choose({ kind: "current" })}
              >
                <span className="w-4">{choice.kind === "current" && <CheckIcon />}</span>
                <span className="flex flex-col items-start">
                  <span>Current checkout</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    Work directly in main
                  </span>
                </span>
              </Button>
              <Button
                variant="ghost"
                className="h-auto justify-start gap-3 px-2 py-2 text-left"
                onClick={() => choose({ kind: "new" })}
              >
                <span className="w-4">
                  {choice.kind === "new" && !choice.baseWorktreePath && <CheckIcon />}
                </span>
                <span className="flex flex-col items-start">
                  <span>New worktree from main</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    Create an isolated checkout on first send
                  </span>
                </span>
              </Button>
              {candidates.length > 0 && (
                <>
                  <p className="mt-1 border-t px-2 pt-2 text-xs font-semibold text-muted-foreground">
                    Existing worktrees
                  </p>
                  {candidates.map((record) => {
                    const name = record.branch.replace(/^agent\//, "");
                    return (
                      <div
                        key={record.worktreePath}
                        className="rounded-lg border border-transparent hover:border-border"
                      >
                        <Button
                          variant="ghost"
                          className="h-auto w-full justify-start gap-3 px-2 py-2 text-left"
                          onClick={() =>
                            choose({ kind: "reuse", worktreePath: record.worktreePath })
                          }
                        >
                          <span className="w-4">
                            {choice.kind === "reuse" &&
                              choice.worktreePath === record.worktreePath && <CheckIcon />}
                          </span>
                          <span className="min-w-0 flex-1 truncate">Reuse {name}</span>
                        </Button>
                        <Button
                          variant="ghost"
                          className="h-auto w-full justify-start gap-3 px-2 py-1.5 text-left text-xs text-muted-foreground"
                          onClick={() =>
                            choose({ kind: "new", baseWorktreePath: record.worktreePath })
                          }
                        >
                          <span className="w-4">
                            {choice.kind === "new" &&
                              choice.baseWorktreePath === record.worktreePath && <CheckIcon />}
                          </span>
                          <span>New isolated worktree from {name}</span>
                        </Button>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          ) : discardRequest ? (
            <div className="flex flex-col gap-3 p-1">
              <div>
                <p className="text-sm font-semibold">Discard this worktree?</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  The checkout will be deleted. Uncommitted changes will be lost.
                </p>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setDiscardRequest(undefined)}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() =>
                    run(actions.discard(discardRequest.keepBranch, discardRequest.resolve))
                  }
                >
                  Discard
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {actions.workspaceDirtyCount > 0 ? (
                <>
                  <Button
                    variant="ghost"
                    className="justify-start"
                    onClick={() => run(actions.commit())}
                  >
                    Commit
                  </Button>
                  <Button
                    variant="ghost"
                    className="justify-start"
                    onClick={() => run(actions.commit({ resolve: true }))}
                  >
                    Commit &amp; resolve session
                  </Button>
                  {status && (
                    <Button
                      variant="ghost"
                      className="justify-start"
                      onClick={() => run(actions.commit({ land: true }))}
                    >
                      Commit &amp; merge into {status.targetBranch.replace(/^agent\//, "")}
                    </Button>
                  )}
                </>
              ) : status && status.aheadCount > 0 ? (
                <Button
                  variant="ghost"
                  className="justify-start"
                  disabled={!actions.canLand}
                  onClick={() => run(actions.land())}
                >
                  Merge locally into {status.targetBranch.replace(/^agent\//, "")}
                </Button>
              ) : status ? (
                <Button
                  variant="destructive"
                  className="justify-start"
                  onClick={() => setDiscardRequest({ keepBranch: false, resolve: true })}
                >
                  Delete empty worktree &amp; resolve
                </Button>
              ) : null}
              {status && (status.dirtyCount > 0 || status.aheadCount > 0) && (
                <Button
                  variant="ghost"
                  className="justify-start text-destructive hover:text-destructive"
                  onClick={() =>
                    setDiscardRequest({
                      keepBranch: status.aheadCount > 0 && !status.merged,
                      resolve: false,
                    })
                  }
                >
                  Discard worktree…
                </Button>
              )}
              {actions.error && (
                <p className="px-2 py-1 text-xs text-destructive">{actions.error}</p>
              )}
              {status && (status.targetDirty || !status.targetOnBranch) && (
                <p className="px-2 py-1 text-xs text-amber-600 dark:text-amber-400">
                  {status.targetDirty
                    ? "Commit or stash changes in the landing target first."
                    : `Switch the landing target to ${status.targetBranch} first.`}
                </p>
              )}
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
});
