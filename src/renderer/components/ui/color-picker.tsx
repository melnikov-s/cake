import type { ProjectWorkflowColor } from "../../../domain/application-data";
import { cn } from "../../lib/utils";
import { Button } from "./button";
import { StatusSwatch } from "./status-swatch";

const projectWorkflowColors: readonly ProjectWorkflowColor[] = [
  "rose",
  "peach",
  "amber",
  "lime",
  "mint",
  "sky",
  "blue",
  "violet",
];

export interface ColorPickerProps {
  value: ProjectWorkflowColor;
  onChange(value: ProjectWorkflowColor): void;
  disabled?: boolean;
  label?: string;
}

export function ColorPicker({
  value,
  onChange,
  disabled = false,
  label = "Status color",
}: ColorPickerProps) {
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={label}>
      {projectWorkflowColors.map((color) => (
        <Button
          key={color}
          type="button"
          variant="ghost"
          size="sm"
          className={cn("size-7 rounded-md p-0", value === color && "bg-muted ring-2 ring-ring/35")}
          role="radio"
          aria-checked={value === color}
          aria-label={color}
          disabled={disabled}
          onClick={() => onChange(color)}
        >
          <StatusSwatch color={color} className="size-3.5" />
        </Button>
      ))}
    </div>
  );
}
