import { observer } from "r-state-tree/react";
import type { MessageReferencePreviewStore } from "../stores/MessageReferencePreviewStore";
import { FullscreenSurface } from "./fullscreen-surface";
import { Button } from "./ui/button";
import { Callout } from "./ui/callout";
import { CopyButton } from "./ui/copy-button";
import { Markdown, useMarkdownLinkActions } from "./ai-elements/markdown";

/** Read-only Pi source evidence for a message outside the visible continuation. */
export const MessageReferencePreview = observer(function MessageReferencePreview({
  store,
}: {
  store: MessageReferencePreviewStore;
}) {
  const actions = useMarkdownLinkActions();
  const page = store.page;
  if (!page) return null;
  return (
    <FullscreenSurface
      eyebrow="Original message"
      title={`${page.message.role} · ${page.message.entryId}`}
      onClose={() => store.close()}
    >
      <div className="flex w-full flex-col gap-4">
        <div>
          <Button
            variant="outline"
            onClick={() => {
              store.close();
              actions?.openSession(page.message.sessionId);
            }}
          >
            Open conversation
          </Button>
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="break-all text-xs text-muted-foreground">
            {page.message.timestamp} · {page.message.ref}
          </div>
          <CopyButton
            key={page.message.ref}
            getText={() => store.textForCopy()}
            onError={(error) => store.showCopyError(error)}
            disabled={store.loading}
          />
        </div>
        <Markdown>
          {page.text || "No textual content. Attachments are referenced in message metadata."}
        </Markdown>
        {store.error && <Callout variant="error">{store.error}</Callout>}
        {store.copyError && (
          <Callout variant="error" role="alert">
            {store.copyError}
          </Callout>
        )}
        {(page.offset > 0 || page.nextOffset !== null) && (
          <div className="flex items-center gap-3">
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
      </div>
    </FullscreenSurface>
  );
});
