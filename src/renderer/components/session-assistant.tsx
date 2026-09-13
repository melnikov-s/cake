import { useEffect, useState, type MouseEvent } from "react";
import { observer } from "r-state-tree/react";
import { cn } from "@/lib/utils";
import type { SessionLabel } from "../../domain/application/application-data";
import { Chat } from "./chat";
import { Avatar } from "./ui/avatar";
import { Popover, PopoverContent, PopoverIconTrigger } from "./ui/popover";
import type { SessionAssistantStore } from "../stores/SessionAssistantStore";

type AssistantSurface = "quick" | "chat";

/** Composer avatar trigger for a one-shot prompt and the full transient session assistant. */
export const SessionAssistant = observer(function SessionAssistant({
  store,
  seed,
  labels,
  value,
  animated = false,
}: {
  store: SessionAssistantStore;
  seed: string;
  labels: readonly SessionLabel[];
  value: readonly string[];
  animated?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [surface, setSurface] = useState<AssistantSurface>("quick");
  const labelColors = value.flatMap((labelId) => {
    const label = labels.find((candidate) => candidate.id === labelId);
    return label ? [label.color] : [];
  });
  const quickResponseRevision = store.quickResponseRevision;

  useEffect(() => {
    if (open) store.requestFocus();
  }, [open, store, surface]);

  useEffect(() => {
    if (!open || surface !== "quick" || quickResponseRevision === 0) return;
    const timer = window.setTimeout(() => setOpen(false), 5_000);
    return () => window.clearTimeout(timer);
  }, [open, quickResponseRevision, surface]);

  const openFullChat = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setSurface("chat");
    setOpen(true);
    store.requestFocus();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverIconTrigger
        tooltip="Ask session assistant · Right-click for chat"
        ariaLabel="Ask session assistant"
        onClick={() => {
          setSurface("quick");
          store.beginQuickPrompt();
        }}
        onContextMenu={openFullChat}
        className="size-10 rounded-full p-0 hover:bg-muted [&_[data-slot=avatar]]:size-9"
      >
        <Avatar
          kind="session"
          seed={seed}
          labelColors={labelColors}
          animated={animated}
          className="size-9"
        />
      </PopoverIconTrigger>
      {surface === "quick" ? (
        <PopoverContent
          side="left"
          align="end"
          offset={10}
          aria-label="Quick session assistant"
          className={cn(
            "w-[min(22rem,calc(100vw-1rem))] overflow-hidden rounded-xl p-0",
            store.quickParts.length > 0 &&
              "overflow-visible border-0 bg-transparent shadow-none [&_[aria-label=Conversation]]:p-0",
          )}
        >
          <Chat
            store={store.quickChatStore}
            compact
            embedded
            composerFocusEnabled
            className={cn(
              "h-auto max-h-[min(18rem,60vh)] [&_.transcript]:max-h-[min(18rem,60vh)] [&_[data-slot=composer-toolbar]]:shrink-0 [&_[data-slot=composer-toolbar]]:border-0 [&_[data-slot=composer-toolbar]]:p-0 [&_[data-slot=composer-toolbar]>div:first-child]:hidden [&_[data-slot=message]]:w-full [&_[data-slot=message-content]]:rounded-md [&_[data-slot=message-content]]:px-3 [&_[data-slot=message-content]]:py-2.5 [&_[data-slot=message-content]]:text-xs [&_[data-slot=message-content]]:leading-5 [&_[data-slot=message-content]]:shadow-none [&_[data-slot=message-actions]]:hidden [&_form]:flex [&_form]:items-center [&_form]:gap-1.5 [&_form]:border-0 [&_form]:bg-transparent [&_form]:p-1.5 [&_form]:shadow-none [&_textarea]:max-h-40 [&_textarea]:min-h-8 [&_textarea]:px-2.5 [&_textarea]:py-1.5 [&_textarea]:text-xs",
              store.quickParts.length === 0 && "[&_.transcript]:hidden",
            )}
            error={store.error ? { message: store.error, title: "Assistant failed" } : undefined}
          />
        </PopoverContent>
      ) : (
        <PopoverContent
          side="left"
          align="end"
          offset={12}
          aria-label="Session assistant chat"
          className="h-[min(24rem,70vh)] w-[min(19rem,calc(100vw-1rem))] overflow-hidden rounded-md p-0"
        >
          <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
            <div className="border-b border-border px-3 py-2">
              <p className="text-xs font-semibold">Session assistant</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Uses your utility model and visible conversation context.
              </p>
            </div>
            <Chat
              store={store.chatStore}
              compact
              embedded
              className="[&_[data-slot=message]]:gap-1.5 [&_[data-slot=message-content]]:rounded-md [&_[data-slot=message-content]]:px-3 [&_[data-slot=message-content]]:py-2 [&_[data-slot=message-content]]:text-xs [&_[data-slot=message-content]]:leading-5 [&_[data-slot=message-content]]:shadow-none [&_[data-slot=message-label]]:text-[10px] [&_form]:rounded-md [&_form]:p-2 [&_textarea]:min-h-9 [&_textarea]:py-1.5"
              error={store.error ? { message: store.error, title: "Assistant failed" } : undefined}
              empty={
                <div className="grid h-full place-items-center p-5 text-center text-xs leading-relaxed text-muted-foreground">
                  Ask for a quick answer or an action in Cake.
                </div>
              }
            />
          </div>
        </PopoverContent>
      )}
    </Popover>
  );
});
