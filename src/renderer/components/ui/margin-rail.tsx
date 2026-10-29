import { cn } from "@/lib/utils";
import { Button } from "./button";
import { CheckIcon, CircleIcon } from "./icons";

/** Labels task switches in the gutter when it fits, otherwise in the reading flow. */
export function MarginRail({
  title,
  status,
  done,
  start,
  onOpen,
}: {
  title: string;
  status: string;
  done: boolean;
  start: boolean;
  onOpen(): void;
}) {
  return (
    <>
      <div
        data-slot="margin-rail"
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-y-0 -left-3 border-l border-border @min-[76rem]/transcript:-left-5",
          start && "top-8",
        )}
      />
      {start && (
        <div
          data-slot="task-section-label"
          // A zero-outer-width float uses only the gutter, but still contributes
          // its full height to the flow-root row so long labels cannot overlap.
          className="mb-3 min-w-0 @min-[76rem]/transcript:float-left @min-[76rem]/transcript:mr-8 @min-[76rem]/transcript:-ml-48 @min-[76rem]/transcript:w-40 in-[[data-slot=transcript-item]:has([data-slot=artifact-disclosure],[data-widget-view-id])]:float-none in-[[data-slot=transcript-item]:has([data-slot=artifact-disclosure],[data-widget-view-id])]:mx-0 in-[[data-slot=transcript-item]:has([data-slot=artifact-disclosure],[data-widget-view-id])]:w-auto"
        >
          <Button
            variant="ghost"
            size="sm"
            onClick={onOpen}
            title={`Show in To-do: ${title}`}
            className="h-auto max-w-full items-start justify-start gap-2 whitespace-normal px-1 py-1 text-left leading-snug"
          >
            {done ? (
              <span className="mt-0.5 shrink-0 text-success [&_svg]:size-3.5">
                <CheckIcon />
              </span>
            ) : (
              <span className="mt-0.5 shrink-0 [&_svg]:size-3.5">
                <CircleIcon />
              </span>
            )}
            <span className="min-w-0 wrap-anywhere">{title}</span>
          </Button>
          <p className="mt-1 pl-6 text-xs leading-snug wrap-anywhere text-muted-foreground">
            {done ? "Done" : status || "Open"}
          </p>
        </div>
      )}
    </>
  );
}
