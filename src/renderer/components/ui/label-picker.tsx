import type { SessionLabel } from "../../../contracts/application/application-data";
import { Button } from "./button";
import { CheckIcon } from "./icons";
import { LabelSwatch } from "./label-swatch";
import { Popover, PopoverContent, PopoverIconTrigger } from "./popover";

/** A compact, single-label picker using the shared session label palette. */
export function LabelPicker({
  open,
  onOpenChange,
  labelId,
  labels,
  inheritedLabels,
  ariaLabel,
  disabled,
  className,
  onChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  labelId?: string;
  labels: readonly SessionLabel[];
  inheritedLabels: readonly SessionLabel[];
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
  onChange(labelId: string | null): Promise<true | undefined>;
}) {
  const selected = labels.find((label) => label.id === labelId);
  const inherited = !labelId && inheritedLabels.length > 0;
  const inheritedNames = inheritedLabels.map((label) => label.name).join(", ");
  const name = inherited
    ? `${inheritedNames} (from linked sessions)`
    : (selected?.name ?? "Unlabelled");
  const labelNoun = inherited && inheritedLabels.length > 1 ? "labels" : "label";
  const choose = async (id: string | null) => {
    if ((await onChange(id)) === true) onOpenChange(false);
  };
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverIconTrigger
        className={className}
        iconSize="inline"
        ariaLabel={`${ariaLabel}. Current ${labelNoun}: ${name}`}
        tooltip={open ? undefined : name}
        wrapTooltip
        aria-haspopup="menu"
        aria-disabled={disabled || undefined}
        onClick={(event) => {
          event.stopPropagation();
          if (disabled) event.preventDefault();
        }}
        onKeyDown={(event) => {
          if (disabled || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
          event.preventDefault();
          if (!open) {
            onOpenChange(true);
            return;
          }
          const id = event.currentTarget.getAttribute("aria-controls");
          const options = id
            ? event.currentTarget.ownerDocument
                .getElementById(id)
                ?.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]:not([disabled])')
            : undefined;
          (event.key === "ArrowUp" ? options?.[options.length - 1] : options?.[0])?.focus();
        }}
      >
        {selected ? (
          <LabelSwatch color={selected.color} />
        ) : inherited ? (
          <LabelSwatch colors={inheritedLabels.map((label) => label.color)} />
        ) : (
          <span
            aria-hidden="true"
            className="size-2.5 rounded-[3px] border border-current opacity-65"
          />
        )}
      </PopoverIconTrigger>
      <PopoverContent
        aria-label="Choose label"
        role="menu"
        initialFocusSelector={selected ? '[aria-checked="true"]' : '[role="menuitemradio"]'}
        side="left-or-vertical"
        align="start"
        className="max-h-[min(24rem,80vh)] w-56 overflow-y-auto p-2"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 px-2 pb-1.5">
          <p className="text-xs font-semibold text-muted-foreground">Label</p>
          {labelId && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-xs"
              role="menuitem"
              disabled={disabled}
              onClick={() => void choose(null)}
            >
              {inheritedNames ? "Use session labels" : "Clear label"}
            </Button>
          )}
        </div>
        {inheritedNames && (
          <p className="px-2 pb-2 text-xs text-muted-foreground">
            From linked sessions: {inheritedNames}
          </p>
        )}
        <div className="grid gap-0.5" role="group" aria-label="Available labels">
          {labels.map((label) => (
            <Button
              key={label.id}
              variant="ghost"
              className="h-8 min-w-0 justify-start gap-2 px-2 text-xs"
              role="menuitemradio"
              aria-checked={label.id === selected?.id}
              disabled={disabled}
              onClick={() => void choose(label.id)}
            >
              <LabelSwatch color={label.color} />
              <span className="min-w-0 flex-1 whitespace-normal text-left">{label.name}</span>
              {label.id === selected?.id && <CheckIcon />}
            </Button>
          ))}
          {labels.length === 0 && (
            <p className="px-2 py-2 text-xs text-muted-foreground">No labels available</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
