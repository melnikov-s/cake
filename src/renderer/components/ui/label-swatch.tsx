import type { HTMLAttributes } from "react";
import type { SessionLabelColor } from "../../../contracts/application/application-data";
import { cn } from "../../lib/utils";
import { mergedSessionLabelColor } from "../../../utils/session-label-color";

type LabelSwatchProps = HTMLAttributes<HTMLSpanElement> &
  (
    | { color: SessionLabelColor; colors?: never }
    | { color?: never; colors: readonly SessionLabelColor[] }
  );

export function LabelSwatch({
  color,
  colors,
  className,
  "aria-label": ariaLabel,
  ...props
}: LabelSwatchProps) {
  return (
    <span
      aria-hidden={ariaLabel ? undefined : true}
      aria-label={ariaLabel}
      data-session-label-color={mergedSessionLabelColor(color ? [color] : colors)}
      className={cn(
        "inline-block size-2.5 shrink-0 rounded-[3px] border border-current bg-current opacity-65 text-[attr(data-session-label-color_type(<color>))]",
        className,
      )}
      {...props}
    />
  );
}
