import type { HTMLAttributes } from "react";
import type { WorkflowStatusColor } from "../../../domain/application/application-data";
import { cn } from "../../lib/utils";
import { workflowStatusPalette } from "../../../utils/workflow-status-palette";

export interface StatusSwatchProps extends HTMLAttributes<HTMLSpanElement> {
  color: WorkflowStatusColor;
}

export function StatusSwatch({
  color,
  className,
  "aria-label": ariaLabel,
  ...props
}: StatusSwatchProps) {
  return (
    <span
      aria-hidden={ariaLabel ? undefined : true}
      aria-label={ariaLabel}
      data-workflow-status-color={workflowStatusPalette[color]}
      className={cn(
        "inline-block size-2.5 shrink-0 rounded-[3px] border border-current bg-current opacity-65 text-[attr(data-workflow-status-color_type(<color>))]",
        className,
      )}
      {...props}
    />
  );
}
