import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { IconButton } from "./icon-button";
import { CloseIcon } from "./icons";
import { PopoverTrigger } from "./popover";

/** One fixed-size composer surface with image thumbnails or file labels. */
export function AttachmentTile({
  name,
  displayName = name,
  imageSrc,
  caption,
  onRemove,
  onClick,
  popover = false,
  ariaLabel,
}: {
  name: string;
  displayName?: string;
  imageSrc?: string;
  /** One muted line under a text label, e.g. where the attachment came from. */
  caption?: ReactNode;
  onRemove?(): void;
  onClick?(): void;
  popover?: boolean;
  ariaLabel?: string;
}) {
  const bodyClassName = cn(
    "flex h-full w-full items-center justify-center rounded-lg font-mono text-xs font-normal leading-4 text-foreground",
    imageSrc ? "overflow-hidden p-1" : caption ? "flex-col gap-1 px-4 py-3" : "px-4 py-6",
  );
  const content = imageSrc ? (
    <img
      src={imageSrc}
      alt={name}
      title={name}
      draggable={false}
      className="h-full w-full rounded-md object-contain"
    />
  ) : (
    <>
      <span
        className="min-w-0 line-clamp-2 whitespace-pre-line text-center [overflow-wrap:anywhere]"
        data-slot="attachment-label"
        title={name}
      >
        {displayName}
      </span>
      {caption && (
        <span
          className="flex max-w-full min-w-0 items-center gap-1 font-sans text-muted-foreground"
          data-slot="attachment-caption"
        >
          {caption}
        </span>
      )}
    </>
  );
  return (
    <div
      className="relative h-20 w-48 shrink-0 rounded-lg border border-border bg-card/40"
      data-slot="attachment-tile"
    >
      {popover ? (
        <PopoverTrigger variant="ghost" className={bodyClassName} aria-label={ariaLabel}>
          {content}
        </PopoverTrigger>
      ) : onClick ? (
        <Button variant="ghost" className={bodyClassName} aria-label={ariaLabel} onClick={onClick}>
          {content}
        </Button>
      ) : (
        <div className={bodyClassName}>{content}</div>
      )}
      {onRemove && (
        <IconButton
          iconSize="inline"
          className="absolute right-1 top-1 size-5 rounded-md"
          tooltip={`Remove ${name}`}
          onClick={onRemove}
        >
          <CloseIcon size={12} />
        </IconButton>
      )}
    </div>
  );
}
