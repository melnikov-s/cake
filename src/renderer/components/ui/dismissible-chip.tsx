import type { ReactElement, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Chip, type ChipProps } from "./chip";
import { IconButton } from "./icon-button";
import { CloseIcon } from "./icons";

export interface DismissibleChipProps extends Omit<ChipProps, "children" | "trailing"> {
  children: ReactNode;
  removeLabel: string;
  onRemove(): void;
}

/** Two sibling actions: the primary Chip and a separately accessible dismiss button. */
export function DismissibleChip({
  children,
  removeLabel,
  onRemove,
  disabled,
  className,
  ...props
}: DismissibleChipProps): ReactElement {
  return (
    <span className="inline-flex min-w-0 items-center gap-0.5">
      <Chip {...props} disabled={disabled} className={cn("min-w-0 truncate", className)}>
        {children}
      </Chip>
      <IconButton
        className="size-6 shrink-0 rounded-full"
        tooltip={removeLabel}
        disabled={disabled}
        onClick={onRemove}
      >
        <CloseIcon />
      </IconButton>
    </span>
  );
}
