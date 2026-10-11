import { AttachmentTile } from "./attachment-tile";
import { Popover, PopoverContent } from "./popover";

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
    <Popover>
      <AttachmentTile
        name={name}
        displayName={name.replace(" · ", "\n")}
        popover
        onRemove={onRemove}
      />
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
  );
}
