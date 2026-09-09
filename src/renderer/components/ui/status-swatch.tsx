import type { HTMLAttributes } from "react";
import type { ProjectWorkflowColor } from "../../../domain/application/application-data";
import { cn } from "../../lib/utils";

const colorClasses = {
  rose: "border-workflow-rose/70 bg-workflow-rose/65",
  peach: "border-workflow-peach/70 bg-workflow-peach/65",
  amber: "border-workflow-amber/70 bg-workflow-amber/65",
  lime: "border-workflow-lime/70 bg-workflow-lime/65",
  mint: "border-workflow-mint/70 bg-workflow-mint/65",
  sky: "border-workflow-sky/70 bg-workflow-sky/65",
  blue: "border-workflow-blue/70 bg-workflow-blue/65",
  violet: "border-workflow-violet/70 bg-workflow-violet/65",
} satisfies Record<ProjectWorkflowColor, string>;

export interface StatusSwatchProps extends HTMLAttributes<HTMLSpanElement> {
  color: ProjectWorkflowColor;
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
      className={cn(
        "inline-block size-2.5 shrink-0 rounded-[3px] border",
        colorClasses[color],
        className,
      )}
      {...props}
    />
  );
}
