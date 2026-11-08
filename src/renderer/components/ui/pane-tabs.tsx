import { useLayoutEffect, useRef } from "react";
import { Button } from "./button";
import { cn } from "@/lib/utils";
import { tabFocusClassName, tabSurfaceClassName } from "./tab-styles";

/** Manually activated tabs, bounded by their pane rather than the window viewport. */
export function PaneTabs({
  id,
  label,
  items,
  value,
  panelId,
  onValueChange,
}: {
  id: string;
  label: string;
  items: readonly { readonly id: string; readonly title: string }[];
  value: string;
  panelId: string;
  onValueChange(value: string): void;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const reveal = (tab: HTMLElement) => {
    const strip = stripRef.current;
    if (!strip) return;
    const bounds = strip.getBoundingClientRect();
    const tabBounds = tab.getBoundingClientRect();
    if (tabBounds.left < bounds.left) strip.scrollLeft += tabBounds.left - bounds.left;
    else if (tabBounds.right > bounds.right) strip.scrollLeft += tabBounds.right - bounds.right;
  };
  useLayoutEffect(() => {
    const selected = stripRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (selected) reveal(selected);
  }, [value]);

  return (
    <div
      ref={stripRef}
      role="tablist"
      aria-label={label}
      aria-orientation="horizontal"
      className="flex w-full min-w-0 max-w-full shrink-0 gap-1.5 overflow-x-auto overflow-y-hidden border-b border-border/65 bg-sidebar/30 px-2 py-1.5"
      onKeyDown={(event) => {
        const tabs = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
        );
        if (!(event.target instanceof HTMLButtonElement)) return;
        const index = tabs.indexOf(event.target);
        if (index < 0) return;
        const next =
          event.key === "ArrowRight"
            ? (index + 1) % tabs.length
            : event.key === "ArrowLeft"
              ? (index + tabs.length - 1) % tabs.length
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? tabs.length - 1
                  : undefined;
        if (next === undefined) return;
        event.preventDefault();
        tabs[next]?.focus();
      }}
    >
      {items.map((item) => (
        <Button
          key={item.id}
          id={`${id}-${item.id}`}
          role="tab"
          aria-selected={item.id === value}
          aria-controls={panelId}
          tabIndex={item.id === value ? 0 : -1}
          title={item.title}
          variant="ghost"
          size="sm"
          className={cn(
            "h-8 min-w-0 max-w-[min(13rem,100%)] shrink-0 justify-start px-2.5 text-xs active:scale-100",
            tabSurfaceClassName(item.id === value),
            tabFocusClassName,
            item.id === value && "font-semibold",
          )}
          onFocus={(event) => reveal(event.currentTarget)}
          onClick={() => onValueChange(item.id)}
        >
          <span className="truncate">{item.title}</span>
        </Button>
      ))}
    </div>
  );
}
