import { useId } from "react";
import { observer } from "r-state-tree/react";
import type { MessageReferencePreviewStore } from "../stores/MessageReferencePreviewStore";
import {
  attachmentLink,
  messageNavigationTarget,
} from "../../contracts/conversations/message-reference";
import { Markdown, useMarkdownLinkActions } from "./ai-elements/markdown";
import { ConversationMarkdownProvider } from "./conversation-markdown-provider";
import { MarkdownImage } from "./markdown-image";
import { isAttachmentImageMimeType } from "../../contracts/conversations/attachment-reference-control";
import { Button } from "./ui/button";
import { Callout } from "./ui/callout";
import { CopyButton } from "./ui/copy-button";
import { DisclosureTrigger } from "./ui/disclosure-trigger";
import { Link } from "./ui/link";
import { LoadingState } from "./ui/loading-state";

/** A user-expanded reference to Pi's original, never a second transcript. */
export const InlineMessageSource = observer(function InlineMessageSource({
  store,
  title,
  sourceSession,
}: {
  store: MessageReferencePreviewStore;
  /** Delivered report title, otherwise resolved from the source session. */
  title?: string;
  /** Attribution supplies a title when this exact source is outside the viewer’s catalog. */
  sourceSession?: { sessionId: string; title: string };
}) {
  const contentId = useId();
  const actions = useMarkdownLinkActions();
  const reference = store.props.reference!;
  const target = messageNavigationTarget(reference);
  const sourceTitle =
    actions?.sessionTitle?.(target.sessionId) ??
    (sourceSession?.sessionId === target.sessionId ? sourceSession.title : "Source session");
  const page = store.page;
  return (
    <section
      className="min-w-0 border-b border-border py-4 last:border-b-0"
      data-slot="message-source"
      data-message-reference={reference}
    >
      <DisclosureTrigger
        data-slot="response-disclosure"
        title={title ?? sourceTitle}
        wrapTitle
        className="rounded-sm text-base leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring"
        open={store.expanded}
        aria-controls={store.expanded ? contentId : undefined}
        onClick={() => store.toggle()}
      />
      {store.expanded && (
        <div
          id={contentId}
          className="flex max-h-[65vh] min-w-0 flex-col gap-3 overflow-y-auto border-l border-border px-4 pt-3"
        >
          <div className="flex shrink-0 items-center justify-between gap-3">
            <Link
              href={reference}
              onClick={(event) => {
                event.preventDefault();
                actions?.openSession(target.sessionId, target.messageId);
              }}
            >
              {title ?? sourceTitle}
            </Link>
            {page && (
              <CopyButton
                getText={() => store.textForCopy()}
                onError={(error) => store.showCopyError(error)}
                disabled={store.loading}
              />
            )}
          </div>
          {store.loading && <LoadingState label="Loading original response" />}
          {store.copyError && (
            <Callout variant="error" role="alert">
              {store.copyError}
            </Callout>
          )}
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
              <ConversationMarkdownProvider
                stateSessionId={page.message.sessionId}
                loadWorkspaceImage={store.loadWorkspaceImage}
                loadAttachmentImage={store.loadAttachmentImage}
              >
                <Markdown>{page.text || "No textual content."}</Markdown>
              </ConversationMarkdownProvider>
              {page.message.inputRefs.map((input) =>
                isAttachmentImageMimeType(input.mimeType) ? (
                  <MarkdownImage
                    key={input.id}
                    alt={input.name}
                    resourcePath={attachmentLink(page.message.sessionId, input.id)}
                    loadImage={store.loadAttachmentImage}
                    caption={input.name}
                  />
                ) : (
                  <div key={input.id} className="break-words text-xs text-muted-foreground">
                    {input.name} · {input.mimeType} · {input.byteLength} bytes
                  </div>
                ),
              )}
              {page.message.hasImages && page.message.inputRefs.length === 0 && (
                <Callout>
                  Embedded image pixels are not available from this source reader. Open the original
                  message to view them.
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
