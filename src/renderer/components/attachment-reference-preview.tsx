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
  if (!content || !store.sessionId) return null;
  return (
    <FullscreenSurface
      eyebrow="Original attachment"
      title={content.reference.name}
      onClose={() => store.close()}
    >
      <div className="flex w-full flex-col gap-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>
            {content.reference.mimeType} · {content.reference.byteLength} bytes
          </span>
          <CopyReferenceButton
            reference={attachmentLink(store.sessionId, content.reference.id)}
            label="attachment link"
          />
        </div>
        {content.kind === "image" ? (
          <ImagePreview
            src={`data:${content.mimeType};base64,${content.data}`}
            alt={content.reference.name}
            imageClassName="max-h-[calc(100vh-180px)] max-w-full object-contain"
          />
        ) : (
          <ReadableData value={content.text} />
        )}
        {store.error && <Callout variant="error">{store.error}</Callout>}
        {content.kind === "text" && (content.offset > 0 || content.nextOffset !== null) && (
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              disabled={store.loading || content.offset === 0}
              onClick={() => store.previous()}
            >
              Previous
            </Button>
            <span className="text-xs text-muted-foreground">
              Characters {content.offset + 1}–{content.offset + content.text.length} of{" "}
              {content.totalCharacters}
            </span>
            <Button
              variant="outline"
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
