import { useState } from "react";
import { observer } from "r-state-tree/react";
import type { ChatStore } from "../stores/ChatStore";
import { Button } from "./ui/button";
import { BranchIcon, FolderIcon, PullRequestIcon } from "./ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

export interface DraftActivationMenuProps {
  store: ChatStore;
}

/** Delays a project draft's checkout choice until the user activates it. */
export const DraftActivationMenu = observer(function DraftActivationMenu({
  store,
}: DraftActivationMenuProps) {
  const [open, setOpen] = useState(false);
  const candidates = store.draftActivationCandidates;
  const activate = (choice: Parameters<ChatStore["activateDraft"]>[0]) => {
    setOpen(false);
    void store.activateDraft(choice);
  };

  if (candidates === undefined)
    return (
      <Button size="sm" onClick={() => activate(undefined)}>
        Activate draft
      </Button>
    );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger size="sm">Activate draft</PopoverTrigger>
      <PopoverContent
        align="end"
        role="menu"
        aria-label="Activate draft"
        className="!w-72 !rounded-lg !border-border !bg-popover !p-1 !shadow-xl"
      >
        <Button
          type="button"
          variant="ghost"
          role="menuitem"
          className="h-9 w-full justify-start gap-2 rounded-md px-2 text-xs font-normal"
          onClick={() => activate({ kind: "current" })}
        >
          <FolderIcon />
          Activate in current checkout
        </Button>
        <Button
          type="button"
          variant="ghost"
          role="menuitem"
          className="h-9 w-full justify-start gap-2 rounded-md px-2 text-xs font-normal"
          onClick={() => activate({ kind: "new" })}
        >
          <BranchIcon />
          Activate in new worktree
        </Button>
        {candidates.length > 0 && (
          <>
            <p className="px-2 pt-2 pb-1 text-[11px] font-medium text-muted-foreground">
              Existing worktrees
            </p>
            {candidates.map((record) => (
              <Button
                key={record.worktreePath}
                type="button"
                variant="ghost"
                role="menuitem"
                className="h-auto min-h-9 w-full justify-start gap-2 rounded-md px-2 py-1.5 text-xs font-normal"
                onClick={() => activate({ kind: "reuse", worktreePath: record.worktreePath })}
              >
                <PullRequestIcon />
                <span className="flex min-w-0 flex-col text-left">
                  <span className="truncate">{record.sessionTitle}</span>
                  <span className="truncate text-[10px] text-muted-foreground">
                    {record.branch.replace(/^agent\//, "")}
                  </span>
                </span>
              </Button>
            ))}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
});
