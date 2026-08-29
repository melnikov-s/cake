import type { SourceLocation } from "../../ipc/source-location";
import { formatSourceLocation } from "../../utils/source-location";
import { Button } from "./ui/button";
import { IconButton } from "./ui/icon-button";
import { CloseIcon } from "./ui/icons";

/** Composer context created from an explicit embedded-VS-Code user selection. */
export function SourceAttachment({
  attachment,
  onOpen,
  onRemove,
}: {
  attachment: { name: string; location: SourceLocation };
  onOpen?(location: SourceLocation): void;
  onRemove?(): void;
}) {
  const start = attachment.location.range?.start;
  const end = attachment.location.range?.end;
  const label =
    start?.column !== undefined && end?.column !== undefined
      ? `${attachment.location.path}:${start.line + 1}:${start.column + 1}-${end.line + 1}:${end.column + 1}`
      : formatSourceLocation(attachment.location);
  return (
    <div className="group relative w-full rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
      <span className="block truncate pr-8 font-mono text-xs font-medium" title={label}>
        {label}
      </span>
      {onOpen ? (
        <Button
          className="mt-2"
          variant="outline"
          size="sm"
          onClick={() => onOpen(attachment.location)}
        >
          Open in VS Code
        </Button>
      ) : null}
      {onRemove ? (
        <IconButton
          className="absolute right-2 top-1.5"
          tooltip={`Remove ${label}`}
          onClick={onRemove}
        >
          <CloseIcon size={14} />
        </IconButton>
      ) : null}
    </div>
  );
}
