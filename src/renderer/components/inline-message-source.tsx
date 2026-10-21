import { useEffect, useId, useRef } from "react";
import { observer } from "r-state-tree/react";
import type { MessageReferencePreviewStore } from "../stores/MessageReferencePreviewStore";
import {
  attachmentLink,
  messageNavigationTarget,
} from "../../contracts/conversations/message-reference";
import { Markdown, MarkdownLinkProvider, useMarkdownLinkActions } from "./ai-elements/markdown";
import { MarkdownImage } from "./markdown-image";
import { Button } from "./ui/button";
import { Callout } from "./ui/callout";
import { CopyButton } from "./ui/copy-button";
import { DisclosureTrigger } from "./ui/disclosure-trigger";
import { Link } from "./ui/link";
import { LoadingState } from "./ui/loading-state";

/** A user-expanded reference to Pi's original, never a second transcript. */
export const InlineMessageSource = observer(function InlineMessageSource({
  store,
  preview = false,
}: {
  store: MessageReferencePreviewStore;
  /** Receipt cards reveal a bounded source preview only when visible. */
  preview?: boolean;
}) {
  const contentId = useId();
  const previewRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = previewRef.current;
    if (!preview || !element || !("IntersectionObserver" in globalThis)) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      store.loadPreview();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [preview, store]);
  const actions = useMarkdownLinkActions();
  const reference = store.props.reference!;
  const target = messageNavigationTarget(reference);
  const title = actions?.sessionTitle?.(target.sessionId) ?? "Source session";
  const page = store.page;
  return (
    <section
      ref={previewRef}
      className="min-w-0"
      data-slot="message-source"
      data-message-reference={reference}
    >
      {preview && !store.expanded && (
        <div className="pb-3 text-sm" data-slot="response-preview">
          {store.loading ? (
            <LoadingState label="Loading response preview" />
          ) : store.error ? (
            <span className="text-muted-foreground">
              Original response unavailable. Expand response to retry.
            </span>
          ) : store.previewText !== undefined ? (
            store.previewText ? (
              <p className="line-clamp-3 whitespace-pre-wrap break-words">{store.previewText}</p>
            ) : (
              <span className="text-muted-foreground">
                This response has no textual content. Expand response to inspect available
                attachments.
              </span>
            )
          ) : (
            <span className="text-muted-foreground">
              Response preview not loaded. Expand response to read the original report.
            </span>
          )}
        </div>
      )}
      <DisclosureTrigger
        title={store.expanded ? "Collapse response" : "Expand response"}
        subtitle={preview ? undefined : title}
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
              Original message · {title}
            </Link>
            {page && (
              <CopyButton
                getText={() => store.textForCopy()}
                onError={(error) => store.showCopyError(error)}
                disabled={store.loading}
              />
            )}
          </div>
          <div className="break-all text-xs text-muted-foreground">
            {reference}
            {page ? ` · ${page.message.role} · ${page.message.timestamp}` : ""}
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
              <MarkdownLinkProvider
                actions={{
                  openExternalUrl: (url) => actions?.openExternalUrl(url),
                  openSession: (sessionId, messageId, attachmentId) =>
                    actions?.openSession(sessionId, messageId, attachmentId),
                  ...actions,
                  loadWorkspaceImage: store.loadWorkspaceImage,
                  loadAttachmentImage: store.loadAttachmentImage,
                }}
              >
                <Markdown>{page.text || "No textual content."}</Markdown>
              </MarkdownLinkProvider>
              {page.message.inputRefs.map((input) =>
                ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(input.mimeType) ? (
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
