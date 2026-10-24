import type { Ref } from "react";
import { Button } from "./button";
import { TooltipBubble, useTooltip } from "./tooltip";
import { cn } from "@/lib/utils";

const format = (tokens: number) =>
  new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 })
    .format(tokens)
    .toLowerCase();

/** Compact context accounting; border conveys cache freshness, never context health. */
export function ContextUsageButton({
  ref,
  system,
  memory,
  messages,
  total,
  limit,
  cacheState,
  detail,
  onClick,
}: {
  ref?: Ref<HTMLButtonElement>;
  system?: number;
  memory?: number;
  messages?: number;
  total?: number;
  limit?: number;
  cacheState: string;
  detail: string;
  onClick(): void;
}) {
  const { anchor, show, hide } = useTooltip();
  return (
    <>
      <Button
        ref={ref}
        variant="ghost"
        aria-label="Browse context"
        aria-description={detail}
        data-slot="context-usage"
        data-cache-state={cacheState}
        className={cn(
          "h-auto min-h-7 shrink-0 gap-1 rounded-full border bg-muted/40 px-2 py-1 font-mono text-xs font-normal tabular-nums",
          cacheState === "likely-warm" ? "border-success/50" : "border-border/60",
        )}
        onClick={() => {
          hide();
          onClick();
        }}
        onMouseEnter={(event) => show(event.currentTarget)}
        onMouseLeave={hide}
        onFocus={(event) => {
          if (event.currentTarget.matches(":focus-visible")) show(event.currentTarget);
        }}
        onBlur={hide}
      >
        {total === undefined || limit === undefined ? (
          "Context unavailable"
        ) : (
          <>
            <span className="@max-[38rem]/composer-dock:hidden">
              [Sys {format(system ?? 0)} · Mem {format(memory ?? 0)} · Msgs {format(messages ?? 0)}]
              ·{" "}
            </span>
            <span className="text-foreground">
              ≈{format(total)}/{format(limit)}
            </span>
          </>
        )}
      </Button>
      {anchor && (
        <TooltipBubble
          label={detail}
          anchor={anchor}
          placement="above"
          wrap
          className="whitespace-pre-line"
        />
      )}
    </>
  );
}
