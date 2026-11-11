import { useState } from "react";
import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Button } from "./ui/button";
import { CheckIcon, ChevronIcon } from "./ui/icons";

export const WidgetTabPicker = observer(function WidgetTabPicker() {
  const root = useStore(RootStore);
  const store = root.widgetAttachmentStore;
  const widgets = store.tabWidgets;
  const navigator = root.workspaceNavigatorStore;
  const selected = navigator.selectedWidget;
  const [open, setOpen] = useState(false);
  if (!widgets.length) return null;
  const title = selected ? store.title(selected) : "Widgets";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        size="sm"
        variant={selected ? "outline" : "ghost"}
        className="min-w-0 max-w-[40%] shrink gap-1 px-1.5 text-xs"
        aria-label={selected ? `Widget tabs: ${title}` : "Widget tabs"}
        aria-haspopup="menu"
        title={title}
      >
        <span className="min-w-0 truncate">{title}</span>
        <ChevronIcon className="shrink-0" />
      </PopoverTrigger>
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
      </PopoverContent>
    </Popover>
  );
});
