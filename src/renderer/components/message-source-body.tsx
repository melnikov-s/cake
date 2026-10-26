import { useId } from "react";
import { observer } from "r-state-tree/react";
import type { MessageReferencePreviewStore } from "../stores/MessageReferencePreviewStore";
import { attachmentLink } from "../../contracts/conversations/message-reference";
import { Markdown } from "./ai-elements/markdown";
import { ConversationMarkdownProvider } from "./conversation-markdown-provider";
import { MarkdownImage } from "./markdown-image";
import { isAttachmentImageMimeType } from "../../contracts/conversations/attachment-reference-control";
import { Button } from "./ui/button";
import { Callout } from "./ui/callout";
import { CopyButton } from "./ui/copy-button";
import { DisclosureTrigger } from "./ui/disclosure-trigger";
import { LoadingState } from "./ui/loading-state";

/** Copies the loaded original, shown beside the card's full-response link. */
export const MessageSourceCopy = observer(function MessageSourceCopy({
  store,
}: {
  store: MessageReferencePreviewStore;
}) {
  if (!store.page) return null;
  return (
    <CopyButton
      getText={() => store.textForCopy()}
      onError={(error) => store.showCopyError(error)}
      disabled={store.loading}
    />
  );
});

/**
 * A user-expanded reference to Pi's original, never a second transcript. The surrounding
 * session card owns the title, expansion and the link to the original.
 */
export const MessageSourceBody = observer(function MessageSourceBody({
  store,
}: {
  store: MessageReferencePreviewStore;
}) {
  const reference = store.props.reference!;
  const page = store.page;
  return (
    <section
      className="flex min-w-0 flex-col gap-3"
      data-slot="message-source"
      data-message-reference={reference}
    >
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
                Characters {page.offset + 1}–{page.offset + page.text.length} of {page.totalChars}
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
    </section>
  );
});

/**
 * The exact original behind a delivered message that already has its own text: a quiet,
 * lazily loaded disclosure inside the card body, so the card's title is not repeated.
 */
export const OriginalResponse = observer(function OriginalResponse({
  store,
}: {
  store: MessageReferencePreviewStore;
}) {
  const contentId = useId();
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-1">
        <DisclosureTrigger
          data-slot="response-disclosure"
          title="Original response"
          chevronPosition="start"
          className="w-fit rounded-md px-1.5 py-1 text-xs text-muted-foreground outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          open={store.expanded}
          aria-controls={store.expanded ? contentId : undefined}
          onClick={() => store.toggle()}
        />
        {store.expanded && <MessageSourceCopy store={store} />}
      </div>
      {store.expanded && (
        <div id={contentId} className="pt-2">
          <MessageSourceBody store={store} />
        </div>
      )}
    </div>
  );
});
