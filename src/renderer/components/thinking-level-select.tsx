import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { ThinkingLevel } from "../../ipc/session-contract";

function thinkingLevelLabel(level: ThinkingLevel) {
  return level === "off"
    ? "No reasoning"
    : `${level.charAt(0).toUpperCase()}${level.slice(1)} reasoning`;
}

/** Select-only dropdown for the thinking level, styled like the model combobox. */
export function ThinkingLevelSelect({
  ariaLabel,
  value,
  levels,
  disabled,
  onSelect,
  variant = "compact",
}: {
  ariaLabel: string;
  value: ThinkingLevel;
  levels: readonly ThinkingLevel[];
  disabled?: boolean;
  onSelect(level: ThinkingLevel): void;
  variant?: "compact" | "settings";
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const optionId = (index: number) => `${listboxId}-option-${index}`;

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
    const active = document.getElementById(optionId(activeIndex));
    active?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, listboxId, open]);

  const focusTrigger = () => requestAnimationFrame(() => triggerRef.current?.focus());

  const openMenu = () => {
    setActiveIndex(Math.max(0, levels.indexOf(value)));
    setOpen(true);
    requestAnimationFrame(() =>
      document.getElementById(optionId(Math.max(0, levels.indexOf(value))))?.focus(),
    );
  };

  const choose = (level: ThinkingLevel) => {
    onSelect(level);
    setOpen(false);
    focusTrigger();
  };

  const move = (delta: number) => {
    if (levels.length === 0) return;
    setActiveIndex((index) => (index + delta + levels.length) % levels.length);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!open) {
      if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
        event.preventDefault();
        openMenu();
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Enter" && levels[activeIndex]) {
      event.preventDefault();
      choose(levels[activeIndex]!);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      focusTrigger();
    }
  };

  return (
    <div
      ref={rootRef}
      className={`model-combobox thinking-level-select ${variant}`}
      onBlur={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        )
          setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="model-combobox-input thinking-level-trigger"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
      >
        {thinkingLevelLabel(value)}
      </button>
      <span className="model-combobox-chevron" aria-hidden="true">
        ⌄
      </span>
      {open && (
        <div className="model-combobox-popover">
          <div
            className="model-combobox-list"
            id={listboxId}
            role="listbox"
            aria-label={`${ariaLabel} options`}
            onKeyDown={onKeyDown}
          >
            <div className="model-combobox-group">
              {levels.map((level, index) => {
                const selected = level === value;
                return (
                  <button
                    id={optionId(index)}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={index === activeIndex ? "active" : undefined}
                    key={level}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => choose(level)}
                  >
                    <span>
                      <strong>{thinkingLevelLabel(level)}</strong>
                    </span>
                    {selected ? <i aria-hidden="true">✓</i> : null}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
