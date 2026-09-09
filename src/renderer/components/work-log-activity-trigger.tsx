import { observer } from "r-state-tree/react";
import { Badge } from "@/components/ui/badge";
import { DisclosureTrigger } from "@/components/ui/disclosure-trigger";
import { formatElapsed } from "@/components/ui/loading-state";
import type { ChatStore } from "@/stores/ChatStore";

/** Keeps the 100 ms work-log clock subscribed to only this small label. */
export const WorkLogActivityTrigger = observer(function WorkLogActivityTrigger({
  store,
  firstPartId,
  lastPartId,
  activityCountLabel,
  open,
  onToggle,
}: {
  store: ChatStore;
  firstPartId?: string;
  lastPartId?: string;
  activityCountLabel: string;
  open: boolean;
  onToggle(): void;
}) {
  const elapsedMs =
    firstPartId && lastPartId
      ? store.workLogPresentation.elapsedMsRange(firstPartId, lastPartId)
      : undefined;
  const title =
    elapsedMs === undefined
      ? activityCountLabel
      : `${activityCountLabel} · ${formatElapsed(elapsedMs)}`;

  return (
    <DisclosureTrigger
      className="px-3 py-2 hover:bg-muted/50"
      open={open}
      onClick={onToggle}
      badge={
        <Badge variant="outline" size="xs" className="text-muted-foreground">
          Activity
        </Badge>
      }
      title={title}
      trailing={
        <span className="text-[11px] text-muted-foreground">
          {open ? "Hide steps" : "View steps"}
        </span>
      }
    />
  );
});
