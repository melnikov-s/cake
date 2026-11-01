import { useState } from "react";
import {
  CAPTURE_ANNOTATION_COLORS,
  type CaptureAnnotationColor,
} from "../../../utils/capture-annotation-colors";
import { cn } from "../../lib/utils";
import { Button } from "./button";
import { Popover, PopoverContent, PopoverIconTrigger } from "./popover";

// Annotation swatches are image data colors, not theme/status colors.
const swatches = {
  yellow: "bg-[#ffdf00]",
  red: "bg-[#ff3b30]",
  cyan: "bg-[#00d9ff]",
  green: "bg-[#46ef65]",
  pink: "bg-[#ff55cc]",
  white: "bg-[#ffffff]",
} satisfies Record<CaptureAnnotationColor, string>;
const dot = "block size-3.5 rounded-full border border-black ring-1 ring-white";

/** Compact preset picker for theme-independent image annotations.
 * Swatch buttons transition colors only: animating inherited visibility prevents initial focus.
 */
export function AnnotationColorPicker({
  value,
  onChange,
  disabled,
}: {
  value: CaptureAnnotationColor;
  onChange(color: CaptureAnnotationColor): void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverIconTrigger
        tooltip="Annotation color"
        ariaLabel="Annotation color"
        aria-haspopup="menu"
        disabled={disabled}
      >
        <span
          aria-hidden="true"
          data-annotation-color={value}
          className={cn(dot, swatches[value])}
        />
      </PopoverIconTrigger>
      <PopoverContent
        role="menu"
        aria-label="Annotation color"
        className="flex gap-1 p-1.5"
        initialFocusSelector='[aria-checked="true"]'
      >
        {CAPTURE_ANNOTATION_COLORS.map((color) => (
          <Button
            key={color}
            role="menuitemradio"
            aria-label={color}
            aria-checked={value === color}
            variant="ghost"
            size="sm"
            disabled={disabled}
            className={cn(
              "size-7 p-0 transition-colors",
              value === color && "bg-muted ring-1 ring-ring",
            )}
            onClick={() => {
              onChange(color);
              setOpen(false);
            }}
          >
            <span aria-hidden="true" className={cn(dot, swatches[color])} />
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
