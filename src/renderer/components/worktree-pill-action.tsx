import type { ButtonProps } from "./ui/button";
import { Button } from "./ui/button";
import { PopoverTrigger } from "./ui/popover";
import { TooltipBubble, useTooltip } from "./ui/tooltip";
import { cn } from "@/lib/utils";

export interface WorktreePillActionProps extends ButtonProps {
  disabledReason?: string;
  popoverTrigger?: boolean;
  tone?: "default" | "destructive";
}

/** Shared pill-shaped action used by the managed-worktree toolbar. */
export function WorktreePillAction({
  className,
  disabled,
  disabledReason,
  popoverTrigger = false,
  tone = "default",
  ...props
}: WorktreePillActionProps) {
  const { anchor, hide, show } = useTooltip();
  const Control = popoverTrigger ? PopoverTrigger : Button;
  const control = (
    <Control
      {...props}
      variant="outline"
      size="sm"
      disabled={disabled || Boolean(disabledReason)}
      className={cn(
        "h-8 shrink-0 rounded-full border-border/80 bg-background/75 px-3 text-sm font-medium text-foreground shadow-sm hover:border-foreground/20 hover:bg-muted",
        tone === "destructive" &&
          "border-destructive/25 text-destructive hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive",
        className,
      )}
    />
  );

  if (!disabledReason) return control;

  return (
    <span
      className="inline-flex shrink-0"
      onMouseEnter={(event) => show(event.currentTarget)}
      onMouseLeave={hide}
    >
      {control}
      {anchor && <TooltipBubble label={disabledReason} anchor={anchor} placement="above" />}
    </span>
  );
}
