import { useState } from "react";
import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Button } from "./ui/button";
import { CheckIcon, ChevronIcon } from "./ui/icons";
import { cn } from "../lib/utils";

/** The widget tab: once bound to a widget it shows that widget; the chevron rebinds/clears it. */
export const WidgetTabPicker = observer(function WidgetTabPicker() {
  const root = useStore(RootStore);
  const store = root.widgetAttachmentStore;
  const widgets = store.tabWidgets;
  const navigator = root.workspaceNavigatorStore;
  const selected = navigator.selectedWidget;
  const active = navigator.showingWidget;
  const [open, setOpen] = useState(false);
  if (!widgets.length) return null;
  const title = selected ? store.title(selected) : undefined;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {selected ? (
        <div
          className={cn(
            "flex h-7 min-w-0 max-w-[40%] shrink items-center rounded-md border",
            active
              ? "border-border bg-card text-foreground shadow-2xs"
              : "border-transparent text-muted-foreground",
          )}
        >
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={active}
            aria-label={`Widget tab: ${title}`}
            title={title}
            className={cn(
              "h-full min-w-0 shrink rounded-r-none pl-1.5 pr-0.5 text-xs",
              active && "text-foreground hover:bg-muted/70",
            )}
            onClick={() => navigator.showWidget()}
          >
            <span className="min-w-0 truncate">{title}</span>
          </Button>
          <PopoverTrigger
            size="sm"
            variant="ghost"
            className={cn(
              "h-full shrink-0 rounded-l-none px-1",
              active && "text-foreground hover:bg-muted/70",
            )}
            aria-label="Widget tabs"
            aria-haspopup="menu"
            title="Choose widget"
          >
            <ChevronIcon />
          </PopoverTrigger>
        </div>
      ) : (
        <PopoverTrigger
          size="sm"
          variant="ghost"
          className="min-w-0 max-w-[40%] shrink gap-1 px-1.5 text-xs"
          aria-label="Widget tabs"
          aria-haspopup="menu"
          title="Widgets"
        >
          <span className="min-w-0 truncate">Widgets</span>
          <ChevronIcon className="shrink-0" />
        </PopoverTrigger>
      )}
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
