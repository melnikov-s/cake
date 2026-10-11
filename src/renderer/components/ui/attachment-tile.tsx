import { Button } from "./button";
import { IconButton } from "./icon-button";
import { CloseIcon } from "./icons";
import { PopoverTrigger } from "./popover";

/** One fixed-size, label-first surface for every composer attachment. */
export function AttachmentTile({
  name,
  displayName = name,
  onRemove,
  onClick,
  popover = false,
  ariaLabel,
}: {
  name: string;
  displayName?: string;
  onRemove?(): void;
  onClick?(): void;
  popover?: boolean;
  ariaLabel?: string;
}) {
  const bodyClassName =
    "flex h-full w-full items-center justify-center rounded-lg px-4 py-6 font-mono text-xs font-normal leading-4 text-foreground";
  const label = (
    <span
      className="min-w-0 line-clamp-2 whitespace-pre-line text-center [overflow-wrap:anywhere]"
      data-slot="attachment-label"
      title={name}
    >
      {displayName}
    </span>
  );
  return (
    <div
      className="relative h-20 w-48 shrink-0 rounded-lg border border-border bg-card/40"
      data-slot="attachment-tile"
    >
      {popover ? (
        <PopoverTrigger variant="ghost" className={bodyClassName} aria-label={ariaLabel}>
          {label}
        </PopoverTrigger>
      ) : onClick ? (
        <Button variant="ghost" className={bodyClassName} aria-label={ariaLabel} onClick={onClick}>
          {label}
        </Button>
      ) : (
        <div className={bodyClassName}>{label}</div>
      )}
      {onRemove && (
        <IconButton
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
