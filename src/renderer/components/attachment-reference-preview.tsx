import { useImageCopy } from "@/lib/use-image-copy";
import { CopyButton } from "./ui/copy-button";
import { observer } from "r-state-tree/react";
import type { AttachmentReferencePreviewStore } from "../stores/AttachmentReferencePreviewStore";
import { attachmentLink } from "../../contracts/conversations/message-reference";
import { FullscreenSurface } from "./fullscreen-surface";
import { ImagePreview } from "./image-preview";
import { Button } from "./ui/button";
import { Callout } from "./ui/callout";
import { CopyReferenceButton } from "./ui/copy-reference-button";
import { ReadableData } from "./ui/readable-data";

export const AttachmentReferencePreview = observer(function AttachmentReferencePreview({
  store,
}: {
  store: AttachmentReferencePreviewStore;
}) {
  const content = store.content;
  const { copy, error: copyError } = useImageCopy(
    content?.kind === "image" ? `data:${content.mimeType};base64,${content.data}` : "",
  );
  if (!content || !store.sessionId) return null;
  return (
    <FullscreenSurface
      eyebrow="Original attachment"
      title={content.reference.name}
      onClose={() => store.close()}
      toolbar={
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {content.reference.mimeType} · {content.reference.byteLength} bytes
          </span>
          {content.kind === "image" && <CopyButton label="image" copy={copy} />}
          <CopyReferenceButton
            reference={attachmentLink(store.sessionId, content.reference.id)}
            label="attachment link"
          />
        </div>
      }
    >
      <div className="flex w-full flex-col gap-4">
        {content.kind === "image" ? (
          <ImagePreview
            src={`data:${content.mimeType};base64,${content.data}`}
            alt={content.reference.name}
            imageClassName="max-h-[calc(100vh-180px)] max-w-full rounded-lg border border-border/65 object-contain"
          />
        ) : (
          <ReadableData value={content.text} />
        )}
        {(copyError || store.error) && (
          <Callout variant="error">{copyError || store.error}</Callout>
        )}
        {content.kind === "text" && (content.offset > 0 || content.nextOffset !== null) && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border/65 bg-muted/35 px-3 py-2">
            <Button
              variant="outline"
              size="sm"
              disabled={store.loading || content.offset === 0}
              onClick={() => store.previous()}
            >
              Previous
            </Button>
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              Characters {content.offset + 1}–{content.offset + content.text.length} of{" "}
              {content.totalCharacters}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={store.loading || content.nextOffset === null}
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
