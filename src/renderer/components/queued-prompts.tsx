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
  StopIcon,
} from "@/components/ui/icons";
import { IconButton } from "@/components/ui/icon-button";
import { LoadingSpinner } from "@/components/ui/loading-state";
import type { ChatStore } from "../stores/ChatStore";
import { describeScheduledOrigin } from "../../utils/scheduled-message-time";

/** Queued prompts stacked above the composer while a session streams. */
export const QueuedPrompts = observer(function QueuedPrompts({ store }: { store: ChatStore }) {
  const [fullscreenPromptId, setFullscreenPromptId] = useState<string>();
  const fullscreenPrompt = store.queuedPrompts.find((entry) => entry.id === fullscreenPromptId);
  if (store.queuedPrompts.length === 0) return null;
  return (
    <>
      <div
        className="flex flex-col gap-1 border-b border-border px-1.5 py-1"
        role="list"
        aria-label="Queued prompts"
      >
        {store.queuedPrompts.map((entry) => {
          const label =
            entry.text ||
            `${entry.attachments.length} attachment${entry.attachments.length === 1 ? "" : "s"}`;
          const scheduled = entry.scheduled ? describeScheduledOrigin(entry.scheduled) : undefined;
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
                {entry.state === "steering" ? (
                  <>
                    <LoadingSpinner label={`Steering: ${label}`} />
                    {store.canStopAndSendQueuedPrompt && (
                      <IconButton
                        tooltip="Stop current response and send now"
                        ariaLabel={`Stop and send now: ${label}`}
                        onClick={() => void store.stopAndSendQueuedPrompt(entry.id)}
                      >
                        <StopIcon />
                      </IconButton>
                    )}
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
                        onClick={() => void store.steerQueuedPrompt(entry.id)}
                      >
                        <SteerIcon />
                      </IconButton>
                    )}
                    {store.canStopAndSendQueuedPrompt && (
                      <IconButton
                        tooltip="Stop current response and send now"
                        ariaLabel={`Stop and send now: ${label}`}
                        onClick={() => void store.stopAndSendQueuedPrompt(entry.id)}
                      >
                        <StopIcon />
                      </IconButton>
                    )}
                    {entry.editable !== false && store.canEditQueuedPrompt && (
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
      {fullscreenPrompt && (
        <FullscreenMessage
          eyebrow={fullscreenPrompt.state === "steering" ? "Steering message" : "Queued message"}
          title={fullscreenPrompt.source?.sender.title ?? "Cake"}
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
