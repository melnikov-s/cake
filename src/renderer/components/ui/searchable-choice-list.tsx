import { useId, useLayoutEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { CheckIcon } from "./icons";
import { SearchInput } from "./search-input";
import type { SearchableChoice } from "./searchable-choice-dialog";

/** Filterable single-choice list for popover content. Filtering policy belongs to the caller;
 * the search field keeps focus while arrow keys move the active option. Escape clears the
 * query first and, once empty, reaches the enclosing popover's dismissal. */
export function SearchableChoiceList<Choice extends SearchableChoice>({
  searchLabel,
  choicesLabel,
  emptyMessage,
  choices: getChoices,
  selectedId,
  onSelect,
  className,
}: {
  searchLabel: string;
  choicesLabel: string;
  emptyMessage: string;
  choices(query: string): readonly Choice[];
  selectedId?: string;
  onSelect(id: string): void;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const choices = useMemo(() => getChoices(query), [getChoices, query]);
  const [activeId, setActiveId] = useState<string>();
  const id = useId();
  const optionId = (index: number) => `${id}-option-${index}`;
  const requestedIndex = choices.findIndex((choice) => choice.id === activeId);
  const selectedIndex = query ? -1 : choices.findIndex((choice) => choice.id === selectedId);
  const activeIndex = requestedIndex >= 0 ? requestedIndex : Math.max(0, selectedIndex);
  const active = choices[activeIndex];

  useLayoutEffect(() => {
    if (active)
      document.getElementById(optionId(activeIndex))?.scrollIntoView?.({ block: "nearest" });
  }, [active?.id, activeIndex, id]);

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="border-b border-border/65 p-1.5">
        <SearchInput
          label={searchLabel}
          value={query}
          onValueChange={(value) => {
            setActiveId(undefined);
            setQuery(value);
          }}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={choices.length ? `${id}-choices` : undefined}
          aria-activedescendant={active ? optionId(activeIndex) : undefined}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              event.stopPropagation();
              if (!choices.length) return;
              const delta = event.key === "ArrowDown" ? 1 : -1;
              setActiveId(choices[(activeIndex + delta + choices.length) % choices.length]?.id);
            } else if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              if (active) onSelect(active.id);
            }
          }}
        />
      </div>
      {choices.length > 0 ? (
        <div
          id={`${id}-choices`}
          role="listbox"
          aria-label={choicesLabel}
          className="max-h-72 scroll-py-1 overflow-y-auto overscroll-contain p-1"
        >
          {choices.map((choice, index) => {
            const isActive = index === activeIndex;
            const selected = choice.id === selectedId;
            return (
              <Button
                key={choice.id}
                id={optionId(index)}
                role="option"
                aria-selected={isActive}
                aria-checked={selected}
                tabIndex={-1}
                variant="ghost"
                title={choice.description ? `${choice.label}\n${choice.description}` : choice.label}
                className={cn(
                  "h-auto w-full items-start justify-start gap-2 px-2 py-1.5 text-left font-normal hover:bg-transparent active:scale-100",
                  isActive && "bg-muted/80 text-foreground hover:bg-muted/80",
                )}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => {
                  if (!isActive) setActiveId(choice.id);
                }}
                onClick={() => onSelect(choice.id)}
              >
                {choice.icon && (
                  <span className="flex h-5 shrink-0 items-center text-muted-foreground">
                    {choice.icon}
                  </span>
                )}
                <span className="grid min-w-0 flex-1">
                  <span className="truncate font-medium text-foreground">{choice.label}</span>
                  {choice.description && (
                    <span className="truncate text-muted-foreground">{choice.description}</span>
                  )}
                </span>
                <span className="flex h-5 w-4 shrink-0 items-center justify-center text-foreground">
                  {selected && <CheckIcon />}
                </span>
              </Button>
            );
          })}
        </div>
      ) : (
        <p role="status" className="px-3 py-6 text-center text-xs text-muted-foreground">
          {emptyMessage}
        </p>
      )}
    </div>
  );
}
