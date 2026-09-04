import { observer } from "r-state-tree/react";
import { ClockIcon, RemoveIcon } from "@/components/ui/icons";
import { IconButton } from "@/components/ui/icon-button";
import type { ChatStore } from "../stores/ChatStore";

function countdown(milliseconds: number) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

/** Pending durable messages for the destination session, shown above its composer. */
export const ScheduledPrompts = observer(function ScheduledPrompts({
  store,
}: {
  store: ChatStore;
}) {
  if (store.scheduledMessages.length === 0) return null;
  return (
    <div
      className="flex flex-col gap-1 border-b border-border px-1.5 py-1"
      role="list"
      aria-label="Scheduled messages"
    >
      {store.scheduledMessages.map((message) => (
        <div
          className="flex items-center justify-between gap-2 rounded-md bg-muted px-2 py-1 text-xs"
          role="listitem"
          key={message.id}
        >
          <ClockIcon />
          <span className="min-w-0 flex-1 truncate" title={message.text}>
            {message.text}
          </span>
          <time
            className="shrink-0 font-mono text-muted-foreground tabular-nums"
            dateTime={message.sendAt}
            title={new Date(message.sendAt).toLocaleString()}
          >
            sends in {countdown(store.scheduledMessageRemainingMs(message.sendAt))}
          </time>
          {store.canCancelScheduledMessage && (
            <IconButton
              tooltip="Cancel scheduled message"
              ariaLabel={`Cancel scheduled message: ${message.text}`}
              onClick={() => void store.cancelScheduledMessage(message.id)}
            >
              <RemoveIcon />
            </IconButton>
          )}
        </div>
      ))}
    </div>
  );
});
