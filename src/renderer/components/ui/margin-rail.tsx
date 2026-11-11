import { cn } from "@/lib/utils";
import { Button } from "./button";
import { CheckIcon, ChevronIcon, CircleIcon, ExpandIcon } from "./icons";
import { IconButton } from "./icon-button";
import { IconSizeProvider } from "./icon-size";

/** An unbordered task heading above the section's message rule. */
export function MarginRail({
  title,
  done,
  start,
  onOpen,
  onFocus,
  focused,
  expanded,
  onToggle,
  showRail = true,
}: {
  title: string;
  done: boolean;
  start: boolean;
  onOpen(): void;
  onFocus(): void;
  focused: boolean;
  expanded: boolean;
  onToggle?(): void;
  showRail?: boolean;
}) {
  return (
    <>
      {expanded && showRail && (
        <div
          data-slot="margin-rail"
          aria-hidden="true"
          className={cn(
            "pointer-events-none -left-3 border-l-4 border-border",
            start
              ? "relative col-start-1 row-start-2 -mb-5 in-[.chat-layout-compact]:-mb-3.5"
              : "absolute inset-y-0",
          )}
        />
      )}
      {start && (
        <div
          data-slot="task-section-label"
          // Keep a modest outdent from the message column, bounded by the
          // transcript inset when the pane is narrow.
          className="col-start-1 row-start-1 mb-3 ml-[clamp(-6rem,calc((100%_-_100cqw)/2_+_1.5rem),-0.75rem)] flex min-w-0 items-start"
        >
          <span
            role="img"
            aria-label={done ? "Done" : "Open"}
            className={cn(
              "mt-1.5 mr-2 ml-1 shrink-0 text-muted-foreground",
              done && "text-success",
            )}
          >
            <IconSizeProvider size="inline">
              {done ? <CheckIcon /> : <CircleIcon />}
            </IconSizeProvider>
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={(event) => {
              event.stopPropagation();
              onOpen();
            }}
            title={`Show in To-do: ${title}`}
            aria-label={`Show in To-do: ${title}`}
            className="h-auto min-w-0 justify-start whitespace-normal px-0 py-1 text-left leading-snug hover:bg-transparent hover:underline"
          >
            <span className="min-w-0 wrap-anywhere">{title}</span>
          </Button>
          {!focused && (
            <IconButton
              iconSize="inline"
              tooltip={`Focus to-do: ${title}`}
              aria-pressed={false}
              onClick={onFocus}
            >
              <ExpandIcon />
            </IconButton>
          )}
          {onToggle && (
            <IconButton
              iconSize="inline"
              data-slot="task-section-disclosure"
              tooltip={`${expanded ? "Collapse" : "Expand"} conversation: ${title}`}
              ariaLabel={title}
              aria-expanded={expanded}
              onClick={onToggle}
              className="flex h-auto min-h-7 w-auto min-w-7 flex-1 self-stretch items-start justify-end px-1 py-1"
            >
              <ChevronIcon className={cn("mt-1 shrink-0", !expanded && "-rotate-90")} />
            </IconButton>
          )}
        </div>
      )}
    </>
  );
}
