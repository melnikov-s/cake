import { observer } from "r-state-tree/react";
import { useLayoutEffect, useRef } from "react";
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
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const rows = Array.from(list.children).slice(0, 3);
    const measure = () => {
      const first = rows[0];
      const last = rows.at(-1);
      if (!first || !last) return;
      const style = getComputedStyle(list);
      // Measure wrapped rows, keeping room for the controls' focus rings.
      const height =
        last.getBoundingClientRect().bottom -
        first.getBoundingClientRect().top +
        (parseFloat(style.paddingTop) || 0) +
        (parseFloat(style.paddingBottom) || 0);
      list.style.maxHeight = `min(${height}px, 30vh)`;
    };
    measure();
    if (!("ResizeObserver" in globalThis)) return;
    const resizeObserver = new ResizeObserver(measure);
    rows.forEach((row) => resizeObserver.observe(row));
    return () => resizeObserver.disconnect();
  }, [items]);

  return (
    <section
      aria-label="Needs attention"
      aria-busy={todos.busy}
      className="flex min-w-0 flex-col gap-1.5 pt-2"
    >
      <h2 className="px-1 pb-0.5 text-xs font-medium">
        Needs attention
        <span className="ml-2 font-normal tabular-nums text-muted-foreground">
          {todos.attentionItems.length}
        </span>
      </h2>
      {todos.error && (
        <Callout variant="error" role="alert">
          {todos.error}
        </Callout>
      )}
      <div
        ref={listRef}
        role="list"
        aria-label="Needs attention items"
        className="-m-1 flex max-h-[30vh] min-h-0 flex-col gap-1.5 overflow-y-auto overscroll-y-contain p-1"
      >
        {items.map((item) => {
          const detail = projectTodoAttentionDetail(item);
          return (
            <div
              key={item.id}
              role="listitem"
              className="group/attention flex min-w-0 shrink-0 items-center rounded-full border border-border/85 bg-background"
            >
              <Button
                variant="ghost"
                disabled={todos.busy}
                aria-label={`Open attention: ${item.title}`}
                title={item.title}
                className="h-auto min-h-9 min-w-0 flex-1 justify-start rounded-full px-3 py-2 text-left text-sm font-normal text-foreground"
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
    </section>
  );
});
