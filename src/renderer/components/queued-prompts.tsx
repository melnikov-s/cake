import { useState } from "react";
import { observer } from "r-state-tree/react";
import { FullscreenMessage } from "@/components/fullscreen-message";
import { Button } from "@/components/ui/button";
import {
  ChatIcon,
  ClockIcon,
  EditIcon,
  RemoveIcon,
  SteerIcon,
  StopAndSendIcon,
} from "@/components/ui/icons";
import { IconButton } from "@/components/ui/icon-button";
import { LoadingSpinner } from "@/components/ui/loading-state";
import { ReorderControls } from "@/components/ui/reorder-controls";
import type { ChatStore } from "../stores/ChatStore";
import { describeScheduledOrigin } from "../../utils/scheduled-message-time";

/** One sender-neutral queue, grouped by Pi delivery lane above the composer. */
export const QueuedPrompts = observer(function QueuedPrompts({ store }: { store: ChatStore }) {
  const [fullscreenPromptId, setFullscreenPromptId] = useState<string>();
  const fullscreenPrompt = store.queuedPrompts.find((entry) => entry.id === fullscreenPromptId);
  if (store.queuedPrompts.length === 0) return null;
  return (
    <>
      <div
        className="flex flex-col gap-2 border-b border-border px-1.5 py-1"
        role="list"
        aria-label="Queued prompts"
      >
        {(["steering", "queued"] as const).map((state) => {
          const entries = store.queuedPrompts.filter((entry) => entry.state === state);
          if (!entries.length) return null;
          const admittedCount = entries.filter((entry) => !entry.pending).length;
          return (
            <div
              key={state}
              role="group"
              aria-label={state === "steering" ? "Steering" : "Queued"}
              className="flex flex-col gap-1"
            >
              {entries.map((entry, index) => {
                const label =
                  entry.text ||
                  `${entry.attachments.length} attachment${entry.attachments.length === 1 ? "" : "s"}`;
                const scheduled = entry.scheduled
                  ? describeScheduledOrigin(entry.scheduled)
                  : undefined;
                return (
                  <div
                    className="flex items-center justify-between gap-2 rounded-md bg-muted px-2 py-1 text-xs"
                    role="listitem"
                    key={entry.id}
                  >
                    <Button
                      variant="ghost"
                      className="h-auto min-w-0 flex-1 justify-start gap-1.5 rounded-sm p-0 text-left text-xs font-normal text-foreground hover:bg-transparent"
                      aria-label={`View queued message: ${label}`}
                      onClick={() => setFullscreenPromptId(entry.id)}
                    >
                      {entry.source && (
                        <span
                          className="shrink-0 text-muted-foreground"
                          title={`Message from ${entry.source.sender.title}`}
                          aria-label={`Message from ${entry.source.sender.title}`}
                        >
                          <ChatIcon size={13} />
                        </span>
                      )}
                      {scheduled && (
                        <span
                          className="shrink-0 text-muted-foreground"
                          title={scheduled.detail}
                          aria-label={`Scheduled message: ${scheduled.summary}`}
                        >
                          <ClockIcon />
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate" title={label}>
                        {label}
                      </span>
                    </Button>
                    <div className="flex shrink-0 items-center gap-0.5">
                      {store.canReorderQueuedPrompt && (
                        <ReorderControls
                          label={label}
                          position={index + 1}
                          count={admittedCount}
                          disabled={entry.pending}
                          onMove={(position) => void store.reorderQueuedPrompt(entry.id, position)}
                        />
                      )}
                      {store.canStopAndSendQueuedPrompt && (
                        <IconButton
                          disabled={entry.pending}
                          tooltip="Stop current response and send now"
                          ariaLabel={`Stop and send now: ${label}`}
                          onClick={() => void store.stopAndSendQueuedPrompt(entry.id)}
                        >
                          <StopAndSendIcon />
                        </IconButton>
                      )}
                      {entry.state === "steering" ? (
                        <LoadingSpinner label={`Steering: ${label}`} />
                      ) : (
                        store.canSteerQueuedPrompt &&
                        !entry.command && (
                          <IconButton
                            disabled={entry.pending}
                            tooltip="Send now as steering"
                            ariaLabel={`Send now as steering: ${label}`}
                            onClick={() => void store.steerQueuedPrompt(entry.id)}
                          >
                            <SteerIcon />
                          </IconButton>
                        )
                      )}
                      {entry.editable !== false && store.canEditQueuedPrompt && (
                        <IconButton
                          disabled={entry.pending}
                          tooltip="Edit"
                          ariaLabel={`Edit queued prompt: ${label}`}
                          onClick={() => void store.editQueuedPrompt(entry.id)}
                        >
                          <EditIcon />
                        </IconButton>
                      )}
                      {store.canRemoveQueuedPrompt && (
                        <IconButton
                          disabled={entry.pending}
                          tooltip="Cancel message"
                          ariaLabel={`Cancel ${entry.state === "steering" ? "steering" : "queued message"}: ${label}`}
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
        })}
      </div>
      {fullscreenPrompt && (
        <FullscreenMessage
          eyebrow={fullscreenPrompt.state === "steering" ? "Steering message" : "Queued message"}
          title={fullscreenPrompt.source?.sender.title ?? "Cake"}
          sourceSession={fullscreenPrompt.source?.sender}
          text={
            fullscreenPrompt.text ||
            `${fullscreenPrompt.attachments.length} attachment${fullscreenPrompt.attachments.length === 1 ? "" : "s"}`
          }
          markdown={fullscreenPrompt.renderUserMessageAsMarkdown}
          onClose={() => setFullscreenPromptId(undefined)}
        />
      )}
    </>
  );
});
