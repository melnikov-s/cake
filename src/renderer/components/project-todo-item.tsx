import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { MarkdownLink } from "./ai-elements/markdown";
import { editorLocationFromPath } from "../../contracts/editor/editor-location";
import { sessionLink } from "../../contracts/conversations/message-reference";
import { projectTodoAssociationKey } from "../../contracts/projects/project-todos";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { CircleIcon, CheckIcon, LinkIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import type { ProjectTodo } from "../../contracts/projects/project-todos";
import type { ProjectTodosStore } from "../stores/ProjectTodosStore";

export const ProjectTodoItem = observer(function ProjectTodoItem({
  item,
  store,
}: {
  item: ProjectTodo;
  store: ProjectTodosStore;
}) {
  const root = useStore(RootStore);
  const selected = store.value?.selectedId === item.id;
  return (
    <li
      className={cn(
        "relative rounded-md border border-transparent px-3 py-3",
        selected &&
          "border-border bg-muted/50 before:absolute before:inset-y-3 before:left-0 before:w-0.5 before:rounded-full before:bg-accent",
      )}
      data-todo-id={item.id}
    >
      <div className="flex items-start gap-2">
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "h-auto min-w-0 flex-1 justify-start whitespace-normal p-0 text-left text-[13px] font-medium leading-relaxed text-foreground hover:bg-transparent hover:text-accent",
            item.state === "done" && "text-muted-foreground",
          )}
          aria-pressed={selected}
          disabled={store.busy}
          onClick={() => void store.select(item)}
        >
          {item.title}
        </Button>
        <IconButton
          className="-mr-1 -mt-1 size-7"
          disabled={store.busy}
          tooltip={`${item.state === "done" ? "Reopen" : "Mark done"}: ${item.title}`}
          onClick={() => void store.setDone(item)}
        >
          {item.state === "done" ? <CheckIcon /> : <CircleIcon />}
        </IconButton>
      </div>
      {item.description !== item.title && (
        <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
          {item.description}
        </p>
      )}
      {item.status && item.status !== item.description && item.status !== item.title && (
        <p className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-muted-foreground">
          {item.status}
        </p>
      )}
      {item.associations.length > 0 && (
        <ul
          aria-label={`Work for ${item.title}`}
          className="mt-2 space-y-1 text-[11px] text-muted-foreground"
        >
          {item.associations.map((association) => (
            <li key={projectTodoAssociationKey(association)} className="flex items-start gap-1.5">
              <span className="mt-0.5 shrink-0">
                <LinkIcon />
              </span>
              <MarkdownLink
                href={
                  association.kind === "session"
                    ? sessionLink(association.sessionId)
                    : association.ref
                }
                className="min-w-0 break-words font-normal no-underline hover:text-foreground hover:underline"
                onOpenSourceLocation={(location) =>
                  void root.projectWorkbenchStore.presentationStore.openFile(
                    editorLocationFromPath(location),
                  )
                }
              >
                {association.title}
              </MarkdownLink>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
});
