import {
  SESSION_LABEL_COLORS,
  type SessionLabelColor,
} from "../../../domain/application/application-data";
import { cn } from "../../lib/utils";
import { Button } from "./button";
import { LabelSwatch } from "./label-swatch";

export interface ColorPickerProps {
  value: SessionLabelColor;
  onChange(value: SessionLabelColor): void;
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
    <div className="grid grid-cols-8 gap-1.5" role="radiogroup" aria-label={label}>
      {SESSION_LABEL_COLORS.map((color) => (
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
          <LabelSwatch color={color} className="size-3.5" />
        </Button>
      ))}
    </div>
  );
}
