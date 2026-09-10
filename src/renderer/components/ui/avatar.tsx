import { Avatar as DiceBearAvatar, Style } from "@dicebear/core";
import gazeDefinition from "@dicebear/styles/gaze.json";
import sliceDefinition from "@dicebear/styles/slice.json";
import { useMemo, type HTMLAttributes } from "react";
import type { ProjectWorkflowColor } from "../../../domain/application/application-data";
import { cn } from "../../lib/utils";

const styles = {
  project: new Style(sliceDefinition),
  session: new Style(gazeDefinition),
} as const;

const statusColorClasses = {
  rose: "border-workflow-rose/70 bg-workflow-rose/65",
  peach: "border-workflow-peach/70 bg-workflow-peach/65",
  amber: "border-workflow-amber/70 bg-workflow-amber/65",
  lime: "border-workflow-lime/70 bg-workflow-lime/65",
  mint: "border-workflow-mint/70 bg-workflow-mint/65",
  sky: "border-workflow-sky/70 bg-workflow-sky/65",
  blue: "border-workflow-blue/70 bg-workflow-blue/65",
  violet: "border-workflow-violet/70 bg-workflow-violet/65",
} satisfies Record<ProjectWorkflowColor, string>;

export interface AvatarProps extends HTMLAttributes<HTMLSpanElement> {
  kind: "project" | "session";
  seed: string;
  statusColor?: ProjectWorkflowColor;
}

/** Deterministic DiceBear avatar with Cake-owned sizing, status color, and accessibility. */
export function Avatar({ kind, seed, statusColor, className, ...props }: AvatarProps) {
  const uri = useMemo(() => new DiceBearAvatar(styles[kind], { seed }).toDataUri(), [kind, seed]);
  return (
    <span
      data-slot="avatar"
      className={cn(
        "inline-grid size-5 shrink-0 place-items-center overflow-hidden border",
        kind === "project" ? "rounded-md border-border bg-muted" : "rounded-full border-border",
        kind === "session" &&
          (statusColor ? statusColorClasses[statusColor] : "bg-muted text-muted-foreground"),
        className,
      )}
      {...props}
    >
      <img className="size-full" src={uri} alt="" aria-hidden="true" />
    </span>
  );
}
