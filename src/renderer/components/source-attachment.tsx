import type { SourceLocation } from "../../ipc/source-location";
import { formatSourceLocation } from "../../utils/source-location";
import { CodeBlock } from "./ai-elements/code";
import { Button } from "./ui/button";
import { IconButton } from "./ui/icon-button";
import { CloseIcon } from "./ui/icons";

/** Inspectable composer context created from an exact embedded-VS-Code selection. */
export function SourceAttachment({
  attachment,
  onOpen,
  onRemove,
}: {
  attachment: { name: string; location: SourceLocation; selectedText: string };
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
    <details className="group relative w-full rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
      <summary className="cursor-pointer list-none pr-8 font-mono text-xs font-medium marker:hidden">
        <span className="block truncate" title={label}>
          {label}
        </span>
      </summary>
      <CodeBlock className="mb-2 mt-3 max-h-56 whitespace-pre overflow-auto rounded-md p-3">
        {attachment.selectedText}
      </CodeBlock>
      {onOpen ? (
        <Button variant="outline" size="sm" onClick={() => onOpen(attachment.location)}>
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
    </details>
  );
}
