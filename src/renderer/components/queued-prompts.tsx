import { useState } from "react";
import { QueuedPromptPopover } from "./queued-prompt-popover";
import { QueuedAttachmentIndicator } from "./queued-attachment-indicator";
import {
  modelReferenceLabel,
  splitModelReferences,
} from "../../contracts/model-presets/model-reference";
import { observer } from "r-state-tree/react";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import {
  BotIcon,
  ChatIcon,
  ClockIcon,
  ContextIcon,
  EditIcon,
  ForkIcon,
  RemoveIcon,
} from "@/components/ui/icons";
import { IconIndicator } from "@/components/ui/icon-indicator";
import { IconButton } from "@/components/ui/icon-button";
import { ReorderControls } from "@/components/ui/reorder-controls";
import { ScheduledGroup } from "@/components/scheduled-prompts";
import { cn } from "@/lib/utils";
import type { ChatStore } from "../stores/ChatStore";
import { describeScheduledOrigin } from "../../utils/scheduled-message-time";

/** One sender-neutral pending list above the composer: steering, then queued Pi delivery
 * lanes, then Cake-owned scheduled messages. */
export const QueuedPrompts = observer(function QueuedPrompts({ store }: { store: ChatStore }) {
  const [openedPrompt, setOpenedPrompt] = useState<{ id: string; editing: boolean }>();
  const scheduled = store.scheduledMessageInteraction;
  const showCategoryHeaders =
    Number(store.queuedPrompts.some((entry) => entry.state === "steering")) +
      Number(store.queuedPrompts.some((entry) => entry.state === "queued")) +
      Number(scheduled.messages.length > 0) >
    1;
  if (store.queuedPrompts.length === 0 && scheduled.messages.length === 0) return null;
  return (
    <>
      <div
        className="@container/queue flex max-h-[min(15rem,25dvh)] flex-col gap-2 overflow-y-auto overscroll-contain border-b border-border px-1.5 py-1"
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
              {showCategoryHeaders && (
                <div className="px-2 text-xs font-medium text-muted-foreground">
                  {state === "steering" ? "Steering" : "Queued"}
                </div>
              )}
              {entries.map((entry, index) => {
                const promptKey = entry.itemId ?? entry.id;
                const label =
                  splitModelReferences(entry.text)
                    .map((part) => (part.model ? modelReferenceLabel(part.model) : part.text))
                    .join("") ||
                  `${entry.attachments.length} attachment${entry.attachments.length === 1 ? "" : "s"}`;
                const scheduled = entry.scheduled
                  ? describeScheduledOrigin(entry.scheduled)
                  : undefined;
                return (
                  <Popover
                    key={promptKey}
                    open={openedPrompt?.id === promptKey}
                    onOpenChange={(open) =>
                      setOpenedPrompt(open ? { id: promptKey, editing: false } : undefined)
                    }
                  >
                    <div
                      className="flex min-w-0 items-center gap-1 rounded-md bg-muted/40 px-2 py-1.5 text-xs motion-safe:animate-arrive"
                      role="listitem"
                    >
                      <QueuedAttachmentIndicator attachments={entry.attachments} />
                      <PopoverTrigger
                        variant="ghost"
                        className="h-7 min-w-0 flex-1 justify-start gap-1.5 rounded-sm p-0 text-left text-sm font-normal text-foreground hover:bg-transparent"
                        aria-label={`View queued message: ${label}`}
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
                        <span className="min-w-0 flex-1 truncate">{label}</span>
                      </PopoverTrigger>
                      <div className="flex shrink-0 items-center gap-x-2">
                        {(entry.pending || entry.state === "steering") && (
                          <span
                            role="status"
                            className="flex items-center gap-1.5 whitespace-nowrap text-muted-foreground"
                          >
                            <span aria-hidden="true">
                              <ClockIcon />
                            </span>
                            <span className="sr-only @min-[30rem]/queue:not-sr-only">
                              {entry.pending
                                ? entry.state === "queued"
                                  ? "Queueing…"
                                  : "Sending…"
                                : "Waiting for agent"}
                            </span>
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
                                <span className="hidden @min-[24rem]/queue:inline">
                                  Send as steering
                                </span>
                                <span className="@min-[24rem]/queue:hidden">Steer</span>
                              </Button>
                            )}
                          {store.canSendQueuedToSideChat(entry) && (
                            <IconButton
                              tooltip="Send to side chat"
                              ariaLabel={`Send to side chat: ${label}`}
                              disabled={store.sendingQueuedToSideChat}
                              onClick={() => void store.sendQueuedToSideChat(entry.id)}
                            >
                              <ForkIcon />
                            </IconButton>
                          )}
                          {entry.provenance ? (
                            <IconIndicator
                              label={
                                entry.provenance === "agent"
                                  ? "Agent-generated message"
                                  : "Automatic message"
                              }
                            >
                              {entry.provenance === "agent" ? <BotIcon /> : <ContextIcon />}
                            </IconIndicator>
                          ) : entry.editable !== false && store.canEditQueuedPrompt ? (
                            <IconButton
                              disabled={entry.pending}
                              tooltip="Edit"
                              ariaLabel={`Edit queued prompt: ${label}`}
                              onClick={() => setOpenedPrompt({ id: promptKey, editing: true })}
                            >
                              <EditIcon />
                            </IconButton>
                          ) : null}
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
                    {openedPrompt?.id === promptKey && (
                      <QueuedPromptPopover
                        store={store}
                        entry={entry}
                        initiallyEditing={openedPrompt.editing}
                        onClose={() => setOpenedPrompt(undefined)}
                      />
                    )}
                  </Popover>
                );
              })}
            </div>
          );
        })}
        <ScheduledGroup store={scheduled} othersPending={store.queuedPrompts.length > 0} />
      </div>
    </>
  );
});
