import { observer } from "r-state-tree/react";
import { projectTodoAttentionDetail } from "../../contracts/projects/project-todos";
import type { ProjectTodosStore } from "../stores/ProjectTodosStore";
import { Button } from "./ui/button";
import { IconButton } from "./ui/icon-button";
import { Callout } from "./ui/callout";
import { CloseIcon } from "./ui/icons";

export const ConversationAttention = observer(function ConversationAttention({
  todos,
  activate,
}: {
  todos: ProjectTodosStore;
  activate(item: Parameters<ProjectTodosStore["activateAttention"]>[0]): Promise<void>;
}) {
  const items = todos.attentionItems;

  return (
    <div aria-busy={todos.busy} className="flex min-w-0 flex-col">
      {todos.error && (
        <Callout variant="error" role="alert">
          {todos.error}
        </Callout>
      )}
      <div
        role="list"
        aria-label="Needs attention items"
        className="flex min-w-0 flex-col gap-0.5 p-1"
      >
        {items.map((item) => {
          const detail = projectTodoAttentionDetail(item);
          return (
            <div
              key={item.id}
              role="listitem"
              className="group/attention flex min-w-0 shrink-0 items-center rounded-sm hover:bg-muted/80"
            >
              <Button
                variant="ghost"
                disabled={todos.busy}
                aria-label={`Open attention: ${item.title}`}
                title={item.title}
                className="h-auto min-h-11 min-w-0 flex-1 justify-start rounded-sm px-1.5 py-1.5 text-left text-xs font-medium text-foreground"
                onClick={() => void activate(item)}
              >
                <span className="flex min-w-0 flex-col whitespace-normal break-words">
                  <span>{item.title}</span>
                  {detail && <span className="text-xs text-muted-foreground">{detail}</span>}
                </span>
              </Button>
              <IconButton
                iconSize="inline"
                tooltip={`Clear attention: ${item.title}`}
                disabled={todos.busy}
                className="mr-1 shrink-0 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground [@media(hover:hover)_and_(not_(any-pointer:coarse))]:opacity-0 [@media(hover:hover)_and_(not_(any-pointer:coarse))]:group-hover/attention:opacity-100 group-focus-within/attention:opacity-100"
                onClick={() => void todos.dismissAttention(item)}
              >
                <CloseIcon size={12} />
              </IconButton>
            </div>
          );
        })}
      </div>
    </div>
  );
});
