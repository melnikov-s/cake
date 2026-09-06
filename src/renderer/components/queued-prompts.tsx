import { observer } from "r-state-tree/react";
import { EditIcon, RemoveIcon, SteerIcon } from "@/components/ui/icons";
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
      {store.queuedPrompts.map((entry) => {
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
            <div className="flex shrink-0 items-center gap-0.5">
              {entry.state === "steering" ? (
                <>
                  <LoadingSpinner label={`Steering: ${label}`} />
                  {store.canCancelSteering && (
                    <IconButton
                      tooltip="Cancel steering"
                      ariaLabel={`Cancel steering: ${label}`}
                      onClick={() => void store.cancelSteering()}
                    >
                      <RemoveIcon />
                    </IconButton>
                  )}
                </>
              ) : (
                <>
                  {store.canSteerQueuedPrompt && (
                    <IconButton
                      tooltip="Send now as steering"
                      ariaLabel={`Send now as steering: ${label}`}
                      onClick={() => store.steerQueuedPrompt(entry.id)}
                    >
                      <SteerIcon />
                    </IconButton>
                  )}
                  {store.canEditQueuedPrompt && (
                    <IconButton
                      tooltip="Edit"
                      ariaLabel={`Edit queued prompt: ${label}`}
                      onClick={() => store.editQueuedPrompt(entry.id)}
                    >
                      <EditIcon />
                    </IconButton>
                  )}
                  {store.canRemoveQueuedPrompt && (
                    <IconButton
                      tooltip="Remove"
                      ariaLabel={`Remove queued prompt: ${label}`}
                      onClick={() => store.removeQueuedPrompt(entry.id)}
                    >
                      <RemoveIcon />
                    </IconButton>
                  )}
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
});
