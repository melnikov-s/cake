import { observer } from "r-state-tree/react";
import type { MessageReferencePreviewStore } from "../stores/MessageReferencePreviewStore";
import { FullscreenSurface } from "./fullscreen-surface";
import { Button } from "./ui/button";
import { Callout } from "./ui/callout";
import { CopyButton } from "./ui/copy-button";
import { Markdown, useMarkdownLinkActions } from "./ai-elements/markdown";
import { ConversationMarkdownProvider } from "./conversation-markdown-provider";

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
      toolbar={
        <div className="flex items-center gap-1.5">
          <CopyButton
            key={page.message.ref}
            getText={() => store.textForCopy()}
            onError={(error) => store.showCopyError(error)}
            disabled={store.loading}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              store.close();
              actions?.openSession(page.message.sessionId);
            }}
          >
            Open conversation
          </Button>
        </div>
      }
    >
      <div className="flex w-full flex-col gap-4">
        <div className="flex items-center justify-between gap-3 rounded-md border border-border/65 bg-muted/35 px-3 py-1.5 font-mono text-xs text-muted-foreground">
          <span className="break-all">
            {page.message.timestamp} · {page.message.ref}
          </span>
        </div>
        <ConversationMarkdownProvider
          stateSessionId={page.message.sessionId}
          loadWorkspaceImage={store.loadWorkspaceImage}
          loadAttachmentImage={store.loadAttachmentImage}
        >
          <Markdown>
            {page.text || "No textual content. Attachments are referenced in message metadata."}
          </Markdown>
        </ConversationMarkdownProvider>
        {store.error && <Callout variant="error">{store.error}</Callout>}
        {store.copyError && (
          <Callout variant="error" role="alert">
            {store.copyError}
          </Callout>
        )}
        {(page.offset > 0 || page.nextOffset !== null) && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border/65 bg-muted/35 px-3 py-2">
            <Button
              variant="outline"
              size="sm"
              disabled={store.loading || page.offset === 0}
              onClick={() => store.previous()}
            >
              Previous
            </Button>
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              Characters {page.offset + 1}–{page.offset + page.text.length} of {page.totalChars}
            </span>
            <Button
              variant="outline"
              size="sm"
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
