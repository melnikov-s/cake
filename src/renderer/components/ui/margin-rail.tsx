import { cn } from "@/lib/utils";
import { Button } from "./button";
import type { ReactNode } from "react";
import { ChevronIcon, ExpandIcon } from "./icons";
import { IconButton } from "./icon-button";

/** An unbordered task heading above the section's message rule. */
export function MarginRail({
  title,
  label,
  completion,
  start,
  onOpen,
  onFocus,
  expanded,
  onToggle,
  showRail = true,
}: {
  title: string;
  label?: ReactNode;
  completion?: ReactNode;
  start: boolean;
  onOpen(): void;
  onFocus(): void;
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
            "pointer-events-none -left-3 border-l-2 border-hairline",
            start
              ? "relative col-start-1 row-start-2 -mb-5 in-[.chat-layout-compact]:-mb-3.5"
              : "absolute inset-y-0",
          )}
        />
      )}
      {start && (
        <div
          data-slot="task-section-label"
          className="group/task-heading col-start-1 row-start-1 mb-3 flex min-w-0 items-center gap-1.5 border-b border-hairline-subtle/75 pb-2"
        >
          {label}
          <Button
            variant="ghost"
            size="sm"
            onClick={(event) => {
              event.stopPropagation();
              onOpen();
            }}
            title={`Show in To-do: ${title}`}
            aria-label={`Show in To-do: ${title}`}
            className="h-auto min-w-0 justify-start whitespace-normal px-0 py-0.5 text-left text-xs font-medium leading-snug text-muted-foreground hover:bg-transparent hover:text-foreground hover:underline"
          >
            <span className="min-w-0 wrap-anywhere">{title}</span>
          </Button>
          <IconButton
            iconSize="inline"
            tooltip={`Focus to-do: ${title}`}
            aria-pressed={false}
            onClick={onFocus}
            className="size-6 opacity-50 transition-opacity hover:opacity-100 group-hover/task-heading:opacity-100 group-has-[:focus-visible]/task-heading:opacity-100"
          >
            <ExpandIcon />
          </IconButton>
          {completion}
          {onToggle && (
            <IconButton
              iconSize="inline"
              data-slot="task-section-disclosure"
              tooltip={`${expanded ? "Collapse" : "Expand"} conversation: ${title}`}
              ariaLabel={title}
              aria-expanded={expanded}
              onClick={onToggle}
              className="ml-auto size-6 text-muted-foreground/75 hover:text-foreground"
            >
              <ChevronIcon className={cn(!expanded && "-rotate-90")} />
            </IconButton>
          )}
        </div>
      )}
    </>
  );
}
