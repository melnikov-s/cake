import { useState } from "react";
import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Button } from "./ui/button";
import { CheckIcon, ChevronIcon, WidgetIcon } from "./ui/icons";
import { cn } from "../lib/utils";
import type { WorkspaceTabPresentation } from "../lib/workspace-tab-stage";

/**
 * The widget tab: once bound to a widget it shows that widget; the chevron rebinds/clears it.
 * Narrow strips show the widget icon (title in tooltip/aria), then only the chevron menu.
 * `measure` renders the same geometry inertly, for the strip's hidden width rows.
 */
export const WidgetTabPicker = observer(function WidgetTabPicker({
  display = "full",
  measure = false,
}: {
  display?: WorkspaceTabPresentation["widget"];
  measure?: boolean;
}) {
  const root = useStore(RootStore);
  const store = root.widgetAttachmentStore;
  const widgets = store.availableTabWidgets;
  const navigator = root.workspaceNavigatorStore;
  const selected = navigator.selectedWidget;
  const active = navigator.showingWidget;
  const [open, setOpen] = useState(false);
  if (!widgets.length) return null;
  const title = selected ? store.title(selected) : undefined;
  const Trigger = measure ? Button : PopoverTrigger;
  const trigger =
    selected && display !== "menu" ? (
      <div
        className={cn(
          "flex h-7 min-w-0 shrink-0 items-center rounded-lg border transition-colors",
          active
            ? "border-accent/35 bg-accent/15 text-accent"
            : "border-transparent text-muted-foreground hover:bg-foreground/[0.055]",
        )}
      >
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={active}
          aria-label={`Widget tab: ${title}`}
          title={title}
          className={cn(
            "h-full min-w-0 shrink-0 rounded-l-lg rounded-r-none pr-0.5 text-xs hover:bg-transparent",
            display === "full" ? "pl-2" : "pl-1.5",
            active && "font-semibold text-accent hover:text-accent",
          )}
          onClick={measure ? undefined : () => navigator.showWidget()}
        >
          {display === "full" ? (
            <span className="max-w-40 min-w-0 truncate">{title}</span>
          ) : (
            <WidgetIcon />
          )}
        </Button>
        <Trigger
          size="sm"
          variant="ghost"
          className={cn(
            "h-full shrink-0 rounded-l-none rounded-r-lg px-1 hover:bg-transparent",
            active && "text-accent hover:text-accent",
          )}
          aria-label="Widget tabs"
          aria-haspopup="menu"
          title="Choose widget"
        >
          <ChevronIcon />
        </Trigger>
      </div>
    ) : (
      <Trigger
        size="sm"
        variant="ghost"
        data-active={selected && active ? true : undefined}
        className={cn(
          "h-7 min-w-0 shrink-0 gap-1 rounded-lg border text-xs",
          display === "full" ? "px-2" : "px-1",
          selected && active
            ? "border-accent/35 bg-accent/15 font-semibold text-accent hover:bg-accent/15 hover:text-accent"
            : "border-transparent hover:bg-foreground/[0.055]",
        )}
        aria-label="Widget tabs"
        aria-haspopup="menu"
        title={title ? `Widgets · ${title}` : "Widgets"}
      >
        {display === "full" ? (
          <span className="min-w-0 truncate">Widgets</span>
        ) : (
          display === "icon" && <WidgetIcon />
        )}
        <ChevronIcon className="shrink-0" />
      </Trigger>
    );
  if (measure) return trigger;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {trigger}
      <PopoverContent
        role="menu"
        aria-label="Widget tabs"
        align="end"
        className="w-64 max-h-80 p-1"
      >
        {widgets.map((attachment) => (
          <Button
            key={attachment.id}
            role="menuitemradio"
            aria-checked={selected?.id === attachment.id}
            variant="ghost"
            size="sm"
            className="w-full min-w-0 justify-start gap-2 px-2 text-xs"
            title={store.title(attachment)}
            onClick={() => {
              navigator.showWidget(attachment.id);
              setOpen(false);
            }}
          >
            <span className="size-4 shrink-0">
              {selected?.id === attachment.id && <CheckIcon />}
            </span>
            <span className="min-w-0 truncate">{store.title(attachment)}</span>
          </Button>
        ))}
        {selected && (
          <>
            <div role="separator" className="-mx-1 my-1 h-px bg-border/70" />
            <Button
              role="menuitem"
              variant="ghost"
              size="sm"
              className="w-full min-w-0 justify-start gap-2 px-2 text-xs"
              onClick={() => {
                navigator.clearWidget();
                setOpen(false);
              }}
            >
              <span className="size-4 shrink-0" />
              <span className="min-w-0 truncate">Clear</span>
            </Button>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
});
