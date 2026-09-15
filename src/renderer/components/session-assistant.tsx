import { useEffect, useState, type MouseEvent } from "react";
import { observer } from "r-state-tree/react";
import { cn } from "@/lib/utils";
import type { SessionLabel } from "../../domain/application/application-data";
import { Chat } from "./chat";
import { Avatar } from "./ui/avatar";
import { Popover, PopoverContent, PopoverIconTrigger } from "./ui/popover";
import { ThinkingBubble } from "./ui/thinking-bubble";
import type { SessionAssistantStore } from "../stores/SessionAssistantStore";

type AssistantSurface = "quick" | "chat";

function composerSelection(trigger: HTMLElement) {
  const input = trigger
    .closest<HTMLElement>('[data-slot="composer-dock"]')
    ?.querySelector<HTMLTextAreaElement>(".workbench-composer textarea");
  if (!input || input.selectionStart === input.selectionEnd) return undefined;
  return input.value.slice(input.selectionStart, input.selectionEnd).slice(0, 32_000);
}

/** Composer avatar trigger for quick and full views of its durable assistant side chat. */
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
  const processing = store.processing;
  const quickResponse = store.quickParts.length > 0;

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
    store.beginChat(composerSelection(event.currentTarget));
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverIconTrigger
        ariaLabel="Ask session assistant"
        onMouseDown={(event) => {
          // Keep the parent composer selection intact until the assistant snapshots it.
          if (event.button === 0) event.preventDefault();
        }}
        onClick={(event) => {
          setSurface("quick");
          store.beginQuickPrompt(composerSelection(event.currentTarget));
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
          side={quickResponse ? "left" : "top"}
          align="center"
          boundary="nearest-ancestor"
          offset={quickResponse ? 12 : 8}
          aria-label="Quick session assistant"
          className={cn(
            "overflow-hidden rounded-xl p-0",
            processing || quickResponse
              ? "w-fit overflow-visible border-0 bg-transparent shadow-none"
              : "w-[min(22rem,calc(100vw-24px))]",
            quickResponse &&
              "max-w-[min(22rem,calc(100vw-24px))] rounded-2xl [&_[aria-label=Conversation]]:p-0",
          )}
        >
          {processing ? (
            <ThinkingBubble />
          ) : (
            <Chat
              store={store.quickChatStore}
              compact
              embedded
              composerFocusEnabled
              className={cn(
                "h-auto max-h-[min(18rem,60vh)] [&_.transcript]:max-h-[min(18rem,60vh)] [&_[data-slot=composer-toolbar]]:shrink-0 [&_[data-slot=composer-toolbar]]:border-0 [&_[data-slot=composer-toolbar]]:p-0 [&_[data-slot=composer-toolbar]>div:first-child]:hidden [&_[data-slot=message]]:w-fit [&_[data-slot=message-content]]:max-w-[min(22rem,calc(100vw-24px))] [&_[data-slot=message-content]]:px-3 [&_[data-slot=message-content]]:py-2.5 [&_[data-slot=message-content]]:text-xs [&_[data-slot=message-content]]:leading-5 [&_[data-slot=message-content]]:shadow-none [&_[data-slot=message-actions]]:hidden [&_form]:flex [&_form]:items-center [&_form]:gap-1.5 [&_form]:border-0 [&_form]:bg-transparent [&_form]:p-1.5 [&_form]:shadow-none [&_textarea]:max-h-40 [&_textarea]:min-h-8 [&_textarea]:px-2.5 [&_textarea]:py-1.5 [&_textarea]:text-xs",
                !quickResponse && "[&_.transcript]:hidden",
                quickResponse &&
                  "[&_[data-slot=message-content]]:rounded-2xl [&_[data-slot=message-content]]:rounded-br-md [&_[data-slot=message-content]]:border-border/70 [&_[data-slot=message-content]]:bg-card/95 [&_[data-slot=message-content]]:shadow-lg",
              )}
              transcriptBehavior={{ showAssistantFullscreen: false }}
              error={store.error ? { message: store.error, title: "Assistant failed" } : undefined}
            />
          )}
        </PopoverContent>
      ) : (
        <PopoverContent
          side="left"
          align="end"
          boundary="nearest-ancestor"
          offset={12}
          aria-label="Session assistant chat"
          className="h-[min(24rem,70vh)] w-[min(19rem,calc(100vw-1rem))] overflow-hidden rounded-md p-0"
        >
          <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
            <div className="border-b border-border px-3 py-2">
              <p className="text-xs font-semibold">Session assistant</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Uses your utility model and continues this session’s assistant chat.
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
