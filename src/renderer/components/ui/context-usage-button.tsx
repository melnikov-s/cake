import type { FocusEvent, MouseEvent, Ref } from "react";
import { Button } from "./button";
import { ContextIcon } from "./icons";
import { TooltipBubble, useTooltip } from "./tooltip";
import { cn } from "@/lib/utils";

const format = (tokens: number) =>
  new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 })
    .format(tokens)
    .toLowerCase();

/** Quiet context total; the subtle cache underline never represents context health.
 * Without an inspection action, renders a read-only indicator with the same treatment.
 */
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
  onClick?(): void;
}) {
  const { anchor, show, hide } = useTooltip();
  const available = total !== undefined && limit !== undefined;
  const breakdown =
    system !== undefined && memory !== undefined && messages !== undefined
      ? ` System ${system.toLocaleString("en")}; memory ${memory.toLocaleString("en")}; messages ${messages.toLocaleString("en")}.`
      : "";
  const description = available
    ? `Estimated active context ${total.toLocaleString("en")} of ${limit.toLocaleString("en")} tokens.${breakdown} ${detail}`
    : detail;
  const attributes = {
    "aria-label": onClick ? "Browse context" : "Context usage",
    "aria-description": description,
    "data-slot": "context-usage",
    "data-cache-state": cacheState,
    className: cn(
      "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-sm border border-border/65 bg-transparent px-[0.4375rem] py-0 font-mono text-xs font-normal tabular-nums [&>svg]:size-3.5",
      cacheState === "likely-warm" &&
        "shadow-[inset_0_-1px_color-mix(in_srgb,var(--success)_40%,transparent)]",
    ),
    onMouseEnter: (event: MouseEvent<HTMLElement>) => show(event.currentTarget),
    onMouseLeave: hide,
    onFocus: (event: FocusEvent<HTMLElement>) => {
      if (event.currentTarget.matches(":focus-visible")) show(event.currentTarget);
    },
    onBlur: hide,
  };
  const content = available ? (
    <>
      <ContextIcon />
      <span className="font-medium text-foreground">
        ≈{format(total)}
        <span className="font-normal text-muted-foreground">/{format(limit)}</span>
      </span>
    </>
  ) : (
    "Context unavailable"
  );
  return (
    <>
      {onClick ? (
        <Button
          ref={ref}
          variant="ghost"
          {...attributes}
          onClick={() => {
            hide();
            onClick();
          }}
        >
          {content}
        </Button>
      ) : (
        <span {...attributes} role="img" tabIndex={0}>
          {content}
        </span>
      )}
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
