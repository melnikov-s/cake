import { observer } from "r-state-tree/react";
import { IconButton } from "@/components/ui/icon-button";
import { CloseIcon } from "@/components/ui/icons";
import type { ProjectTodosStore } from "../stores/ProjectTodosStore";

/** Selection is durable context, not a send action or a replacement for the user's draft. */
export const ProjectTodoComposerContext = observer(function ProjectTodoComposerContext({
  store,
}: {
  store: ProjectTodosStore;
}) {
  const selected = store.selectedItem;
  if (!selected) return null;
  return (
    <div
      aria-label="Next message context"
      className="flex min-w-0 items-center gap-2 px-2 pb-2 pt-1"
    >
      <div className="min-w-0 flex-1">
        <p className="text-[10px] text-muted-foreground">Next message context</p>
        <p className="truncate text-xs font-medium text-accent" title={selected.title}>
          {selected.title}
        </p>
      </div>
      <IconButton
        tooltip="Clear to-do context"
        className="size-7"
        disabled={store.busy}
        onClick={() => void store.clearSelection()}
      >
        <CloseIcon />
      </IconButton>
    </div>
  );
});
