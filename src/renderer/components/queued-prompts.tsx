import { observer } from "r-state-tree/react";
import { RemoveIcon } from "@/components/ui/icons";
import { IconButton } from "@/components/ui/icon-button";
import { LoadingSpinner } from "@/components/ui/loading-state";
import type { ChatStore } from "../stores/ChatStore";

/** Queued prompts stacked above the composer while a session streams. */
export const QueuedPrompts = observer(function QueuedPrompts({ store }: { store: ChatStore }) {
  if (store.queuedPrompts.length === 0) return null;
  return (
    <div
      className="flex flex-col gap-1 border-b border-border px-1.5 py-1"
      role="list"
      aria-label="Queued prompts"
    >
      {store.queuedPrompts.map((entry, index) => {
        const label =
          entry.text ||
          `${entry.attachments.length} attachment${entry.attachments.length === 1 ? "" : "s"}`;
        return (
          <div
            className="flex items-center justify-between gap-2 rounded-md bg-muted px-2 py-1 text-xs"
            role="listitem"
            key={entry.id}
          >
            <span className="min-w-0 flex-1 truncate" title={label}>
              {label}
            </span>
            <div className="flex shrink-0 items-center gap-1">
              <LoadingSpinner label={`Queued: ${label}`} />
              {index === 0 && store.canDequeuePrompts && (
                <IconButton
                  tooltip="Cancel and edit all queued messages"
                  ariaLabel={`Cancel and edit all queued messages: ${label}`}
                  onClick={() => void store.dequeuePrompts()}
                >
                  <RemoveIcon />
                </IconButton>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
});
