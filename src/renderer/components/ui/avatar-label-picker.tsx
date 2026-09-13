import { useState } from "react";
import type { SessionLabel } from "../../../domain/application/application-data";
import { cn } from "../../lib/utils";
import { Avatar, type AvatarProps } from "./avatar";
import { Button } from "./button";
import { CheckIcon } from "./icons";
import { Popover, PopoverContent, PopoverIconTrigger } from "./popover";
import { LabelSwatch } from "./label-swatch";

export interface AvatarLabelPickerProps {
  seed: string;
  labels: readonly SessionLabel[];
  value: readonly string[];
  disabled?: boolean;
  animated?: boolean;
  interaction?: AvatarProps["interaction"];
  className?: string;
  onChange(labelIds: readonly string[]): void;
}

/** Session-avatar trigger and ordered multi-label selector. */
export function AvatarLabelPicker({
  seed,
  labels,
  value,
  disabled = false,
  animated = false,
  interaction,
  className,
  onChange,
}: AvatarLabelPickerProps) {
  const [open, setOpen] = useState(false);
  const byId = new Map(labels.map((label) => [label.id, label]));
  const selected = value.flatMap((labelId) => {
    const label = byId.get(labelId);
    return label ? [label] : [];
  });
  const names = selected.map((label) => label.name).join(", ") || "Unlabelled";
  const toggle = (labelId: string) =>
    onChange(
      value.includes(labelId)
        ? value.filter((selectedId) => selectedId !== labelId)
        : [...value, labelId],
    );
  const makePrimary = (labelId: string) =>
    onChange([labelId, ...value.filter((selectedId) => selectedId !== labelId)]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverIconTrigger
        className={cn(
          "size-7 rounded-full p-0 hover:bg-muted",
          animated &&
            "touch-none select-none motion-safe:cursor-grab data-[avatar-held=true]:cursor-grabbing data-[avatar-held=true]:bg-transparent",
          className,
        )}
        ariaLabel={`Change session labels. Current labels: ${names}`}
        disabled={disabled}
      >
        <Avatar
          kind="session"
          seed={seed}
          labelColors={selected.map((label) => label.color)}
          animated={animated}
          interaction={interaction}
          className="size-6"
        />
      </PopoverIconTrigger>
      <PopoverContent
        motion="bouncy"
        align="start"
        side="right"
        className="max-h-[min(32rem,80vh)] w-64 overflow-y-auto p-2"
      >
        <div className="flex items-center justify-between px-2 pb-1.5">
          <p className="text-[11px] font-semibold text-muted-foreground">Session labels</p>
          {value.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[10px] text-muted-foreground"
              onClick={() => onChange([])}
            >
              Clear
            </Button>
          )}
        </div>
        <div className="grid gap-0.5" role="group" aria-label="Session labels">
          {labels.map((label) => {
            const checked = value.includes(label.id);
            const primary = value[0] === label.id;
            return (
              <div key={label.id} className="flex items-center gap-1 rounded-md hover:bg-muted">
                <Button
                  type="button"
                  variant="ghost"
                  className="h-9 min-w-0 flex-1 justify-start gap-2 bg-transparent px-2 text-xs hover:bg-transparent"
                  role="checkbox"
                  aria-checked={checked}
                  onClick={() => toggle(label.id)}
                >
                  <span
                    className={cn(
                      "grid size-4 shrink-0 place-items-center rounded border border-border",
                      checked && "border-primary bg-primary text-primary-foreground",
                    )}
                  >
                    {checked && <CheckIcon />}
                  </span>
                  <LabelSwatch color={label.color} className="size-2.5" />
                  <span className="truncate">{label.name}</span>
                </Button>
                {checked && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={cn(
                      "mr-1 h-6 px-1.5 text-[10px]",
                      primary ? "text-foreground" : "text-muted-foreground",
                    )}
                    disabled={primary}
                    onClick={() => makePrimary(label.id)}
                  >
                    {primary ? "Primary" : "Make primary"}
                  </Button>
                )}
              </div>
            );
          })}
          {labels.length === 0 && (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">
              No labels are available for this project.
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
