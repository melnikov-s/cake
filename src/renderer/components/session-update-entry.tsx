import { observer } from "r-state-tree/react";
import type { SourceLocation } from "../../contracts/editor/source-location";
import type { SessionUpdateEntryStore } from "../stores/SessionUpdateEntryStore";
import type { ProjectTodosStore } from "../stores/ProjectTodosStore";
import { referenceTodoOrigin } from "../lib/result-todo-origin";
import { Markdown } from "./ai-elements/markdown";
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
  return (
    <SessionMessage
      source={entry.sessionId ? { sessionId: entry.sessionId, title: entry.title } : undefined}
      title={entry.title}
      sources={source ? [source] : undefined}
      preview={source ? undefined : entry.text}
      open={store.expanded}
      onToggle={() => store.toggle()}
      todo={{
        origin: entry.reference
          ? referenceTodoOrigin(entry.reference)
          : entry.sessionId
            ? { sessionIds: [entry.sessionId] }
            : undefined,
        todos,
      }}
    >
      {!source && <Markdown onOpenSourceLocation={onOpenSourceLocation}>{entry.text}</Markdown>}
    </SessionMessage>
  );
});
