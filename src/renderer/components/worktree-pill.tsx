import { useState } from "react";
import { observer } from "r-state-tree/react";
import type { WorktreeCreationStore } from "../stores/WorktreeCreationStore";
import type { WorktreeStore } from "../stores/WorktreeStore";
import type { WorktreeRecord } from "../../ipc/worktree-contract";
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
import { IconButton } from "./ui/icon-button";
import {
  BranchIcon,
  CautionIcon,
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  FolderIcon,
  MergeIcon,
  MergeResolveIcon,
  PullRequestIcon,
  RebaseIcon,
  ResolveIcon,
  RestoreIcon,
  TrashIcon,
} from "./ui/icons";
import { LoadingState } from "./ui/loading-state";
import { Popover, PopoverContent, PopoverIconTrigger } from "./ui/popover";
import { TooltipBubble, useTooltip } from "./ui/tooltip";
import { WorktreePillAction } from "./worktree-pill-action";
import { WorktreeStatusIcon } from "./worktree-status-icon";
import { cn } from "@/lib/utils";

export interface WorktreePillProps {
  creation: WorktreeCreationStore;
  actions: WorktreeStore;
  record?: WorktreeRecord;
  sessionId: string;
  projectPath: string;
  configurationMode?: "new-session" | "activate-draft" | "edit-draft";
  onConfigured(): void;
}

type ConfirmationKind = "dirty-target" | "dirty-target-resolve" | "discard-resolve";

