import type { Ref } from "react";
import { Button } from "./button";
import { ContextIcon } from "./icons";
import { TooltipBubble, useTooltip } from "./tooltip";
import { cn } from "@/lib/utils";

const format = (tokens: number) =>
  new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 })
    .format(tokens)
    .toLowerCase();

/** Quiet context total; the subtle cache underline never represents context health. */
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
  const available = total !== undefined && limit !== undefined;
  const description = available
    ? `Estimated active context ${total.toLocaleString("en")} of ${limit.toLocaleString("en")} tokens. System ${(system ?? 0).toLocaleString("en")}; memory ${(memory ?? 0).toLocaleString("en")}; messages ${(messages ?? 0).toLocaleString("en")}. ${detail}`
    : detail;
  return (
    <>
      <Button
        ref={ref}
        variant="ghost"
        aria-label="Browse context"
        aria-description={description}
        data-slot="context-usage"
        data-cache-state={cacheState}
        className={cn(
          "h-7 shrink-0 gap-1.5 rounded-sm border border-border/65 bg-transparent px-[0.4375rem] py-0 font-mono text-xs font-normal tabular-nums [&>svg]:size-3.5",
          cacheState === "likely-warm" &&
            "shadow-[inset_0_-1px_color-mix(in_srgb,var(--success)_40%,transparent)]",
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
        {available ? (
          <>
            <ContextIcon />
            <span className="font-medium text-foreground">
              ≈{format(total)}
              <span className="font-normal text-muted-foreground">/{format(limit)}</span>
            </span>
          </>
        ) : (
          "Context unavailable"
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
