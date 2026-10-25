import { observer } from "r-state-tree/react";
import type { SourceLocation } from "../../contracts/editor/source-location";
import type { SessionUpdateEntryStore } from "../stores/SessionUpdateEntryStore";
import type { ProjectTodosStore } from "../stores/ProjectTodosStore";
import { referenceTodoOrigin } from "../lib/result-todo-origin";
import { Markdown } from "./ai-elements/markdown";
import { InlineMessageSource } from "./inline-message-source";
import { MessageDisclosure } from "./ui/message-disclosure";
import { SessionMessage } from "./ui/session-message";
import { ResultTodoFooter } from "./result-todo-done";

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
  const content = source ? (
    <InlineMessageSource
      store={source}
      title={entry.title}
      sourceSession={
        entry.sessionId ? { sessionId: entry.sessionId, title: entry.title } : undefined
      }
    />
  ) : (
    <MessageDisclosure title={entry.title} open={store.expanded} onToggle={() => store.toggle()}>
      <Markdown onOpenSourceLocation={onOpenSourceLocation}>{entry.text}</Markdown>
    </MessageDisclosure>
  );
  if (!entry.sessionId) return content;
  return (
    <SessionMessage
      source={entry.sessionId ? { sessionId: entry.sessionId, title: entry.title } : undefined}
      footer={
        <ResultTodoFooter
          origin={
            entry.reference
              ? referenceTodoOrigin(entry.reference)
              : entry.sessionId
                ? { sessionIds: [entry.sessionId] }
                : undefined
          }
          todos={todos}
        />
      }
    >
      <div className="px-5">{content}</div>
    </SessionMessage>
  );
});
