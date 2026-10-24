import { observer } from "r-state-tree/react";
import { Markdown } from "@/components/ai-elements/markdown";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { DisclosureTrigger } from "@/components/ui/disclosure-trigger";
import { LoadingState } from "@/components/ui/loading-state";
import { SessionIdLink } from "@/components/ui/session-id-link";
import { Fragment } from "react";
import type { MessageBoardStore } from "../stores/MessageBoardStore";

export const MessageBoardArtifact = observer(function MessageBoardArtifact({
  store,
}: {
  store: MessageBoardStore;
}) {
  const knownSessionIds = [
    ...new Set(
      store.entries.flatMap((entry) => [
        entry.authorSessionId,
        ...(entry.audience === "workgroup" ? [] : entry.audience),
        ...(store.receipts[entry.sequence]?.receipts.map((receipt) => receipt.sessionId) ?? []),
      ]),
    ),
  ];
  return (
    <section className="grid min-w-0 gap-3" aria-label="Workboard">
      <header className="flex min-w-0 flex-wrap items-center justify-between gap-3 pr-10">
        <p className="min-w-0 text-xs text-muted-foreground">
          Shared coordination entries. Browsing does not mark an agent as read.
        </p>
      </header>
      {store.error && (
        <Callout variant="error">
          {store.error}
          <Button
            size="sm"
            variant="outline"
            disabled={store.loading}
            onClick={() => store.receive()}
          >
            Retry board update
          </Button>
        </Callout>
      )}
      {!store.loading && !store.entries.length && (
        <p className="py-6 text-sm text-muted-foreground">No coordination entries yet.</p>
      )}
      {store.entries.map((entry) => (
        <article key={entry.sequence} className="min-w-0 rounded-lg border border-border p-3">
          <DisclosureTrigger
            title={`#${entry.sequence} · ${entry.description}`}
            open={store.expanded.includes(entry.sequence)}
            onClick={() => void store.toggleBody(entry.sequence)}
          />
          <p className="mt-1 break-all text-xs text-muted-foreground">
            From{" "}
            <SessionIdLink sessionId={entry.authorSessionId} knownSessionIds={knownSessionIds} /> ·{" "}
            {new Date(entry.createdAt).toLocaleString()}
          </p>
          {entry.topic && (
            <p className="mt-1 break-all text-xs text-muted-foreground">
              Topic: {entry.topic}
              {entry.supersedes?.length
                ? ` · Supersedes ${entry.supersedes.map((sequence) => `#${sequence}`).join(", ")} for this entry's audience`
                : ""}
            </p>
          )}
          {store.expanded.includes(entry.sequence) && (
            <div className="min-w-0 pt-3">
              {store.bodies[entry.sequence] ? (
                <Markdown>{store.bodies[entry.sequence]?.body ?? ""}</Markdown>
              ) : (
                <LoadingState label="Loading entry" />
              )}
            </div>
          )}
          <div className="mt-2 flex min-w-0 flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 break-all text-xs text-muted-foreground">
              For{" "}
              {entry.audience === "workgroup"
                ? "the workgroup"
                : entry.audience.map((sessionId, index) => (
                    <Fragment key={sessionId}>
                      {index > 0 && ", "}
                      <SessionIdLink sessionId={sessionId} knownSessionIds={knownSessionIds} />
                    </Fragment>
                  ))}
            </span>
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={store.showingReceipts.includes(entry.sequence)}
              onClick={() => void store.toggleReceipts(entry.sequence)}
            >
              Agent receipts for #{entry.sequence}
            </Button>
          </div>
          {store.showingReceipts.includes(entry.sequence) && (
            <div className="mt-2 grid min-w-0 gap-2 text-xs text-muted-foreground">
              <p>Read means supplied content, not understanding or completion.</p>
              {store.receipts[entry.sequence] ? (
                store.receipts[entry.sequence]?.receipts.map((receipt) => (
                  <div
                    key={receipt.sessionId}
                    className="grid min-w-0 gap-1 break-all border-t border-border pt-2"
                  >
                    <span className="font-mono">
                      <SessionIdLink
                        sessionId={receipt.sessionId}
                        knownSessionIds={knownSessionIds}
                      />
                    </span>
                    <span>
                      Notified:{" "}
                      {receipt.notifiedAt
                        ? new Date(receipt.notifiedAt).toLocaleString()
                        : "Not recorded"}{" "}
                      · Read:{" "}
                      {receipt.readAt ? new Date(receipt.readAt).toLocaleString() : "Not recorded"}
                    </span>
                  </div>
                ))
              ) : (
                <LoadingState label="Loading receipts" />
              )}
            </div>
          )}
        </article>
      ))}
      {store.loading && <LoadingState label="Loading board" />}
      {store.hasMore && (
        <Button variant="outline" disabled={store.loading} onClick={() => void store.loadMore()}>
          Load more entries
        </Button>
      )}
    </section>
  );
});
