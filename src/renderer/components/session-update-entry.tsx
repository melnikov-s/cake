import { useId } from "react";
import { observer } from "r-state-tree/react";
import type { SourceLocation } from "../../contracts/editor/source-location";
import type { SessionUpdateEntryStore } from "../stores/SessionUpdateEntryStore";
import { Markdown } from "./ai-elements/markdown";
import { InlineMessageSource } from "./inline-message-source";
import { DisclosureTrigger } from "./ui/disclosure-trigger";
import { SessionMessage } from "./ui/session-message";

export const SessionUpdateEntry = observer(function SessionUpdateEntry({
  store,
  onOpenSourceLocation,
}: {
  store: SessionUpdateEntryStore;
  onOpenSourceLocation?(location: SourceLocation): void;
}) {
  const contentId = useId();
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
    <section className="min-w-0 border-b border-border py-4 last:border-b-0">
      <DisclosureTrigger
        data-slot="response-disclosure"
        title={entry.title}
        wrapTitle
        className="rounded-sm text-base leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring"
        open={store.expanded}
        aria-controls={store.expanded ? contentId : undefined}
        onClick={() => store.toggle()}
      />
      {store.expanded && (
        <div id={contentId} className="mt-3 min-w-0 border-l border-border px-4 text-sm">
          <Markdown onOpenSourceLocation={onOpenSourceLocation}>{entry.text}</Markdown>
        </div>
      )}
    </section>
  );
  return entry.sessionId ? (
    <SessionMessage source={{ sessionId: entry.sessionId, title: entry.title }}>
      <div className="px-5">{content}</div>
    </SessionMessage>
  ) : (
    content
  );
});
