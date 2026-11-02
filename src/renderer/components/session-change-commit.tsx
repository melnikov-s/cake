import { observer } from "r-state-tree/react";
import { Button } from "./ui/button";
import { CommitIcon } from "./ui/icons";
import { ChangeStats } from "./ui/change-stats";
import { SessionChangeFile } from "./session-change-file";
import { changeTotals, type BranchCommit } from "../../contracts/worktrees/worktree-changes";
import type { SessionChangesStore } from "../stores/SessionChangesStore";

export const SessionChangeCommit = observer(function SessionChangeCommit({
  commit,
  store,
}: {
  commit: BranchCommit;
  store: SessionChangesStore;
}) {
  const open = store.expandedCommits.has(commit.hash);
  return (
    <div className="border-t border-border/45">
      <Button
        variant="ghost"
        className="h-auto w-full items-start justify-start gap-2 rounded-none px-4 py-2.5 text-left font-normal text-foreground"
        aria-expanded={open}
        onClick={() => store.toggleCommit(commit.hash)}
      >
        <span className="mt-1 shrink-0 text-muted-foreground">
          <CommitIcon />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block whitespace-normal text-xs leading-relaxed">{commit.subject}</span>
          <span className="mt-1 flex items-center justify-between gap-2">
            <span className="font-mono text-xs text-muted-foreground">
              {commit.hash.slice(0, 7)}
            </span>
            <ChangeStats {...changeTotals(commit.files)} />
          </span>
        </span>
      </Button>
      {open && (
        <div className="pb-2 pl-5">
          {commit.files.map((file) => (
            <SessionChangeFile key={file.path} file={file} store={store} commit={commit.hash} />
          ))}
        </div>
      )}
    </div>
  );
});
