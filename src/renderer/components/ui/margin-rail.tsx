import { cn } from "@/lib/utils";
import { Button } from "./button";
import { CheckIcon, CircleIcon } from "./icons";

/** An unbordered task heading above the section's message rule. */
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
          "pointer-events-none -left-3 border-l border-border",
          start
            ? "relative col-start-1 row-start-2 -mb-5 in-[.chat-layout-compact]:-mb-3.5"
            : "absolute inset-y-0",
        )}
      />
      {start && (
        <div
          data-slot="task-section-label"
          // Keep a modest outdent from the message column, bounded by the
          // transcript inset when the pane is narrow.
          className="col-start-1 row-start-1 mb-3 ml-[clamp(-6rem,calc((100%_-_100cqw)/2_+_1.5rem),-0.75rem)] min-w-0"
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
