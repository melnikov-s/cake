import { observer } from "r-state-tree/react";
import type { MessageReferencePreviewStore } from "../stores/MessageReferencePreviewStore";
import { FullscreenSurface } from "./fullscreen-surface";
import { Button } from "./ui/button";
import { Callout } from "./ui/callout";

/** Read-only Pi source evidence for a message outside the visible continuation. */
export const MessageReferencePreview = observer(function MessageReferencePreview({
  store,
}: {
  store: MessageReferencePreviewStore;
}) {
  const page = store.page;
  if (!page) return null;
  return (
    <FullscreenSurface
      eyebrow="Original message"
      title={`${page.message.role} · ${page.message.entryId}`}
      onClose={() => store.close()}
    >
      <div className="flex w-full flex-col gap-4">
        <Callout>
          This exact message is outside the visible conversation. Viewing its Pi original does not
          change the active branch or the agent’s context.
        </Callout>
        <div className="text-xs text-muted-foreground">
          {page.message.timestamp} · {page.message.ref}
        </div>
        <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
          {page.text || "No textual content. Attachments are referenced in message metadata."}
        </div>
        {store.error && <Callout variant="error">{store.error}</Callout>}
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
