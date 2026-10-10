import { IconButton } from "./icon-button";
import { CloseIcon } from "./icons";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

/** Compact pasted-input preview. Presentation only; opening it never changes model access. */
export function TextAttachment({
  name,
  text,
  onRemove,
}: {
  name: string;
  text: string;
  onRemove?(): void;
}) {
  const preview = text.slice(0, 16_000);
  return (
    <div className="flex items-center gap-1" data-slot="text-attachment">
      <Popover>
        <PopoverTrigger
          variant="outline"
          size="sm"
          className="h-6 rounded-full px-2 font-mono text-xs"
        >
          {name}
        </PopoverTrigger>
        <PopoverContent className="w-[min(36rem,90vw)]" data-cake-private-preview="true">
          <p className="mb-2 text-xs text-muted-foreground">
            Attachment preview · opening this does not change model access
          </p>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap font-mono text-xs">
            {preview}
          </pre>
          {preview.length < text.length && (
            <p className="mt-2 text-xs text-muted-foreground">
              Showing the first 16,000 characters. The complete original is attached.
            </p>
          )}
        </PopoverContent>
      </Popover>
      {onRemove && (
        <IconButton tooltip={`Remove ${name}`} onClick={onRemove}>
          <CloseIcon size={12} />
        </IconButton>
      )}
    </div>
  );
}
