import { observer } from "r-state-tree/react";
import { IconButton } from "@/components/ui/icon-button";
import { CheckIcon, RestoreIcon } from "@/components/ui/icons";
import type { ProjectTodo } from "../../contracts/projects/project-todos";
import type { ProjectTodosStore } from "../stores/ProjectTodosStore";

/** The same human completion/restore action in the pane and transcript headings. */
export const ProjectTodoStateAction = observer(function ProjectTodoStateAction({
  item,
  title,
  done,
  store,
  className,
  notifyOnError,
}: {
  item: ProjectTodo;
  title: string;
  done: boolean;
  store: ProjectTodosStore;
  className?: string;
  notifyOnError?: boolean;
}) {
  return (
    <IconButton
      iconSize="inline"
      className={className}
      disabled={store.busy}
      tooltip={`${done ? "Reopen" : "Mark done"}: ${title}`}
      onClick={(event) => {
        event.stopPropagation();
        void store.setDone(item, { notifyOnError });
      }}
    >
      {done ? <RestoreIcon /> : <CheckIcon />}
    </IconButton>
  );
});
