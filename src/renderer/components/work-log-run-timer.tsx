import { observer } from "r-state-tree/react";
import type { ChatStore } from "../stores/ChatStore";
import { formatVisibleElapsed } from "./ui/loading-state";

/** Shared count-up chip for observed work-log activity; frozen on completion. */
export const WorkLogRunTimer = observer(function WorkLogRunTimer({
  store,
  partId,
  startPartId,
}: {
  store: ChatStore;
  partId: string;
  startPartId?: string;
}) {
  const elapsedMs = startPartId
    ? store.workLogPresentation.elapsedMsRange(startPartId, partId)
    : store.workLogPresentation.elapsedMs(partId);
  const elapsed = formatVisibleElapsed(elapsedMs);
  if (!elapsed) return null;
  return (
    <span
      className="flex items-center gap-1 font-mono text-xs tabular-nums text-muted-foreground whitespace-nowrap"
      aria-label="elapsed time"
    >
      {elapsed}
    </span>
  );
});
