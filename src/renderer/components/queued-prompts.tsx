import { observer } from "r-state-tree/react";
import { EditIcon, RemoveIcon, SteerIcon } from "@/components/ui/icons";
import { IconButton } from "@/components/ui/icon-button";
import type { ChatStore } from "../stores/ChatStore";

/** Queued prompts stacked above the composer while a session streams. */
export const QueuedPrompts = observer(function QueuedPrompts({ store }: { store: ChatStore }) {
  if (store.queuedPrompts.length === 0) return null;
  return (
    <div className="queued-prompts" role="list" aria-label="Queued prompts">
      {store.queuedPrompts.map((entry) => {
        const label =
          entry.text ||
          `${entry.attachments.length} attachment${entry.attachments.length === 1 ? "" : "s"}`;
        return (
          <div className="queued-prompt" role="listitem" key={entry.id}>
            <span className="queued-prompt-text" title={label}>
              {label}
            </span>
            <div className="queued-prompt-actions">
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
            </div>
          </div>
        );
      })}
    </div>
  );
});
