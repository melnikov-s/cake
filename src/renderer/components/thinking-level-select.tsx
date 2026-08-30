import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import type { ThinkingLevel } from "../../ipc/session-contract";
import { Button } from "./ui/button";
import { ChevronDownIcon } from "./ui/icons";
import { NavItem } from "./ui/nav-item";

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
      className={cn(
        "relative inline-flex w-full items-center",
        variant === "settings" && "max-w-md",
      )}
      onBlur={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        )
          setOpen(false);
      }}
    >
      <Button
        ref={triggerRef}
        type="button"
        variant="outline"
        className={cn(
          "h-8 w-full justify-between px-2.5 text-xs font-normal",
          variant === "settings" && "h-9 text-sm",
        )}
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span className="truncate">{thinkingLevelLabel(value)}</span>
        <span className="pointer-events-none shrink-0 text-muted-foreground" aria-hidden="true">
          <ChevronDownIcon size={14} />
        </span>
      </Button>
      {open && (
        <div className="absolute top-[calc(100%+4px)] left-0 z-50 w-full min-w-[200px] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl">
          <div
            className="max-h-60 overflow-y-auto p-1 text-xs"
            id={listboxId}
            role="listbox"
            aria-label={`${ariaLabel} options`}
            onKeyDown={onKeyDown}
          >
            <div className="space-y-0.5">
              {levels.map((level, index) => {
                const selected = level === value;
                return (
                  <NavItem
                    id={optionId(index)}
                    role="option"
                    aria-selected={selected}
                    active={index === activeIndex}
                    key={level}
                    label={thinkingLevelLabel(level)}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => choose(level)}
                    trailing={selected ? <span className="font-mono text-accent">✓</span> : null}
                  />
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
