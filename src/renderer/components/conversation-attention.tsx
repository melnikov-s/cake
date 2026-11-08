import { observer } from "r-state-tree/react";
import type { ProjectTodosStore } from "../stores/ProjectTodosStore";
import { Button } from "./ui/button";
import { IconButton } from "./ui/icon-button";
import { Callout } from "./ui/callout";
import { CloseIcon } from "./ui/icons";

export const ConversationAttention = observer(function ConversationAttention({
  todos,
}: {
  todos: ProjectTodosStore;
}) {
  return (
    <section aria-label="Needs attention" className="flex min-w-0 flex-col gap-1.5 pt-2">
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
      {todos.attentionItems.map((item) => (
        <div
          key={item.id}
          className="flex min-w-0 items-center rounded-full border border-border/85 bg-background"
        >
          <Button
            variant="ghost"
            disabled={todos.busy}
            aria-label={`Open attention: ${item.title}`}
            title={item.title}
            className="h-auto min-h-9 min-w-0 flex-1 justify-start rounded-full px-3 py-2 text-left text-sm font-normal text-foreground"
            onClick={() => void todos.activateAttention(item)}
          >
            <span className="min-w-0 whitespace-normal break-words">{item.attentionReason}</span>
          </Button>
          <IconButton
            tooltip={`Clear attention: ${item.title}`}
            disabled={todos.busy}
            className="mr-1 shrink-0 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => void todos.dismissAttention(item)}
          >
            <CloseIcon />
          </IconButton>
        </div>
      ))}
    </section>
  );
});
