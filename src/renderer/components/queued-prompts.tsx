import { useState } from "react";
import { observer } from "r-state-tree/react";
import { FullscreenMessage } from "@/components/fullscreen-message";
import { Button } from "@/components/ui/button";
import { ChatIcon, ClockIcon, EditIcon, RemoveIcon } from "@/components/ui/icons";
import { IconButton } from "@/components/ui/icon-button";
import { ReorderControls } from "@/components/ui/reorder-controls";
import { ScheduledGroup } from "@/components/scheduled-prompts";
import { cn } from "@/lib/utils";
import type { ChatStore } from "../stores/ChatStore";
import { describeScheduledOrigin } from "../../utils/scheduled-message-time";

/** One sender-neutral pending list above the composer: steering, then queued Pi delivery
 * lanes, then Cake-owned scheduled messages. */
export const QueuedPrompts = observer(function QueuedPrompts({ store }: { store: ChatStore }) {
  const [fullscreenPromptId, setFullscreenPromptId] = useState<string>();
  const fullscreenPrompt = store.queuedPrompts.find((entry) => entry.id === fullscreenPromptId);
  const scheduled = store.scheduledMessageInteraction;
  if (store.queuedPrompts.length === 0 && scheduled.messages.length === 0) return null;
  return (
    <>
      <div
        className="flex max-h-[min(15rem,25dvh)] flex-col gap-2 overflow-y-auto overscroll-contain border-b border-border px-1.5 py-1"
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
              className={cn(
                "flex shrink-0 flex-col gap-1",
                state === "queued" &&
                  store.queuedPrompts.some((entry) => entry.state === "steering") &&
                  "border-t border-border pt-2",
              )}
            >
              <div className="px-2 text-xs font-medium text-muted-foreground">
                {state === "steering" ? "Steering" : "Queued"}
              </div>
              {entries.map((entry, index) => {
                const label =
                  entry.text ||
                  `${entry.attachments.length} attachment${entry.attachments.length === 1 ? "" : "s"}`;
                const scheduled = entry.scheduled
                  ? describeScheduledOrigin(entry.scheduled)
                  : undefined;
                return (
                  <div
                    className={cn(
                      "flex gap-1 rounded-md bg-muted/40 px-2 py-1.5 text-xs",
                      entry.state === "steering" ? "flex-col" : "items-center",
                    )}
                    role="listitem"
                    key={entry.id}
                  >
                    <Button
                      variant="ghost"
                      className={cn(
                        "h-auto min-w-0 justify-start gap-1.5 rounded-sm p-0 text-left text-sm font-normal text-foreground hover:bg-transparent",
                        entry.state === "steering" ? "w-full" : "flex-1",
                      )}
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
                    <div
                      className={cn(
                        "flex items-center gap-x-2 gap-y-1",
                        entry.state === "steering" ? "flex-wrap justify-between" : "shrink-0",
                      )}
                    >
                      {(entry.pending || entry.state === "steering") && (
                        <span
                          role="status"
                          className="flex items-center gap-1.5 whitespace-nowrap text-muted-foreground"
                        >
                          <span aria-hidden="true">
                            <ClockIcon />
                          </span>
                          {entry.pending ? "Sending…" : "Waiting for agent"}
                        </span>
                      )}
                      <div className="ml-auto flex shrink-0 items-center gap-0.5">
                        {store.canReorderQueuedPrompt && entries.length > 1 && (
                          <ReorderControls
                            label={label}
                            position={index + 1}
                            count={admittedCount}
                            disabled={entry.pending}
                            onMove={(position) =>
                              void store.reorderQueuedPrompt(entry.id, position)
                            }
                          />
                        )}
                        {entry.state === "steering" && store.canStopAndSendQueuedPrompt && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 font-normal"
                            disabled={entry.pending}
                            title="Stop current response and send now"
                            aria-label={`Stop and send now: ${label}`}
                            aria-description="Stops the current response and sends this message immediately."
                            onClick={() => void store.stopAndSendQueuedPrompt(entry.id)}
                          >
                            Send now
                          </Button>
                        )}
                        {entry.state === "queued" &&
                          store.canSteerQueuedPrompt &&
                          !entry.command && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 font-normal"
                              disabled={entry.pending}
                              title="Send now as steering"
                              aria-label={`Send now as steering: ${label}`}
                              onClick={() => void store.steerQueuedPrompt(entry.id)}
                            >
                              Send as steering
                            </Button>
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
                  </div>
                );
              })}
            </div>
          );
        })}
        <ScheduledGroup store={scheduled} othersPending={store.queuedPrompts.length > 0} />
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
