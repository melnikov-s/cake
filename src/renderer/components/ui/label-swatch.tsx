import type { HTMLAttributes } from "react";
import type { SessionLabelColor } from "../../../domain/application/application-data";
import { cn } from "../../lib/utils";
import { sessionLabelPalette } from "../../../utils/session-label-palette";

export interface LabelSwatchProps extends HTMLAttributes<HTMLSpanElement> {
  color: SessionLabelColor;
}

export function LabelSwatch({
  color,
  className,
  "aria-label": ariaLabel,
  ...props
}: LabelSwatchProps) {
  return (
    <span
      aria-hidden={ariaLabel ? undefined : true}
      aria-label={ariaLabel}
      data-session-label-color={sessionLabelPalette[color]}
      className={cn(
        "inline-block size-2.5 shrink-0 rounded-[3px] border border-current bg-current opacity-65 text-[attr(data-session-label-color_type(<color>))]",
        className,
      )}
      {...props}
    />
  );
}
