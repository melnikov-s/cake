import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import type { ModelOption } from "../../ipc/session-contract";
import { ChevronDownIcon } from "./ui/icons";
import { Input } from "./ui/input";
import { NavItem } from "./ui/nav-item";

export interface ModelGroup {
  id: string;
  name: string;
  models: ModelOption[];
}

interface ModelComboboxProps {
  ariaLabel: string;
  groups: ModelGroup[];
  value: string;
  onSelect(value: string): void;
  variant?: "compact" | "settings";
}

function modelValue(model: ModelOption) {
  return `${model.provider}/${model.id}`;
}

export function ModelCombobox({
  ariaLabel,
  groups,
  value,
  onSelect,
  variant = "compact",
}: ModelComboboxProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const selectableGroups = useMemo(
    () =>
      groups
        .map((group) => ({ ...group, models: group.models.filter((model) => model.authenticated) }))
        .filter((group) => group.models.length > 0),
    [groups],
  );
  const allModels = useMemo(
    () => selectableGroups.flatMap((group) => group.models),
    [selectableGroups],
  );
  const selectedModel = allModels.find((model) => modelValue(model) === value);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredGroups = useMemo(
    () =>
      selectableGroups
        .map((group) => ({
          ...group,
          models: group.models.filter(
            (model) =>
              !normalizedQuery ||
              `${model.name}\n${model.id}\n${group.name}`
                .toLocaleLowerCase()
                .includes(normalizedQuery),
          ),
        }))
        .filter((group) => group.models.length > 0),
    [selectableGroups, normalizedQuery],
  );
  const filteredModels = filteredGroups.flatMap((group) => group.models);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !rootRef.current?.contains(event.target))
        setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const active = document.getElementById(`${listboxId}-option-${activeIndex}`);
    active?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, listboxId, open]);

  const openMenu = (initialQuery = "") => {
    setQuery(initialQuery);
    const selectedIndex = initialQuery
      ? -1
      : filteredModels.findIndex((model) => modelValue(model) === value);
    setActiveIndex(Math.max(0, selectedIndex));
    setOpen(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const choose = (model: ModelOption) => {
    onSelect(modelValue(model));
    setOpen(false);
    setQuery("");
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!open) {
      if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
        event.preventDefault();
        openMenu();
      } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        openMenu(event.key);
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (filteredModels.length ? (index + 1) % filteredModels.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) =>
        filteredModels.length ? (index - 1 + filteredModels.length) % filteredModels.length : 0,
      );
    } else if (event.key === "Enter" && filteredModels[activeIndex]) {
      event.preventDefault();
      choose(filteredModels[activeIndex]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      setQuery("");
    }
  };

  let optionIndex = 0;
  return (
    <div
      ref={rootRef}
      className={cn(
        "relative inline-flex w-full items-center",
        variant === "settings" && "max-w-md",
      )}
      onBlur={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        ) {
          setOpen(false);
          setQuery("");
        }
      }}
    >
      <Input
        ref={inputRef}
        className={cn("h-8 w-full pr-7 text-xs", variant === "settings" && "h-9 text-sm")}
        role="combobox"
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={
          open && filteredModels[activeIndex] ? `${listboxId}-option-${activeIndex}` : undefined
        }
        autoComplete="off"
        spellCheck={false}
        readOnly={!open}
        value={open ? query : (selectedModel?.name ?? value)}
        placeholder={open ? "Search models…" : "Choose model"}
        onClick={() => {
          if (!open) openMenu();
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          setActiveIndex(0);
        }}
        onKeyDown={onKeyDown}
      />
      <span
        className="pointer-events-none absolute right-2 text-muted-foreground"
        aria-hidden="true"
      >
        <ChevronDownIcon size={14} />
      </span>
      {open && (
        <div className="absolute top-[calc(100%+4px)] left-0 z-50 w-full min-w-[260px] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl">
          <div
            className="max-h-60 overflow-y-auto p-1 text-xs"
            id={listboxId}
            role="listbox"
            aria-label={`${ariaLabel} options`}
          >
            {filteredGroups.length === 0 ? (
              <p className="p-3 text-center text-muted-foreground">No matching models</p>
            ) : (
              filteredGroups.map((group) => (
                <div role="group" aria-label={group.name} key={group.id} className="space-y-0.5">
                  <div className="px-2 pt-1.5 pb-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                    {group.name}
                  </div>
                  {group.models.map((model) => {
                    const index = optionIndex++;
                    const selected = modelValue(model) === value;
                    return (
                      <NavItem
                        id={`${listboxId}-option-${index}`}
                        role="option"
                        aria-selected={selected}
                        active={index === activeIndex}
                        key={modelValue(model)}
                        onMouseEnter={() => setActiveIndex(index)}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => choose(model)}
                        label={model.name}
                        description={model.id}
                        trailing={
                          selected ? (
                            <i className="font-mono text-accent not-italic" aria-hidden="true">
                              ✓
                            </i>
                          ) : null
                        }
                      />
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
