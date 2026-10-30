import { useRef, useState, type ReactNode } from "react";
import { Button } from "./button";
import { ChevronIcon } from "./icons";
import { Popover, PopoverContent } from "./popover";

export interface ContextMenuItem {
  label: string;
  disabled?: boolean;
  onSelect?: () => void;
  items?: readonly ContextMenuItem[];
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
  return (
    <Popover open={open} onOpenChange={setOpen}>
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
        role="menu"
        aria-label={label}
        className="min-w-48 p-1"
        onKeyDown={(event) => {
          if (event.key === "Tab") setOpen(false);
        }}
      >
        <MenuItems key={String(open)} items={items} close={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

function MenuItems({ items, close }: { items: readonly ContextMenuItem[]; close(): void }) {
  const [expanded, setExpanded] = useState<string>();
  return items.map((item) => (
    <div key={item.label}>
      <Button
        variant="ghost"
        role="menuitem"
        disabled={item.disabled}
        aria-haspopup={item.items ? "menu" : undefined}
        aria-expanded={item.items ? expanded === item.label : undefined}
        className="h-7 w-full justify-between gap-4 px-2 text-xs transition-colors"
        onClick={(event) => {
          if (item.items) {
            event.preventDefault();
            setExpanded(expanded === item.label ? undefined : item.label);
          } else {
            close();
            item.onSelect?.();
          }
        }}
        onKeyDown={(event) => {
          if (item.items && event.key === "ArrowRight") {
            event.preventDefault();
            setExpanded(item.label);
          }
        }}
      >
        {item.label}
        {item.items && (
          <ChevronIcon className={expanded === item.label ? undefined : "-rotate-90"} />
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
          <MenuItems items={item.items} close={close} />
        </div>
      )}
    </div>
  ));
}