/** Horizontal session-start choices and deterministic worktree actions for running sessions. */
export const WorktreePill = observer(function WorktreePill({
  creation,
  actions,
  record: knownRecord,
  sessionId,
  projectPath,
  configurationMode,
  onConfigured,
}: WorktreePillProps) {
  const [existingOpen, setExistingOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<ConfirmationKind>();
  const { anchor: warningAnchor, hide: hideWarning, show: showWarning } = useTooltip();
  const choice = creation.choice(sessionId);
  // Session-start choices are the only surface that needs the full worktree candidate list.
  const candidates = configurationMode ? creation.candidates(projectPath) : [];
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

  if (configurationMode) {
    const selectedExisting =
      choice.kind === "reuse"
        ? candidates.find((record) => record.worktreePath === choice.worktreePath)
        : undefined;
    return (
      <div
        data-testid="worktree-pill"
        data-slot="worktree-pill"
        className="@container/worktree mx-4 -mb-5 flex min-w-0 flex-wrap items-center gap-1 rounded-t-[1.75rem] border border-b-0 border-border/85 bg-card px-5 pt-3 pb-8 text-xs"
      >
        {creation.preparingSessionId === sessionId && (
          <div className="mb-1 w-full" data-testid="worktree-creation-progress">
            <LoadingState
              label="Creating worktree and running setup commands"
              variant="Dots"
              startedAt={creation.preparingStartedAt}
            />
          </div>
        )}
        <IconButton
          disabled={busy}
          tooltip="Current checkout"
          aria-pressed={choice.kind === "current"}
          className={cn(
            "flex h-7.5 w-auto shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-normal shadow-none @max-[460px]/worktree:w-7.5 @max-[460px]/worktree:gap-0 @max-[460px]/worktree:px-0",
            choice.kind === "current" &&
              "bg-muted text-foreground aria-pressed:bg-muted aria-pressed:text-foreground",
          )}
          onClick={() => choose({ kind: "current" })}
        >
          <FolderIcon />
          <span className="@max-[460px]/worktree:sr-only">Current checkout</span>
        </IconButton>
        <IconButton
          disabled={busy}
          tooltip="New worktree"
          aria-pressed={choice.kind === "new"}
          className={cn(
            "flex h-7.5 w-auto shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-normal shadow-none @max-[460px]/worktree:w-7.5 @max-[460px]/worktree:gap-0 @max-[460px]/worktree:px-0",
            choice.kind === "new" &&
              "bg-muted text-foreground aria-pressed:bg-muted aria-pressed:text-foreground",
          )}
          onClick={() => choose({ kind: "new" })}
        >
          <BranchIcon />
          <span className="@max-[460px]/worktree:sr-only">New worktree</span>
        </IconButton>
        <Popover open={existingOpen} onOpenChange={setExistingOpen}>
          <PopoverIconTrigger
            disabled={busy || candidates.length === 0}
            tooltip="Choose existing worktree"
            aria-haspopup="menu"
            className={cn(
              "flex h-7.5 w-auto shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-normal shadow-none @max-[460px]/worktree:w-7.5 @max-[460px]/worktree:gap-0 @max-[460px]/worktree:px-0",
              choice.kind === "reuse" &&
                "bg-muted text-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
            )}
          >
            <PullRequestIcon />
            <span className="max-w-56 truncate @max-[460px]/worktree:sr-only">
              {selectedExisting
                ? `${selectedExisting.sessionTitle} · ${selectedExisting.branch.replace(/^agent\//, "")}`
                : "Existing worktree"}
            </span>
            <ChevronDownIcon size={12} />
          </PopoverIconTrigger>
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
        {configurationMode !== "activate-draft" && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            aria-label="Draft"
            aria-pressed={choice.kind === "draft"}
            className={cn(
              "ml-auto flex h-7.5 shrink-0 items-center rounded-lg bg-transparent px-2 text-xs font-normal text-muted-foreground shadow-none hover:bg-muted hover:text-foreground",
              choice.kind === "draft" && "bg-muted text-foreground",
            )}
            onClick={() => choose({ kind: "draft" })}
          >
            Draft
          </Button>
        )}
      </div>
    );
  }

  // The catalog Model receives authoritative worktree lifecycle events. Do not let an
  // older status request temporarily mask its landed state.
  const record = knownRecord ?? status?.record;
  if (!record) return null;

  const branch = record.branch.replace(/^agent\//, "");
  const landed = record.state === "landed";
  const hasUncommittedChanges = (status?.dirtyCount ?? 0) > 0;
  const hasCommits = (status?.aheadCount ?? 0) > 0;
  const hasWorkToMerge = hasUncommittedChanges || hasCommits;
  const statusDisabledReason = status ? undefined : "Loading worktree status…";
  const sessionDisabledReason = actions.isSessionRunning
    ? "Wait for the session to finish before using worktree actions."
    : undefined;
  const operationDisabledReason =
    sessionDisabledReason ??
    (actions.isQueued
      ? "Another merge is already in progress. This merge will start automatically."
      : busy
        ? "A worktree operation is already in progress."
        : undefined);
  const mergeDisabledReason =
    operationDisabledReason ??
    statusDisabledReason ??
    (!hasWorkToMerge ? "There are no changes or commits to merge." : undefined);
  const rebaseDisabledReason =
    operationDisabledReason ??
    statusDisabledReason ??
    (hasUncommittedChanges ? "Commit or discard changes before rebasing." : undefined);
  const mergeLabel =
    actions.phase === "committing"
      ? "Committing…"
      : actions.isQueued
        ? "Waiting to merge…"
        : actions.phase === "landing"
          ? "Merging…"
          : actions.phase === "resolving"
            ? "Resolving conflicts…"
            : hasUncommittedChanges
              ? "Commit & merge"
              : "Merge";
  const mergeAndResolveLabel = "Merge & resolve";
  const targetWarning = status?.targetDirty
    ? "The merge target has uncommitted changes."
    : status && !status.targetOnBranch
      ? `Switch the merge target to ${status.targetBranch} first.`
      : undefined;

  return (
    <>
      <div
        data-testid="worktree-pill"
        data-slot="worktree-pill"
        className="@container/worktree mx-4 -mb-5 flex flex-col gap-1 rounded-t-[1.75rem] border border-b-0 border-border/85 bg-card px-5 pt-3 pb-8"
      >
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-xs">
          <span className="flex h-7.5 min-w-0 shrink items-center gap-1.5 px-2 text-xs font-normal text-foreground">
            <WorktreeStatusIcon state={record.state} className="shrink-0" />
            <span className="truncate max-w-56">{branch}</span>
            {targetWarning && (
              <span
                className="shrink-0 cursor-default text-amber-600 dark:text-amber-400"
                data-testid="worktree-target-warning"
                role="img"
                aria-label={targetWarning}
                tabIndex={0}
                onMouseEnter={(event) => showWarning(event.currentTarget)}
                onMouseLeave={hideWarning}
                onFocus={(event) => showWarning(event.currentTarget)}
                onBlur={hideWarning}
              >
                <CautionIcon />
              </span>
            )}
            {targetWarning && warningAnchor && (
              <TooltipBubble label={targetWarning} anchor={warningAnchor} />
            )}
          </span>
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1 @max-[560px]/worktree:w-full @max-[560px]/worktree:justify-start">
            {status && !landed && status.behindCount > 0 && (
              <WorktreePillAction
                icon={<RebaseIcon />}
                aria-label="Rebase"
                tooltip="Rebase onto target branch"
                disabledReason={rebaseDisabledReason}
                onClick={() => run(actions.rebase())}
              >
                {actions.phase === "rebasing"
                  ? "Rebasing…"
                  : actions.phase === "resolving-rebase"
                    ? "Resolving rebase…"
                    : "Rebase"}
              </WorktreePillAction>
            )}
            {!landed && (
              <>
                <WorktreePillAction
                  icon={<MergeIcon />}
                  aria-label={mergeLabel}
                  tooltip={hasUncommittedChanges ? "Commit changes and merge" : "Merge worktree"}
                  disabledReason={mergeDisabledReason}
                  onClick={() => {
                    if (status?.targetDirty) {
                      setConfirmation("dirty-target");
                      return;
                    }
                    run(actions.commitAndMerge());
                  }}
                >
                  {mergeLabel}
                </WorktreePillAction>
                <WorktreePillAction
                  icon={<MergeResolveIcon />}
                  aria-label={mergeAndResolveLabel}
                  tooltip={
                    hasUncommittedChanges
                      ? "Commit changes, merge, and resolve sessions"
                      : "Merge and resolve sessions"
                  }
                  disabledReason={mergeDisabledReason}
                  onClick={() => {
                    if (status?.targetDirty) {
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
                icon={<ResolveIcon />}
                aria-label="Resolve"
                tooltip="Resolve worktree sessions"
                disabledReason={operationDisabledReason}
                onClick={() => run(actions.resolve())}
              >
                {actions.phase === "resolving-session" ? "Resolving…" : "Resolve"}
              </WorktreePillAction>
            )}
            {actions.stalled && (
              <>
                <WorktreePillAction
                  icon={<RestoreIcon />}
                  aria-label="Retry"
                  tooltip="Retry worktree operation"
                  disabledReason={sessionDisabledReason}
                  onClick={() => run(actions.retryLanding())}
                >
                  Retry
                </WorktreePillAction>
                <WorktreePillAction
                  icon={<CloseIcon size={14} />}
                  aria-label="Dismiss"
                  tooltip="Dismiss worktree operation"
                  disabledReason={sessionDisabledReason}
                  onClick={() => run(actions.cancelLanding())}
                >
                  Dismiss
                </WorktreePillAction>
              </>
            )}
            {actions.isQueued && (
              <WorktreePillAction
                icon={<CloseIcon size={14} />}
                aria-label="Cancel queued merge"
                tooltip="Remove this merge from the queue"
                onClick={() => run(actions.cancelLanding())}
              >
                Cancel
              </WorktreePillAction>
            )}
            {!landed && (
              <Popover
                open={confirmation === "discard-resolve"}
                onOpenChange={(open) => setConfirmation(open ? "discard-resolve" : undefined)}
              >
                <WorktreePillAction
                  popoverTrigger
                  icon={<TrashIcon />}
                  aria-label="Discard & resolve"
                  tooltip="Discard worktree and resolve sessions"
                  tone="destructive"
                  disabledReason={operationDisabledReason}
                >
                  {actions.phase === "discarding" ? "Discarding…" : "Discard & resolve"}
                </WorktreePillAction>
                <PopoverContent align="end" side="top" className="!w-80 !p-0">
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
        </div>
        {actions.isQueued && (
          <p className="px-2 text-xs text-muted-foreground">
            Another merge is in progress. This merge will start automatically when it finishes.
          </p>
        )}
        {actions.error && <p className="px-2 text-xs text-destructive">{actions.error}</p>}
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
