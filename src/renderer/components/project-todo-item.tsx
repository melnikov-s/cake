import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { MarkdownLink } from "./ai-elements/markdown";
import { editorLocationFromPath } from "../../contracts/editor/editor-location";
import { projectTodoAssociationDestination } from "../lib/project-todo-association";
import { projectTodoAssociationKey } from "../../contracts/projects/project-todos";
import { NavItem } from "@/components/ui/nav-item";
import { ProjectTodoSessionLink } from "./project-todo-session-link";
import { IconButton } from "@/components/ui/icon-button";
import { CircleIcon, CheckIcon } from "@/components/ui/icons";
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
  const selected = store.selectedItem?.id === item.id;
  const sessions = item.associations.filter((association) => association.kind === "session");
  const resources = item.associations.filter((association) => association.kind !== "session");
  return (
    <li data-todo-id={item.id}>
      <NavItem
        wholeRowAction
        motionFeedback
        active={selected}
        aria-busy={store.busy}
        actionProps={{
          "aria-pressed": selected,
          "aria-label": item.title,
          "aria-disabled": store.busy || item.state === "done",
        }}
        onClick={() => void store.select(item)}
        className="flex-wrap items-start gap-y-0 px-3 py-3 text-[13px] leading-relaxed"
        label={
          <span className={cn("font-medium", item.state === "done" && "text-muted-foreground")}>
            {item.title}
          </span>
        }
        trailing={
          <div className="flex items-start gap-2">
            {sessions.length > 0 && (
              <span className="flex max-w-36 flex-col gap-1 pt-0.5">
                {sessions.map((association) => (
                  <ProjectTodoSessionLink
                    key={association.sessionId}
                    sessionId={association.sessionId}
                    title={association.title}
                  />
                ))}
              </span>
            )}
            <IconButton
              className="-mr-1 -mt-1 size-7"
              disabled={store.busy}
              tooltip={`${item.state === "done" ? "Reopen" : "Mark done"}: ${item.title}`}
              onClick={() => void store.setDone(item)}
            >
              {item.state === "done" ? <CheckIcon /> : <CircleIcon />}
            </IconButton>
          </div>
        }
      >
        {item.description !== item.title && (
          <p className="mt-1 w-full whitespace-pre-wrap break-words text-xs font-normal leading-relaxed text-muted-foreground">
            {item.description}
          </p>
        )}
        {item.status && item.status !== item.description && item.status !== item.title && (
          <p className="mt-1 w-full whitespace-pre-wrap break-words text-[11px] font-normal leading-relaxed text-muted-foreground">
            {item.status}
          </p>
        )}
        {resources.length > 0 && (
          <ul
            aria-label={`Work for ${item.title}`}
            className="mt-1.5 w-full space-y-0.5 text-[11px] leading-4 text-muted-foreground"
          >
            {resources.map((association) => {
              const { href, Icon } = projectTodoAssociationDestination(association);
              return (
                <li
                  key={projectTodoAssociationKey(association)}
                  className="flex items-start gap-1.5 [&>a]:min-w-0 [&>a]:break-words [&>a]:font-normal [&>a]:no-underline [&>a:hover]:text-foreground [&>a:hover]:underline"
                >
                  <span className="mt-0.5 shrink-0 [&>svg]:size-3">
                    <Icon />
                  </span>
                  <MarkdownLink
                    href={href}
                    onOpenSourceLocation={(location) =>
                      void root.projectWorkbenchStore.presentationStore.openFile(
                        editorLocationFromPath(location),
                      )
                    }
                  >
                    {association.title}
                  </MarkdownLink>
                </li>
              );
            })}
          </ul>
        )}
      </NavItem>
    </li>
  );
});
