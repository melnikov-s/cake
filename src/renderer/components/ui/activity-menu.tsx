import { useState } from "react";
import { Button } from "./button";
import { ChevronIcon } from "./icons";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { StatusDot, type StatusDotProps } from "./status-dot";

interface ActivityMenuItem {
  id: string;
  title: string;
  description: string;
  status: StatusDotProps["status"];
  action?: string;
  accessibleLabel: string;
  onSelect(): void;
}

export interface ActivityMenuGroup {
  label: string;
  items: readonly ActivityMenuItem[];
}

/** Compact header entry and grouped disclosure for a conversation's delegated work. */
export function ActivityMenu({
  summary,
  status,
  groups,
  onOpen,
}: {
  summary: string;
  status: StatusDotProps["status"];
  groups: readonly ActivityMenuGroup[];
  onOpen?(): void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        variant="outline"
        size="sm"
        className="h-7 gap-1.5 rounded-full bg-card/95 px-2.5 font-mono text-[10px] shadow-sm"
        aria-label={`Activity · ${summary}`}
        onClick={onOpen}
      >
        <StatusDot status={status} />
        <span className="@max-[640px]/session-pane:hidden">Activity ·</span>
        <span>{summary}</span>
        <ChevronIcon />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        className="w-[min(24rem,calc(100vw-24px))] p-2"
        aria-label="Conversation activity"
      >
        <div className="grid max-h-80 gap-2 overflow-y-auto">
          {groups
            .filter((group) => group.items.length > 0)
            .map((group) => (
              <section key={group.label} aria-label={group.label}>
                <h3 className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
                  {group.label}
                </h3>
                <div className="grid gap-1">
                  {group.items.map((item) => (
                    <Button
                      key={item.id}
                      variant="ghost"
                      className="h-auto min-w-0 justify-start gap-2 px-2.5 py-2 text-left"
                      aria-label={item.accessibleLabel}
                      title={`${item.title} — ${item.description}`}
                      onClick={() => {
                        item.onSelect();
                        setOpen(false);
                      }}
                    >
                      <StatusDot status={item.status} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium">{item.title}</span>
                        <span className="block truncate font-mono text-[10px] font-normal text-muted-foreground">
                          {item.description}
                        </span>
                      </span>
                      {item.action && (
                        <span className="shrink-0 text-[10px] font-normal">{item.action}</span>
                      )}
                    </Button>
                  ))}
                </div>
              </section>
            ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
