import { cn } from "@/lib/utils";
import type { ThinkingLevel } from "../../contracts/conversations/session-contract";
import { TooltipBubble, useTooltip } from "./ui/tooltip";
import { modelChipClassName, reasoningLabel } from "./model-picker";

/**
 * The model picker's chip, read-only, for an agent whose configuration this surface
 * cannot change. Like the picker, it shows the model, reasoning and Fast mode; the
 * provider, often a long custom name, is in the tooltip and accessible name.
 */
export function ModelSummary({
  provider,
  modelId,
  thinkingLevel,
  fastMode,
  className,
}: {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  fastMode: boolean;
  className?: string;
}) {
  const { anchor, hide, show } = useTooltip();
  const thinking = thinkingLevel === "off" ? undefined : reasoningLabel(thinkingLevel);
  const description = [
    `${provider}/${modelId}`,
    thinking && `${thinking} reasoning`,
    fastMode && "Fast mode",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div
      data-slot="model-summary"
      className={cn(modelChipClassName, "cursor-default", className)}
      aria-label={`Model: ${description}`}
      tabIndex={0}
      onMouseEnter={(event) => show(event.currentTarget)}
      onMouseLeave={hide}
      onFocus={(event) => {
        if (event.currentTarget.matches(":focus-visible")) show(event.currentTarget);
      }}
      onBlur={hide}
    >
      <span className="min-w-0 truncate font-semibold" aria-hidden="true">
        {modelId}
      </span>
      {thinking && (
        <span className="shrink-0 text-muted-foreground" aria-hidden="true">
          · {thinking}
        </span>
      )}
      {fastMode && (
        <span className="shrink-0 text-muted-foreground" aria-hidden="true">
          · Fast
        </span>
      )}
      {anchor && <TooltipBubble label={description} anchor={anchor} />}
    </div>
  );
}
