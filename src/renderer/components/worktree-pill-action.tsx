import type { ReactNode } from "react";
import type { ButtonProps } from "./ui/button";
import { Button } from "./ui/button";
import { PopoverTrigger } from "./ui/popover";
import { TooltipBubble, useTooltip } from "./ui/tooltip";
import { cn } from "@/lib/utils";

export interface WorktreePillActionProps extends ButtonProps {
  disabledReason?: string;
  popoverTrigger?: boolean;
  tone?: "default" | "destructive";
  icon?: ReactNode;
  tooltip?: string;
}

/** Action button matching Cake's header toolbar style used in the worktree pill. */
export function WorktreePillAction({
  className,
  children,
  disabled,
  disabledReason,
  icon,
  popoverTrigger = false,
  tone = "default",
  tooltip,
  variant = "ghost",
  size = "sm",
  "aria-label": ariaLabel,
  ...props
}: WorktreePillActionProps) {
  const { anchor, hide, show } = useTooltip();
  const Control = popoverTrigger ? PopoverTrigger : Button;
  const isDestructive = tone === "destructive" || variant === "destructive";

  const control = (
    <Control
      {...props}
      variant={isDestructive ? "ghost" : variant}
      size={size}
      disabled={disabled || Boolean(disabledReason)}
      aria-label={ariaLabel ?? tooltip}
      className={cn(
        "flex h-7.5 shrink-0 items-center gap-1.5 rounded-lg bg-transparent px-2 text-xs font-normal text-muted-foreground shadow-none transition-colors hover:bg-muted hover:text-foreground @max-[430px]/worktree:w-7.5 @max-[430px]/worktree:gap-0 @max-[430px]/worktree:px-0",
        isDestructive &&
          "text-muted-foreground hover:bg-destructive/10 hover:text-destructive active:bg-destructive/15",
        className,
      )}
    >
      {icon && <span className="shrink-0">{icon}</span>}
      <span className="@max-[430px]/worktree:sr-only">{children}</span>
    </Control>
  );

  const tooltipLabel = disabledReason ?? tooltip;
  if (!tooltipLabel) return control;

  return (
    <span
      className="inline-flex shrink-0"
      onMouseEnter={(event) => show(event.currentTarget)}
      onMouseLeave={hide}
    >
      {control}
      {anchor && <TooltipBubble label={tooltipLabel} anchor={anchor} placement="above" />}
    </span>
  );
}
