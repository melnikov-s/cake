import { autoMergeOutcomeLabel } from "../../contracts/worktrees/auto-merge";
import { MarkdownLink } from "./ai-elements/markdown";
import { Button } from "./ui/button";
import { LinkIcon } from "./ui/icons";
import { observer } from "r-state-tree/react";
import type { SourceLocation } from "../../contracts/editor/source-location";
import type { SessionUpdateEntryStore } from "../stores/SessionUpdateEntryStore";
import type { ProjectTodosStore } from "../stores/ProjectTodosStore";
import { referenceTodoOrigin } from "../lib/result-todo-origin";
import { ReportMessageBody } from "./report-message-body";
import { SessionMessage } from "./session-message";

export const SessionUpdateEntry = observer(function SessionUpdateEntry({
  store,
  onOpenSourceLocation,
  todos,
}: {
  store: SessionUpdateEntryStore;
  onOpenSourceLocation?(location: SourceLocation): void;
  todos?: ProjectTodosStore;
}) {
  const { entry } = store.props;
  const source = store.source;
  const title =
    entry.sessionId &&
    (entry.title === entry.sessionId || entry.title === `Session ${entry.sessionId}`)
      ? "Untitled session"
      : entry.systemDetail && !entry.sessionId && entry.title !== "Interrupted report"
        ? "Session update"
        : entry.title;
  const todo = {
    origin: entry.reference
      ? referenceTodoOrigin(entry.reference)
      : entry.sessionId
        ? { sessionIds: [entry.sessionId] }
        : undefined,
    todos,
  };
  if (!source && (entry.autoMergeOutcome || entry.systemDetail)) {
    const outcome = entry.autoMergeOutcome;
    const needsReview = outcome
      ? !outcome.merged || !outcome.resolutionSucceeded
      : entry.needsReview || entry.title === "Interrupted report";
    const status = outcome
      ? autoMergeOutcomeLabel(outcome)
      : entry.title === "Interrupted report"
        ? "Report interrupted"
        : needsReview
          ? "Auto-merge needs review"
          : undefined;
    const item = todo.origin ? todos?.itemsForResult(todo.origin)[0] : undefined;
    const sessionHref = entry.sessionId
      ? `cake://session/${encodeURIComponent(entry.sessionId)}`
      : undefined;
    return (
      <div
        data-slot="session-system-update"
        className="group/session-update min-w-0 px-2 py-1 text-xs text-muted-foreground"
      >
        <div className="flex w-full min-w-0 items-center gap-3">
          {item && todos ? (
            <Button
              variant="ghost"
              size="sm"
              className="min-w-0 flex-1 justify-start px-0 text-left hover:bg-transparent hover:text-foreground"
              aria-label={`View linked to-do: ${item.title}`}
              title={title}
              onClick={() => todos.reveal(item)}
            >
              <span className="truncate">{title}</span>
            </Button>
          ) : sessionHref ? (
            <MarkdownLink
              href={sessionHref}
              presentation="text"
              title={title}
              className="min-w-0 flex-1 truncate text-xs font-medium [&>span]:line-clamp-none [&>span]:block [&>span]:truncate"
            >
              {title}
            </MarkdownLink>
          ) : (
            <span className="min-w-0 flex-1 truncate font-medium" title={title}>
              {title}
            </span>
          )}
          <div className="flex shrink-0 items-center gap-3">
            <span
              data-slot="session-update-outcome"
              className={`whitespace-nowrap text-right ${needsReview ? "text-attention" : ""}`}
            >
              {status}
            </span>
            {sessionHref && (
              <MarkdownLink
                href={sessionHref}
                presentation="icon"
                className="opacity-0 transition-opacity group-hover/session-update:opacity-100 group-focus-within/session-update:opacity-100"
                aria-label="Open session"
                title="Open session"
              >
                <LinkIcon />
              </MarkdownLink>
            )}
          </div>
        </div>
        {needsReview && (
          <p className="mt-1 whitespace-pre-wrap break-words text-foreground">
            {outcome?.message ?? entry.text}
          </p>
        )}
        {item && todos?.error && (
          <p role="alert" className="text-destructive">
            {todos.error}
          </p>
        )}
      </div>
    );
  }
  return (
    <SessionMessage
      source={entry.sessionId ? { sessionId: entry.sessionId, title: entry.title } : undefined}
      title={title}
      sources={source ? [source] : undefined}
      preview={source ? undefined : (entry.body ?? entry.text)}
      open={store.expanded}
      onToggle={() => store.toggle()}
      todo={todo}
    >
      {!source && (
        <ReportMessageBody onOpenSourceLocation={onOpenSourceLocation}>
          {entry.body ?? entry.text}
        </ReportMessageBody>
      )}
    </SessionMessage>
  );
});
