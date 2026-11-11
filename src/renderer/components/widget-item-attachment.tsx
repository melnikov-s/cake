import type { WidgetItemAttachment as WidgetItem } from "../../contracts/widgets/widget-composer-item";
import { AttachmentTile } from "./ui/attachment-tile";
import { Badge } from "./ui/badge";
import { ArtifactIcon } from "./ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

type WidgetItemFields = Pick<WidgetItem, "name" | "itemId" | "data" | "widget">;

const source = (item: WidgetItemFields) => item.widget.title || item.widget.lineageId;

/** Item details as the model receives them; React escapes every widget-provided string. */
function WidgetItemDetails({ item }: { item: WidgetItemFields }) {
  const data = item.data === undefined ? undefined : JSON.stringify(item.data, null, 2);
  return (
    <div className="flex min-w-0 flex-col gap-2 text-xs">
      <p className="text-muted-foreground">
        From {source(item)} · revision {item.widget.revision}
      </p>
      <p className="text-sm font-medium [overflow-wrap:anywhere]">{item.name}</p>
      <p className="font-mono text-muted-foreground [overflow-wrap:anywhere]">{item.itemId}</p>
      {data !== undefined && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2 font-mono [overflow-wrap:anywhere]">
          {data}
        </pre>
      )}
    </div>
  );
}

/** A widget-provided item in the composer (removable) or a sent message. */
export function WidgetItemAttachment({
  item,
  onRemove,
  presentation = "attachment",
}: {
  item: WidgetItemFields;
  onRemove?(): void;
  presentation?: "attachment" | "transcript";
}) {
  if (presentation === "transcript")
    return (
      <Popover>
        <Badge variant="mono" className="w-fit max-w-full p-0" data-slot="widget-item">
          <PopoverTrigger
            variant="ghost"
            className="h-auto min-w-0 gap-1 rounded-full px-2 py-0.5 font-mono text-xs font-normal text-muted-foreground"
            aria-label={`${item.name} from ${source(item)}`}
          >
            <ArtifactIcon size={12} />
            <span className="min-w-0 truncate">{item.name}</span>
          </PopoverTrigger>
        </Badge>
        <PopoverContent className="w-[min(28rem,90vw)]" data-cake-private-preview="true">
          <WidgetItemDetails item={item} />
        </PopoverContent>
      </Popover>
    );
  return (
    <Popover>
      <AttachmentTile
        name={item.name}
        caption={
          <>
            <ArtifactIcon size={12} />
            <span className="truncate">{source(item)}</span>
          </>
        }
        popover
        ariaLabel={`${item.name} from ${source(item)}`}
        onRemove={onRemove}
      />
      <PopoverContent className="w-[min(28rem,90vw)]" data-cake-private-preview="true">
        <WidgetItemDetails item={item} />
      </PopoverContent>
    </Popover>
  );
}
