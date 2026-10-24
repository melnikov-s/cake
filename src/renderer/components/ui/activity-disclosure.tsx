import { useId, useRef, useState, type ReactNode } from "react";
import { Button } from "./button";
import { ChevronIcon } from "./icons";
import { StatusDot, type StatusDotProps } from "./status-dot";
import { cn } from "@/lib/utils";

interface ActivityDisclosureItem {
  id: string;
  title: string;
  description: string;
  status: StatusDotProps["status"];
  icon: ReactNode;
  iconLabel: string;
  action?: string;
  accessibleLabel: string;
  onSelect(): void;
}

/** Compact entry and disclosure for a conversation's delegated work. */
export function ActivityDisclosure({
  summary,
  status,
  items,
  onOpen,
  presentation = "pill",
}: {
  summary: string;
  status: StatusDotProps["status"];
  items: readonly ActivityDisclosureItem[];
  onOpen?(): void;
  presentation?: "pill" | "strip";
}) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div
      data-slot="activity-disclosure"
      className={cn("flex min-w-0 shrink-0 flex-col", presentation === "strip" && "-mx-5 -mt-3")}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }}
    >
      <Button
        ref={triggerRef}
        variant={presentation === "strip" ? "ghost" : "outline"}
        size="sm"
        data-slot={presentation === "strip" ? "composer-activity" : undefined}
        className={cn(
          "gap-1.5 font-mono text-xs",
          presentation === "strip"
            ? "h-9 w-full shrink-0 justify-start rounded-none rounded-t-[1.75rem] bg-muted/20 px-5 shadow-none"
            : "h-7 rounded-full bg-card/95 px-2.5 shadow-sm",
        )}
        aria-label={`Activity · ${summary}`}
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => {
          if (!open) onOpen?.();
          setOpen(!open);
        }}
      >
        <StatusDot status={status} />
        <span className={presentation === "pill" ? "@max-[640px]/session-pane:hidden" : undefined}>
          Activity ·
        </span>
        <span>{summary}</span>
        <ChevronIcon className={cn(presentation === "strip" && "ml-auto", open && "rotate-180")} />
      </Button>
      <div
        id={contentId}
        role="region"
        aria-label="Conversation activity"
        hidden={!open}
        className={cn(
          "grid max-h-[min(16rem,35vh)] min-w-0 gap-1 overflow-y-auto overscroll-contain p-2",
          presentation === "strip" && "border-t border-border/65",
          !open && "hidden",
        )}
      >
        {items.map((item) => (
          <Button
            key={item.id}
            variant="ghost"
            className="h-auto min-w-0 justify-start gap-2 px-2.5 py-2 text-left"
            aria-label={item.accessibleLabel}
            aria-description={`${item.iconLabel} · ${item.description}`}
            title={`${item.iconLabel}: ${item.title} — ${item.description}`}
            onClick={() => {
              item.onSelect();
              setOpen(false);
            }}
          >
            <span
              role="img"
              aria-label={item.iconLabel}
              title={item.iconLabel}
              className="flex shrink-0 text-muted-foreground"
            >
              {item.icon}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium">{item.title}</span>
              <span className="block truncate font-mono text-xs font-normal text-muted-foreground">
                {item.description}
              </span>
            </span>
            {item.action && <span className="shrink-0 text-xs font-normal">{item.action}</span>}
            <span className="flex w-[7px] shrink-0 justify-center">
              {item.status && <StatusDot status={item.status} />}
            </span>
          </Button>
        ))}
      </div>
    </div>
  );
}
