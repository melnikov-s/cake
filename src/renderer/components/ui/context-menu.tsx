import { useRef, useState, type ReactNode } from "react";
import { Button } from "./button";
import { ChevronIcon } from "./icons";
import { Popover, PopoverContent } from "./popover";

export interface ContextMenuItem {
  label: string;
  disabled?: boolean;
  onSelect?: () => void;
  items?: readonly ContextMenuItem[];
  /** Replace the menu with an interactive panel, such as a calendar. */
  content?: (close: () => void) => ReactNode;
}

/** Pointer and keyboard context actions, with an accessible expandable submenu. */
export function ContextMenu({
  children,
  label,
  items,
}: {
  children: ReactNode;
  label: string;
  items: readonly ContextMenuItem[];
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [point, setPoint] = useState<{ x: number; y: number }>();
  const [panel, setPanel] = useState<ContextMenuItem>();
  const close = () => {
    setOpen(false);
    setPanel(undefined);
  };
  return (
    <Popover open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <div
        ref={anchor}
        tabIndex={-1}
        onContextMenu={(event) => {
          if (!items.length) return;
          event.preventDefault();
          setPoint({ x: event.clientX, y: event.clientY });
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (
            !items.length ||
            !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
          )
            return;
          event.preventDefault();
          setPoint(undefined);
          setOpen(true);
        }}
      >
        {children}
      </div>
      <PopoverContent
        anchorRef={anchor}
        anchorPoint={point}
        align="start"
        offset={2}
        role={panel ? "dialog" : "menu"}
        aria-label={panel?.label ?? label}
        className={panel ? "p-3" : "min-w-48 p-1"}
        onKeyDown={(event) => {
          if (event.key === "Tab" && !panel) close();
        }}
      >
        {panel ? (
          <>
            <Button
              variant="ghost"
              className="mb-1 h-7 gap-1 px-1"
              aria-label="Back to menu"
              onClick={(event) => {
                const surface = event.currentTarget.closest('[role="dialog"]');
                setPanel(undefined);
                requestAnimationFrame(() =>
                  surface?.querySelector<HTMLElement>('[role="menuitem"]')?.focus(),
                );
              }}
            >
              <ChevronIcon className="rotate-90" />
              {panel.label}
            </Button>
            {panel.content?.(close)}
          </>
        ) : (
          <MenuItems key={String(open)} items={items} close={close} openPanel={setPanel} />
        )}
      </PopoverContent>
    </Popover>
  );
}

function MenuItems({
  items,
  close,
  openPanel,
}: {
  items: readonly ContextMenuItem[];
  close(): void;
  openPanel(item: ContextMenuItem): void;
}) {
  const [expanded, setExpanded] = useState<string>();
  return items.map((item) => (
    <div key={item.label}>
      <Button
        variant="ghost"
        role="menuitem"
        disabled={item.disabled}
        aria-haspopup={item.content ? "dialog" : item.items ? "menu" : undefined}
        aria-expanded={item.items ? expanded === item.label : undefined}
        className="h-7 w-full justify-between gap-4 px-2 text-xs transition-colors"
        onClick={(event) => {
          if (item.items) {
            event.preventDefault();
            setExpanded(expanded === item.label ? undefined : item.label);
          } else if (item.content) {
            event.preventDefault();
            openPanel(item);
          } else {
            close();
            item.onSelect?.();
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" && (item.items || item.content)) {
            event.preventDefault();
            if (item.content) openPanel(item);
            else setExpanded(item.label);
          }
        }}
      >
        {item.label}
        {(item.items || item.content) && (
          <ChevronIcon
            className={item.items && expanded === item.label ? undefined : "-rotate-90"}
          />
        )}
      </Button>
      {item.items && expanded === item.label && (
        <div
          role="menu"
          aria-label={item.label}
          className="ml-2 border-l border-border pl-1"
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft") return;
            event.preventDefault();
            setExpanded(undefined);
            event.currentTarget.parentElement?.querySelector<HTMLButtonElement>("button")?.focus();
          }}
        >
          <MenuItems items={item.items} close={close} openPanel={openPanel} />
        </div>
      )}
    </div>
  ));
}
