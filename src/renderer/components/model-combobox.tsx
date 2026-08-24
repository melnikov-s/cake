import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { ModelOption } from "../../ipc/session-contract";
import { ChevronDownIcon } from "./ui/icons";

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
      className={`model-combobox ${variant}`}
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
      <input
        ref={inputRef}
        className="model-combobox-input"
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
      <span className="model-combobox-chevron" aria-hidden="true">
        <ChevronDownIcon />
      </span>
      {open && (
        <div className="model-combobox-popover">
          <div
            className="model-combobox-list"
            id={listboxId}
            role="listbox"
            aria-label={`${ariaLabel} options`}
          >
            {filteredGroups.length === 0 ? (
              <p className="model-combobox-empty">No matching models</p>
            ) : (
              filteredGroups.map((group) => (
                <div
                  className="model-combobox-group"
                  role="group"
                  aria-label={group.name}
                  key={group.id}
                >
                  <div className="model-combobox-provider">{group.name}</div>
                  {group.models.map((model) => {
                    const index = optionIndex++;
                    const selected = modelValue(model) === value;
                    return (
                      <button
                        id={`${listboxId}-option-${index}`}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className={index === activeIndex ? "active" : undefined}
                        key={modelValue(model)}
                        onMouseEnter={() => setActiveIndex(index)}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => choose(model)}
                      >
                        <span>
                          <strong>{model.name}</strong>
                          <small>{model.id}</small>
                        </span>
                        {selected ? <i aria-hidden="true">✓</i> : null}
                      </button>
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
