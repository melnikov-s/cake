import { useEffect, useId } from "react";
import { observer } from "r-state-tree/react";
import { ImagePreview } from "@/components/image-preview";
import { AttachmentReference } from "@/components/ui/attachment-reference";
import { LoadingSpinner } from "@/components/ui/loading-state";
import { IconButton } from "@/components/ui/icon-button";
import { ChevronIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import type { TranscriptInteractionStore } from "../stores/TranscriptInteractionStore";
import type { UiPart } from "../../contracts/conversations/session-contract";
import type { TranscriptAttachmentImagesStore } from "../stores/TranscriptAttachmentImagesStore";

/**
 * A user's image in the transcript. Pending, saved-with-pixels and vaulted-reference
 * forms share a collapsible frame and caption row. Disclosure belongs to the
 * transcript interaction owner so folding a task or virtualizing a row preserves it.
 */
export const TranscriptImageAttachment = observer(function TranscriptImageAttachment({
  part,
  interaction,
  sessionId,
  images,
}: {
  part: Extract<UiPart, { kind: "attachment" }>;
  interaction: TranscriptInteractionStore;
  sessionId?: string;
  images?: TranscriptAttachmentImagesStore;
}) {
  const bodyId = useId();
  const expanded = interaction.imageExpanded(part.id);
  const reference = part.inputReference;
  const vaulted = part.data === undefined && reference ? images?.image(reference.id) : undefined;
  useEffect(() => {
    if (part.data === undefined && reference) void images?.load(reference);
  }, [images, part.data, reference]);
  const src =
    part.data !== undefined
      ? `data:${part.mediaType};base64,${part.data}`
      : vaulted?.status === "ready"
        ? vaulted.src
        : undefined;
  const name = reference?.name ?? part.name;
  return (
    <figure className="my-1 mb-2 ml-auto w-[min(76%,34rem)] overflow-hidden rounded-[14px] border border-border bg-card">
      <figcaption className="flex h-8 min-w-0 items-center gap-1 px-1 text-xs text-muted-foreground">
        <IconButton
          tooltip={`${expanded ? "Collapse" : "Expand"} image: ${name}`}
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => interaction.toggleImage(part.id)}
        >
          <ChevronIcon aria-hidden="true" className={cn(!expanded && "-rotate-90")} />
        </IconButton>
        {reference && sessionId ? (
          <AttachmentReference sessionId={sessionId} reference={reference} />
        ) : (
          <span className="truncate">{name}</span>
        )}
      </figcaption>
      <div
        id={bodyId}
        hidden={!expanded}
        className={cn(expanded && "flex aspect-[16/10] items-center justify-center bg-muted/40")}
      >
        {expanded &&
          (src ? (
            <ImagePreview
              src={src}
              alt={name}
              caption={name}
              className="flex size-full items-center justify-center rounded-none"
              imageClassName="max-h-full max-w-full object-contain"
            />
          ) : vaulted?.status === "unavailable" ? (
            <span title={vaulted.error} className="px-3 text-xs text-muted-foreground">
              Image not available
            </span>
          ) : (
            <LoadingSpinner label={`Loading ${name}`} />
          ))}
      </div>
    </figure>
  );
});
