import { Button } from "./button";
import { CheckIcon, CircleIcon } from "./icons";

/** Labels a task switch in the reading flow; only the continuation rule uses the gutter. */
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
        className="pointer-events-none absolute inset-y-0 -left-5 hidden border-l border-border @min-[72rem]/transcript:block"
      />
      {start && (
        <div data-slot="task-section-label" className="mb-3 min-w-0">
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
          <p className="mt-1 pl-6 text-xs leading-snug text-muted-foreground">
            {done ? "Done" : status || "Open"}
          </p>
        </div>
      )}
    </>
  );
}
