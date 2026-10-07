import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { DialogBackdrop, DialogContent, DialogDescription, DialogTitle } from "./dialog";
import { Button } from "./button";
import { Input } from "./input";
import { IconButton } from "./icon-button";
import { CloseIcon, SearchIcon } from "./icons";

export interface SearchableChoice {
  id: string;
  label: string;
  description?: string;
  icon?: ReactNode;
}

/** Mount while open. Filtering and selection policy belong to the caller;
 * active-option navigation, focus containment and restoration are local DOM state. */
export function SearchableChoiceDialog({
  title,
  description,
  searchLabel,
  query,
  choices,
  initialActiveId,
  onQueryChange,
  onSelect,
  onClose,
}: {
  title: string;
  description: string;
  searchLabel: string;
  query: string;
  choices: readonly SearchableChoice[];
  /** Preferred option when the dialog mounts; missing choices fall back to the first. */
  initialActiveId?: string;
  onQueryChange(query: string): void;
  onSelect(id: string): void;
  onClose(): void;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [activeId, setActiveId] = useState<string | undefined>(initialActiveId);
  const activeIndex = Math.max(
    0,
    choices.findIndex((choice) => choice.id === activeId),
  );
  const active = choices[activeIndex];
  const optionId = (index: number) => `${id}-option-${index}`;

  useLayoutEffect(() => {
    const previous = document.activeElement;
    const containFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !contentRef.current?.contains(event.target))
        inputRef.current?.focus();
    };
    document.addEventListener("focusin", containFocus);
    inputRef.current?.focus();
    return () => {
      document.removeEventListener("focusin", containFocus);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  useLayoutEffect(() => {
    if (active)
      document.getElementById(optionId(activeIndex))?.scrollIntoView?.({ block: "nearest" });
  }, [active?.id, activeIndex, id]);

  return (
    <DialogBackdrop
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      onClose={onClose}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        } else if (event.key === "Tab") {
          const controls = contentRef.current?.querySelectorAll<HTMLElement>(
            'input, button:not([tabindex="-1"])',
          );
          const first = controls?.[0];
          const last = controls?.[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <DialogContent ref={contentRef} className="max-w-md p-3">
        <div className="flex items-start justify-between gap-3 px-2 pb-3 pt-1">
          <div className="grid gap-2">
            <DialogTitle id={`${id}-title`}>{title}</DialogTitle>
            <DialogDescription id={`${id}-description`}>{description}</DialogDescription>
          </div>
          <IconButton tooltip="Close" onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </div>
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-3 top-3 text-muted-foreground" />
          <Input
            ref={inputRef}
            role="combobox"
            aria-label={searchLabel}
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={`${id}-choices`}
            aria-activedescendant={active ? optionId(activeIndex) : undefined}
            placeholder="Type to filter…"
            className="pl-9"
            value={query}
            onChange={(event) => {
              setActiveId(undefined);
              onQueryChange(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const delta = event.key === "ArrowDown" ? 1 : -1;
                const next = choices[(activeIndex + delta + choices.length) % choices.length];
                setActiveId(next?.id);
              } else if (event.key === "Enter") {
                event.preventDefault();
                if (active) onSelect(active.id);
              }
            }}
          />
        </div>
        <div
          id={`${id}-choices`}
          role="listbox"
          aria-label="Session destination"
          className="mt-2 max-h-72 overflow-y-auto"
        >
          {choices.map((choice, index) => (
            <Button
              key={choice.id}
              id={optionId(index)}
              role="option"
              aria-selected={active?.id === choice.id}
              tabIndex={-1}
              variant="ghost"
              className={cn(
                "h-auto w-full justify-start gap-3 px-3 py-2.5 text-left",
                active?.id === choice.id && "bg-accent text-accent-foreground",
              )}
              onMouseMove={() => setActiveId(choice.id)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onSelect(choice.id)}
            >
              {choice.icon}
              <span className="grid min-w-0 gap-0.5">
                <span className="truncate">{choice.label}</span>
                {choice.description && (
                  <span
                    className={cn(
                      "truncate text-xs font-normal",
                      active?.id === choice.id
                        ? "text-accent-foreground/80"
                        : "text-muted-foreground",
                    )}
                  >
                    {choice.description}
                  </span>
                )}
              </span>
            </Button>
          ))}
        </div>
        {choices.length === 0 && (
          <p role="status" className="px-3 py-6 text-center text-sm text-muted-foreground">
            No matching destinations.
          </p>
        )}
        <p className="px-2 pt-3 text-xs text-muted-foreground">
          Arrow keys to choose · Enter to create · Esc to cancel
        </p>
      </DialogContent>
    </DialogBackdrop>
  );
}
