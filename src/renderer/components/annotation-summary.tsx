import { AnnotationIcon, RemoveIcon } from "@/components/ui/icons";
import { IconButton } from "@/components/ui/icon-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { Annotation } from "../../ipc/session-contract";

export function AnnotationSummary({
  annotations,
  onRemove,
  className,
}: {
  annotations: readonly Annotation[];
  onRemove?(id: string): void;
  className?: string;
}) {
  if (annotations.length === 0) return null;
  const label = `${annotations.length} annotation${annotations.length === 1 ? "" : "s"}`;
  return (
    <Popover>
      <PopoverTrigger
        variant="outline"
        size="sm"
        className={cn("w-fit gap-1.5 rounded-full px-3 text-muted-foreground", className)}
        aria-label={`View ${label}`}
      >
        <AnnotationIcon size={15} />
        {label}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        className="max-h-80 w-[min(24rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-border bg-popover p-2 shadow-xl"
        aria-label={label}
      >
        <div className="px-2 py-1 text-xs font-semibold text-foreground">{label}</div>
        <div className="grid gap-1">
          {annotations.map((annotation, index) => (
            <div key={annotation.id} className="group rounded-lg bg-muted/60 p-2.5">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="mb-1 text-[11px] font-medium text-muted-foreground">
                    Annotation {index + 1}
                  </div>
                  <blockquote className="line-clamp-4 whitespace-pre-wrap border-l-2 border-border pl-2 text-xs text-foreground">
                    {annotation.selectedText}
                  </blockquote>
                  {annotation.comment ? (
                    <p className="mt-2 whitespace-pre-wrap text-xs text-foreground">
                      {annotation.comment}
                    </p>
                  ) : null}
                </div>
                {onRemove ? (
                  <IconButton
                    tooltip="Remove annotation"
                    ariaLabel={`Remove annotation ${index + 1}`}
                    onClick={() => onRemove(annotation.id)}
                  >
                    <RemoveIcon />
                  </IconButton>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
