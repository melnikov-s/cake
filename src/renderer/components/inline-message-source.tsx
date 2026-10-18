import { useId } from "react";
import { observer } from "r-state-tree/react";
import type { MessageReferencePreviewStore } from "../stores/MessageReferencePreviewStore";
import { messageNavigationTarget } from "../../contracts/conversations/message-reference";
import { Markdown, useMarkdownLinkActions } from "./ai-elements/markdown";
import { Button } from "./ui/button";
import { Callout } from "./ui/callout";
import { DisclosureTrigger } from "./ui/disclosure-trigger";
import { Link } from "./ui/link";
import { LoadingState } from "./ui/loading-state";

/** A reference to Pi's original, never a second transcript or an attachment read. */
export const InlineMessageSource = observer(function InlineMessageSource({
  store,
}: {
  store: MessageReferencePreviewStore;
}) {
  const contentId = useId();
  const actions = useMarkdownLinkActions();
  const reference = store.props.reference!;
  const target = messageNavigationTarget(reference);
  const title = actions?.sessionTitle?.(target.sessionId) ?? "Source session";
  const page = store.page;
  return (
    <section className="min-w-0" data-slot="message-source" data-message-reference={reference}>
      <DisclosureTrigger
        title="Full agent response"
        subtitle={title}
        open={store.expanded}
        aria-controls={store.expanded ? contentId : undefined}
        onClick={() => store.toggle()}
      />
      {store.expanded && (
        <div
          id={contentId}
          className="flex max-h-[65vh] min-w-0 flex-col gap-3 overflow-y-auto border-l border-border pl-4 pt-3"
        >
          <Link
            href={reference}
            onClick={(event) => {
              event.preventDefault();
              actions?.openSession(target.sessionId, target.messageId);
            }}
          >
            Original message · {title}
          </Link>
          <div className="break-all text-xs text-muted-foreground">
            {reference}
            {page ? ` · ${page.message.role} · ${page.message.timestamp}` : ""}
          </div>
          {store.loading && <LoadingState label="Loading original response" />}
          {store.error ? (
            <Callout variant="error" role="alert">
              <strong>Original response unavailable</strong>
              {store.error}
              <Button size="sm" variant="ghost" onClick={() => void store.load()}>
                Retry source
              </Button>
            </Callout>
          ) : page ? (
            <>
              <Markdown renderImages={false}>{page.text || "No textual content."}</Markdown>
              {(page.message.hasImages || page.message.inputRefs.length > 0) && (
                <Callout>
                  <strong>Attachment metadata only</strong>
                  Images and attachments are not loaded or inspected by this view.
                  {page.message.inputRefs.map((input) => (
                    <div key={input.id} className="break-words">
                      {input.name} · {input.mimeType} · {input.byteLength} bytes
                    </div>
                  ))}
                </Callout>
              )}
              {(page.offset > 0 || page.nextOffset !== null) && (
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    variant="outline"
                    disabled={store.loading || page.offset === 0}
                    onClick={() => store.previous()}
                  >
                    Previous
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    Characters {page.offset + 1}–{page.offset + page.text.length} of{" "}
                    {page.totalChars}
                  </span>
                  <Button
                    variant="outline"
                    disabled={store.loading || page.nextOffset === null}
                    onClick={() => store.next()}
                  >
                    Next
                  </Button>
                </div>
              )}
            </>
          ) : null}
        </div>
      )}
    </section>
  );
});
