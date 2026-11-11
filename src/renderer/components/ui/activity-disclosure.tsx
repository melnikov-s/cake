import { useId, useRef, useState, type ReactNode } from "react";
import { Button } from "./button";
import { ChevronIcon, ChatIcon, ForkIcon } from "./icons";
import { StatusDot, type StatusDotProps } from "./status-dot";
import { InsetDisclosures, type InsetDisclosureSection } from "./inset-disclosures";
import { cn } from "@/lib/utils";
import { textPreview } from "@/lib/text-preview";

interface ActivityDisclosureItem {
  id: string;
  title: string;
  description: string;
  status: StatusDotProps["status"];
  icon: ReactNode;
  iconLabel: string;
  accessibleLabel: string;
  onSelect(): void;
}

/** Running work, presented in header chrome or in the composer's shared inset stack. */
export function ActivityDisclosure({
  summary,
  status,
  items,
  onOpen,
  actions,
  presentation = "pill",
  sessionCount = 0,
  subagentCount = 0,
  sections = [],
}: {
  summary: string;
  status: StatusDotProps["status"];
  items: readonly ActivityDisclosureItem[];
  onOpen?(): void;
  actions?: ReactNode;
  presentation?: "pill" | "inset";
  sessionCount?: number;
  subagentCount?: number;
  sections?: readonly InsetDisclosureSection[];
}) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const renderItems = (collapse: () => void) =>
    items.map((item) => (
      <Button
        key={item.id}
        variant="ghost"
        className="h-auto min-h-11 min-w-0 w-full justify-start gap-2 px-1.5 py-1.5 text-left"
        aria-label={item.accessibleLabel}
        aria-description={`${item.iconLabel} · ${item.description}`}
        title={`${item.iconLabel}: ${item.title} — ${item.description}`}
        onClick={() => {
          item.onSelect();
          collapse();
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
        <span className="min-w-0 flex-1 whitespace-normal [overflow-wrap:anywhere]">
          <span className="line-clamp-3 text-xs font-medium text-foreground">
            {textPreview(item.title)}
          </span>
          <span className="line-clamp-2 text-xs font-normal text-muted-foreground">
            {textPreview(item.description)}
          </span>
        </span>
        <span className="flex w-[7px] shrink-0 justify-center">
          {item.status && <StatusDot status={item.status} />}
        </span>
      </Button>
    ));

  if (presentation === "inset")
    return (
      <InsetDisclosures
        sections={[
          ...(items.length
            ? [
                {
                  id: "activity",
                  label: "Activity",
                  count: items.length,
                  icon: <ForkIcon />,
                  accessibleLabel: `Activity · ${summary}`,
                  accessibleDescription: `${sessionCount} Project Sessions and ${subagentCount} Temporary subagents`,
                  regionLabel: "Conversation activity",
                  summary: (
                    <>
                      <span
                        className="flex items-center gap-1"
                        title={`${sessionCount} Project Sessions`}
                      >
                        <ForkIcon />
                        {sessionCount}
                      </span>
                      <span
                        className="flex items-center gap-1"
                        title={`${subagentCount} Temporary subagents`}
                      >
                        <ChatIcon />
                        {subagentCount}
                      </span>
                    </>
                  ),
                  onOpen,
                  actions,
                  renderContent: renderItems,
                },
              ]
            : []),
          ...sections,
        ]}
      />
    );

  return (
    <div
      data-slot="activity-disclosure"
      className="flex min-w-0 shrink-0 flex-col"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }}
    >
      <div className="flex min-w-0 items-center">
        <Button
          iconSize="inline"
          ref={triggerRef}
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 rounded-full bg-card/95 px-2.5 font-mono text-xs shadow-sm"
          aria-label={`Activity · ${summary}`}
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => {
            if (!open) onOpen?.();
            setOpen(!open);
          }}
        >
          <StatusDot status={status} />
          <span className="@max-[640px]/session-pane:hidden">Activity ·</span>
          <span>{summary}</span>
          <ChevronIcon className={cn(open && "rotate-180")} />
        </Button>
        {actions}
      </div>
      <div
        id={contentId}
        role="region"
        aria-label="Conversation activity"
        hidden={!open}
        className={cn(
          "grid max-h-[min(16rem,35vh)] min-w-0 gap-1 overflow-y-auto overscroll-contain p-2",
          !open && "hidden",
        )}
      >
        {renderItems(() => setOpen(false))}
      </div>
    </div>
  );
}
