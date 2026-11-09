import { autoMergeOutcomeLabel } from "../../contracts/worktrees/auto-merge";
import { MarkdownLink } from "./ai-elements/markdown";
import { ContextPill } from "./ui/context-pill";
import { ResultTodoDone } from "./result-todo-done";
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
      : entry.needsReview;
    const status = outcome
      ? autoMergeOutcomeLabel(outcome)
      : needsReview
        ? "Auto-merge needs review"
        : undefined;
    return (
      <div
        data-slot="session-system-update"
        className="min-w-0 px-2 py-1 text-xs text-muted-foreground"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="min-w-0 break-words font-medium">{title}</span>
          {status && <span className={needsReview ? "text-attention" : undefined}>{status}</span>}
          {entry.sessionId && (
            <MarkdownLink href={`cake://session/${encodeURIComponent(entry.sessionId)}`}>
              Open session
            </MarkdownLink>
          )}
          <ContextPill title="System details" text={entry.text} plainText />
        </div>
        {needsReview && outcome && (
          <p className="mt-1 whitespace-pre-wrap break-words text-foreground">{outcome.message}</p>
        )}
        <ResultTodoDone {...todo} readOnly />
      </div>
    );
  }
  return (
    <SessionMessage
      compact
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
