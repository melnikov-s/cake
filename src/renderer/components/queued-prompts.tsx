import type { ReactNode } from "react";
import { observer } from "r-state-tree/react";
import { IconButton } from "@/components/ui/icon-button";
import type { ChatStore } from "../stores/ChatStore";

function ChipIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

const SteerIcon = () => (
  <ChipIcon>
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
  </ChipIcon>
);
const EditIcon = () => (
  <ChipIcon>
    <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
  </ChipIcon>
);
const RemoveIcon = () => (
  <ChipIcon>
    <path d="M18 6 6 18M6 6l12 12" />
  </ChipIcon>
);

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
