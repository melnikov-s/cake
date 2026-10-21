import { useState } from "react";
import { observer } from "r-state-tree/react";
import { FullscreenMessage } from "@/components/fullscreen-message";
import { Button } from "@/components/ui/button";
import { ChevronDownIcon, ClockIcon, RemoveIcon, RepeatIcon } from "@/components/ui/icons";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";
import type { ScheduledMessageInteractionStore } from "../stores/ScheduledMessageInteractionStore";
import {
  describeScheduledSend,
  formatCountdown,
  formatRepeatInterval,
} from "../../utils/scheduled-message-time";

/**
 * Scheduled messages as the last group of the pending list, after steering and queued items.
 * A summary row shows the count and the next countdown; it expands to one row per schedule.
 */
export const ScheduledGroup = observer(function ScheduledGroup({
  store,
  othersPending,
}: {
  store: ScheduledMessageInteractionStore;
  othersPending: boolean;
}) {
  const [fullscreenId, setFullscreenId] = useState<string>();
  const messages = store.messages;
  const next = messages[0];
  if (!next) return null;
  const fullscreen = messages.find((message) => message.id === fullscreenId);
  const expanded = store.isExpanded(othersPending);
  const nextRemaining = store.remainingMs(next.sendAt);
  const repeating = store.repeatingCount;
  return (
    <div
      role="group"
      aria-label="Scheduled"
      className={cn("flex shrink-0 flex-col gap-1", othersPending && "border-t border-border pt-2")}
    >
      <Button
        variant="ghost"
        className="h-auto min-h-[30px] w-full flex-wrap justify-start gap-1.5 rounded-sm py-1 pr-1 pl-2 text-left text-xs font-normal whitespace-normal hover:bg-muted/40"
        aria-expanded={expanded}
        title={describeScheduledSend(next)}
        onClick={() => store.toggleExpanded(othersPending)}
      >
        <ClockIcon />
        <span className="font-medium text-foreground">{messages.length} scheduled</span>
        <span aria-hidden="true">·</span>
        <span role="timer" className="font-mono tabular-nums">
          {nextRemaining === 0 ? "sending…" : `next in ${formatCountdown(nextRemaining)}`}
        </span>
        {repeating > 0 && (
          <>
            <span aria-hidden="true">·</span>
            <span className="inline-flex items-center gap-1">
              <RepeatIcon size={11} />
              {repeating} repeating
            </span>
          </>
        )}
        <span
          aria-hidden="true"
          className={cn("ml-auto grid h-[22px] w-6 place-items-center", expanded && "rotate-180")}
        >
          <ChevronDownIcon />
        </span>
      </Button>
      {expanded &&
        messages.map((message) => {
          const remaining = store.remainingMs(message.sendAt);
          return (
            <div
              className="flex flex-wrap items-center gap-1 rounded-md bg-muted/40 px-2 py-1.5 text-xs"
              role="listitem"
              key={message.id}
              title={describeScheduledSend(message)}
            >
              <Button
                variant="ghost"
                className="h-auto min-w-0 flex-[1_1_160px] justify-start gap-1.5 rounded-sm p-0 text-left text-sm font-normal text-foreground hover:bg-transparent"
                aria-label={`View scheduled message: ${message.text}`}
                onClick={() => setFullscreenId(message.id)}
              >
                <span className="shrink-0 text-muted-foreground" aria-hidden="true">
                  <ClockIcon />
                </span>
                <span className="min-w-0 flex-1 truncate">{message.text}</span>
              </Button>
              <div className="ml-auto flex shrink-0 items-center gap-2.5">
                {message.repeatEverySeconds !== undefined && (
                  <span className="inline-flex items-center gap-1 whitespace-nowrap text-muted-foreground">
                    <RepeatIcon size={12} />
                    every {formatRepeatInterval(message.repeatEverySeconds)}
                  </span>
                )}
                <time
                  role="timer"
                  className="min-w-16 text-right font-mono whitespace-nowrap text-muted-foreground tabular-nums"
                  dateTime={message.sendAt}
                >
                  {remaining === 0 ? "Sending…" : `in ${formatCountdown(remaining)}`}
                </time>
                {store.canCancel && (
                  <IconButton
                    tooltip="Cancel scheduled message"
                    ariaLabel={`Cancel scheduled message: ${message.text}`}
                    onClick={() => void store.cancel(message.id)}
                  >
                    <RemoveIcon />
                  </IconButton>
                )}
              </div>
            </div>
          );
        })}
      {fullscreen && (
        <FullscreenMessage
          eyebrow="Scheduled message"
          title={describeScheduledSend(fullscreen)}
          text={fullscreen.text}
          markdown={false}
          onClose={() => setFullscreenId(undefined)}
        />
      )}
    </div>
  );
});

/** Scheduled messages alone, for surfaces that show no composer or queue. */
export const ScheduledPrompts = observer(function ScheduledPrompts({
  store,
}: {
  store: ScheduledMessageInteractionStore;
}) {
  if (store.messages.length === 0) return null;
  return (
    <div className="flex flex-col px-1.5 py-1" role="list" aria-label="Scheduled messages">
      <ScheduledGroup store={store} othersPending={false} />
    </div>
  );
});
