import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEventHandler,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import { DialogBackdrop, DialogContent, DialogDescription, DialogTitle } from "./dialog";
import { Button } from "./button";
import { SearchableChoiceInput } from "./searchable-choice-input";
import { IconButton } from "./icon-button";
import { CloseIcon } from "./icons";

const RESULT_BATCH_SIZE = 25;

export interface SearchableChoice {
  id: string;
  label: string;
  description?: string;
  icon?: ReactNode;
}

export interface SearchableChoiceOptionProps {
  id: string;
  role: "option";
  "aria-selected": boolean;
  tabIndex: -1;
  onMouseDown: MouseEventHandler<HTMLButtonElement>;
}

/** Mount while open. Filtering and selection policy belong to the caller;
 * active-option navigation, focus containment and restoration are local DOM state. */
export function SearchableChoiceDialog<Choice extends SearchableChoice>({
  title,
  description,
  searchLabel,
  choicesLabel = "Session destination",
  emptyMessage = "No matching destinations.",
  choices: getChoices,
  filters,
  stableHeight = false,
  renderChoice,
  initialActiveId,
  onSelect,
  onClose,
}: {
  title: string;
  description?: string;
  searchLabel: string;
  choicesLabel?: string;
  emptyMessage?: string;
  /** Called during the deferred results render, never from the input event. */
  choices(query: string): readonly Choice[];
  filters?: ReactNode;
  /** Keep one viewport-clamped frame height so typing never resizes or moves the dialog;
   * results scroll inside it and leftover space stays below the list. */
  stableHeight?: boolean;
  /** Compose an authoritative row instead of the default destination button. */
  renderChoice?(
    choice: Choice,
    optionProps: SearchableChoiceOptionProps,
    onSelect: () => void,
  ): ReactNode;
  /** Preferred option when the dialog mounts; missing choices fall back to the first. */
  initialActiveId?: string;
  onSelect(id: string): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const choices = useMemo(() => getChoices(query), [getChoices, query]);
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [activeId, setActiveId] = useState<string | undefined>(initialActiveId);
  const activeIndex = Math.max(
    0,
    choices.findIndex((choice) => choice.id === activeId),
  );
  const active = choices[activeIndex];
  const pageStart = Math.floor(activeIndex / RESULT_BATCH_SIZE) * RESULT_BATCH_SIZE;
  const pageEnd = Math.min(pageStart + RESULT_BATCH_SIZE, choices.length);
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
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true });
    };
  }, []);

  useLayoutEffect(() => {
    if (active)
      document.getElementById(optionId(activeIndex))?.scrollIntoView?.({ block: "nearest" });
  }, [active?.id, activeIndex, id]);

  return (
    <DialogBackdrop
      aria-labelledby={`${id}-title`}
      aria-describedby={description ? `${id}-description` : undefined}
      onClose={onClose}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        } else if (event.key === "Tab") {
          const controls = contentRef.current?.querySelectorAll<HTMLElement>(
            'input:not(:disabled), button:not(:disabled):not([tabindex="-1"])',
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
      <DialogContent
        ref={contentRef}
        className={cn(
          "max-w-md overflow-hidden p-0 phone:p-0",
          stableHeight && "flex h-[min(28rem,75vh)] flex-col",
        )}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border/65 bg-sidebar/30 px-4 py-3">
          <div className="grid gap-1">
            <DialogTitle id={`${id}-title`}>{title}</DialogTitle>
            {description && (
              <DialogDescription id={`${id}-description`}>{description}</DialogDescription>
            )}
          </div>
          <IconButton tooltip="Close" onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </div>
        <div className={cn("p-3", stableHeight && "flex min-h-0 flex-1 flex-col")}>
          <SearchableChoiceInput
            inputRef={inputRef}
            query={query}
            role="combobox"
            aria-label={searchLabel}
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={`${id}-choices`}
            aria-activedescendant={active ? optionId(activeIndex) : undefined}
            placeholder="Type to filter…"
            onQueryChange={(value) => {
              setActiveId(undefined);
              setQuery(value);
            }}
            onConfirm={() => {
              if (active) onSelect(active.id);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const delta = event.key === "ArrowDown" ? 1 : -1;
                const nextIndex = (activeIndex + delta + choices.length) % choices.length;
                const next = choices[nextIndex];
                setActiveId(next?.id);
              }
            }}
          />
          {filters}
          <div
            id={`${id}-choices`}
            role="listbox"
            aria-label={choicesLabel}
            className={cn(
              "mt-2 space-y-0.5 overflow-y-auto",
              stableHeight ? "min-h-0" : "max-h-72",
            )}
          >
            {choices.slice(pageStart, pageEnd).map((choice, offset) => {
              const index = pageStart + offset;
              return renderChoice ? (
                <div key={choice.id}>
                  {renderChoice(
                    choice,
                    {
                      id: optionId(index),
                      role: "option",
                      "aria-selected": active?.id === choice.id,
                      tabIndex: -1,
                      onMouseDown: (event) => event.preventDefault(),
                    },
                    () => onSelect(choice.id),
                  )}
                </div>
              ) : (
                <Button
                  key={choice.id}
                  id={optionId(index)}
                  role="option"
                  aria-selected={active?.id === choice.id}
                  tabIndex={-1}
                  variant="ghost"
                  className={cn(
                    "h-auto w-full justify-start gap-3 rounded-md border border-transparent px-3 py-2 text-left text-xs text-foreground",
                    active?.id === choice.id &&
                      "border-primary/40 bg-primary/10 hover:bg-primary/15",
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onSelect(choice.id)}
                >
                  {choice.icon && (
                    <span className="shrink-0 text-muted-foreground">{choice.icon}</span>
                  )}
                  <span className="grid min-w-0 gap-0.5">
                    <span className="truncate font-medium">{choice.label}</span>
                    {choice.description && (
                      <span
                        className={cn(
                          "truncate text-xs font-normal",
                          active?.id === choice.id ? "text-foreground" : "text-muted-foreground",
                        )}
                      >
                        {choice.description}
                      </span>
                    )}
                  </span>
                </Button>
              );
            })}
          </div>
          {choices.length > RESULT_BATCH_SIZE && (
            <div className="mt-2 flex items-center justify-between gap-2 border-t border-border/60 pt-2 text-xs text-muted-foreground">
              <Button
                variant="ghost"
                size="sm"
                disabled={pageStart === 0}
                onClick={() => setActiveId(choices[pageStart - RESULT_BATCH_SIZE]?.id)}
              >
                Previous results
              </Button>
              <span className="font-mono tabular-nums">
                {pageStart + 1}–{pageEnd} of {choices.length}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={pageEnd === choices.length}
                onClick={() => setActiveId(choices[pageEnd]?.id)}
              >
                Next results
              </Button>
            </div>
          )}
          {choices.length === 0 && (
            <p role="status" className="px-3 py-6 text-center text-xs text-muted-foreground">
              {emptyMessage}
            </p>
          )}
        </div>
      </DialogContent>
    </DialogBackdrop>
  );
}
