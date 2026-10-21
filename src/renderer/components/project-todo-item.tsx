import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { Link } from "@/components/ui/link";
import { sessionLink, parseSessionLink } from "../../contracts/conversations/message-reference";
import { projectTodoAssociationKey } from "../../contracts/projects/project-todos";
import { Button } from "@/components/ui/button";
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
        "rounded-md border border-transparent p-2",
        selected && "border-border bg-sidebar-active",
      )}
      data-todo-id={item.id}
    >
      <div className="flex items-start gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-auto min-w-0 flex-1 justify-start whitespace-normal px-1 py-1 text-left"
          aria-pressed={selected}
          disabled={store.busy}
          onClick={() => void store.select(item)}
        >
          {item.title}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0"
          disabled={store.busy}
          aria-label={`${item.state === "done" ? "Reopen" : "Mark done"}: ${item.title}`}
          onClick={() => void store.setDone(item)}
        >
          {item.state === "done" ? "Reopen" : "Done"}
        </Button>
      </div>
      {item.status && (
        <p className="whitespace-pre-wrap break-words px-1 pb-1 text-xs leading-relaxed text-muted-foreground">
          {item.status}
        </p>
      )}
      {item.associations.length > 0 && (
        <ul
          aria-label={`Work for ${item.title}`}
          className="space-y-1 px-1 pb-1 text-xs text-muted-foreground"
        >
          {item.associations.map((association) => {
            const href =
              association.kind === "session" ? sessionLink(association.sessionId) : association.ref;
            return (
              <li key={projectTodoAssociationKey(association)}>
                <Link
                  href={href}
                  title={association.title}
                  className="inline-block max-w-full truncate align-bottom"
                  onClick={(event) => {
                    event.preventDefault();
                    const target = parseSessionLink(href);
                    if (target)
                      void root.navigationStore.openSessionLink(target.sessionId, target.messageId);
                  }}
                >
                  {association.title}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
});
